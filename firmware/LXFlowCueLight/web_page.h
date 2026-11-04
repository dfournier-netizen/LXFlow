// The light's own settings page, served at http://<light IP>/ (firmware 1.2; Art-Net 1.4).
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
.bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0;display:flex;gap:10px;align-items:center}
</style></head><body><main>
<header><h1 id="title">LXFlow Cue Light</h1><div class="meta" id="meta">Loading…</div></header>

<section><h2>Mode, pixels and OSC</h2>
<div class="row">
<label>Mode<select id="mode"><option value="both">LXFlow and OSC (OSC wins while active)</option><option value="lxflow">LXFlow only</option><option value="osc">OSC only (no LXFlow)</option><option value="artnet">Art-Net pixel control only</option></select></label>
<label>OSC name (used in /cuelight/&lt;name&gt;/…)<input id="oscName" maxlength="23" placeholder="e.g. LX"></label>
<label>OSC listen port (UDP)<input id="oscPort" type="number" min="1" max="65535"></label>
</div>
<div class="row" style="margin-top:10px">
<label>Pixels (LEDs on the ring or tape)<input id="leds" type="number" min="1" max="170"></label>
<label>Colour order<select id="order"><option value="grb">GRB (standard WS2812)</option><option value="rgb">RGB</option><option value="rbg">RBG</option><option value="gbr">GBR</option><option value="brg">BRG</option><option value="bgr">BGR</option></select></label>
<label>Check<button id="rgbTest" type="button">Show red, green, blue</button></label>
</div>
<div class="row" style="margin-top:10px">
<label style="flex-direction:row;display:flex;align-items:center;gap:8px;color:var(--text)"><input id="gamma" type="checkbox">Gamma curve (even-looking fades)</label>
<label style="flex-direction:row;display:flex;align-items:center;gap:8px;color:var(--text)"><input id="dither" type="checkbox">Dithering (finer low-level steps; may flicker on camera)</label>
</div>
<p class="meta">Send OSC to <b id="sendTo">this light's IP</b>, or broadcast to the network so one message reaches every light. Every mode uses all the pixels, gamma and dithering. If the colour check shows the wrong colours, change Colour order. Changing the mode, port, pixels or colour order restarts the light.</p>
</section>

