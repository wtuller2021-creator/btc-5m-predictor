(() => {
  "use strict";

  const RTDS = "wss://ws-live-data.polymarket.com";
  const GAMMA_EVENTS = "https://gamma-api.polymarket.com/events";
  const SERIES = "btc-up-or-down-5m";
  const STORAGE = "btc5m_pro_ledger_v2";
  const SETTINGS = "btc5m_pro_settings_v2";

  const $ = id => document.getElementById(id);
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const pct = x => Number.isFinite(x) ? (x*100).toFixed(3)+"%" : "—";
  const usd = x => Number.isFinite(x) ? "$"+x.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) : "—";
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",second:"2-digit"});
  const fmtDate = ts => new Date(ts).toLocaleDateString([], {month:"short",day:"numeric"});
  const sleep = ms => new Promise(r=>setTimeout(r,ms));

  let ws = null, reconnectTimer = null, lastTick = 0;
  let cycleStart = null, currentSlug = null, currentEvent = null, decidedFor = null;
  let samples = [];
  let ledger = loadLedger();
  let notificationEnabled = false;
  let marketPollTimer = null;
  let verifyTimer = null;

  function loadLedger() {
    try { const x = JSON.parse(localStorage.getItem(STORAGE) || "[]"); return Array.isArray(x) ? x : []; }
    catch { return []; }
  }
  function saveLedger() {
    localStorage.setItem(STORAGE, JSON.stringify(ledger));
    renderLedger();
  }
  function setConn(ok, text) {
    $("connDot").className = "dot " + (ok ? "ok" : "bad");
    $("connText").textContent = text;
  }

  // --- Polymarket active market discovery ---
  async function findActiveMarket() {
    try {
      const u = GAMMA_EVENTS + "?series_slug=" + encodeURIComponent(SERIES) + "&closed=false&limit=500&order=endDate&ascending=true";
      const r = await fetch(u, {cache:"no-store"});
      if (!r.ok) throw new Error("Gamma HTTP "+r.status);
      const events = await r.json();
      const now = Date.now();
      const ev = events.find(e => {
        const s = Date.parse(e.eventStartTime || e.startDate || "");
        const end = Date.parse(e.endDate || e.endDateIso || "");
        return Number.isFinite(s) && Number.isFinite(end) && s <= now && now < end;
      }) || events.find(e => {
        const end = Date.parse(e.endDate || e.endDateIso || "");
        return Number.isFinite(end) && end > now;
      });
      if (ev) {
        currentEvent = ev;
        currentSlug = ev.slug || (ev.markets && ev.markets[0] && ev.markets[0].slug) || null;
        $("marketSlug").textContent = currentSlug ? currentSlug : "Active event found";
        $("mktStatus").textContent = "Live";
      }
    } catch (e) {
      $("mktStatus").textContent = "API retrying";
    }
  }

  // --- Resolution verification ---
  // We intentionally verify with Polymarket's resolved market state instead of
  // deciding the result ourselves from a live BTC quote.
  async function fetchResolution(slug) {
    if (!slug) return null;
    try {
      const r = await fetch(GAMMA_EVENTS + "?slug=" + encodeURIComponent(slug), {cache:"no-store"});
      if (!r.ok) return null;
      const data = await r.json();
      const ev = Array.isArray(data) ? data[0] : data;
      const markets = ev?.markets || [];
      const m = markets[0] || ev;
      if (!m) return null;

      let outcomes = m.outcomes, prices = m.outcomePrices;
      if (typeof outcomes === "string") { try { outcomes = JSON.parse(outcomes); } catch {} }
      if (typeof prices === "string") { try { prices = JSON.parse(prices); } catch {} }
      if (!Array.isArray(outcomes) || !Array.isArray(prices)) return null;

      let best = -1, winner = null;
      outcomes.forEach((o,i) => {
        const p = Number(prices[i]);
        if (Number.isFinite(p) && p > best) { best=p; winner=String(o).toUpperCase(); }
      });

      const closed = Boolean(m.closed || ev?.closed);
      if (!closed || !winner || best < 0.98) return null;

      const normalized = winner.includes("UP") ? "UP" : winner.includes("DOWN") ? "DOWN" : null;
      return normalized ? {winner: normalized, raw: winner, source:"Polymarket resolved market", resolvedAt: Date.now()} : null;
    } catch { return null; }
  }

  async function verifyRecord(id) {
    const idx = ledger.findIndex(x => x.id === id);
    if (idx < 0 || ledger[idx].result !== "PENDING") return;
    const rec = ledger[idx];
    const result = await fetchResolution(rec.marketSlug);
    if (result) {
      ledger[idx] = {...rec, result: rec.prediction === result.winner ? "WIN" : "LOSS", actual: result.winner, resolutionSource: result.source, resolvedAt: result.resolvedAt};
      saveLedger();
      return true;
    }
    return false;
  }

  function queueVerification(rec) {
    const maxAttempts = 30;
    let attempts = 0;
    const run = async () => {
      if (await verifyRecord(rec.id)) return;
      attempts++;
      if (attempts < maxAttempts) verifyTimer = setTimeout(run, 5000);
    };
    setTimeout(run, 3000);
  }

  // --- Live Chainlink feed ---
  function connectFeed() {
    try { if (ws) ws.close(); } catch {}
    ws = new WebSocket(RTDS);
    ws.onopen = () => {
      setConn(true,"Live Chainlink feed");
      ws.send(JSON.stringify({
        action:"subscribe",
        subscriptions:[{
          topic:"crypto_prices_chainlink",
          type:"*",
          filters:'{"symbol":"btc/usd"}'
        }]
      }));
    };
    ws.onmessage = e => {
      try {
        const d = JSON.parse(e.data);
        const p = extractPrice(d);
        if (!Number.isFinite(p) || p <= 0) return;
        lastTick = Date.now();
        handlePrice(p, lastTick);
      } catch {}
    };
    ws.onerror = () => setConn(false,"Feed error — reconnecting");
    ws.onclose = () => {
      setConn(false,"Feed disconnected — reconnecting");
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectFeed,3000);
    };
  }

  function extractPrice(d) {
    const candidates = [
      d?.payload?.data?.price, d?.payload?.price, d?.data?.price, d?.price,
      d?.payload?.data?.value, d?.payload?.value
    ];
    for (const x of candidates) {
      const n = Number(x);
      if (Number.isFinite(n) && n > 1000) return n;
    }
    return NaN;
  }

  function resetCycle(startMs) {
    cycleStart = startMs;
    samples = [];
    decidedFor = null;
    $("prediction").textContent = "ANALYZING";
    $("prediction").className = "predSide pending";
    $("confidence").textContent = "—";
    $("predTime").textContent = "No locked prediction";
    $("ret30").textContent = "—"; $("ret60").textContent = "—"; $("ret90").textContent = "—";
    $("slope").textContent = "—"; $("vol").textContent = "—"; $("score").textContent = "—";
    $("samples").textContent = "0";
  }

  function handlePrice(price, ts) {
    const start = Math.floor(ts / 300000) * 300000;
    if (cycleStart !== start) {
      resetCycle(start);
      findActiveMarket();
    }
    const sec = (ts - cycleStart) / 1000;
    if (sec < 0 || sec > 305) return;
    samples.push({t:ts,p:price});
    // Keep a reasonable local window; one sample per event can be frequent.
    if (samples.length > 1200) samples = samples.slice(-900);

    $("btcPrice").textContent = usd(price);
    $("seconds").textContent = `${Math.min(300,Math.floor(sec))} / 300s`;
    $("progress").style.width = (clamp(sec/300,0,1)*100).toFixed(1)+"%";
    $("clock").textContent = `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(Math.floor(sec%60)).padStart(2,"0")}`;
    $("phase").textContent = sec < 90 ? "Analyzing first 90 seconds" : sec < 300 ? "Prediction locked • waiting for resolution" : "Cycle complete";
    $("samples").textContent = String(samples.length);

    const features = computeFeatures(price, sec);
    $("ret30").textContent = pct(features.ret30);
    $("ret60").textContent = pct(features.ret60);
    $("ret90").textContent = pct(features.ret90);
    $("slope").textContent = pct(features.slope);
    $("vol").textContent = pct(features.vol);

    if (sec >= 90 && decidedFor !== start) {
      const pred = predict(features);
      decidedFor = start;
      $("prediction").textContent = pred.side;
      $("prediction").className = "predSide " + pred.side.toLowerCase();
      $("confidence").textContent = (pred.confidence*100).toFixed(1)+"%";
      $("predTime").textContent = "Locked at +90s • " + fmtTime(ts);
      $("score").textContent = pred.score.toFixed(3);

      const rec = {
        id: `${start}-${Math.random().toString(36).slice(2)}`,
        cycleStart:start,
        prediction:pred.side,
        confidence:pred.confidence,
        score:pred.score,
        btcAt90:price,
        ret30:features.ret30,
        ret60:features.ret60,
        ret90:features.ret90,
        slope:features.slope,
        volatility:features.vol,
        marketSlug:currentSlug || `btc-updown-5m-${Math.floor(start/1000)}`,
        lockedAt:ts,
        result:"PENDING",
        actual:null,
        resolutionSource:null
      };
      ledger.unshift(rec);
      ledger = ledger.slice(0,2000);
      saveLedger();
      notify(pred.side, pred.confidence);
      queueVerification(rec);
    }

    // Once a cycle has passed, retry verification for any pending rows.
    if (sec > 300) {
      ledger.filter(x => x.result === "PENDING" && x.cycleStart < start).slice(0,10).forEach(queueVerification);
    }
  }

  function nearest(sec) {
    const target = cycleStart + sec*1000;
    let best = null, dist = Infinity;
    for (const s of samples) {
      const d = Math.abs(s.t-target);
      if (d < dist) { dist=d; best=s; }
    }
    return best && dist <= 4000 ? best.p : null;
  }

  function computeFeatures(price, sec) {
    const p0 = nearest(0) || samples[0]?.p || price;
    const p30 = nearest(30) || price, p60 = nearest(60) || price, p90 = nearest(90) || price;
    const ret = p => p0 ? (p-p0)/p0 : 0;
    const values = samples.map(x=>x.p);
    let vol = 0;
    if (values.length > 3) {
      const rs=[]; for(let i=1;i<values.length;i++) rs.push((values[i]-values[i-1])/values[i-1]);
      const mean=rs.reduce((a,b)=>a+b,0)/rs.length;
      vol=Math.sqrt(rs.reduce((a,b)=>a+(b-mean)**2,0)/rs.length)*Math.sqrt(Math.max(1,rs.length));
    }
    // Least-squares slope, normalized to return per second.
    const recent=samples.slice(-Math.min(120,samples.length));
    let slope=0;
    if(recent.length>4){
      const t0=recent[0].t;
      const xs=recent.map(x=>(x.t-t0)/1000), ys=recent.map(x=>x.p);
      const xm=xs.reduce((a,b)=>a+b,0)/xs.length, ym=ys.reduce((a,b)=>a+b,0)/ys.length;
      const den=xs.reduce((a,x)=>a+(x-xm)**2,0);
      const num=xs.reduce((a,x,i)=>a+(x-xm)*(ys[i]-ym),0);
      slope=den?num/den/price:0;
    }
    return {move:ret(price),ret30:ret(p30),ret60:ret(p60),ret90:ret(p90),slope,vol};
  }

  function predict(f) {
    // Transparent heuristic. Confidence is deliberately capped; it is not a probability guarantee.
    const momentum =
      0.30*clamp(f.ret30/0.0015,-1,1) +
      0.25*clamp(f.ret60/0.0025,-1,1) +
      0.20*clamp(f.ret90/0.0035,-1,1);
    const position=0.15*clamp(f.move/0.0025,-1,1);
    const trend=0.20*clamp(f.slope/0.00003,-1,1);
    const volPenalty=clamp(f.vol/0.00035,0,1);
    let score=(momentum+position+trend)*(1-0.22*volPenalty);
    let p=0.5+0.5*Math.tanh(score*1.6);
    p=clamp(p,0.51,0.89);
    const side=p>=0.5?"UP":"DOWN";
    return {side,confidence:side==="UP"?p:1-p,score};
  }

  function notify(side, conf) {
    if (!notificationEnabled) return;
    try {
      new Notification(`BTC 5M: ${side}`, {body:`90-second prediction locked • ${(conf*100).toFixed(1)}% model confidence`});
    } catch {}
  }

  $("notifyBtn").onclick = async () => {
    if (!("Notification" in window)) { alert("Notifications are not supported in this browser."); return; }
    const p = await Notification.requestPermission();
    notificationEnabled = p === "granted";
    $("notifyBtn").textContent = notificationEnabled ? "Alerts enabled ✓" : "Enable alerts";
    localStorage.setItem(SETTINGS, JSON.stringify({notificationEnabled}));
  };
  $("refreshBtn").onclick = () => { findActiveMarket(); connectFeed(); };
  $("clearBtn").onclick = () => {
    if (confirm("Delete the local prediction ledger? This cannot be undone.")) {
      ledger=[]; saveLedger();
    }
  };
  $("exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(ledger,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`btc5m-predictions-${new Date().toISOString().slice(0,10)}.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };

  function renderLedger() {
    const body=$("historyBody");
    if (!ledger.length) {
      body.innerHTML='<tr><td colspan="7" class="empty">No predictions yet. The first locked prediction will appear here.</td></tr>';
    } else {
      body.innerHTML=ledger.slice(0,200).map(r=>{
        const predClass=r.prediction.toLowerCase();
        const resultClass=r.result==="WIN"?"win":r.result==="LOSS"?"loss":"pending";
        const resultText=r.result==="WIN"?"✓ CORRECT":r.result==="LOSS"?"✕ WRONG":"◷ PENDING";
        return `<tr>
          <td>${fmtDate(r.lockedAt)} ${fmtTime(r.lockedAt)}</td>
          <td>${escapeHtml(r.marketSlug||"—")}</td>
          <td><span class="pill ${predClass}">${r.prediction}</span></td>
          <td>${(Number(r.confidence)*100).toFixed(1)}%</td>
          <td>${usd(Number(r.btcAt90))}</td>
          <td><span class="pill ${resultClass}">${resultText}${r.actual?` • ${r.actual}`:""}</span></td>
          <td>${escapeHtml(r.resolutionSource||"Waiting for Polymarket resolution")}</td>
        </tr>`;
      }).join("");
    }

    const verified=ledger.filter(x=>x.result==="WIN"||x.result==="LOSS");
    const correct=verified.filter(x=>x.result==="WIN");
    const acc=verified.length?correct.length/verified.length:null;
    const avg=verified.length?verified.reduce((a,x)=>a+Number(x.confidence||0),0)/verified.length:null;
    let streak=0;
    for(const x of verified){ if(x.result==="WIN") streak++; else break; }

    $("statVerified").textContent=verified.length;
    $("statCorrect").textContent=correct.length;
    $("statAccuracy").textContent=acc==null?"—":(acc*100).toFixed(1)+"%";
    $("statConf").textContent=avg==null?"—":(avg*100).toFixed(1)+"%";
    $("statStreak").textContent=streak;
    $("ledgerStatus").textContent=`${ledger.length} predictions stored locally • ${ledger.filter(x=>x.result==="PENDING").length} awaiting verification`;
  }

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}

  try {
    const s=JSON.parse(localStorage.getItem(SETTINGS)||"{}");
    notificationEnabled=Boolean(s.notificationEnabled && "Notification" in window && Notification.permission==="granted");
    if(notificationEnabled) $("notifyBtn").textContent="Alerts enabled ✓";
  } catch {}

  renderLedger();
  findActiveMarket();
  connectFeed();

  // Refresh market metadata regularly without disturbing the live feed.
  setInterval(findActiveMarket, 15000);
  // Verify pending historical records on startup, too.
  setTimeout(()=>ledger.filter(x=>x.result==="PENDING").slice(0,20).forEach(queueVerification),2000);

  // Recover gracefully if a browser suspends/resumes the tab.
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden){ findActiveMarket(); if(!ws || ws.readyState!==1) connectFeed(); }
  });
})();
