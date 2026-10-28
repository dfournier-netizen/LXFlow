// The light's own settings page, served at http://<light IP>/ (firmware 1.2; contact inputs 1.3).
#pragma once
const char PAGE_HTML[] = R"HTML(<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LXFlow Cue Light</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--panel2:#1c232d;--line:#2a323d;--text:#e6edf3;--dim:#8b97a7;--accent:#4f8cff;--ok:#3fb950;--bad:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:980px;margin:0 auto;display:grid;gap:16px}main>*{min-width:0}
h1{font-size:22px;margin:0}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.row>label{display:grid;gap:4px;font-size:12px;color:var(--dim);flex:1 1 140px;min-width:0}
input,select,button{font:inherit;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:7px 9px;min-width:0}
input[type=color]{padding:2px;width:44px;height:34px}input[type=checkbox]{width:18px;height:18px}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.meta{color:var(--dim);font-size:13px}.meta b{color:var(--text);font-weight:600}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:860px}
th,td{padding:5px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:middle}th{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;border-top:0}
td input:not([type=checkbox]):not([type=color]),td select{width:100%}
.log td{font-family:ui-monospace,Consolas,monospace;font-size:12px}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--panel2);padding:1px 5px;border-radius:5px}
.cheat{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 16px;font-size:13px}
#msg{min-height:1.4em}.ok{color:var(--ok)}.bad{color:var(--bad)}
.state{font-weight:600}.state.on{color:var(--ok)}
.bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0;display:flex;gap:10px;align-items:center}
</style></head><body><main>
<header><h1 id="title">LXFlow Cue Light</h1><div class="meta" id="meta">Loading…</div></header>

<section><h2>Mode and OSC</h2>
<div class="row">
<label>Mode<select id="mode"><option value="both">LXFlow and OSC (OSC wins while active)</option><option value="lxflow">LXFlow only</option><option value="osc">OSC only (no LXFlow)</option></select></label>
<label>OSC name (used in /cuelight/&lt;name&gt;/…)<input id="oscName" maxlength="23" placeholder="e.g. LX"></label>
<label>OSC listen port (UDP)<input id="oscPort" type="number" min="1" max="65535"></label>
</div>
<p class="meta">Send OSC to <b id="sendTo">this light's IP</b>, or broadcast to the network so one message reaches every light. Changing the mode or port restarts the light.</p>
</section>

<section><h2>Button sends OSC</h2>
<div class="row">
<label>To IP address<input id="ackIp" placeholder="e.g. 192.168.1.20 (blank = off)"></label>
<label>Port<input id="ackPort" type="number" min="1" max="65535"></label>
<label>OSC address ({name} = this light)<input id="ackAddr" placeholder="/cuelight/{name}/ack"></label>
<label>Argument (optional)<input id="ackArg" placeholder="e.g. 1, or Go+ Sequence 5"></label>
<button id="ackTest" type="button">Send test</button>
</div>
<p class="meta">Examples: Companion <code>/location/1/0/1/press</code>, grandMA3 <code>/cmd</code> with argument <code>Go+ Sequence 5</code>, QLab <code>/cue/5/go</code>. A whole number is sent as an int, a decimal as a float, anything else as text.</p>
</section>

<section><h2>Contact inputs</h2>
<p class="meta">Two dry-contact inputs on 3.5 mm jacks (tip and sleeve): input 1 is GPIO 32, input 2 is GPIO 33. When one fires it shows its look for the set seconds (0 = until cleared) and sends its OSC message, if it has one, to the IP and port under <b>Button sends OSC</b>. OSC is not sent in LXFlow-only mode. Dry contacts only: never connect a voltage.</p>
<div class="tbl"><table id="inputs"><thead><tr><th>Input</th><th>Fires when</th><th>Colour</th><th>Pattern</th><th>Speed</th><th>Level %</th><th>Seconds</th><th>Button clears</th><th></th></tr></thead></table></div>
</section>

