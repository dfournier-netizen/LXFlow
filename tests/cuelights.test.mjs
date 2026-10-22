// Cue light controller (cuelights.js) driven by simulated ESP32 lights.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import { WebSocketServer, WebSocket } from 'ws';
import { createCueLights } from '../cuelights.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const N = (text, target, lead) => ({ text, target, lead });

test('standby, ack (button and screen), GO, styles, targeting, identify, forget, discovery', async () => {
  const cues = [
    { id: 'c0' }, { id: 'c1' },
    { id: 'c2', _notify: N('LX 1', 'LX', 2) },
    { id: 'c3', _notify: N('Roll VT', 'Video', 1) },
    { id: 'c4', _notify: N('Everyone', 'all', 1) },
    { id: 'c5', _notify: { target: 'LX', lead: 1 } },          // no text: pop-ups ignore it, so do lights
    { id: 'c6', _notify: N('GO only', 'LX', 0) },
  ];
  let view = { cues, idx: 0 }, saved = null, pub = null;
  const cl = createCueLights({
    goMs: 300, identMs: 200, discoveryPort: 0,
    getView: () => view, loadState: () => ({}), saveState: s => { saved = s; },
    roomCode: () => 'abc', port: () => 7390, bindHost: () => '',
    onChange: s => { pub = s; },
  });
  const srv = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => cl.attach(ws, req)));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const light = (id, code = 'abc') => new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/cuelight`);
    const L = { ws, msgs: [], closed: null, get last() { return this.msgs.at(-1); } };
    ws.on('message', m => L.msgs.push(JSON.parse(String(m))));
    ws.on('close', c => { L.closed = c; });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', id, fw: '1.0.0', code })); setTimeout(() => res(L), 60); });
  });
  const move = async idx => { view = idx == null ? null : { cues, idx }; cl.refresh(); await wait(30); };
  try {
    const bad = await light('AAAAAAAAAAAA', 'nope'); await wait(30);
    assert.equal(bad.closed, 4001, 'wrong room code refused');

    const lx = await light('111111111111'), vid = await light('222222222222'), all = await light('333333333333'), none = await light('444444444444');
    await wait(20);
    assert.equal(pub.lights.filter(l => l.online).length, 4);
    assert.equal(lx.last.s, 'off', 'unassigned light starts dark');

    cl.configureLight('111111111111', { position: 'LX', name: 'LX desk' });
    cl.configureLight('222222222222', { position: 'Video Op' });   // target "Video" matches by contains, like the pop-ups
    cl.configureLight('333333333333', { position: 'all' });
    await wait(20);
    assert.equal(saved.lights['111111111111'].name, 'LX desk');
    assert.deepEqual([lx.last.s, lx.last.flash], ['standby', true], 'idx 0 is inside lead 2 of cue 2');
    assert.equal(vid.last.s, 'off');
    assert.deepEqual([all.last.s, all.last.flash], ['standby', true]);
    assert.equal(none.last.s, 'off');

    lx.ws.send(JSON.stringify({ t: 'ack' })); await wait(30);
    assert.deepEqual([lx.last.s, lx.last.flash], ['standby', false], 'button ack -> steady');
    assert.equal(all.last.flash, true, 'ack is per light');
    assert.equal(cl.ackPosition('ALL'), 1, 'screen ack matches position');
    await wait(20);
    assert.equal(all.last.flash, false);

    await move(1);
    assert.equal(lx.last.flash, false, 'ack holds while the same standby stays live');
    await move(2);
    assert.equal(lx.last.s, 'go'); assert.ok(lx.last.ms > 0);
    assert.deepEqual([vid.last.s, vid.last.flash], ['standby', true], 'next cue standby during GO');
    assert.equal(all.last.s, 'go');
    await wait(380);
    assert.equal(lx.last.s, 'off', 'GO clears after its time');
    assert.equal(all.last.s, 'standby', '"all" light falls through to its next standby');

    await move(3);
    assert.equal(vid.last.s, 'go');
    assert.equal(lx.last.s, 'standby', 'target "all" reaches every assigned light');
    assert.equal(none.last.s, 'off');
    await wait(350);

    await move(4);                                             // cue 5 has no text, cue 6 has lead 0
    assert.equal(lx.last.s, 'go', 'GO on the all-cue');
    await wait(350);
    assert.equal(lx.last.s, 'off', 'no standby for a text-less notify');
    await move(5);
    assert.equal(lx.last.s, 'off', 'lead 0 never stands by');
    await move(6);
    assert.equal(lx.last.s, 'go', 'lead 0 still GOes');
    await wait(350);

    // GO only on a real move: picking the caller / reconnecting does not fire it
    await move(null);
    assert.equal(lx.last.s, 'off', 'no caller -> dark');
    await move(2);
    assert.equal(lx.last.s, 'off', 'caller appearing on a GO cue does not fire GO');
    await move(-1);
    assert.equal(lx.last.s, 'off', 'caller with no active cue: cue 2 is outside lead 2 of cue 0');

    await move(0);
    cl.setStyle('steady'); await wait(20);
    assert.deepEqual([lx.last.s, lx.last.flash], ['standby', false], 'steady style');
    assert.equal(cl.ackLight('111111111111'), false, 'nothing to ack when steady');
    cl.setStyle('flash'); await wait(20);
    assert.equal(lx.last.flash, true);

    lx.ws.send(JSON.stringify({ t: 'ack' })); await wait(20);
    await move(5); await move(0);
    assert.equal(lx.last.flash, true, 'leaving and re-entering a standby flashes again');

    cl.identify('111111111111'); await wait(20);
    assert.equal(lx.last.t, 'ident');
    cl.setCaller('usr_1'); assert.equal(saved.caller, 'usr_1');

    cl.forget('444444444444'); await wait(20);
    assert.ok(saved.lights['444444444444'], 'online light is not forgotten');
    none.ws.close(); await wait(40);
    assert.equal(pub.lights.find(l => l.id === '444444444444').state, 'offline');
    cl.forget('444444444444'); await wait(20);
    assert.ok(!saved.lights['444444444444'], 'offline light forgotten');
    assert.ok(!pub.lights.some(l => l.id === '444444444444'));

    // discovery answers on an ephemeral port
    cl.stop();
    const cl2 = createCueLights({ getView: () => null, port: () => 7390, bindHost: () => '', discoveryPort: 17491 });
    cl2.startDiscovery(); await wait(50);
    const u = dgram.createSocket('udp4');
    const reply = await new Promise(res => {
      u.on('message', m => res(String(m)));
      u.bind(0, () => u.send('LXFLOW_DISCOVER', 17491, '127.0.0.1'));
      setTimeout(() => res(null), 800);
    });
    u.close(); cl2.stop();
    assert.equal(reply, 'LXFLOW 7390');
    for (const L of [lx, vid, all]) L.ws.terminate();
  } finally {
    cl.stop(); srv.close();
  }
});
