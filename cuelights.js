// LXFlow cue lights — server side (see firmware/LXFlowCueLight).
// ESP32 cue lights connect by WebSocket on path /cuelight and are told what to show.
// The caller's cue pointer drives them; per-cue _notify {target, lead} decides who gets
// STANDBY (lead cues ahead) and GO (on the cue). Host chooses caller, standby style and
// which position each light belongs to. Operators on LXFlow screens get the same
// standbys (crew acks), so everyone can see who has acknowledged.

import dgram from 'node:dgram';
import os from 'node:os';

const DISCOVERY_PORT = 7391;
const STYLES = ['flash', 'steady'];

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

function createCueLights(opts) {
  const o = Object.assign({ goMs: 3000, identMs: 3000, missMs: 10000, log: () => {} }, opts);
  // persisted: { style, ackSteady, caller, lights: { id: { name, position } } }
  const st = Object.assign({ style: 'flash', ackSteady: true, caller: '', lights: {} }, o.loadState ? o.loadState() : {});
  if (!STYLES.includes(st.style)) st.style = 'flash';
  st.ackSteady = st.ackSteady !== false;

  const live = new Map();       // id -> { ws, ip, fw, sent: 'json', goUntil, goTimer }
  const acks = new Set();       // `${lightId}|${cueKey}`
  let lastIdx = null;          // caller's last cue id ('' = on show, no cue; null = no caller)
  let udp = null;
  const userAcks = new Set();   // `${userId}|${cueKey}`
  const missed = new Map();     // userId -> { until, timer }: missed an ack at GO
  let pendingByUser = new Map();  // userId -> Set of unacked standby keys, as of the last refresh

  const save = () => { if (o.saveState) o.saveState(JSON.parse(JSON.stringify(st))); };

  // Same targeting rule as the on-screen pop-ups (notifyTargetsMe in index.html),
  // with the light's position standing in for the operator's position.
  function matches(light, n) {
    const pos = norm(light.position);
    if (!pos) return false;                         // unassigned lights stay dark
    if (!n || !n.text) return false;                // pop-ups need text too
    const tgt = norm(n.target || 'all');
    return pos === 'all' || !tgt || tgt === 'all' || tgt === 'everyone' || pos === tgt || pos.includes(tgt) || tgt.includes(pos);
  }

  const cueKey = (c, j) => (c && c.id != null ? String(c.id) : '#' + j);
  const leadOf = n => Number(n.lead) || 0;          // 0 = GO only, as in the pop-ups

  // ---- crew (operators on LXFlow screens) ----
  // Targeting is notifyTargetsMe from index.html: position or name, contains-match either way.
  function userMatches(u, n) {
    if (!n || !n.text) return false;
    const t = norm(n.target || 'all');
    if (!t || t === 'all' || t === 'everyone') return true;
    return [norm(u.position), norm(u.name)].filter(Boolean).some(x => x === t || x.includes(t) || t.includes(x));
  }
  function userStandbys(u, cues, idx) {             // every live standby key for this user
    const out = [];
    if (idx == null || !Array.isArray(cues)) return out;
    for (let j = Math.max(0, idx + 1); j < cues.length; j++) {
      const c = cues[j], n = c && c._notify;
      if (!n || leadOf(n) <= 0 || j - leadOf(n) > idx) continue;
      if (userMatches(u, n)) out.push(cueKey(c, j));
    }
    return out;
  }
  const needsAck = () => st.style === 'flash' || st.ackSteady;
  function users() {
    const seen = new Map();
    for (const u of (o.getUsers ? o.getUsers() : [])) if (u && u.id && !seen.has(u.id)) seen.set(u.id, u);
    return [...seen.values()];
  }
  function pendingFor(u, v) { return needsAck() ? userStandbys(u, v.cues, v.idx).filter(k => !userAcks.has(u.id + '|' + k)) : []; }
  function crewState(u, v) {
    if (pendingFor(u, v).length) return 'pending';
    const m = missed.get(u.id);
    return m && m.until > Date.now() ? 'missed' : 'ok';
  }
  function updateCrew(v) {
    const keep = new Set();
    for (const u of users()) for (const k of userStandbys(u, v.cues, v.idx)) keep.add(u.id + '|' + k);
    for (const a of [...userAcks]) if (!keep.has(a)) userAcks.delete(a);
    pendingByUser = new Map(users().map(u => [u.id, new Set(pendingFor(u, v))]));
  }
  function markMissed(userId) {
    const m = missed.get(userId);
    if (m) clearTimeout(m.timer);
    missed.set(userId, { until: Date.now() + o.missMs, timer: setTimeout(() => { missed.delete(userId); changed(); }, o.missMs + 5) });
  }
  function ackUsersAt(position) {                   // a light's button acks the operators at its position
    const p = norm(position);
    if (!p || p === 'all') return 0;
    const v = view();
    let n = 0;
    for (const u of users()) if (norm(u.position) === p) for (const k of userStandbys(u, v.cues, v.idx)) { if (!userAcks.has(u.id + '|' + k)) n++; userAcks.add(u.id + '|' + k); }
    return n;
  }

  // What one light should show right now (ignoring an active GO window).
  function standbyFor(id, light, cues, idx) {
    if (idx == null || !Array.isArray(cues)) return null;
    for (let j = Math.max(0, idx + 1); j < cues.length; j++) {
      const c = cues[j], n = c && c._notify;
      if (!n || leadOf(n) <= 0) continue;
      if (j - leadOf(n) > idx) continue;            // too far ahead
      if (!matches(light, n)) continue;
      return cueKey(c, j);
    }
    return null;
  }

  function desired(id) {
    const light = st.lights[id] || {};
    const l = live.get(id);
    if (l && l.goUntil && l.goUntil > Date.now()) return { t: 'state', s: 'go', ms: Math.max(1, l.goUntil - Date.now()) };
    const v = view();
    const key = standbyFor(id, light, v.cues, v.idx);
    if (!key) return { t: 'state', s: 'off' };
    return { t: 'state', s: 'standby', flash: st.style === 'flash' && !acks.has(id + '|' + key), _key: key };
  }

  function push(id, force) {
    const l = live.get(id);
    if (!l) return;
    const d = desired(id);
    l.state = d.s === 'standby' ? (d.flash ? 'standby-flash' : 'standby') : d.s;
    l.key = d._key || null;
    delete d._key;
    const sig = d.s === 'go' ? 'go' : JSON.stringify(d);
    if (!force && sig === l.sent) return;
    l.sent = sig;
    send(l.ws, d);
  }

  function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} }

  // Call whenever cues, the caller, or the caller's pointer may have changed.
  // view(): the caller's show and pointer. idx null = no caller / caller offline;
  // -1 = caller is on the show with no active cue (standby for cue 1 still shows).
  function view() {
    const v = o.getView ? o.getView(st.caller) : null;
    return v && Array.isArray(v.cues) && Number.isInteger(v.idx) ? v : { cues: [], idx: null };
  }

  function refresh() {
    const { cues, idx } = view();
    const cur = idx != null && idx >= 0 && cues[idx] ? String(cues[idx].id ?? '#' + idx) : null;
    // GO fires only when the caller MOVES onto a cue -- not when the caller is
    // picked, reconnects, or rows are inserted above the live cue.
    if (cur !== lastIdx) {
      if (cur != null && lastIdx != null) {
        for (const [userId, keys] of pendingByUser) if (keys.has(cur)) markMissed(userId);
      }
      if (cur != null && lastIdx != null && cues[idx]._notify) {
        const n = cues[idx]._notify;
        for (const [id, l] of live) {
          if (!matches(st.lights[id] || {}, n)) continue;
          clearTimeout(l.goTimer);
          l.goUntil = Date.now() + o.goMs;
          l.sent = null;                            // always re-send a new GO
          l.goTimer = setTimeout(() => { l.goUntil = 0; push(id); changed(); }, o.goMs + 5);
        }
      }
    }
    lastIdx = idx == null ? null : (cur ?? '');
    // drop acks for standbys that are no longer active
    const keep = new Set();
    for (const id of live.keys()) {
      const k = standbyFor(id, st.lights[id] || {}, cues, idx);
      if (k) keep.add(id + '|' + k);
    }
    for (const a of [...acks]) if (!keep.has(a)) acks.delete(a);
    for (const id of live.keys()) push(id);
    updateCrew({ cues, idx });
    changed();
  }

  let changeQueued = false, lastPublic = '';
  function changed() {
    if (changeQueued) return;
    changeQueued = true;
    setImmediate(() => {
      changeQueued = false;
      const p = publicState(), sig = JSON.stringify(p);
      if (sig === lastPublic) return;               // pointer moves that change nothing stay quiet
      lastPublic = sig;
      if (o.onChange) o.onChange(p);
    });
  }

  function publicState() {
    const ids = new Set([...Object.keys(st.lights), ...live.keys()]);
    const lights = [...ids].sort().map(id => {
      const p = st.lights[id] || {}, l = live.get(id);
      return { id, name: p.name || 'Cue light ' + id.slice(-4), position: p.position || '',
        online: !!l, ip: l ? l.ip : '', fw: l ? l.fw : '', state: l ? (l.state || 'off') : 'offline' };
    });
    const v = view();
    const crew = {};
    for (const u of users()) crew[u.id] = crewState(u, v);
    return { style: st.style, ackSteady: st.ackSteady, caller: st.caller, lights, crew };
  }

  function ackLightOnly(id) {                       // stops this light flashing
    const l = live.get(id);
    if (!l || l.state !== 'standby-flash' || !l.key) return false;
    acks.add(id + '|' + l.key);
    push(id);
    return true;
  }

  // The light's own button: stops it flashing and acks the operators at its position.
  function ackLight(id) {
    const l = live.get(id);
    if (!l || !l.key) return false;
    const a = ackLightOnly(id);
    const b = ackUsersAt((st.lights[id] || {}).position) > 0;
    updateCrew(view()); changed();
    return a || b;
  }

  // Lights at a position (and the operators there).
  function ackPosition(position) {
    const p = norm(position);
    if (!p) return 0;
    let n = 0;
    for (const id of live.keys()) if (norm((st.lights[id] || {}).position) === p && ackLightOnly(id)) n++;
    ackUsersAt(position);
    updateCrew(view()); changed();
    return n;
  }

  // An operator's on-screen ACK: their own standbys, plus the light at their position.
  function ackUser(userId) {
    const u = users().find(x => x.id === userId);
    if (!u) return 0;
    const v = view();
    let n = 0;
    for (const k of userStandbys(u, v.cues, v.idx)) { if (!userAcks.has(u.id + '|' + k)) n++; userAcks.add(u.id + '|' + k); }
    const p = norm(u.position);
    if (p) for (const id of live.keys()) if (norm((st.lights[id] || {}).position) === p) ackLightOnly(id);
    updateCrew(v); changed();
    return n;
  }

  // A new socket on /cuelight.
  function attach(ws, req) {
    let id = null;
    const ip = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    const helloTimer = setTimeout(() => { try { ws.close(4000, 'no hello'); } catch (_) {} }, 5000);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(String(raw)); } catch (_) { return; }
      if (!id) {
        if (m.t !== 'hello' || !/^[0-9A-Fa-f]{12}$/.test(String(m.id || ''))) return;
        const code = o.roomCode ? o.roomCode() : '';
        if (code && String(m.code || '') !== code) { clearTimeout(helloTimer); try { ws.close(4001, 'room code'); } catch (_) {} return; }
        clearTimeout(helloTimer);
        id = String(m.id).toUpperCase();
        const old = live.get(id);
        if (old) { clearTimeout(old.goTimer); try { old.ws.close(4002, 'replaced'); } catch (_) {} }
        live.set(id, { ws, ip, fw: String(m.fw || ''), sent: null, goUntil: 0 });
        if (!st.lights[id]) { st.lights[id] = { name: '', position: '' }; save(); }
        o.log(`cue light ${id} connected from ${ip}`);
        push(id, true);
        changed();
        return;
      }
      if (m.t === 'ack') ackLight(id);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (id && live.get(id) && live.get(id).ws === ws) {
        clearTimeout(live.get(id).goTimer);
        live.delete(id);
        o.log(`cue light ${id} disconnected`);
        changed();
      }
    });
    ws.on('error', () => {});
  }

  // ---- host controls ----
  function setStyle(s) { if (!STYLES.includes(s)) return; st.style = s; save(); for (const id of live.keys()) push(id); updateCrew(view()); changed(); }
  function setAckSteady(on) { st.ackSteady = !!on; save(); updateCrew(view()); changed(); }
  function setCaller(userId) { st.caller = String(userId || ''); save(); refresh(); }
  function configureLight(id, patch) {
    if (!st.lights[id]) return;
    if (patch.name != null) st.lights[id].name = String(patch.name).slice(0, 40);
    if (patch.position != null) st.lights[id].position = String(patch.position).slice(0, 40);
    save(); refresh();
  }
  function identify(id) { const l = live.get(id); if (l) send(l.ws, { t: 'ident', ms: o.identMs }); }
  function forget(id) {                             // offline lights only; an online one would just reconnect
    if (live.has(id) || !st.lights[id]) return;
    delete st.lights[id]; save(); changed();
  }
  function getCaller() { return st.caller; }

  // ---- discovery: answer "LXFLOW_DISCOVER" broadcasts with "LXFLOW <port>" ----
  function inSubnet(addr, ip, mask) {
    const n = s => s.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
    return ((n(addr) & n(mask)) >>> 0) === ((n(ip) & n(mask)) >>> 0);
  }
  function bindInfo() {
    const h = o.bindHost ? o.bindHost() : '';
    if (!h || h === '0.0.0.0' || h === '::') return null;
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list || []) if (a.family === 'IPv4' && a.address === h) return a;
    return null;
  }
  function startDiscovery() {
    if (udp) return;
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', e => { o.log('cue light discovery off: ' + e.message); try { udp.close(); } catch (_) {} udp = null; });
    udp.on('message', (msg, rinfo) => {
      if (String(msg).trim() !== 'LXFLOW_DISCOVER') return;
      const b = bindInfo();
      if (b && !inSubnet(rinfo.address, b.address, b.netmask)) return;   // only answer on the bound network
      udp.send('LXFLOW ' + o.port(), rinfo.port, rinfo.address);
    });
    udp.bind(o.discoveryPort || DISCOVERY_PORT);
  }
  function stop() {
    if (udp) { try { udp.close(); } catch (_) {} udp = null; }
    for (const m of missed.values()) clearTimeout(m.timer);
    for (const l of live.values()) { clearTimeout(l.goTimer); try { l.ws.close(); } catch (_) {} }
  }

  return { attach, refresh, publicState, ackLight, ackPosition, ackUser, setStyle, setAckSteady, setCaller, getCaller,
    configureLight, identify, forget, startDiscovery, stop };
}

export { createCueLights, DISCOVERY_PORT };
