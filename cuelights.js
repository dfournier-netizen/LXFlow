// LXFlow cue lights — server side (see firmware/LXFlowCueLight).
// ESP32 cue lights connect by WebSocket on path /cuelight and are told what to show.
// The caller's cue pointer drives them; per-cue _notify {target, lead, warn, cd}
// decides who gets WARNING, STANDBY, COUNTDOWN and GO. On top of that the caller
// or host can HOLD a position, call PLACES or STOP for everyone, and run a
// countdown by hand; anyone can CALL a position. Operators on LXFlow screens get the
// same standbys (crew acks), so everyone can see who has acknowledged.
//
// Every condition shows a "look" (colour, pattern, speed, level) that the host can
// edit, with optional per-position overrides. Firmware 1.1+ renders looks; 1.0.x
// lights get the old standby/GO/off messages. Firmware 1.2+ also takes OSC on its own
// and is sent its position's looks so its built-in OSC addresses match LXFlow's.

import dgram from 'node:dgram';
import os from 'node:os';

const DISCOVERY_PORT = 7391;
const STYLES = ['flash', 'steady'];
const PATTERNS = ['solid', 'flash', 'pulse', 'dblink', 'spin', 'strobe', 'countdown', 'dot', 'off'];
const LOCAL_PATTERNS = ['solid', 'flash', 'pulse', 'dblink', 'off'];
// What a light shows, highest priority first.
const CONDITIONS = ['stop', 'go', 'countdown', 'standby', 'call', 'hold', 'standbyAcked', 'missed', 'warning', 'places', 'idle'];
const LOCAL = ['lost', 'nowifi'];             // shown by the light itself, with no LXFlow link
const DEFAULT_LOOKS = {
  stop:         { color: '#ff0000', pattern: 'strobe',    rate: 250,  level: 100 },
  go:           { color: '#00ff00', pattern: 'solid',     rate: 1000, level: 100 },
  countdown:    { color: '#ff5000', pattern: 'countdown', rate: 1000, level: 100 },
  standby:      { color: '#ff0000', pattern: 'flash',     rate: 500,  level: 100 },
  call:         { color: '#ffffff', pattern: 'spin',      rate: 1000, level: 100 },
  hold:         { color: '#ffa000', pattern: 'solid',     rate: 1000, level: 100 },
  standbyAcked: { color: '#ff0000', pattern: 'solid',     rate: 1000, level: 100 },
  missed:       { color: '#ff0000', pattern: 'dblink',    rate: 1000, level: 30 },
  warning:      { color: '#ffa000', pattern: 'pulse',     rate: 2000, level: 100 },
  places:       { color: '#3060ff', pattern: 'pulse',     rate: 3000, level: 100 },
  idle:         { color: '#ffffff', pattern: 'dot',       rate: 1000, level: 10 },
  lost:         { color: '#0000ff', pattern: 'pulse',     rate: 2400, level: 35 },
  nowifi:       { color: '#ff00ff', pattern: 'pulse',     rate: 2400, level: 35 },
};

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function clean(look, local) {
  if (!look || typeof look !== 'object') return null;
  const color = String(look.color || '').toLowerCase();
  const pattern = String(look.pattern || '');
  const rate = Math.round(Number(look.rate));
  const level = Math.round(Number(look.level));
  if (!/^#[0-9a-f]{6}$/.test(color)) return null;
  if (!(local ? LOCAL_PATTERNS : PATTERNS).includes(pattern)) return null;
  if (!(rate >= 100 && rate <= 5000) || !(level >= 1 && level <= 100)) return null;
  return { color, pattern, rate, level };
}
function fwAtLeast(fw, want) {
  const a = String(fw || '0').split('.').map(n => parseInt(n, 10) || 0), b = want.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
}
// "7:30 PM", "7:30:15pm", "19:30", "19:30:00" -> next matching wall-clock time (ms), or null.
function parseClock(text, now) {
  const m = String(text || '').trim().match(/^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(?:([ap])\.?\s*m?\.?)?$/i);
  if (!m) return null;
  let h = +m[1];
  const ap = (m[4] || '').toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; if (ap === 'p' && h !== 12) h += 12; if (ap === 'a' && h === 12) h = 0; }
  else if (h > 23) return null;
  const d = new Date(now); d.setHours(h, +m[2], +(m[3] || 0), 0);
  let t = d.getTime();
  if (t < now - 12 * 3600e3) t += 24 * 3600e3;      // overnight shows: 1:00 AM after a 10 PM start
  return t;
}

