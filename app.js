(()=>{
'use strict';
const WS='wss://ws-live-data.polymarket.com';
const EVENTS='https://gamma-api.polymarket.com/events';
const CLOB='https://clob.polymarket.com';
const SERIES='btc-up-or-down-5m';
const STORE='btc_edge_ledger_v4';
const OLD_STORE='btc_edge_ledger_v3';
const SETTINGS='btc_edge_settings_v4';
const MODEL_STORE='btc_edge_model_v4';
const $=id=>document.getElementById(id);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const fmtUSD=x=>Number.isFinite(x)?'$'+x.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const fmtPct=x=>Number.isFinite(x)?(x*100).toFixed(3)+'%':'—';
const time=x=>new Date(x).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30)));
let ws=null,retryTimer=null,market=null,cycleStart=null,cycleEnd=null,locked=false;
let ticks=[],lastPrice=null,ledger=loadLedger(),notifyOn=false,lastFeatures=null,lastEngine=null,verifyJobs=new Set();
let model=loadModel();

function parseArray(x){if(Array.isArray(x))return x;if(typeof x==='string'){try{return JSON.parse(x)}catch{}}return []}
function loadLedger(){try{let x=JSON.parse(localStorage.getItem(STORE)||'null');if(Array.isArray(x))return x;let old=JSON.parse(localStorage.getItem(OLD_STORE)||'[]');return Array.isArray(old)?old:[]}catch{return[]}}
function saveLedger(){localStorage.setItem(STORE,JSON.stringify(ledger.slice(0,5000)));renderLedger()}
function loadModel(){try{let x=JSON.parse(localStorage.getItem(MODEL_STORE)||'null');if(x&&Array.isArray(x.w)&&Number.isFinite(x.b))return x}catch{}return {w:new Array(12).fill(0),b:0,seen:0,updatedAt:null}}
function saveModel(){localStorage.setItem(MODEL_STORE,JSON.stringify(model))}
function setConn(ok,text){$('led').className='led '+(ok?'ok':'bad');$('conn').textContent=text}
function setBadge(id,text,cls='good'){$(id).textContent=text;$(id).className='badge '+cls}

