// A local, disposable DOM integration fixture. No corporate page/API is contacted.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const original=fs.readFileSync(path.join(root,'../BetterBitrix.user.js'),'utf8');
const companion=fs.readFileSync(path.join(root,'companion/BetterBitrixPortable.user.js'),'utf8');
for(const script of [original,companion])new vm.Script(script);
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  const order=url.searchParams.get('order')==='bridge-first'?['bridge','original']:['original','bridge'];
  if(url.pathname.endsWith('.js')){
    const source=url.pathname==='/original.js'?original:companion;
    response.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});
    // Permit only this local fixture at the upstream origin guard. Shipping sources stay intact.
    response.end(source.replace('location.origin !== ORIGIN','location.hostname !== "127.0.0.1"'));return;
  }
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  response.end(`<!doctype html><html><head><title>BetterBitrix widget coexistence</title>
<script>
window.BX={message:()=>1178,bitrix_sessid:()=>"fixture-only",rest:{callMethod(method,params,done){
 const date=params.from;
 done({data:()=>method==='calendar.user.settings.get'?{timezoneName:'Europe/Moscow'}:[
  {NAME:'Еженедельный созвон команды — обсуждение проектов и планирование следующей недели',DATE_FROM:date+' 10:00:00',DATE_TO:date+' 10:30:00',RRULE:{FREQ:'WEEKLY'},DATE_FROM_TS_UTC:1,DESCRIPTION:'https://zoom.us/j/123'},
  {NAME:'W'.repeat(180),DATE_FROM:date+' 11:00:00',DESCRIPTION:'https://teams.live.com/meet/123'}
 ]});
}}};
window.GM_getValue=()=>null;window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=()=>{throw Error("Network is disabled in this fixture");};
window.unsafeWindow=window;window.fixtureErrors=[];
window.addEventListener("error",event=>window.fixtureErrors.push(event.message));
</script>${order.map(name=>`<script src="/${name==='bridge'?'companion':'original'}.js"></script>`).join('')}
</head><body><main style="margin:100px 390px;font:16px sans-serif;min-width:400px">
<h1>Coexistence: ${order.join(' → ')}</h1><pre id="result">Loading…</pre>
<script>setInterval(()=>{
const host=document.getElementById("b24-eight-hours-panel"),button=host?.shadowRoot?.getElementById("primary");
document.getElementById("result").textContent=JSON.stringify({original:window.__b24EightHoursInstalled,bridge:window.__betterBitrixDesktopInstalled,panel:!!host,primary:button?.textContent,errors:window.fixtureErrors},null,2);
},300);</script></main></body></html>`);
});
server.listen(47654,'127.0.0.1',()=>process.stdout.write('Widget fixture: http://127.0.0.1:47654/\n'));