function createCueLights(opts) {
  const o = Object.assign({ goMs: 3000, identMs: 3000, missMs: 10000, previewMs: 3000, tickMs: 500, log: () => {}, now: () => Date.now() }, opts);
  // persisted: { style, ackSteady, caller, lights, looks, overrides, stealth, stealthLevel, stop, places, holds }
  const st = Object.assign({ style: 'flash', ackSteady: true, caller: '', lights: {}, looks: {}, overrides: {},
    stealth: false, stealthLevel: 15, stop: false, places: false, holds: [] }, o.loadState ? o.loadState() : {});
  if (!STYLES.includes(st.style)) st.style = 'flash';
  st.ackSteady = st.ackSteady !== false;
  if (!Array.isArray(st.holds)) st.holds = [];
  if (!st.looks || typeof st.looks !== 'object') st.looks = {};
  if (!st.overrides || typeof st.overrides !== 'object') st.overrides = {};

  const live = new Map();       // id -> { ws, ip, fw, v11, sent, goUntil, goTimer, key, cond, missedUntil, preview }
  const acks = new Set();       // `${lightId}|${cueKey}`
  let lastIdx = null;          // caller's last cue id ('' = on show, no cue; null = no caller)
  let udp = null, ticker = null;
  const userAcks = new Set();   // `${userId}|${cueKey}`
  const missed = new Map();     // userId -> { until, timer }: missed an ack at GO
  let pendingByUser = new Map();  // userId -> Set of unacked standby keys, as of the last refresh
  const calls = new Map();      // norm(position) -> { position, fromId, fromName, at }
  const manualCd = new Map();   // norm(position) -> { position, end, total }
  const sbStart = new Map();    // cueKey -> when its standby window opened (for "seconds" countdowns)
  const now = () => o.now();

  const save = () => { if (o.saveState) o.saveState(JSON.parse(JSON.stringify(st))); };
  const emit = ev => { if (o.onEvent) try { o.onEvent(ev); } catch (_) {} };

  // ---- looks ----
  function look(cond, position) {
    const ov = st.overrides[norm(position)];
    return (ov && ov[cond]) || st.looks[cond] || DEFAULT_LOOKS[cond];
  }
  function wire(lk, cd) {
    const n = parseInt(lk.color.slice(1), 16);
    let level = lk.level;
    if (st.stealth) level = Math.min(level, st.stealthLevel);
    const out = { t: 'look', c: [(n >> 16) & 255, (n >> 8) & 255, n & 255], p: lk.pattern, r: lk.rate, b: Math.max(1, Math.round(level * 2.55)) };
    if (cd && lk.pattern === 'countdown') out.cd = { l: Math.max(0, cd.end - now()), t: cd.total };
    return out;
  }

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
  const warnOf = n => Math.max(0, Number(n.warn) || 0);

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
    return m && m.until > now() ? 'missed' : 'ok';
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
    missed.set(userId, { until: now() + o.missMs, timer: setTimeout(() => { missed.delete(userId); changed(); }, o.missMs + 5) });
  }
  function ackUsersAt(position) {                   // a light's button acks the operators at its position
    const p = norm(position);
    if (!p || p === 'all') return 0;
    const v = view();
    let n = 0;
    for (const u of users()) if (norm(u.position) === p) for (const k of userStandbys(u, v.cues, v.idx)) { if (!userAcks.has(u.id + '|' + k)) n++; userAcks.add(u.id + '|' + k); }
    return n;
  }

  // ---- cue-driven conditions ----
  // Standby key for one light, or null.
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
  // WARNING: `warn` cues before the standby window opens (or before GO when lead is 0).
  function warningFor(target, isUser, v) {
    if (v.idx == null) return false;
    for (let j = Math.max(0, v.idx + 1); j < v.cues.length; j++) {
      const n = v.cues[j] && v.cues[j]._notify;
      if (!n || warnOf(n) <= 0) continue;
      const open = j - leadOf(n);                     // first idx of the standby (or GO) window
      if (v.idx < open && v.idx >= open - warnOf(n) && (isUser ? userMatches(target, n) : matches(target, n))) return true;
    }
    return false;
  }
  function timeColumn(columns) {
    if (!Array.isArray(columns)) return null;
    const c = columns.find(c => c && c.key === 'time') || columns.find(c => c && /^(time|start|start time|go time|clock)$/i.test(String(c.label || '').trim()));
    return c ? c.key : null;
  }
  // Soonest countdown for a target: cue-based (time or seconds), or hand-started at its exact position.
  function countdownFor(target, isUser, v) {
    let best = null;
    const t = now();
    const take = cd => { if (cd && cd.end > t && (!best || cd.end < best.end)) best = cd; };
    const pos = norm(target.position);
    if (pos && pos !== 'all') take(manualCd.get(pos));
    if (v.idx == null) return best;
    const tkey = timeColumn(v.columns);
    for (let j = Math.max(0, v.idx + 1); j < v.cues.length; j++) {
      const c = v.cues[j], n = c && c._notify;
      if (!n || !n.cd || !n.cd.mode) continue;
      if (!(isUser ? userMatches(target, n) : matches(target, n))) continue;
      const secs = Math.max(1, Math.min(3600, Number(n.cd.seconds) || 60)) * 1000;
      if (n.cd.mode === 'time' && tkey) {
        const at = parseClock(c[tkey], t);
        if (at && t >= at - secs && t < at) take({ end: at, total: secs });
      } else if (n.cd.mode === 'seconds') {
        const s = sbStart.get(cueKey(c, j));
        if (s != null) take({ end: s + secs, total: secs });
      }
    }
    return best;
  }
  function trackStandbyStarts(v) {
    const active = new Set();
    if (v.idx != null) for (let j = Math.max(0, v.idx + 1); j < v.cues.length; j++) {
      const n = v.cues[j] && v.cues[j]._notify;
      if (n && leadOf(n) > 0 && j - leadOf(n) <= v.idx) active.add(cueKey(v.cues[j], j));
    }
    for (const k of [...sbStart.keys()]) if (!active.has(k)) sbStart.delete(k);
    for (const k of active) if (!sbStart.has(k)) sbStart.set(k, now());
  }

  // What one light shows right now.
  function condFor(id) {
    const light = st.lights[id] || {};
    const pos = norm(light.position);
    const l = live.get(id);
    const t = now();
    if (l && l.preview && l.preview.until > t) return { cond: l.preview.cond, key: l.key || null };
    if (st.stop) return { cond: 'stop', key: null };
    if (!pos) return { cond: st.places ? 'places' : 'idle', key: null };
    const v = view();
    const key = standbyFor(id, light, v.cues, v.idx);
    if (l && l.goUntil > t) return { cond: 'go', key };
    const cd = countdownFor(light, false, v);
    if (cd) return { cond: 'countdown', key, cd };
    if (key && st.style === 'flash' && !acks.has(id + '|' + key)) return { cond: 'standby', key };
    if (pos !== 'all' && calls.has(pos)) return { cond: 'call', key };
    if (pos !== 'all' && st.holds.some(h => norm(h) === pos)) return { cond: 'hold', key };
    if (key) return { cond: 'standbyAcked', key };
    if (l && l.missedUntil > t) return { cond: 'missed', key };
    if (warningFor(light, false, v)) return { cond: 'warning', key };
    if (st.places) return { cond: 'places', key };
    return { cond: 'idle', key };
  }
  // Firmware 1.0.x only knows standby (flash/steady), GO and off.
  function legacy(d) {
    if (d.cond === 'go') return { t: 'state', s: 'go', ms: Math.max(1, (live.get(d.id).goUntil || now()) - now()) };
    if (d.cond === 'standby') return { t: 'state', s: 'standby', flash: true };
    if (d.cond === 'standbyAcked' || (d.cond === 'countdown' && d.key)) return { t: 'state', s: 'standby', flash: false };
    return { t: 'state', s: 'off' };
  }

  function push(id, force) {
    const l = live.get(id);
    if (!l) return;
    const d = condFor(id);
    d.id = id;
    l.cond = d.cond;
    l.key = d.key || null;
    const pos = (st.lights[id] || {}).position;
    let msg, sig;
    if (l.v11) {
      const pv = l.preview && l.preview.until > now() ? l.preview : null;
      msg = wire(pv ? pv.look : look(d.cond, pos), d.cd);
      sig = JSON.stringify([d.cond, msg.c, msg.p, msg.r, msg.b, d.cd ? Math.round(d.cd.end / 250) : 0]);
    } else {
      msg = legacy(d);
      sig = d.cond === 'go' ? 'go' : JSON.stringify(msg);
    }
    if (!force && sig === l.sent) return;
    l.sent = sig;
    send(l.ws, msg);
  }

  function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} }
  function localLooks(l) {
    if (!l || !l.v11) return;
    const pack = k => { const w = wire(look(k, '')); return { c: w.c, p: w.p, r: w.r, b: w.b }; };
    send(l.ws, { t: 'local', lost: pack('lost'), nowifi: pack('nowifi') });
  }
  // Firmware 1.2: the looks its built-in OSC addresses use (this light's position, no stealth).
  const OSC_LOOKS = ['standby', 'standbyAcked', 'go', 'hold', 'call', 'places', 'stop', 'warning', 'countdown', 'idle'];
  function oscLooks(id) {
    const l = live.get(id);
    if (!l || !l.v12) return;
    const pos = (st.lights[id] || {}).position;
    const looks = {};
    for (const k of OSC_LOOKS) {
      const lk = look(k, pos), n = parseInt(lk.color.slice(1), 16);
      looks[k] = { c: [(n >> 16) & 255, (n >> 8) & 255, n & 255], p: lk.pattern, r: lk.rate, b: Math.max(1, Math.round(lk.level * 2.55)) };
    }
    const sig = JSON.stringify(looks);
    if (sig === l.oscSent) return;
    l.oscSent = sig;
    send(l.ws, { t: 'looks', looks });
  }

  // view(): the caller's show and pointer. idx null = no caller / caller offline;
  // -1 = caller is on the show with no active cue (standby for cue 1 still shows).
  function view() {
    const v = o.getView ? o.getView(st.caller) : null;
    return v && Array.isArray(v.cues) && Number.isInteger(v.idx) ? { cues: v.cues, idx: v.idx, columns: v.columns || [] } : { cues: [], idx: null, columns: [] };
  }

  // Call whenever cues, the caller, or the caller's pointer may have changed.
  function refresh() {
    const v = view();
    const { cues, idx } = v;
    trackStandbyStarts(v);
    const cur = idx != null && idx >= 0 && cues[idx] ? String(cues[idx].id ?? '#' + idx) : null;
    // GO fires only when the caller MOVES onto a cue -- not when the caller is
    // picked, reconnects, or rows are inserted above the live cue.
    if (cur !== lastIdx) {
      if (cur != null && lastIdx != null) {
        for (const [userId, keys] of pendingByUser) if (keys.has(cur)) markMissed(userId);
        for (const [id, l] of live) if (needsAck() && l.key === cur && !acks.has(id + '|' + cur)) l.missedUntil = now() + o.missMs;
      }
      if (cur != null && lastIdx != null && cues[idx]._notify) {
        const n = cues[idx]._notify;
        for (const [id, l] of live) {
          if (!matches(st.lights[id] || {}, n)) continue;
          clearTimeout(l.goTimer);
          l.goUntil = now() + o.goMs;
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
    updateCrew(v);
    changed();
  }

  // Time moves countdowns, missed and preview windows along between pointer moves.
  function tick() {
    const t = now();
    for (const [k, cd] of [...manualCd]) if (cd.end <= t) manualCd.delete(k);
    trackStandbyStarts(view());
    for (const id of live.keys()) push(id);
    changed();
  }
  ticker = setInterval(tick, o.tickMs);
  if (ticker.unref) ticker.unref();

  let changeQueued = false, lastPublic = '';
  function changed() {
    if (changeQueued) return;
    changeQueued = true;
    setImmediate(() => {
      changeQueued = false;
      const p = publicState(), sig = JSON.stringify(p);
      if (sig === lastPublic) return;               // pointer moves that change nothing stay quiet
      lastPublic = sig;
      p.now = now();                               // lets screens correct for clock differences
      if (o.onChange) o.onChange(p);
    });
  }

  function positions() {
    const seen = new Map();
    const add = p => { const k = norm(p); if (k && k !== 'all' && !seen.has(k)) seen.set(k, String(p).trim()); };
    for (const id of Object.keys(st.lights)) add(st.lights[id].position);
    for (const u of users()) add(u.position);
    for (const k of Object.keys(st.overrides)) add(k);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  function publicState() {
    const ids = new Set([...Object.keys(st.lights), ...live.keys()]);
    const lights = [...ids].sort().map(id => {
      const p = st.lights[id] || {}, l = live.get(id);
      const state = !l ? 'offline' : l.cond === 'standby' ? 'standby-flash' : l.cond === 'standbyAcked' ? 'standby' : (l.cond || 'idle');
      return { id, name: p.name || 'Cue light ' + id.slice(-4), position: p.position || '',
        online: !!l, ip: l ? l.ip : '', fw: l ? l.fw : '', needsFlash: !!l && !l.v11, state,
        mode: l ? l.mode : '', oscName: l ? l.oscName : '', oscPort: l ? l.oscPort : 0 };
    });
    const v = view();
    const crew = {}, crewCd = {}, crewWarn = {};
    for (const u of users()) {
      crew[u.id] = crewState(u, v);
      const cd = countdownFor(u, true, v);
      if (cd) crewCd[u.id] = { end: cd.end, total: cd.total };
      if (warningFor(u, true, v)) crewWarn[u.id] = true;
    }
    const looks = {};
    for (const k of [...CONDITIONS, ...LOCAL]) looks[k] = look(k, '');
    return {
      style: st.style, ackSteady: st.ackSteady, caller: st.caller, lights, crew, crewCd, crewWarn,
      looks, overrides: st.overrides, stealth: st.stealth, stealthLevel: st.stealthLevel, positions: positions(),
      cond: {
        stop: st.stop, places: st.places, holds: st.holds.slice(),
        calls: Object.fromEntries([...calls].map(([k, c]) => [k, { position: c.position, fromId: c.fromId, fromName: c.fromName }])),
        countdowns: Object.fromEntries([...manualCd].filter(([, c]) => c.end > now()).map(([k, c]) => [k, { position: c.position, end: c.end, total: c.total }])),
      },
    };
  }

  // ---- acks ----
  function ackLightOnly(id) {                       // this light's standby counts as acknowledged
    const l = live.get(id);
    if (!l || !l.key || acks.has(id + '|' + l.key)) return false;
    acks.add(id + '|' + l.key);
    push(id);
    return true;
  }

  // The light's own button: acks its standby (and the operators at its position);
  // with no standby left to ack, it answers a CALL to its position.
  function ackLight(id) {
    const l = live.get(id);
    if (!l) return false;
    const light = st.lights[id] || {};
    if (l.key) {
      const a = ackLightOnly(id);
      const b = ackUsersAt(light.position) > 0;
      if (a || b) { updateCrew(view()); changed(); return true; }
    }
    if (norm(light.position) !== 'all' && calls.has(norm(light.position))) return ackCall(light.position, light.name || light.position);
    return false;
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

  // ---- calls, holds, places, stop, countdowns ----
  const repaint = () => { for (const id of live.keys()) push(id); changed(); };
  function call(position, from) {
    const p = norm(position);
    if (!p || p === 'all') return false;
    calls.set(p, { position: String(position).trim(), fromId: (from && from.id) || '', fromName: (from && from.name) || 'Someone', at: now() });
    repaint();
    return true;
  }
  function ackCall(position, byName) {
    const p = norm(position), c = calls.get(p);
    if (!c) return false;
    calls.delete(p);
    emit({ type: 'callAcked', to: c.fromId, position: c.position, by: byName || c.position });
    repaint();
    return true;
  }
  function cancelCall(position) { if (!calls.delete(norm(position))) return false; repaint(); return true; }
  function callFrom(position) { const c = calls.get(norm(position)); return c ? c.fromId : null; }
  function setHold(position, on) {
    const p = norm(position);
    if (!p || p === 'all') return;
    st.holds = st.holds.filter(h => norm(h) !== p);
    if (on) st.holds.push(String(position).trim());
    save(); repaint();
  }
  function setPlaces(on) { st.places = !!on; save(); repaint(); }
  function setStop(on) { st.stop = !!on; save(); repaint(); }
  function startCountdown(position, seconds) {
    const p = norm(position), s = Math.round(Number(seconds));
    if (!p || p === 'all' || !(s >= 1 && s <= 3600)) return false;
    manualCd.set(p, { position: String(position).trim(), end: now() + s * 1000, total: s * 1000 });
    repaint();
    return true;
  }
  function cancelCountdown(position) { manualCd.delete(norm(position)); repaint(); }

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
        const fw = String(m.fw || '');
        live.set(id, { ws, ip, fw, v11: fwAtLeast(fw, '1.1.0'), v12: fwAtLeast(fw, '1.2.0'), sent: null, goUntil: 0, missedUntil: 0,
          mode: ['lxflow', 'osc', 'both'].includes(m.mode) ? m.mode : '', oscName: String(m.oscName || '').slice(0, 23), oscPort: Number(m.oscPort) || 0 });
        if (!st.lights[id]) { st.lights[id] = { name: '', position: '' }; save(); }
        o.log(`cue light ${id} connected from ${ip} (fw ${fw || '?'})`);
        localLooks(live.get(id));
        oscLooks(id);
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
    save(); oscLooks(id); refresh();
  }
  function relook(localChanged) {
    save();
    if (localChanged) for (const l of live.values()) localLooks(l);
    for (const id of live.keys()) oscLooks(id);
    repaint();
  }
  // Global look for a condition (null = back to the built-in default).
  function setLook(cond, lk) {
    const local = LOCAL.includes(cond);
    if (!local && !CONDITIONS.includes(cond)) return false;
    if (lk == null) delete st.looks[cond];
    else { const c = clean(lk, local); if (!c) return false; st.looks[cond] = c; }
    relook(local);
    return true;
  }
  // Per-position override (null = use the global look). The light's own lost/no-Wi-Fi looks have none.
  function setOverride(position, cond, lk) {
    const p = norm(position);
    if (!p || p === 'all' || !CONDITIONS.includes(cond)) return false;
    const ov = st.overrides[p] || {};
    if (lk == null) delete ov[cond];
    else { const c = clean(lk, false); if (!c) return false; ov[cond] = c; }
    if (Object.keys(ov).length) st.overrides[p] = ov; else delete st.overrides[p];
    relook(false);
    return true;
  }
  function setStealth(on, level) {
    if (on != null) st.stealth = !!on;
    if (level != null) { const n = Math.round(Number(level)); if (n >= 1 && n <= 100) st.stealthLevel = n; }
    relook(true);
  }
  // Show a look on every online light (or one position's) for a few seconds.
  function preview(cond, position, lk) {
    if (!CONDITIONS.includes(cond)) return 0;
    const p = norm(position);
    const given = lk ? clean(lk, false) : null;
    let n = 0;
    for (const [id, l] of live) {
      if (p && norm((st.lights[id] || {}).position) !== p) continue;
      const shown = given || look(cond, p ? position : (st.lights[id] || {}).position);
      l.preview = { cond, look: shown, until: now() + o.previewMs };
      l.sent = null;
      setTimeout(() => { if (l.preview && l.preview.until <= now()) { l.preview = null; l.sent = null; push(id); changed(); } }, o.previewMs + 5);
      push(id); n++;
    }
    changed();
    return n;
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
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (udp) { try { udp.close(); } catch (_) {} udp = null; }
    for (const m of missed.values()) clearTimeout(m.timer);
    for (const l of live.values()) { clearTimeout(l.goTimer); try { l.ws.close(); } catch (_) {} }
  }

  return { attach, refresh, publicState, ackLight, ackPosition, ackUser, setStyle, setAckSteady, setCaller, getCaller,
    configureLight, identify, forget, startDiscovery, stop,
    call, ackCall, cancelCall, callFrom, setHold, setPlaces, setStop, startCountdown, cancelCountdown,
    setLook, setOverride, setStealth, preview };
}

export { createCueLights, DISCOVERY_PORT, CONDITIONS, DEFAULT_LOOKS, PATTERNS, parseClock };