function findUpDown(m){const outcomes=parseArray(m?.outcomes),ids=parseArray(m?.clobTokenIds);let up=-1,down=-1;outcomes.forEach((o,i)=>{let s=String(o).toLowerCase();if(s.includes('up'))up=i;if(s.includes('down'))down=i});return{up:up>=0?ids[up]:null,down:down>=0?ids[down]:null}}
async function getActive(){
 try{
  const u=EVENTS+'?series_slug='+encodeURIComponent(SERIES)+'&closed=false&limit=100&order=endDate&ascending=true';
  const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw Error();const arr=await r.json(),now=Date.now();
  const ev=arr.find(e=>{const s=Date.parse(e.eventStartTime||e.startDate||'');const end=Date.parse(e.endDate||e.endDateIso||'');return s<=now&&now<end});
  if(!ev)return;
  const m=(ev.markets||[]).find(x=>!x.closed)||ev.markets?.[0]||null;
  const s=Date.parse(ev.eventStartTime||m?.startDateIso||ev.startDate),end=Date.parse(ev.endDate||m?.endDateIso||'');
  if(!Number.isFinite(s)||!Number.isFinite(end))return;
  const changed=cycleStart!==s;market={event:ev,market:m};cycleStart=s;cycleEnd=end;
  $('slug').textContent=ev.slug||m?.slug||'active market';setBadge('clockState','POLYMARKET SYNC','good');updateConsensus();
  if(changed)resetCycle();
 }catch(e){setBadge('clockState','RETRYING','warn')}
}
function resetCycle(){
 locked=false;ticks=[];lastPrice=null;lastFeatures=null;lastEngine=null;
 $('call').textContent='ANALYZING';$('call').className='call wait';$('conf').textContent='—';$('quality').textContent='BUILDING';
 $('callHint').textContent='AI engine is observing the first 90 seconds. One decision will be frozen at +90s.';
 $('signal').className='signal';$('engineText').textContent='Initializing adaptive model…';drawChart();
}
function connect(){
 try{ws?.close()}catch{};ws=new WebSocket(WS);
 ws.onopen=()=>{retryTimer=null;setConn(true,'CHAINLINK LIVE');ws.send(JSON.stringify({action:'subscribe',subscriptions:[{topic:'crypto_prices_chainlink',type:'*',filters:'{"symbol":"btc/usd"}'}]}))};
 ws.onmessage=e=>{try{const d=JSON.parse(e.data),p=extract(d);if(!Number.isFinite(p))return;onTick(p,extractTs(d)||Date.now(),Date.now())}catch{}};
 ws.onerror=()=>setConn(false,'FEED ERROR');
 ws.onclose=()=>{setConn(false,'RECONNECTING');clearTimeout(retryTimer);retryTimer=setTimeout(connect,3000)};
}
function extract(d){const p=d?.payload||{},list=[p,p?.data?.[0],d?.data?.[0],d];for(const x of list){const n=Number(x?.value??x?.price);if(Number.isFinite(n)&&n>1000)return n}return NaN}
function extractTs(d){const p=d?.payload||{},n=Number(p?.timestamp??d?.timestamp??p?.data?.[0]?.timestamp);return Number.isFinite(n)&&n>1e12?n:Number.isFinite(n)&&n>1e9?n*1000:null}
function onTick(price,sourceTs,receivedTs){
 if(!cycleStart)return;const t=Math.max(sourceTs,cycleStart);if(t<cycleStart-5000||t>cycleEnd+5000)return;if(ticks.length&&t<=ticks[ticks.length-1].t)return;
 lastPrice=price;ticks.push({t,p:price,received:receivedTs});if(ticks.length>1600)ticks=ticks.slice(-1300);renderLive();
}
function nearest(sec){const target=cycleStart+sec*1000;let best=null,dist=Infinity;for(const x of ticks){const d=Math.abs(x.t-target);if(d<dist){dist=d;best=x}}return best&&dist<=6000?best.p:null}
function rangeReturn(sec){const now=lastPrice;if(!now)return 0;const old=nearest(sec);return old?(now-old)/old:0}
function stdev(a){if(a.length<2)return 0;const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1))}
function slopeNorm(){const a=ticks.slice(-100);if(a.length<5)return 0;const x=a.map(q=>(q.t-a[0].t)/1000),y=a.map(q=>Math.log(q.p));const xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length,den=x.reduce((s,v)=>s+(v-xm)**2,0),num=x.reduce((s,v,i)=>s+(v-xm)*(y[i]-ym),0);return den?num/den:0}
function features(){
 const p0=ticks[0]?.p||lastPrice,now=lastPrice||p0,rets=[5,10,15,30,45,60,75].map(rangeReturn),logR=[];
 for(let i=1;i<ticks.length;i++)logR.push(Math.log(ticks[i].p/ticks[i-1].p));
 const vol=stdev(logR.slice(-Math.min(180,logR.length))),recent=ticks.slice(-80).map(x=>x.p),mean=recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:now;
 const dispersion=mean?(now-mean)/mean:0,sl=slopeNorm(),accel=rangeReturn(15)-rangeReturn(60)/4;
 const signs=ticks.slice(-70).map((x,i,a)=>i?Math.sign(x.p-a[i-1].p):0).filter(Boolean),consistency=signs.length?Math.abs(signs.reduce((a,b)=>a+b,0)/signs.length):0;
 const path=ticks.slice(1).reduce((s,x,i)=>s+Math.abs(x.p-ticks[i].p),0)||1,efficiency=Math.abs(now-p0)/path;
 const reversals=signs.length>3?signs.slice(1).reduce((s,x,i)=>s+(x!==signs[i]?1:0),0)/(signs.length-1):0;
 const volRecent=stdev(logR.slice(-45)),volLong=stdev(logR.slice(-180)),volRatio=volLong?volRecent/volLong:1;
 const c=marketConsensus();
 return {p0,now,rets,vol,dispersion,sl,accel,consistency,efficiency,reversals,volRatio,consensus:c};
}
function marketConsensus(){
 const m=market?.market;if(!m)return null;const outs=parseArray(m.outcomes),prices=parseArray(m.outcomePrices).map(Number);let up=-1,down=-1;outs.forEach((o,i)=>{const s=String(o).toLowerCase();if(s.includes('up'))up=i;if(s.includes('down'))down=i});
 if(up<0||down<0)return null;const u=prices[up],d=prices[down];if(!Number.isFinite(u)||!Number.isFinite(d))return null;return clamp(u/(u+d||1),.01,.99)
}
async function updateConsensus(){const c=marketConsensus();if(c!=null){$('consensus').textContent=(c*100).toFixed(1)+'% UP';return}const ids=findUpDown(market?.market);if(!ids.up)return;try{const r=await fetch(CLOB+'/midpoint?token_id='+encodeURIComponent(ids.up),{cache:'no-store'});if(!r.ok)return;const j=await r.json(),x=Number(j.mid||j.price);if(Number.isFinite(x))$('consensus').textContent=(x*100).toFixed(1)+'% UP'}catch{}}