<section><h2>Custom triggers</h2>
<p class="meta">Checked top to bottom before the built-in addresses; the first match wins. <code>*</code> matches anything, <code>?</code> one character. Leave Argument blank to match any value. Duration 0 = stays until another trigger, <code>/off</code>, or the button (if ticked).</p>
<div class="tbl"><table><thead><tr><th>OSC address</th><th>Argument</th><th>Colour</th><th>Pattern</th><th>Speed</th><th>Level %</th><th>Seconds</th><th>Button clears</th><th></th><th></th></tr></thead><tbody id="trigs"></tbody></table></div>
<div class="row" style="margin-top:8px"><button id="addTrig" type="button">Add trigger</button><button id="clearNow" type="button">Clear the OSC look now</button></div>
</section>

<section><h2>Recent OSC received</h2>
<div class="tbl log"><table><thead><tr><th>When</th><th>Address</th><th>Argument</th><th>From</th><th>Did</th><th></th></tr></thead><tbody id="log"><tr><td colspan="6" class="meta">Nothing yet. Send something from your console or Companion.</td></tr></tbody></table></div>
</section>

<section><h2>Built-in addresses</h2>
<p class="meta">&lt;name&gt; is this light's OSC name, its 4-character ID, or <code>all</code>. Looks match LXFlow's when the light has been connected to LXFlow.</p>
<div class="cheat">
<div><code>/cuelight/&lt;name&gt;/standby</code> flashes until the button acks it</div>
<div><code>/cuelight/&lt;name&gt;/go [seconds]</code> GO, 3 s by default</div>
<div><code>/cuelight/&lt;name&gt;/hold</code>, <code>/places</code>, <code>/stop</code>, <code>/warning</code>; argument 0 turns one off</div>
<div><code>/cuelight/&lt;name&gt;/call</code> spins until the button answers it</div>
<div><code>/cuelight/&lt;name&gt;/countdown 30</code> drains the ring over 30 s</div>
<div><code>/cuelight/&lt;name&gt;/look r g b pattern speed level seconds</code></div>
<div><code>/cuelight/&lt;name&gt;/off</code> clears the OSC look</div>
<div><code>/cuelight/&lt;name&gt;/ident</code> spins white</div>
</div></section>

