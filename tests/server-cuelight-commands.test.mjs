// Who may do what: anyone can CALL; caller or host run HOLD/PLACES/STOP/countdown; host edits looks.
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
const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);

test('permissions and call acknowledgement round trip', { skip: !lan && 'no non-loopback IPv4 address to test a remote screen' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxflow-clcmd-'));
  const reserve = net.createServer();
  await new Promise(r => reserve.listen(0, '0.0.0.0', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, ['server.js', '--no-open', `--port=${port}`], { env: { ...process.env, ROS_CODE: '', ROS_DATA: path.join(dir, 'data.json'), ROS_IMAGES: path.join(dir, 'images'), ROS_CONFIG: path.join(dir, 'config.json'), ROS_DISCOVERY_PORT: String(21000 + (port % 20000)) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b);
  const sockets = [];
  try {
    await until(() => out.includes('Keep this window open') || child.exitCode !== null, 'server start');
    const open = host => new Promise((res, rej) => { const ws = new WebSocket(`ws://${host}:${port}`); const msgs = []; ws.on('message', m => msgs.push(JSON.parse(String(m)))); ws.once('open', () => res({ ws, msgs, send: o => ws.send(JSON.stringify(o)), last: t => msgs.findLast(m => m.t === t) })); ws.once('error', rej); sockets.push(ws); });
    const host = await open('127.0.0.1');
    host.send({ t: 'join', id: 'u_sm', name: 'Dom', position: 'SM' });
    const op = await open(lan.address);
    op.send({ t: 'join', id: 'u_lx', name: 'Sam', position: 'LX' });
    await until(() => op.last('cuelights'), 'op state');
    assert.equal(op.last('cuelights').host, false, 'LAN screen is not the host');
    assert.equal(host.last('cuelights').host, true);

    op.send({ t: 'cuelight:cmd', op: 'stop', on: true });
    assert.match((await until(() => op.last('error'), 'stop refused')).message, /caller or the host/);
    op.send({ t: 'cuelight:set', op: 'look', cond: 'go', look: { color: '#123456', pattern: 'solid', rate: 1000, level: 50 } });
    await until(() => op.msgs.filter(m => m.t === 'error').length >= 2, 'look refused');

    op.send({ t: 'cuelight:call', position: 'SM' });
    await until(() => host.last('cuelights')?.cond?.calls?.sm?.fromName === 'Sam', 'host sees the call');
    host.send({ t: 'cuelight:ackCall' });
    const acked = await until(() => op.last('cuelight:callAcked'), 'caller of the CALL is told');
    assert.deepEqual([acked.position, acked.by], ['SM', 'Dom']);
    await until(() => !Object.keys(host.last('cuelights').cond.calls).length, 'call cleared');

    host.send({ t: 'cuelight:set', op: 'caller', userId: 'u_lx' });
    await until(() => op.last('cuelights')?.caller === 'u_lx', 'op is caller');
    op.send({ t: 'cuelight:cmd', op: 'places', on: true });
    await until(() => host.last('cuelights')?.cond?.places === true, 'caller can call places');
    op.send({ t: 'cuelight:cmd', op: 'hold', position: 'SM', on: true });
    await until(() => host.last('cuelights')?.cond?.holds?.includes('SM'), 'caller can hold');
    op.send({ t: 'cuelight:cmd', op: 'countdown', position: 'SM', seconds: 30 });
    await until(() => host.last('cuelights')?.crewCd?.u_sm?.total === 30000, 'host screen gets the countdown');
    host.send({ t: 'cuelight:set', op: 'look', cond: 'go', look: { color: '#123456', pattern: 'solid', rate: 1000, level: 50 } });
    await until(() => host.last('cuelights')?.looks?.go?.color === '#123456', 'host edits looks');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.cueLights.places, true, 'places persists');
    assert.deepEqual(cfg.cueLights.holds, ['SM']);
  } finally {
    for (const ws of sockets) try { ws.terminate(); } catch {}
    child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
  }
});