function vec(f){
 const r=f.rets;return [
  clamp(r[0]/.00035,-3,3),clamp(r[1]/.00055,-3,3),clamp(r[2]/.00075,-3,3),clamp(r[3]/.0012,-3,3),
  clamp(r[5]/.0017,-3,3),clamp(r[6]/.0021,-3,3),clamp(f.sl/.000012,-3,3),clamp(f.accel/.0007,-3,3),
  clamp(f.efficiency,0,1)*2-1,clamp(f.consistency*2-1,-1,1),clamp(f.dispersion/.0015,-3,3),f.consensus==null?0:clamp((f.consensus-.5)*4,-2,2)
 ]
}
function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s}
function heuristic(f){
 const r=f.rets;
 const mom=.20*clamp(r[0]/.00035,-1,1)+.17*clamp(r[1]/.00055,-1,1)+.16*clamp(r[2]/.00075,-1,1)+.15*clamp(r[3]/.0012,-1,1)+.10*clamp(r[5]/.0017,-1,1);
 const trend=.16*clamp(f.sl/.000012,-1,1),path=.10*clamp((f.efficiency-.25)/.55,-1,1)*Math.sign(r[3]||0),acc=.10*clamp(f.accel/.0007,-1,1);
 const prior=f.consensus==null?0:.18*clamp((f.consensus-.5)/.25,-1,1);const volPenalty=clamp(f.vol/.0007,0,1),chop=(1-f.consistency)*.15;
 return (mom+trend+path+acc+prior)*(1-.24*volPenalty)*(1-chop)
}
function trainModel(){
 const data=ledger.filter(r=>(r.result==='WIN'||r.result==='LOSS')&&(r.actual==='UP'||r.actual==='DOWN')&&Array.isArray(r.features)&&r.features.length===12);
 if(data.length<8)return;
 let w=model.w.slice(),b=model.b,lr=.025;
 for(let epoch=0;epoch<35;epoch++){
  const grad=new Array(12).fill(0);let gb=0;
  for(const r of data){const y=r.result==='WIN'?1:0,z=dot(w,r.features)+b,p=sigmoid(z),err=p-y;for(let i=0;i<12;i++)grad[i]+=err*r.features[i];gb+=err}
  const reg=.0015;for(let i=0;i<12;i++)w[i]-=lr*((grad[i]/data.length)+reg*w[i]);b-=lr*gb/data.length;
 }
 model={w,b,seen:data.length,updatedAt:Date.now()};saveModel();
}
function aiEngine(f){
 const v=vec(f),h=heuristic(f),ml=model.seen>=8?dot(model.w,v)+model.b:0;
 const mlP=sigmoid(ml),hP=sigmoid(h*2.35),prior=f.consensus==null?.5:f.consensus;
 const mlWeight=model.seen>=8?clamp(.22+.015*model.seen,.22,.48):0;
 const p=clamp((1-mlWeight-.16)*hP+mlWeight*mlP+.16*prior,.04,.96);
 const side=p>=.5?'UP':'DOWN',confidence=Math.max(p,1-p);
 const volPenalty=clamp(f.vol/.0007,0,1),quality=clamp(.48+.24*f.consistency+.18*f.efficiency+.10*(1-volPenalty)-.08*f.reversals,0,1);
 const agreement=1-Math.min(1,Math.abs(hP-mlP)*1.6);return{side,p,confidence,quality,hP,mlP,prior,agreement,mlReady:model.seen>=8,trainCount:model.seen,score:2*(p-.5)}
}
function existingForCycle(){return ledger.find(r=>r.cycleStart===cycleStart)}
function lockPrediction(){
 if(locked||!cycleStart)return;const sec=(Date.now()-cycleStart)/1000;if(sec<89.85||sec>92.5)return;
 if(ticks.length<3){$('call').textContent='DATA DELAY';$('callHint').textContent='Not enough verified live observations — no fabricated prediction.';return}
 if(existingForCycle()){locked=true;return}
 const f=features(),e=aiEngine(f);locked=true;lastFeatures=f;lastEngine={...e,cycle:cycleStart};
 $('call').textContent=e.side;$('call').className='call '+e.side.toLowerCase();$('signal').className='signal '+e.side.toLowerCase();$('conf').textContent=(e.confidence*100).toFixed(1)+'%';$('quality').textContent=(e.quality*100).toFixed(0)+'%';
 $('callHint').textContent='LOCKED at +90s • AI ensemble • '+(e.mlReady?'adaptive model active':'adaptive model warming up');
 $('engineText').textContent=`AI ensemble locked • ${e.trainCount} verified samples used for adaptive learning • decision frozen after +90s`;
 const rec={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random()),cycleStart,marketSlug:market?.event?.slug||market?.market?.slug||('btc-updown-5m-'+Math.floor(cycleStart/1000)),prediction:e.side,confidence:e.confidence,probability:e.p,score:e.score,quality:e.quality,btcAt90:nearest(90)||lastPrice,ret30:f.rets[3],ret60:f.rets[5],ret90:(f.now-f.p0)/f.p0,slope:f.sl,volatility:f.vol,consensus:f.consensus,features:vec(f),modelSeen:e.trainCount,lockedAt:Date.now(),result:'PENDING',actual:null,verification:null};
 ledger.unshift(rec);ledger=ledger.slice(0,5000);saveLedger();notify(rec);verifyAfterClose(rec)
}
async function resolveRecord(rec){
 try{
  const r=await fetch(EVENTS+'/slug/'+encodeURIComponent(rec.marketSlug),{cache:'no-store'});if(!r.ok)return null;const ev=await r.json(),ms=ev?.markets||[],m=ms.find(x=>x.slug===rec.marketSlug)||ms[0];if(!m)return null;
  const closed=Boolean(m.closed||ev.closed||m.closedTime||ev.closedTime);const status=String(m.umaResolutionStatus||'').toLowerCase();if(!closed||status!=='resolved')return null;
  const outs=parseArray(m.outcomes),prices=parseArray(m.outcomePrices).map(Number);let winner=null,best=-1;outs.forEach((o,i)=>{const p=prices[i];if(Number.isFinite(p)&&p>best){best=p;winner=String(o).toUpperCase()}});
  if(!winner||best<.99)return null;const side=winner.includes('UP')?'UP':winner.includes('DOWN')?'DOWN':null;if(!side)return null;
  return{side,source:'Polymarket market closed + UMA resolution + resolved outcome',at:Date.now(),marketId:m.id||null,status:m.umaResolutionStatus};
 }catch{return null}
}
function verifyAfterClose(rec){
 if(verifyJobs.has(rec.id))return;verifyJobs.add(rec.id);let tries=0;
 const run=async()=>{const i=ledger.findIndex(x=>x.id===rec.id);if(i<0||ledger[i].result!=='PENDING'){verifyJobs.delete(rec.id);return}if(Date.now()<rec.cycleStart+300000){setTimeout(run,6000);return}const out=await resolveRecord(rec);if(out){ledger[i]={...ledger[i],result:ledger[i].prediction===out.side?'WIN':'LOSS',actual:out.side,verification:out.source,resolvedAt:out.at,resolutionStatus:out.status,marketId:out.marketId};trainModel();saveLedger();verifyJobs.delete(rec.id);return}if(++tries<90)setTimeout(run,6000);else verifyJobs.delete(rec.id)};setTimeout(run,3000)
}
function renderLive(){
 if(!cycleStart)return;const sec=(Date.now()-cycleStart)/1000;$('elapsed').textContent=Math.max(0,Math.min(300,Math.floor(sec)))+' / 300s';$('timer').textContent=String(Math.max(0,Math.floor(sec/60))).padStart(2,'0')+':'+String(Math.max(0,Math.floor(sec%60))).padStart(2,'0');$('prog').style.width=(clamp(sec/300,0,1)*100)+'%';$('phase').textContent=sec<90?'AI ANALYSIS • LOCK AT 01:30':sec<300?'PREDICTION FROZEN • AWAITING RESOLUTION':'CYCLE COMPLETE';$('price').textContent=fmtUSD(lastPrice);
 const f=features();lastFeatures=f;$('r30').textContent=fmtPct(f.rets[3]);$('r60').textContent=fmtPct(f.rets[5]);$('r90').textContent=fmtPct((f.now-f.p0)/f.p0);$('trend').textContent=fmtPct(f.sl);$('vol').textContent=fmtPct(f.vol);$('samples').textContent=ticks.length;$('modelSamples').textContent=model.seen+' verified';$('agreement').textContent=lastEngine?((lastEngine.agreement*100).toFixed(0)+'%'):'—';$('quality').textContent=locked?((lastEngine?.quality||0)*100).toFixed(0)+'%':'BUILDING';drawChart();if(sec>=89.85&&!locked)lockPrediction();if(sec<90&&!locked)$('engineText').textContent=ticks.length>5?'AI ensemble online • momentum • trend • microstructure • volatility • adaptive learning':'Collecting live observations…';
}
function drawChart(){const svg=$('line');if(!ticks.length){svg.setAttribute('points','0,50 100,50');return}const a=ticks.slice(-140),min=Math.min(...a.map(x=>x.p)),max=Math.max(...a.map(x=>x.p)),span=max-min||1;svg.setAttribute('points',a.map((x,i)=>`${i/(a.length-1||1)*100},${100-((x.p-min)/span)*90-5}`).join(' '))}
function renderLedger(){
 const body=$('rows');if(!ledger.length)body.innerHTML='<tr><td colspan="7" class="empty">No predictions yet.</td></tr>';else body.innerHTML=ledger.slice(0,300).map(r=>{const pc=(r.prediction||'').toLowerCase(),rc=r.result==='WIN'?'win':r.result==='LOSS'?'loss':'pending',txt=r.result==='WIN'?'✓ CORRECT':r.result==='LOSS'?'✕ WRONG':'◷ PENDING';return `<tr><td>${time(r.lockedAt)}</td><td><span class="pill ${pc}">${r.prediction}</span></td><td>${Number(r.confidence*100).toFixed(1)}%</td><td>${fmtUSD(r.btcAt90)}</td><td>${Number(r.quality*100).toFixed(0)}%</td><td><span class="pill ${rc}">${txt}${r.actual?' • '+r.actual:''}</span></td><td>${r.verification||'Waiting for official resolution'}</td></tr>`}).join('');
 const v=ledger.filter(x=>x.result==='WIN'||x.result==='LOSS'),w=v.filter(x=>x.result==='WIN');let streak=0;for(const x of ledger){if(x.result==='WIN')streak++;else if(x.result==='LOSS')break};$('verified').textContent=v.length;$('correct').textContent=w.length;$('accuracy').textContent=v.length?(w.length/v.length*100).toFixed(1)+'%':'—';$('avgConf').textContent=v.length?(v.reduce((a,x)=>a+x.confidence,0)/v.length*100).toFixed(1)+'%':'—';$('streak').textContent=streak;$('pending').textContent=ledger.filter(x=>x.result==='PENDING').length;$('ledgerMeta').textContent=ledger.length+' records';$('modelSamples').textContent=model.seen+' verified';
}
function notify(r){if(notifyOn&&'Notification'in window&&Notification.permission==='granted'){try{new Notification('BTC EDGE AI • '+r.prediction,{body:`90s prediction locked • ${(r.confidence*100).toFixed(1)}% model confidence`})}catch{}}}
$('notify').onclick=async()=>{if(!('Notification'in window)){alert('Notifications are not supported here.');return}const p=await Notification.requestPermission();notifyOn=p==='granted';$('notify').textContent=notifyOn?'Alerts enabled ✓':'Enable alerts';localStorage.setItem(SETTINGS,JSON.stringify({notifyOn}))};
$('sync').onclick=()=>{getActive();connect()};
$('clear').onclick=()=>{if(confirm('Delete the prediction ledger and adaptive AI training history? This cannot be undone.')){ledger=[];model={w:new Array(12).fill(0),b:0,seen:0,updatedAt:null};saveModel();saveLedger()}};
$('export').onclick=()=>{const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),model,ledger},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='btc-edge-ai-ledger-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
try{const s=JSON.parse(localStorage.getItem(SETTINGS)||'{}');notifyOn=Boolean(s.notifyOn&&Notification?.permission==='granted');if(notifyOn)$('notify').textContent='Alerts enabled ✓'}catch{}
trainModel();renderLedger();getActive();connect();setInterval(()=>{getActive();updateConsensus()},15000);setInterval(renderLive,100);setInterval(()=>ledger.filter(x=>x.result==='PENDING').slice(0,30).forEach(verifyAfterClose),15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){getActive();if(!ws||ws.readyState!==1)connect()}});
})();
