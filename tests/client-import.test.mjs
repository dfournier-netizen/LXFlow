import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const ctx=vm.createContext({curEvent:()=>({columns:[]})});
vm.runInContext(html.slice(html.indexOf('const slugc='),html.indexOf('function attachImageToCue('))+html.slice(html.indexOf('function buildMerge('),html.indexOf('function sendImport('))+'\nglobalThis.api={autoMap,importValue,buildMerge};',ctx);
const {autoMap,importValue,buildMerge}=ctx.api;
const plain=value=>JSON.parse(JSON.stringify(value));
const table=(keys,map,values={})=>({columns:keys.map(key=>({key,label:key})),rows:[values],_map:map});
test('duplicate destination mappings are rejected rather than overwriting values',()=>{
 assert.throws(()=>buildMerge(table(['a','b'],{a:'time',b:'time'},{a:'06:30',b:'07:30'}),[{key:'time',label:'Time'}]),/same column/);
});
test('duplicate labels map one existing column and preserve the second as new',()=>{
 const t={columns:[{key:'notes',label:'Notes'},{key:'notes_2',label:'Notes'}],rows:[{notes:'Audio',notes_2:'LX'}]};
 assert.deepEqual(plain(autoMap(t,[{key:'notes',label:'Notes'}])),{notes:'notes',notes_2:'__new__'});
 const merged=buildMerge(t,[{key:'notes',label:'Notes'}]);assert.equal(merged.rows[0].notes,'Audio');assert.equal(merged.rows[0].notes_2,'LX');
});
test('new columns allocate collision-free keys and reserve internal metadata names',()=>{
 const keys=['notes','id','_images','__proto__','constructor'];const map=Object.fromEntries(keys.map(k=>[k,'__new__']));
 const t=table(keys,map,Object.fromEntries(keys.map(k=>[k,'source '+k])));delete t.rows[0]._images;
 const result=buildMerge(t,[{key:'notes'},{key:'notes_2'}]);
 assert.deepEqual(plain(result.columns.map(c=>c.key)),['notes_3','id_2','_images_2','__proto___2','constructor_2']);assert.match(result.rows[0].id,/^cue_/);assert.equal(result.rows[0].id_2,'source id');
 assert.throws(()=>buildMerge(table(['a'],{a:'id'}),[{key:'id'}]),/valid destination/);
});
test('explicit decimal-day conversions round clocks and retain durations over 24h',()=>{
 assert.equal(importValue('0.2708333333333333','clock'),'06:30:00');
 assert.equal(importValue(String(25/24),'duration'),'25:00:00');
 assert.equal(importValue(String((86400-0.4)/86400),'clock'),'00:00:00');
 assert.equal(importValue(String(1.6/86400),'duration'),'00:00:02');
 for(const value of ['6:30:00 AM','25:00:00','PRE - SHOW',''])assert.equal(importValue(value,'clock'),value);
 assert.equal(importValue('0.2708333333333333'),'0.2708333333333333');
 assert.throws(()=>importValue('-0.5','duration'),/non-negative/);assert.throws(()=>importValue('1e100','clock'),/within range/);
});
test('skip-all and missing destination mappings are rejected',()=>{
 assert.throws(()=>buildMerge(table(['a'],{a:'__skip__'}),[]),/at least one/);
 assert.throws(()=>buildMerge(table(['a'],{a:'missing'}),[]),/valid destination/);
});
