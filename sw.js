self.addEventListener("install",e=>self.skipWaiting());
self.addEventListener("activate",e=>self.clients.claim());
self.addEventListener("fetch",e=>{ if(e.request.method==="GET") e.respondWith(caches.open("btc5m-v1").then(async c=>{try{const r=await fetch(e.request);c.put(e.request,r.clone());return r}catch(_){return c.match(e.request)}}))});
