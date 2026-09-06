const $=id=>document.getElementById(id);
const RTDS="wss://ws-live-data.polymarket.com";
const GAMMA="https://gamma-api.polymarket.com/events";
const CLOB="https://clob.polymarket.com";
let ws=null, ticks=[], market=null, cycleStart=0, decidedFor=0, timer=null, lastMarketFetch=0;

function cycleFor(ts){ return Math.floor(ts/300000)*300000; }
function fmtTime(ms){return new Date(ms).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"});}
function pct(x){return (x*100).toFixed(3)+"%";}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

function connect(){
  if(ws) try{ws.close()}catch(_){}
  ws=new WebSocket(RTDS);
  ws.onopen=()=>{
    $("conn").textContent="Chainlink live";
    $("conn").className="pill ok";
    ws.send(JSON.stringify({action:"subscribe",subscriptions:[
      {topic:"crypto_prices_chainlink",type:"*",filters:'{"symbol":"btc/usd"}'}
    ]}));
  };
  ws.onmessage=e=>{
    try{
      const m=JSON.parse(e.data);
      const p=m?.payload;
      let arr=p?.data;
      if(!Array.isArray(arr)) arr=p?.data?.data;
      if(!Array.isArray(arr)) arr=(p?.symbol==="btc/usd"&&p?.value!=null)?[p]:null;
      if(!arr) return;
      for(const q of arr){
        const value=Number(q.value);
        const ts=Number(q.timestamp ?? q.timestamp_ms ?? Date.now());
        if(value>1000 && Number.isFinite(value)){
          ticks.push({t:ts,v:value});
          ticks=ticks.filter(x=>x.t>=Date.now()-12*60*1000);
          onTick(ts,value);
        }
      }
    }catch(err){ $("diag").textContent="RTDS parse error: "+err.message; }
  };
  ws.onclose=()=>{ $("conn").textContent="Reconnecting…"; $("conn").className="pill"; setTimeout(connect,1500); };
  ws.onerror=()=>{};
}
function onTick(ts,v){
  const cs=cycleFor(ts);
  if(cs!==cycleStart){cycleStart=cs; decidedFor=0; ticks=ticks.filter(x=>x.t>=cs-60000); $("pred").textContent="ANALYZING"; $("pred").className="prediction neutral";}
  const sec=(ts-cs)/1000;
  $("cycle").textContent=fmtTime(cs)+" → "+fmtTime(cs+300000);
  $("timer").textContent=sec<90?`${Math.max(0,90-sec).toFixed(0)}s until decision`:`Decision made ${Math.max(0,sec-90).toFixed(0)}s ago`;
  $("price").textContent="$"+v.toLocaleString(undefined,{maximumFractionDigits:2});
  const windowTicks=ticks.filter(x=>x.t>=cs && x.t<=ts);
  if(windowTicks.length<3) return;
  const open=windowTicks[0].v;
  const move=(v-open)/open;
  $("move").textContent=pct(move);
  const ret30=retAt(ts,30), ret60=retAt(ts,60), ret90=retAt(ts,90);
  const slope=linearSlope(windowTicks.slice(-60));
  const vol=stdevReturns(windowTicks.slice(-90));
  $("trend").textContent=pct(slope);
  $("vol").textContent=(vol*100).toFixed(3)+"%";
  if(sec>=90 && decidedFor!==cs){
    const result=predict({move,ret30,ret60,ret90,slope,vol,windowTicks});
    decidedFor=cs; renderPrediction(result);
    notifyUser(result, cs);
    saveDecision({cs,result,open,price:v});
  }
  $("diag").textContent=
`Samples: ${windowTicks.length}
30s return: ${pct(ret30)}
60s return: ${pct(ret60)}
90s return: ${pct(ret90)}
Slope score: ${pct(slope)}
1s-return volatility: ${(vol*100).toFixed(3)}%
Decision gate: ${sec>=90?"OPEN":"LOCKED"}
Note: the settlement rule is Chainlink-based; this model uses the same Polymarket RTDS Chainlink feed.`;
}
function retAt(ts,s){
  const a=ticks.find(x=>x.t>=ts-s*1000);
  const b=ticks.filter(x=>x.t<=ts).at(-1);
  return a&&b?(b.v/a.v-1):0;
}
function linearSlope(a){
  if(a.length<5)return 0;
  const x=a.map((_,i)=>i), y=a.map(z=>z.v);
  const mx=(x.length-1)/2, my=y.reduce((s,z)=>s+z,0)/y.length;
  let num=0,den=0; for(let i=0;i<x.length;i++){num+=(x[i]-mx)*(y[i]-my);den+=(x[i]-mx)**2}
  const raw=num/den;
  return raw/(my||1);
}
function stdevReturns(a){
  const r=[]; for(let i=1;i<a.length;i++) r.push(a[i].v/a[i-1].v-1);
  if(r.length<3)return 0;
  const m=r.reduce((s,z)=>s+z,0)/r.length;
  return Math.sqrt(r.reduce((s,z)=>s+(z-m)**2,0)/(r.length-1));
}
/* Transparent heuristic ensemble:
   - momentum at 30/60/90s
   - position vs open
   - short trend slope
   - volatility penalty
   The weights are intentionally conservative. The app records outcomes locally so
   you can replace these weights with a backtested/calibrated model later. */
function predict(f){
  const momentum=0.30*clamp(f.ret30/0.0015,-1,1)+0.25*clamp(f.ret60/0.0025,-1,1)+0.20*clamp(f.ret90/0.0035,-1,1);
  const position=0.15*clamp(f.move/0.0025,-1,1);
  const trend=0.20*clamp(f.slope/0.00003,-1,1);
  const volPenalty=clamp(f.vol/0.00035,0,1);
  let score=momentum+position+trend;
  score*=1-0.22*volPenalty;
  // Map score to a probability-like confidence, then keep it modest.
  let p=0.5+0.5*Math.tanh(score*1.6);
  p=clamp(p,0.51,0.89);
  const side=p>=0.5?"UP":"DOWN";
  const confidence=side==="UP"?p:1-p;
  return {side,confidence,score,features:f};
}
function renderPrediction(r){
  $("pred").textContent=r.side;
  $("pred").className="prediction "+(r.side==="UP"?"up":"down");
  $("conf").textContent=`Model confidence: ${(r.confidence*100).toFixed(1)}% • score ${r.score.toFixed(3)} • paper-trade only`;
  $("fill").style.width=(r.confidence*100)+"%";
}
async function findMarket(){
  try{
    const now=Date.now();
    if(now-lastMarketFetch<15000)return;
    lastMarketFetch=now;
    const u=GAMMA+"?series_slug=btc-up-or-down-5m&closed=false&limit=500&order=endDate&ascending=true";
    const data=await fetch(u).then(r=>r.json());
    const ev=(data||[]).find(x=>{
      const s=Date.parse(x.eventStartTime||x.startDate);
      const e=Date.parse(x.endDate);
      return Number.isFinite(s)&&Number.isFinite(e)&&s<=now&&now<e;
    });
    if(!ev){$("market").textContent="No active market found; retrying…";return}
    market=ev;
    const m=ev.markets?.[0]||ev;
    $("market").textContent=ev.title||ev.slug||"BTC Up or Down 5m";
    let prices=m.outcomePrices;
    if(typeof prices==="string")try{prices=JSON.parse(prices)}catch(_){}
    if(Array.isArray(prices)) $("odds").textContent=`Displayed market prices: Up ${prices[0]??"—"} • Down ${prices[1]??"—"}`;
  }catch(e){$("market").textContent="Market discovery error: "+e.message}
}
function notifyUser(r,cs){
  const text=`BTC 5M decision @ +90s: ${r.side} (${(r.confidence*100).toFixed(1)}% model confidence).`;
  if("Notification" in window && Notification.permission==="granted") new Notification("BTC 5M Predictor",{body:text});
  if(navigator.vibrate) navigator.vibrate([150,80,150]);
}
$("notify").onclick=async()=>{
  if(!("Notification" in window)){alert("Notifications are not supported in this browser.");return}
  const p=await Notification.requestPermission();
  $("notify").textContent=p==="granted"?"90s alerts enabled":"Notifications blocked";
};
$("reset").onclick=()=>{decidedFor=0;$("pred").textContent="ANALYZING";$("pred").className="prediction neutral"};
function saveDecision(d){const a=JSON.parse(localStorage.getItem("btc5m_decisions")||"[]");a.push(d);localStorage.setItem("btc5m_decisions",JSON.stringify(a.slice(-500)));}
if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
connect(); findMarket(); setInterval(findMarket,15000);
setInterval(()=>{const t=Date.now();$("timer").textContent=`Local clock: ${new Date(t).toLocaleTimeString()}`},1000);
