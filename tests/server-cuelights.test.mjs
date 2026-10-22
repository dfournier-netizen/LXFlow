// End to end: real server.js, a host browser client and a simulated ESP32 light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what) => { for (let i = 0; i < 150; i++) { const v = fn(); if (v) return v; await delay(20); } throw new Error('Timed out: ' + what); };

test('host sets caller/style/position; caller pointer drives the light; screen ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxflow-cuelights-'));
  const reserve = net.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, ['server.js', '--no-open', `--port=${port}`, '--host=127.0.0.1'], { env: { ...process.env, ROS_CODE: 'abc', ROS_DATA: path.join(dir, 'data.json'), ROS_IMAGES: path.join(dir, 'images'), ROS_CONFIG: path.join(dir, 'config.json'), ROS_DISCOVERY_PORT: String(20000 + (port % 20000)) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b);
  const sockets = [];
  try {
    await until(() => out.includes('Keep this window open') || child.exitCode !== null, 'server start');
    assert.equal(child.exitCode, null, out);

    const open = (p = '') => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`); const msgs = []; ws.on('message', m => msgs.push(JSON.parse(String(m)))); ws.once('open', () => res({ ws, msgs, send: o => ws.send(JSON.stringify(o)) })); ws.once('error', rej); sockets.push(ws); });

    const host = await open();
    host.send({ t: 'join', id: 'usr_host', name: 'Caller', position: 'SM', code: 'abc' });
    const st = await until(() => host.msgs.find(m => m.t === 'state'), 'state');
    let cl = await until(() => host.msgs.findLast(m => m.t === 'cuelights'), 'cuelights');
    assert.equal(cl.host, true, 'loopback client is the host');

    // a show with a notify on cue b targeted at LX
    const ev = st.events[0];
    ev.days[0].shows[0].cues = [{ id: 'a', action: 'A' }, { id: 'b', action: 'B', _notify: { text: 'LX go', target: 'LX', lead: 1 } }, { id: 'c', action: 'C' }];
    host.send({ t: 'event:update', event: ev });
    const ptr = cueId => ({ eventId: ev.id, dayId: ev.days[0].id, showId: ev.days[0].shows[0].id, cueId });

    // light: wrong code refused, right code registers
    const bad = await open('/cuelight');
    const badClose = new Promise(r => bad.ws.once('close', c => r(c)));
    bad.send({ t: 'hello', id: 'AAAAAAAAAAAA', fw: '1.0.0', code: 'nope' });
    assert.equal(await badClose, 4001);
    const light = await open('/cuelight');
    light.send({ t: 'hello', id: '0123456789AB', fw: '1.0.0', code: 'abc' });
    cl = await until(() => host.msgs.findLast(m => m.t === 'cuelights' && m.lights.some(l => l.id === '0123456789AB' && l.online)), 'light online');
    assert.equal(light.msgs.at(-1).s, 'off');
    assert.ok(!host.msgs.some(m => m.t === 'state' && m.lights), 'lights are not mixed into show state');

    // operator on LX
    const op = await open();
    op.send({ t: 'join', id: 'usr_lx', name: 'Op', position: 'LX', code: 'abc' });
    await until(() => op.msgs.find(m => m.t === 'cuelights'), 'op cuelights');

    host.send({ t: 'cuelight:set', op: 'light', id: '0123456789AB', name: 'LX desk', position: 'LX' });
    host.send({ t: 'cuelight:set', op: 'caller', userId: 'usr_host' });
    host.send({ t: 'pointer', pointer: ptr('a') });
    await until(() => light.msgs.at(-1)?.s === 'standby' && light.msgs.at(-1).flash === true, 'flashing standby');

    // the operator's screen sees it and acks
    await until(() => op.msgs.findLast(m => m.t === 'cuelights')?.lights.some(l => l.state === 'standby-flash' && l.position === 'LX'), 'op sees flashing');
    op.send({ t: 'cuelight:ack' });
    await until(() => light.msgs.at(-1)?.s === 'standby' && light.msgs.at(-1).flash === false, 'acked steady');

    // an operator moving their own pointer does nothing; the caller's GO does
    op.send({ t: 'pointer', pointer: ptr('c') });
    await delay(100);
    assert.equal(light.msgs.at(-1).s, 'standby');
    host.send({ t: 'pointer', pointer: ptr('b') });
    await until(() => light.msgs.at(-1)?.s === 'go', 'GO');
    assert.ok(light.msgs.at(-1).ms > 2900 && light.msgs.at(-1).ms <= 3000);

    // steady style persists to config
    host.send({ t: 'cuelight:set', op: 'style', style: 'steady' });
    await until(() => host.msgs.findLast(m => m.t === 'cuelights')?.style === 'steady', 'style');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.cueLights.style, 'steady');
    assert.equal(cfg.cueLights.caller, 'usr_host');
    assert.equal(cfg.cueLights.lights['0123456789AB'].position, 'LX');

    // light drops -> offline, assignment kept
    light.ws.close();
    await until(() => host.msgs.findLast(m => m.t === 'cuelights')?.lights.find(l => l.id === '0123456789AB')?.state === 'offline', 'offline');
  } finally {
    for (const ws of sockets) try { ws.terminate(); } catch {}
    child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
  }
});
