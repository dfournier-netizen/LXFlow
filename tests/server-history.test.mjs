import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {WebSocket} from 'ws';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function start(dir) {
  const reserve = net.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, ['server.js', '--no-open', `--port=${port}`, '--host=127.0.0.1'], {env:{...process.env, ROS_CODE:'', ROS_DATA:path.join(dir,'data.json'), ROS_IMAGES:path.join(dir,'images')}, stdio:['ignore','pipe','pipe']});
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let i = 0; i < 100 && !output.includes('Keep this window open') && child.exitCode === null; i++) await delay(30);
  if (child.exitCode !== null) throw new Error(output);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await new Promise((r,j) => {ws.once('open',r);ws.once('error',j);});
  async function send(message, type='state') {
    messages.length = 0; ws.send(JSON.stringify(message));
    for (let i = 0; i < 100; i++) { const found = messages.find(m=>m.t===type); if(found) return found; await delay(10); }
    throw new Error(`Timed out ${message.t}: ${output}`);
  }
  await send({t:'join',id:'tester'},'joined');
  return {send, messages, close:async()=>{ws.close(); await delay(100); child.kill(); await new Promise(r=>child.once('exit',r));}};
}
test('shared persistent undo/redo, pointer identity, wipe images and backup recovery', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-history-'));
  let app;
  try {
    app=await start(dir);
    let state=await app.send({t:'event:create',name:'Test'});
    let ev=state.events.find(e=>e.name==='Test');
    ev.days[0].shows[0].cues=[{id:'a',action:'A'},{id:'b',action:'B'}];
    state=await app.send({t:'event:update',event:ev});
    const selection={eventId:ev.id,dayId:ev.days[0].id,showId:ev.days[0].shows[0].id};
    const invalid=structuredClone(ev); invalid.days[0].shows=[null];
    const rejected=await app.send({t:'event:update',event:invalid},'error');
    assert.equal(rejected.message,'Invalid event');
    await app.send({t:'lock',showId:selection.showId,cueId:'a',colKey:'action'},'locks');
    assert.match((await app.send({t:'history:undo'},'error')).message,/Finish active cell edits/);
    await app.send({t:'unlock',showId:selection.showId,cueId:'a',colKey:'action'},'locks');

    let presence=await app.send({t:'pointer',pointer:{...selection,cueId:'b',cueIdx:1}},'presence');
    assert.equal(presence.users[0].pointer.cueId,'b');
    ev.days[0].shows[0].cues.reverse();
    await app.send({t:'event:update',event:ev});
    assert.equal(app.messages.find(m=>m.t==='presence').users[0].pointer.cueIdx,0);
    ev.days[0].shows[0].cues=ev.days[0].shows[0].cues.filter(c=>c.id!=='b');
    await app.send({t:'event:update',event:ev});
    assert.equal(app.messages.find(m=>m.t==='presence').users[0].pointer.cueIdx,-1);
    state=await app.send({t:'history:undo'});
    assert.deepEqual(state.events.find(e=>e.id===ev.id).days[0].shows[0].cues.map(c=>c.id),['b','a']);
    state=await app.send({t:'history:redo'});
    assert.equal(state.events.find(e=>e.id===ev.id).days[0].shows[0].cues.length,1);
    await app.send({t:'event:delete',id:ev.id});
    state=await app.send({t:'history:undo'});
    assert.ok(state.events.some(e=>e.id===ev.id));
    fs.mkdirSync(path.join(dir,'images')); fs.writeFileSync(path.join(dir,'images','example.png'),'retained');
    await app.send({t:'data:wipe'});
    assert.equal(fs.readFileSync(path.join(dir,'images','example.png'),'utf8'),'retained');
    await app.close(); app=await start(dir);
    state=await app.send({t:'history:undo'});
    assert.ok(state.events.some(e=>e.id===ev.id));
    assert.equal(state.history.canRedo,true);
    await app.send({t:'event:create',name:'Branch'});
    assert.equal(app.messages.find(m=>m.t==='state').history.canRedo,false);
    await app.close(); app=null;
    const file=path.join(dir,'data.json'); assert.ok(fs.existsSync(file+'.bak'));
    fs.writeFileSync(file,'{broken');
    app=await start(dir);
    await app.send({t:'event:create',name:'Recovered'});
    assert.ok(fs.readdirSync(dir).some(f=>f.startsWith('data.json.corrupt-')));
  } finally {if(app) await app.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
