import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function renderCueAck(){');
const code = html.slice(start, html.indexOf('\n}', start) + 2);
test('screen ACK shows only while my own standby is unacknowledged', () => {
  let hidden = true;
  const ack = { classList: { toggle: (_c, v) => { hidden = v; } } };
  const app = { classList: { contains: () => false } };
  const ctx = vm.createContext({ me: { id: 'u1', position: 'LX' }, cueLights: {}, $: s => s === '#cueAck' ? ack : app });
  vm.runInContext(code, ctx);
  const show = crew => { ctx.cueLights = { crew, lights: [] }; vm.runInContext('renderCueAck()', ctx); return !hidden; };
  assert.equal(show({ u1: 'pending' }), true);
  assert.equal(show({ u1: 'ok' }), false, 'acked or no standby');
  assert.equal(show({ u1: 'missed' }), false, 'missed: nothing left to ack');
  assert.equal(show({ u2: 'pending' }), false, 'someone else');
  assert.equal(show(undefined), false, 'no cue light state yet');
});
test('sidebar ack dot reflects crew state and defaults to green', () => {
  const s = html.indexOf('function renderPresence(){');
  const body = html.slice(s, html.indexOf('\n}', s) + 2);
  assert.match(body, /cueLights\.crew&&cueLights\.crew\[u\.id\]\)\|\|'ok'/);
  assert.match(html, /\.ackdot\.pending\{/);
  assert.match(html, /\.ackdot\.missed\{/);
});
