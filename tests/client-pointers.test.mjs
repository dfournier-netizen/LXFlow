import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const section=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
function client(saved=0,bindings={}){
  const elements={ '#signin':{classList:{contains:()=>true}}, '#modalRoot':{children:[]}, '#followHint':{}, '#goBtn':{focus(){}} };
  let keydown;
  const sent=[];
  const context=vm.createContext({store:{load:(k,d)=>k==='pointer'?saved:k==='keybinds'?bindings:d,save(){}},window:{matchMedia:()=>({matches:false}),addEventListener:(type,fn)=>{keydown=fn;}},document:{querySelectorAll:()=>[]},$:id=>elements[id],send:m=>sent.push(m),renderMyPtr(){},renderBody(){},renderSelectors(){},renderHead(){},afterPointer(){},renderAll(){},checkNotifications(){},scrollToActive(){},deleteCue(){},addCue(){},firedNotes:new Set()});
  vm.runInContext(section('let keybinds =','let hiddenCols')+section('let state =','applyTheme();')+section('function curEvent()','/* ====================== render')+section('function applyFollow()','/* ====================== actions')+section('function advance(','function addCue()')+section('function codeMatch(','/* ====================== modals'),context);
  vm.runInContext("state.events=[{id:'e',days:[{id:'d',shows:[{id:'s',cues:[{id:'a'},{id:'b'},{id:'c'}]}]}]}];ensureSel();reconcilePointer();renderMyPtr=()=>{};renderBody=()=>{};afterPointer=()=>{};",context);
  return {run:code=>vm.runInContext(code,context),sent,elements,key:(extra={})=>{const e={code:'Space',key:' ',target:{tagName:'BODY'},preventDefault(){this.prevented=true;},...extra};keydown(e);return e;}};
}
test('legacy index migrates to ID and survives insert/reorder/remove before current cue',()=>{
 const c=client(1); assert.equal(c.run('pointerCueId'),'b');
 c.run("curShow().cues.unshift({id:'new'});reconcilePointer()"); assert.equal(c.run('pointerIdx'),2);
 c.run('curShow().cues.reverse();reconcilePointer()'); assert.equal(c.run('pointerCueId'),'b'); assert.equal(c.run('pointerIdx'),1);
 c.run('curShow().cues.shift();reconcilePointer()');assert.equal(c.run('pointerCueId'),'b');assert.equal(c.run('pointerIdx'),0);
});
test('deleting active cue clears pointer; GO explicitly starts; empty show stays empty',()=>{
 const c=client(1);c.run('curShow().cues.splice(1,1);reconcilePointer()');assert.equal(c.run('pointerIdx'),-1);assert.equal(c.run('currentPointer().cueId'),null);
 c.key();assert.equal(c.run('pointerCueId'),'a');c.run('curShow().cues=[];advance()');assert.equal(c.run('pointerIdx'),-1);
});
test('saved ID restores selection; stale ID never silently chooses another cue',()=>{
 const c=client({eventId:'e',dayId:'d',showId:'s',cueId:'b',cueIdx:0});assert.equal(c.run('pointerIdx'),1);
 const stale=client({eventId:'e',dayId:'d',showId:'s',cueId:'missing',cueIdx:0});assert.equal(stale.run('pointerIdx'),-1);
});
test('follow resolves ID after reorder, clears deleted target, and blocks local GO',()=>{
 const c=client();c.run("followId='operator';presence=[{id:'operator',name:'Op',pointer:{eventId:'e',dayId:'d',showId:'s',cueId:'c',cueIdx:0}}];applyFollow()");assert.equal(c.run('pointerCueId'),'c');
 c.run('curShow().cues.reverse();applyFollow()');assert.equal(c.run('pointerIdx'),0);c.key();assert.equal(c.run('pointerCueId'),'c');
 c.run('curShow().cues.shift();applyFollow()');assert.equal(c.run('activeIdx()'),-1);
});
test('Space advances once with partial saved bindings and prevents button default',()=>{
 const c=client(0,{up:'KeyK'});const e=c.key({target:{tagName:'BUTTON'}});assert.equal(c.run('pointerCueId'),'b');assert.equal(e.prevented,true);
 c.key({repeat:true});assert.equal(c.run('pointerCueId'),'b');
});
test('typing spaces and open modals never advance; Escape exits editing',()=>{
 const c=client();let blurred=false;c.key({target:{tagName:'TD',isContentEditable:true}});assert.equal(c.run('pointerCueId'),'a');
 c.key({code:'Escape',key:'Escape',target:{isContentEditable:true,blur(){blurred=true;}}});assert.equal(blurred,true);
 c.elements['#modalRoot'].children=[{}];c.key();assert.equal(c.run('pointerCueId'),'a');
 c.elements['#modalRoot'].children=[];c.key();assert.equal(c.run('pointerCueId'),'b');
});
test('modified keys do not fire GO and undo uses shared protocol',()=>{
 const c=client();c.key({ctrlKey:true});assert.equal(c.run('pointerCueId'),'a');c.key({code:'KeyZ',ctrlKey:true,key:'z'});assert.equal(c.sent.at(-1).t,'history:undo');
});

test('switching shows chooses its first cue and never carries another show ID',()=>{
 const c=client(1);c.run("curDay().shows.push({id:'s2',cues:[{id:'x'}]});cycleShow(1)");assert.equal(c.run('pointerCueId'),'x');assert.equal(c.run('currentPointer().showId'),'s2');
});
test('legacy remote index is supported, but explicit deleted ID wins over stale index',()=>{
 const c=client();assert.equal(c.run("pointerIndex({showId:'s',cueIdx:2})"),2);assert.equal(c.run("pointerIndex({showId:'s',cueId:null,cueIdx:2})"),-1);
});