<section><h2>Art-Net pixel control</h2>
<div class="row">
<label>Art-Net universe (0–32767)<input id="artUni" type="number" min="0" max="32767"></label>
<label>Start address (1–512)<input id="artAddr" type="number" min="1" max="512"></label>
<label>Hold last frame (seconds)<input id="artHold" type="number" min="1" max="60"></label>
</div>
<p class="meta" id="artMap">Used in Art-Net mode only.</p>
<p class="meta">Status: <b id="artLive">—</b></p>
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
function rowData(tr){const o={};tr.querySelectorAll('[data-k]').forEach(i=>{const k=i.dataset.k;o[k]=i.type==='checkbox'?i.checked:(['r','l','d'].includes(k)?+i.value:i.value.trim());});return o;}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
async function test(tr){const t=rowData(tr);if(!t.a){msg('Give the trigger an OSC address first.',false);return;}await post('/api/test',{what:'trigger',trigger:t});msg('Showing that look on the light.',true);}
function fill(s){
  $('#mode').value=s.mode;$('#leds').value=s.leds;$('#leds').max=s.maxLeds||170;$('#order').value=s.order||'grb';$('#gamma').checked=s.gamma!==false;$('#dither').checked=!!s.dither;$('#oscName').value=s.oscName;$('#oscPort').value=s.oscPort;
  if(s.art){$('#artUni').value=s.art.uni;$('#artAddr').value=s.art.addr;$('#artHold').value=s.art.hold;artMapText();}
  $('#ackIp').value=s.ackIp;$('#ackPort').value=s.ackPort;$('#ackAddr').value=s.ackAddr;$('#ackArg').value=s.ackArg;
  const tb=$('#trigs');tb.innerHTML='';(s.triggers||[]).forEach(t=>tb.append(trigRow(t)));
}
function status(s){
  $('#title').textContent='Cue light '+s.short+(s.oscName?' · '+s.oscName:'');
  $('#meta').innerHTML='';
  $('#meta').append('Firmware '+s.fw+' · IP ',el('b',{},s.ip),' · '+s.host.toLowerCase()+'.local · Wi-Fi '+s.rssi+' dBm · LXFlow: '+(s.mode==='osc'?'off (OSC only)':s.linked?'connected '+s.lxflow:'not connected')+' · showing: '+s.showing+(s.mode!=='lxflow'&&!s.oscUp?' · OSC port did not open':''));
  $('#sendTo').textContent=s.ip+' port '+s.oscPort;
  if(s.art){const a=s.art;
    $('#artLive').textContent=s.mode!=='artnet'?'off (mode is not Art-Net)':!a.up?'Art-Net port did not open':a.live==='idle'?(a.pkts?'no data for '+a.ago+' s; idle':'waiting for ArtDmx on universe '+a.uni):(a.live==='holding'?'holding last frame':'receiving')+' from '+a.from+' · '+a.pkts+' packets'+(a.polls?' · '+a.polls+' polls answered':'');
    artMapText();}
  const lg=$('#log');lg.innerHTML='';
  if(!s.log.length)lg.append(el('tr',{},el('td',{colspan:'6',class:'meta'},s.mode==='lxflow'?'OSC is off in LXFlow-only mode.':'Nothing yet. Send something from your console or Companion.')));
  s.log.forEach(r=>lg.append(el('tr',{},el('td',{},r.ago+' s ago'),el('td',{},r.a),el('td',{},r.v),el('td',{},r.from),el('td',{},r.did),
    el('td',{},el('button',{type:'button',onclick:()=>{$('#trigs').append(trigRow({a:r.a,v:r.v}));markDirty();msg('Added. Pick a look, then Save.');}},'Make trigger')))));
}
function artMapText(){const n=+$('#leds').value||(state&&state.art&&state.art.leds)||12,u=+$('#artUni').value||0,s=+$('#artAddr').value||1,e=s+n*3-1;
  $('#artMap').textContent='Used in Art-Net mode only. Net '+(u>>8)+' · Sub-Net '+((u>>4)&15)+' · Universe '+(u&15)+'. '+n+' pixels × R, G, B = channels '+s+'–'+e+(e>512?' (past 512: those LEDs stay dark)':'')+'. Send unicast to '+(state?state.ip:'this light')+', or broadcast on this Wi-Fi network. Levels go through gamma, dithering (if on) and the light\'s brightness setting.';}
async function load(first){
  try{const s=await (await fetch('/api/state')).json();state=s;status(s);if(first||!dirty)fill(s);}
  catch(e){$('#meta').textContent='Lost contact with the light. Retrying…';}
}
$('#addTrig').onclick=()=>{$('#trigs').append(trigRow({}));markDirty();};
$('#rgbTest').onclick=async()=>{await post('/api/test',{what:'rgb'});msg('Showing red, green, blue for 5 s with the saved colour order.',true);};
$('#clearNow').onclick=async()=>{await post('/api/test',{what:'clear'});msg('Cleared.',true);};
$('#ackTest').onclick=async()=>{const r=await post('/api/test',{what:'ack'});msg(r.ok?'Sent. (Save to keep these settings.)':r.error,r.ok);};
document.querySelectorAll('section input,section select').forEach(i=>{i.addEventListener('input',markDirty);i.addEventListener('change',markDirty);});
$('#save').onclick=async()=>{
  const body={mode:$('#mode').value,leds:Math.min(+$('#leds').value||12,+$('#leds').max||170),order:$('#order').value,gamma:$('#gamma').checked,dither:$('#dither').checked,oscName:$('#oscName').value.trim(),oscPort:+$('#oscPort').value||8000,
    artUni:+$('#artUni').value||0,artAddr:+$('#artAddr').value||1,artHold:+$('#artHold').value||3,
    ackIp:$('#ackIp').value.trim(),ackPort:+$('#ackPort').value||8000,ackAddr:$('#ackAddr').value.trim(),ackArg:$('#ackArg').value.trim(),
    triggers:[...$('#trigs').children].map(rowData).filter(t=>t.a)};
  try{const r=await post('/api/config',body);
    if(!r.ok){msg(r.error||'Could not save.',false);return;}
    dirty=false;
    msg(r.restart?'Saved. The light is restarting; this page reconnects in a few seconds.':'Saved.',true);
    setTimeout(()=>load(true),r.restart?6000:300);}
  catch(e){msg('Could not save: '+e.message,false);}
};
['#artUni','#artAddr','#leds'].forEach(k=>$(k).addEventListener('input',artMapText));
load(true);setInterval(()=>load(false),1500);
</script></body></html>)HTML";
