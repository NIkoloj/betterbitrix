const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const crypto=require('node:crypto');
const transport=fs.readFileSync(path.join(__dirname,'../companion/transport.js'),'utf8');
const bundle=fs.readFileSync(path.join(__dirname,'../companion/BetterBitrixPortable.user.js'),'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
function world() {
  let now=0, disconnected=false, command=null;
  const storage=new Map(),locks=new Set(),timers=[],requests=[],executions=[];
  const pages=[];
  const nextCommand=value=>command=value;
  async function advance(ms=2000) {
    now+=ms;
    const due=timers.filter(timer=>timer.at<=now);
    for(const timer of due){timers.splice(timers.indexOf(timer),1);timer.fn();}
    await flush();
  }
  function page({hash='',uid=1178,frame=false}={}) {
    const events=new Map(),state={protocol:1,uid,observedAt:now,meetingsStatus:'ready',timer:{status:'running',startedAt:0,accumulatedMs:0},dailyUrl:'https://zoom.us/j/123'};
    const location={origin:'https://b24.entgld.com',pathname:'/',search:'',hash};
    const pageWindow={addEventListener:(name,fn)=>events.set(name,fn),__betterBitrixDesktop:{execute:async(name,params,id)=>{
      if(name==='state')return {...state,observedAt:now};
      executions.push({name,params,id});return state;
    }}};
    pageWindow.top=frame?{}:pageWindow;
    class Clock extends Date {static now(){return now;}}
    const sandbox={unsafeWindow:pageWindow,location,history:{state:null,replaceState(_state,_title,url){location.hash='';assert.equal(url,'/');}},navigator:{locks:{request:async(name,options,fn)=>{
      if(locks.has(name))return fn(null);
      locks.add(name);try{return await fn({name});}finally{locks.delete(name);}
    }}},crypto,Date:Clock,setTimeout:(fn,ms)=>{timers.push({fn,at:now+ms});},GM_getValue:(key,fallback)=>storage.get(key)??fallback,GM_setValue:(key,value)=>storage.set(key,JSON.parse(JSON.stringify(value))),GM_registerMenuCommand(){},alert(){},GM_xmlhttpRequest:details=>{
      requests.push(details);
      queueMicrotask(()=>{
        if(disconnected)return details.onerror();
        const data=JSON.parse(details.data);
        if(details.url.endsWith('/pair'))return details.onload({status:200,responseText:JSON.stringify({token:'A'.repeat(64),uid:data.state.uid})});
        const current=command;command=null;
        details.onload({status:200,responseText:JSON.stringify({command:current})});
      });
    }};
    vm.runInNewContext(transport,sandbox);
    const result={state,location,close:()=>events.get('pagehide')?.(),hashChange:()=>events.get('hashchange')?.()};pages.push(result);return result;
  }
  function paired(){storage.set('portablePair',{port:47653,uid:1178,token:'A'.repeat(64)});}
  return {page,paired,advance,requests,storage,executions,nextCommand,offline:value=>disconnected=value};
}

test('companion pairs after portal identity appears and keeps only its bridge credential in GM storage',async()=>{
  const w=world();const p=w.page({uid:null,hash:'#betterbitrix-pair=47653.'+'B'.repeat(48)});await flush();
  assert.equal(p.location.hash,'');assert.equal(w.requests.length,0);
  p.state.uid=1178;await w.advance();
  const pairing=w.requests.find(item=>item.url.endsWith('/pair'));
  assert.ok(pairing);assert.equal(pairing.anonymous,true);assert.equal(JSON.parse(pairing.data).nonce,'B'.repeat(48));
  assert.equal(w.storage.get('portablePair').uid,1178);assert.equal(w.storage.get('portablePair').token,'A'.repeat(64));
  assert.doesNotMatch(JSON.stringify([...w.storage]),/sessid|cookie|password|nonce/i);
  assert.equal(p.state.timer.status,'running');
});

test('a linked companion authenticates locally, reconnects after EXE outage and never polls from frames',async()=>{
  const w=world();w.paired();w.offline(true);w.page();w.page({frame:true});await flush();
  assert.equal(w.requests.length,1);
  await w.advance();assert.equal(w.requests.length,2);
  w.offline(false);await w.advance();
  assert.equal(w.requests.length,3);assert.equal(w.requests[2].headers.Authorization,'Bearer '+'A'.repeat(64));
  assert.equal(w.requests[2].url,'http://127.0.0.1:47653/exchange');assert.equal(w.requests[2].anonymous,true);
  assert.doesNotMatch(w.requests[2].data,/csrf|cookie|password|profile/i);
});

test('closing the leader tab transfers the bridge to another tab using the saved pairing',async()=>{
  const w=world();w.paired();const first=w.page();w.page();await flush();
  assert.equal(w.requests.length,1);const firstId=JSON.parse(w.requests[0].data).clientId;
  first.close();await w.advance();await w.advance();
  const lastId=JSON.parse(w.requests.at(-1).data).clientId;
  assert.notEqual(lastId,firstId);assert.equal(w.storage.get('portablePair').token,'A'.repeat(64));
});

test('command IDs are marked before execution and cannot be repeated after a tab restart',async()=>{
  const w=world();w.paired();const command={type:'command',id:'one',command:'finish',params:{},expectedUid:1178};
  w.nextCommand(command);const first=w.page();await flush();
  assert.equal(w.executions.length,1);assert.equal(w.storage.get('portableCompleted')[0].id,'one');
  w.offline(true);await w.advance();w.offline(false);await w.advance();
  const result=JSON.parse(w.requests.at(-1).data).results[0];assert.equal(result.id,'one');assert.equal(result.error,null);
  first.close();await w.advance();w.nextCommand(command);w.page();await flush();
  assert.equal(w.executions.length,1);
});

test('an account switch prevents commands and cached identity is never used for another session',async()=>{
  const w=world();w.paired();const page=w.page({uid:999});await flush();assert.equal(w.requests.length,0);
  page.state.uid=1178;w.nextCommand({type:'command',id:'wrong-user',command:'quickAdd',expectedUid:999});await w.advance();
  assert.equal(w.executions.length,0);
});

test('portable bundle requests only localhost transport and exposes no cookies/native messaging permissions',()=>{
  const header=bundle.slice(0,bundle.indexOf('// ==/UserScript=='));
  assert.match(header,/\/\/ @connect\s+127\.0\.0\.1/);
  assert.doesNotMatch(header,/GM_cookie|nativeMessaging|@connect\s+\*/);
  assert.match(bundle,/const window=unsafeWindow, XMLHttpRequest=window.XMLHttpRequest, navigator=window.navigator/);
  assert.equal((header.match(/\/\/ @name /g)||[]).length,1);
});