<div class="bar"><button class="primary" id="save" type="button">Save settings</button><span id="msg" role="status"></span></div>
</main>
<script>
const $=s=>document.querySelector(s);
const PATS=['solid','flash','pulse','dblink','spin','strobe','countdown','dot','off','clear'];
const PAT_LABEL={solid:'Solid',flash:'Flash',pulse:'Pulse',dblink:'Double blink',spin:'Spin',strobe:'Strobe',countdown:'Countdown',dot:'One LED',off:'Off',clear:'Clear (end OSC look)'};
const SPEEDS=[[3000,'Very slow'],[2000,'Slow'],[1000,'Medium'],[500,'Fast'],[250,'Very fast']];
let state=null, dirty=false;
function el(t,a={},...k){const e=document.createElement(t);for(const[x,v]of Object.entries(a)){if(x.startsWith('on'))e.addEventListener(x.slice(2),v);else if(x==='value')e.value=v;else if(x==='checked')e.checked=v;else e.setAttribute(x,v);}k.forEach(c=>e.append(c));return e;}
function msg(t,ok){const m=$('#msg');m.textContent=t;m.className=ok===false?'bad':ok?'ok':'';}
function markDirty(){dirty=true;msg('Unsaved changes');}
function trigRow(t){
  t=Object.assign({a:'',v:'',c:'#ff0000',p:'solid',r:1000,l:100,d:0,k:false},t);
  const pat=el('select',{},...PATS.map(p=>el('option',{value:p},PAT_LABEL[p])));pat.value=t.p;
  const sp=el('select',{},...SPEEDS.map(([ms,l])=>el('option',{value:String(ms)},l)));
  pat.dataset.k='p';sp.dataset.k='r';
  if(!SPEEDS.some(([ms])=>ms===t.r))sp.append(el('option',{value:String(t.r)},t.r+' ms'));sp.value=String(t.r);
  const tr=el('tr',{},
    el('td',{},el('input',{value:t.a,placeholder:'/ma3/exec/201','data-k':'a'})),
    el('td',{},el('input',{value:t.v,placeholder:'any','data-k':'v',style:'width:80px'})),
    el('td',{},el('input',{type:'color',value:t.c,'data-k':'c'})),
    el('td',{},pat),
    el('td',{},sp),
    el('td',{},el('input',{type:'number',min:'1',max:'100',value:String(t.l),'data-k':'l',style:'width:70px'})),
    el('td',{},el('input',{type:'number',min:'0',max:'3600',value:String(t.d),'data-k':'d',style:'width:70px'})),
    el('td',{},el('input',{type:'checkbox',checked:!!t.k,'data-k':'k'})),
    el('td',{},el('button',{type:'button',onclick:()=>test(tr)},'Test')),
    el('td',{},el('button',{type:'button','aria-label':'Delete trigger',onclick:()=>{tr.remove();markDirty();}},'✕')));
  tr.addEventListener('input',markDirty);tr.addEventListener('change',markDirty);
  return tr;
}
function gpiRow(t,i){
  t=Object.assign({w:'off',c:'#ffffff',p:'solid',r:1000,l:100,d:5,k:false,a:'',v:''},t);
  const when=el('select',{'data-k':'w'},el('option',{value:'off'},'Off'),el('option',{value:'close'},'Contact closes'),el('option',{value:'open'},'Contact opens'));when.value=t.w;
  const pat=el('select',{'data-k':'p'},...PATS.map(p=>el('option',{value:p},PAT_LABEL[p])));pat.value=t.p;
  const sp=el('select',{'data-k':'r'},...SPEEDS.map(([ms,l])=>el('option',{value:String(ms)},l)));
  if(!SPEEDS.some(([ms])=>ms===t.r))sp.append(el('option',{value:String(t.r)},t.r+' ms'));sp.value=String(t.r);
  const tb=el('tbody',{},el('tr',{},
    el('td',{style:'white-space:nowrap'},String(i+1)+' ',el('span',{id:'gs'+i,class:'state'+(t.closed?' on':'')},t.closed?'Closed':'Open')),
    el('td',{},when),
    el('td',{},el('input',{type:'color',value:t.c,'data-k':'c'})),
    el('td',{},pat),
    el('td',{},sp),
    el('td',{},el('input',{type:'number',min:'1',max:'100',value:String(t.l),'data-k':'l',style:'width:70px'})),
    el('td',{},el('input',{type:'number',min:'0',max:'3600',value:String(t.d),'data-k':'d',style:'width:70px'})),
    el('td',{},el('input',{type:'checkbox',checked:!!t.k,'data-k':'k'})),
    el('td',{},el('button',{type:'button',onclick:()=>testInput(tb,i)},'Test'))),
    el('tr',{},el('td',{style:'border-top:0'}),el('td',{colspan:'8',style:'border-top:0'},el('div',{class:'row'},
      el('label',{},'Sends OSC address ({name} = this light)',el('input',{value:t.a,placeholder:'blank = none','data-k':'a'})),
      el('label',{},'Argument',el('input',{value:t.v,placeholder:'optional','data-k':'v'}))))));
  tb.addEventListener('input',markDirty);tb.addEventListener('change',markDirty);
  return tb;
}
async function testInput(tr,i){const r=await post('/api/test',{what:'input',n:i,input:rowData(tr)});msg(r.osc?'Showing that look and sent the OSC message.':rowData(tr).a?'Showing that look. The OSC message was not sent: check the IP and port under Button sends OSC (and Save), and that the mode is not LXFlow only.':'Showing that look on the light.',true);}
function rowData(tr){const o={};tr.querySelectorAll('[data-k]').forEach(i=>{const k=i.dataset.k;o[k]=i.type==='checkbox'?i.checked:(['r','l','d'].includes(k)?+i.value:i.value.trim());});return o;}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
async function test(tr){const t=rowData(tr);if(!t.a){msg('Give the trigger an OSC address first.',false);return;}await post('/api/test',{what:'trigger',trigger:t});msg('Showing that look on the light.',true);}
function fill(s){
  $('#mode').value=s.mode;$('#oscName').value=s.oscName;$('#oscPort').value=s.oscPort;
  $('#ackIp').value=s.ackIp;$('#ackPort').value=s.ackPort;$('#ackAddr').value=s.ackAddr;$('#ackArg').value=s.ackArg;
  const tb=$('#trigs');tb.innerHTML='';(s.triggers||[]).forEach(t=>tb.append(trigRow(t)));
  const ib=$('#inputs');[...ib.tBodies].forEach(x=>x.remove());(s.inputs||[]).forEach((t,i)=>ib.append(gpiRow(t,i)));
}
function status(s){
  $('#title').textContent='Cue light '+s.short+(s.oscName?' · '+s.oscName:'');
  $('#meta').innerHTML='';
  $('#meta').append('Firmware '+s.fw+' · IP ',el('b',{},s.ip),' · '+s.host.toLowerCase()+'.local · Wi-Fi '+s.rssi+' dBm · LXFlow: '+(s.mode==='osc'?'off (OSC only)':s.linked?'connected '+s.lxflow:'not connected')+' · showing: '+s.showing+(s.mode!=='lxflow'&&!s.oscUp?' · OSC port did not open':''));
  $('#sendTo').textContent=s.ip+' port '+s.oscPort;
  (s.inputs||[]).forEach((g,i)=>{const e=$('#gs'+i);if(e){e.textContent=g.closed?'Closed':'Open';e.className='state'+(g.closed?' on':'');}});
  const lg=$('#log');lg.innerHTML='';
  if(!s.log.length)lg.append(el('tr',{},el('td',{colspan:'6',class:'meta'},s.mode==='lxflow'?'OSC is off in LXFlow-only mode.':'Nothing yet. Send something from your console or Companion.')));
  s.log.forEach(r=>lg.append(el('tr',{},el('td',{},r.ago+' s ago'),el('td',{},r.a),el('td',{},r.v),el('td',{},r.from),el('td',{},r.did),
    el('td',{},el('button',{type:'button',onclick:()=>{$('#trigs').append(trigRow({a:r.a,v:r.v}));markDirty();msg('Added. Pick a look, then Save.');}},'Make trigger')))));
}
async function load(first){
  try{const s=await (await fetch('/api/state')).json();state=s;status(s);if(first||!dirty)fill(s);}
  catch(e){$('#meta').textContent='Lost contact with the light. Retrying…';}
}
$('#addTrig').onclick=()=>{$('#trigs').append(trigRow({}));markDirty();};
$('#clearNow').onclick=async()=>{await post('/api/test',{what:'clear'});msg('Cleared.',true);};
$('#ackTest').onclick=async()=>{const r=await post('/api/test',{what:'ack'});msg(r.ok?'Sent. (Save to keep these settings.)':r.error,r.ok);};
document.querySelectorAll('section input,section select').forEach(i=>{i.addEventListener('input',markDirty);i.addEventListener('change',markDirty);});
$('#save').onclick=async()=>{
  const body={mode:$('#mode').value,oscName:$('#oscName').value.trim(),oscPort:+$('#oscPort').value||8000,
    ackIp:$('#ackIp').value.trim(),ackPort:+$('#ackPort').value||8000,ackAddr:$('#ackAddr').value.trim(),ackArg:$('#ackArg').value.trim(),
    triggers:[...$('#trigs').children].map(rowData).filter(t=>t.a),
    inputs:[...$('#inputs').tBodies].map(rowData)};
  try{const r=await post('/api/config',body);
    if(!r.ok){msg(r.error||'Could not save.',false);return;}
    dirty=false;
    msg(r.restart?'Saved. The light is restarting; this page reconnects in a few seconds.':'Saved.',true);
    setTimeout(()=>load(true),r.restart?6000:300);}
  catch(e){msg('Could not save: '+e.message,false);}
};
load(true);setInterval(()=>load(false),1500);
</script></body></html>)HTML";
