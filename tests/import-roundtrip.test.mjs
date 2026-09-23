import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import XLSX from 'xlsx';
import {WebSocket} from 'ws';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const root=new URL('../',import.meta.url);
const html=fs.readFileSync(new URL('public/index.html',root),'utf8');
function buildMerge(table,columns){
  const ctx=vm.createContext({curEvent:()=>({columns})});
  vm.runInContext(html.slice(html.indexOf('const slugc='),html.indexOf('function attachImageToCue('))+html.slice(html.indexOf('function buildMerge('),html.indexOf("$('#btnUpload').onclick="))+'\nglobalThis.merge=buildMerge;',ctx);
  return JSON.parse(JSON.stringify(ctx.merge(table,columns)));
}
async function start(dir){
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,['server.js','--no-open',`--port=${port}`,'--host=127.0.0.1'],{cwd:root,env:{...process.env,ROS_CODE:'',ROS_DATA:path.join(dir,'data.json'),ROS_IMAGES:path.join(dir,'images')},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<750&&!output.includes('Keep this window open')&&child.exitCode===null;i++)await delay(20);
  if(!output.includes('Keep this window open')){child.kill();throw Error(output);}
  const ws=new WebSocket(`ws://127.0.0.1:${port}`);const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
  async function send(msg,type='state'){messages.length=0;ws.send(JSON.stringify(msg));for(let i=0;i<150;i++){const error=messages.find(m=>m.t==='error');if(error&&type!=='error')throw Error(error.message);const m=messages.find(m=>m.t===type);if(m)return m;await delay(10);}throw Error(`No ${type} for ${msg.t}: ${JSON.stringify(messages)}`);}
  const initial=await send({t:'join',id:'roundtrip'});
  return {initial,send,upload:async(bytes,name)=>{const data=new FormData();data.append('file',new Blob([bytes]),name);data.append('startRow','1');const response=await fetch(`http://127.0.0.1:${port}/upload`,{method:'POST',body:data});const result=await response.json();assert.equal(result.ok,true,result.error);return result.tables;},close:async()=>{ws.close();await delay(50);const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}};
}
function workbook(){const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet([['Start Time','End Time','TRT','Unformatted'],[6.5/24,7.5/24,25/24,0.2708333333333333]]);ws.A2.z='h:mm:ss AM/PM';ws.B2.z='h:mm:ss AM/PM';ws.C2.z='[h]:mm:ss';XLSX.utils.book_append_sheet(wb,ws,'Show');return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});}

test('HTTP upload -> production client mapping -> WS merge -> disk/restart preserves clock and duration text',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-roundtrip-'));let app;
 try{
  app=await start(dir);let state=await app.send({t:'event:create',name:'Roundtrip'});const ev=state.events.find(e=>e.name==='Roundtrip');const target={eventId:ev.id,dayId:ev.days[0].id,showId:ev.days[0].shows[0].id};
  const fixtures=[{bytes:workbook(),name:'times.xlsx',expected:['6:30:00 AM','7:30:00 AM','25:00:00']},{bytes:Buffer.from('Start Time,End Time,TRT,Unformatted\n6:30:00 AM,7:30:00 AM,25:00:00,0.2708333333333333\n'),name:'times.csv',expected:['6:30:00 AM','7:30:00 AM','25:00:00']}];
  if(process.env.LXFLOW_IMPORT_WORKBOOK)fixtures.push({bytes:fs.readFileSync(process.env.LXFLOW_IMPORT_WORKBOOK),name:'supplied.xlsx',row:1,expected:['6:30:00 AM','7:30:00 AM','1:00:00']});
  const expected=[];
  for(const fixture of fixtures){const [table]=await app.upload(fixture.bytes,fixture.name);const row=fixture.row||0;assert.deepEqual(['start_time','end_time','trt'].map(k=>table.rows[row][k]),fixture.expected);if(!fixture.row){assert.equal(typeof table.rows[0].unformatted,'string');assert.ok(Number(table.rows[0].unformatted)>0.27&&Number(table.rows[0].unformatted)<0.28);}
   table._map=Object.fromEntries(table.columns.map(c=>[c.key,'__skip__']));const columns=state.events.find(e=>e.id===ev.id).columns;Object.assign(table._map,{start_time:'time',end_time:columns.some(c=>c.key==='end_time')?'end_time':'__new__',trt:columns.some(c=>c.key==='trt')?'trt':'__new__'});const merged=buildMerge(table,columns);assert.deepEqual([merged.rows[row].time,merged.rows[row].end_time,merged.rows[row].trt],fixture.expected);assert.equal(merged.rows[0].unformatted,undefined);
   state=await app.send({t:'merge',...target,...merged});expected.push(...merged.rows);
  }
  const getRows=events=>events.find(e=>e.id===ev.id).days[0].shows[0].cues;
  assert.deepEqual(getRows(state.events),expected);
  await delay(100); // server batches disk writes for 40 ms
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'data.json'),'utf8'));assert.deepEqual(getRows(persisted.events.map(e=>e.ev)),expected);
  await app.close();app=await start(dir);assert.deepEqual(getRows(app.initial.events),expected);
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('multi-table merge is atomic, acknowledged by request ID, and undone as one shared edit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lxflow-batch-'));let app;
 try{
  app=await start(dir);const created=await app.send({t:'event:create',name:'Batches'});const ev=created.events.find(e=>e.name==='Batches');const target={eventId:ev.id,dayId:ev.days[0].id,showId:ev.days[0].shows[0].id};
  const valid={columns:[{key:'trt',label:'TRT'}],rows:[{id:'first',trt:'25:00:00'}]};
  const invalid={columns:[],rows:[{id:'second',unknown:'must reject'}]};
  const rejected=await app.send({t:'merge',...target,batches:[valid,invalid],requestId:'reject-this'},'error');assert.equal(rejected.requestId,'reject-this');assert.match(rejected.message,/unknown column/);
  // A rejected batch must not have added either its first row or first column.
  const ack=await app.send({t:'merge',...target,batches:[valid,{columns:[],rows:[{id:'second',trt:'00:01:00'}]}],requestId:'accept-this'},'merge:result');assert.equal(ack.requestId,'accept-this');assert.equal(ack.ok,true);
  const undone=await app.send({t:'history:undo'});const reverted=undone.events.find(e=>e.id===ev.id);assert.equal(reverted.days[0].shows[0].cues.length,0);assert.equal(reverted.columns.some(c=>c.key==='trt'),false);
  const redone=await app.send({t:'history:redo'});assert.deepEqual(redone.events.find(e=>e.id===ev.id).days[0].shows[0].cues.map(c=>c.trt),['25:00:00','00:01:00']);
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
