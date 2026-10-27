// Cue light looks, conditions and commands (firmware 1.1 protocol) with simulated lights.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createCueLights, parseClock } from '../cuelights.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const N = (text, target, lead, extra = {}) => ({ text, target, lead, ...extra });
const hhmmss = t => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };

async function rig(cues, extra = {}) {
  const ctx = { view: { cues, idx: 0, columns: [{ key: 'time', label: 'Time' }] }, pub: null, events: [], saved: null,
    users: [{ id: 'u_lx', name: 'Sam', position: 'LX' }, { id: 'u_v', name: 'Ana', position: 'Video' }] };
  const cl = createCueLights({
    goMs: 150, missMs: 450, previewMs: 150, tickMs: 50, discoveryPort: 0,
    getView: () => ctx.view, getUsers: () => ctx.users, loadState: () => ({}), saveState: s => { ctx.saved = s; },
    roomCode: () => '', port: () => 7390, bindHost: () => '', onChange: s => { ctx.pub = s; }, onEvent: e => ctx.events.push(e),
    ...extra,
  });
  const srv = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => cl.attach(ws, req)));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const light = (id, fw = '1.1.0') => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/cuelight`);
    const L = { ws, msgs: [], get last() { return this.msgs.filter(m => m.t === 'look' || m.t === 'state').at(-1); } };
    ws.on('message', m => L.msgs.push(JSON.parse(String(m))));
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', id, fw })); setTimeout(() => res(L), 60); });
  });
  const move = async idx => { ctx.view = idx == null ? null : { ...ctx.view, idx }; cl.refresh(); await wait(30); };
  const done = () => { cl.stop(); srv.close(); };
  return { cl, ctx, light, move, done };
}
const is = (m, p, c) => m && m.t === 'look' && m.p === p && (!c || JSON.stringify(m.c) === JSON.stringify(c));
const RED = [255, 0, 0], GREEN = [0, 255, 0], AMBER = [255, 160, 0], WHITE = [255, 255, 255], BLUE = [48, 96, 255];

test('parseClock reads show-sheet times', () => {
  const base = new Date(2026, 9, 27, 18, 0, 0).getTime();
  const h = t => new Date(parseClock(t, base)).getHours() * 60 + new Date(parseClock(t, base)).getMinutes();
  assert.equal(h('7:30 PM'), 19 * 60 + 30);
  assert.equal(h('7:30pm'), 19 * 60 + 30);
  assert.equal(h('19:30'), 19 * 60 + 30);
  assert.equal(h('12:15 am'), 15);
  assert.equal(new Date(parseClock('19:30:45', base)).getSeconds(), 45);
  assert.equal(parseClock('soon', base), null);
  assert.equal(parseClock('25:00', base), null);
  assert.ok(parseClock('1:00 AM', new Date(2026, 9, 27, 22, 0).getTime()) > new Date(2026, 9, 27, 22, 0).getTime(), 'overnight rolls to tomorrow');
});

test('cue-driven looks: idle, standby, ack, GO, missed, warning; legacy firmware', async () => {
  const cues = [
    { id: 'a' }, { id: 'b' },
    { id: 'c', _notify: N('LX 1', 'LX', 1, { warn: 1 }) },
    { id: 'd' },
  ];
  const r = await rig(cues);
  try {
    const lx = await r.light('111111111111'), old = await r.light('222222222222', '1.0.1');
    assert.ok(lx.msgs.some(m => m.t === 'local' && m.lost && m.nowifi), 'local looks sent on connect');
    assert.ok(!old.msgs.some(m => m.t === 'local'), 'old firmware gets no local looks');
    assert.ok(is(lx.last, 'dot'), 'unassigned light idles');
    r.cl.configureLight('111111111111', { position: 'LX' });
    r.cl.configureLight('222222222222', { position: 'LX' });
    await wait(30);
    assert.ok(is(lx.last, 'pulse', AMBER), 'idx 0: warning (1 cue before the standby window)');
    assert.equal(r.ctx.pub.crewWarn.u_lx, true, 'operator sees the warning too');
    assert.equal(old.last.s, 'off', 'legacy light: warning shows as off');

    await r.move(1);
    assert.ok(is(lx.last, 'flash', RED), 'standby flashes red');
    assert.deepEqual([old.last.s, old.last.flash], ['standby', true], 'legacy light gets the old standby');
    lx.ws.send(JSON.stringify({ t: 'ack' })); await wait(40);
    assert.ok(is(lx.last, 'solid', RED), 'acked: steady red');
    assert.equal(r.ctx.pub.crew.u_lx, 'ok', 'button acks the operator at LX');

    await r.move(2);
    assert.ok(is(lx.last, 'solid', GREEN), 'GO green');
    assert.equal(old.last.s, 'go');
    await wait(200);
    assert.ok(is(lx.last, 'dot'), 'back to idle after GO');
    assert.ok(is(old.last, undefined) || old.last.s === 'off');

    await r.move(1); await r.move(2);                 // standby not acked this time
    await wait(200);
    assert.ok(is(lx.last, 'dblink', RED), 'missed ack shows after GO');
    assert.equal(lx.last.b, Math.round(30 * 2.55), 'missed is dim (30%)');
    await wait(350);
    assert.ok(is(lx.last, 'dot'), 'missed clears');

    await r.move(null);
    assert.ok(is(lx.last, 'dot', WHITE), 'no caller: plain idle');
  } finally { r.done(); }
});

test('commands: hold, call (+ack back), places, stop, manual countdown', async () => {
  const r = await rig([{ id: 'a' }, { id: 'b' }]);
  try {
    const lx = await r.light('111111111111'), vid = await r.light('333333333333'), all = await r.light('444444444444');
    r.cl.configureLight('111111111111', { position: 'LX' });
    r.cl.configureLight('333333333333', { position: 'Video' });
    r.cl.configureLight('444444444444', { position: 'all' });
    await wait(30);

    r.cl.setHold('lx', true); await wait(30);
    assert.ok(is(lx.last, 'solid', AMBER), 'hold: amber at LX (case-insensitive)');
    assert.ok(is(vid.last, 'dot'), 'other positions unaffected');
    assert.ok(is(all.last, 'dot'), '"all" lights do not take position holds');
    assert.deepEqual(r.ctx.pub.cond.holds, ['lx']);

    r.cl.call('LX', { id: 'u_v', name: 'Ana' }); await wait(30);
    assert.ok(is(lx.last, 'spin', WHITE), 'call outranks hold');
    assert.equal(r.ctx.pub.cond.calls.lx.fromName, 'Ana');
    lx.ws.send(JSON.stringify({ t: 'ack' })); await wait(40);
    assert.ok(is(lx.last, 'solid', AMBER), 'call answered: back to hold');
    assert.deepEqual(r.ctx.events.at(-1), { type: 'callAcked', to: 'u_v', position: 'LX', by: 'LX' });
    r.cl.setHold('LX', false); await wait(30);
    assert.ok(is(lx.last, 'dot'));

    r.cl.call('Video', { id: 'u_lx', name: 'Sam' });
    assert.equal(r.cl.callFrom('video'), 'u_lx');
    assert.equal(r.cl.ackCall('Video', 'Ana'), true);
    assert.equal(r.ctx.events.at(-1).by, 'Ana', 'screen ack names who answered');

    r.cl.setPlaces(true); await wait(30);
    assert.ok([lx, vid, all].every(L => is(L.last, 'pulse', BLUE)), 'places reaches every light');
    r.cl.setStop(true); await wait(30);
    assert.ok([lx, vid, all].every(L => is(L.last, 'strobe', RED)), 'stop overrides everything');
    r.cl.setStop(false); await wait(30);
    assert.ok(is(lx.last, 'pulse', BLUE), 'places is still on until released');
    r.cl.setPlaces(false); await wait(30);
    assert.ok(is(lx.last, 'dot'));

    assert.equal(r.cl.startCountdown('LX', 1), true); await wait(30);
    assert.ok(is(lx.last, 'countdown', [255, 80, 0]), 'manual countdown');
    assert.ok(lx.last.cd.t === 1000 && lx.last.cd.l > 800 && lx.last.cd.l <= 1000, 'countdown carries time left and total');
    assert.ok(r.ctx.pub.cond.countdowns.lx && r.ctx.pub.crewCd.u_lx, 'operator countdown');
    await wait(1100);
    assert.ok(is(lx.last, 'dot'), 'countdown ends on its own');
    assert.ok(!r.ctx.pub.cond.countdowns.lx);
  } finally { r.done(); }
});

test('cue countdowns: seconds from standby, and to the Time column', async () => {
  const soon = Date.now() + 20000;
  const cues = [
    { id: 'a' },
    { id: 'b', _notify: N('Video roll', 'Video', 1, { cd: { mode: 'seconds', seconds: 1 } }) },
    { id: 'c', time: hhmmss(soon), _notify: N('Pyro', 'LX', 1, { cd: { mode: 'time', seconds: 60 } }) },
  ];
  const r = await rig(cues);
  try {
    r.ctx.view = { ...r.ctx.view, idx: -1 };
    const lx = await r.light('111111111111'), vid = await r.light('333333333333');
    r.cl.configureLight('111111111111', { position: 'LX' });
    r.cl.configureLight('333333333333', { position: 'Video' });
    await wait(30);
    assert.ok(is(lx.last, 'countdown'), 'time column: within 60 s of the cue time');
    assert.ok(lx.last.cd.t === 60000 && lx.last.cd.l > 15000 && lx.last.cd.l <= 20000);
    await r.move(0);
    assert.ok(is(vid.last, 'countdown'), 'seconds: starts with the standby');
    await wait(1100);
    assert.ok(is(vid.last, 'flash', RED), 'after the countdown it is a normal standby');
  } finally { r.done(); }
});

test('looks: defaults, per-position overrides, stealth, preview, validation', async () => {
  const cues = [{ id: 'a' }, { id: 'b', _notify: N('All', 'all', 1) }];
  const r = await rig(cues);
  try {
    const lx = await r.light('111111111111'), vid = await r.light('333333333333');
    r.cl.configureLight('111111111111', { position: 'LX' });
    r.cl.configureLight('333333333333', { position: 'Video' });
    await wait(30);
    assert.ok(is(lx.last, 'flash', RED) && is(vid.last, 'flash', RED));

    assert.equal(r.cl.setLook('standby', { color: '#0000ff', pattern: 'pulse', rate: 2000, level: 50 }), true);
    await wait(30);
    assert.ok(is(vid.last, "pulse", [0, 0, 255]) && vid.last.r === 2000 && vid.last.b === Math.round(50 * 2.55), "global look applies " + JSON.stringify(vid.last));
    assert.equal(r.cl.setOverride('lx', 'standby', { color: '#00ff00', pattern: 'spin', rate: 500, level: 100 }), true);
    await wait(30);
    assert.ok(is(lx.last, 'spin', GREEN), 'LX override');
    assert.ok(is(vid.last, 'pulse', [0, 0, 255]), 'Video keeps the default');
    assert.deepEqual(Object.keys(r.ctx.saved.overrides), ['lx'], 'overrides persist');

    r.cl.setStealth(true); await wait(30);
    assert.equal(lx.last.b, Math.round(15 * 2.55), 'stealth caps the level');
    assert.ok(lx.msgs.filter(m => m.t === 'local').length >= 2, 'local looks re-sent under stealth');
    r.cl.setStealth(false); await wait(30);

    r.cl.preview('stop', 'Video'); await wait(30);
    assert.ok(is(vid.last, 'strobe', RED), 'preview on one position');
    assert.ok(is(lx.last, 'spin', GREEN), 'others untouched');
    await wait(200);
    assert.ok(is(vid.last, 'pulse', [0, 0, 255]), 'preview ends');

    assert.equal(r.cl.setLook('standby', { color: 'red', pattern: 'pulse', rate: 1000, level: 50 }), false, 'bad colour refused');
    assert.equal(r.cl.setLook('standby', { color: '#ff0000', pattern: 'spin', rate: 10, level: 50 }), false, 'bad speed refused');
    assert.equal(r.cl.setLook('lost', { color: '#ff0000', pattern: 'spin', rate: 1000, level: 50 }), false, 'local looks: simple patterns only');
    assert.equal(r.cl.setLook('nope', { color: '#ff0000', pattern: 'solid', rate: 1000, level: 50 }), false);
    r.cl.setLook('standby', null); r.cl.setOverride('LX', 'standby', null); await wait(30);
    assert.ok(is(lx.last, 'flash', RED), 'reset to built-in');
    assert.equal(r.ctx.pub.overrides.lx, undefined);
  } finally { r.done(); }
});
