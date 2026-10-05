const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const C=require('../BetterBitrix.user.js');
const source=fs.readFileSync(require.resolve('../BetterBitrix.user.js'),'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.__testRuntime={addDay,armLearning,journal,identity,claim,resolvePending,startWorkDay,togglePause,finishWorkDay,timerState,timerElapsedMs,formatClock,workDay,timeZoneFor,loadMeetings,renderMeetings,showAllMeetings,getMeetingsState:()=>meetingsState,setMeetingsUI:value=>{ui=value;}};})();');
const prefix='b24-eight-hours-v1:';
const origin='https://b24.entgld.com';
const shared=()=>({store:new Map(),locks:new Set(),calls:[],fetch:async()=>({ok:true,status:200,json:async()=>({status:'success',data:{id:891},errors:[]})})});
function runtime(s,uid=1178){
 class XHR {open(){}send(){}setRequestHeader(){}addEventListener(){}}
 const listeners={};
 const window={top:{},BX:{message:()=>uid,bitrix_sessid:()=>`csrf-${uid}`},fetch:async(url,options)=>{s.calls.push({url,options});return s.fetch(url,options);},addEventListener:(name,fn)=>{listeners[name]=fn;},confirm:()=>true};
 const sandbox={window,location:{origin,pathname:'/company/personal/user/1178/tasks/task/view/129769/'},document:{readyState:'loading',addEventListener(){},body:null},localStorage:{getItem:key=>s.store.get(key) || null,setItem:(key,value)=>s.store.set(key,value),removeItem:key=>s.store.delete(key)},XMLHttpRequest:XHR,navigator:{locks:{request:async(key,opts,fn)=>{if(s.locks.has(key))return fn(null);s.locks.add(key);try{return await fn({name:key});}finally{s.locks.delete(key);}}}},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,URL,URLSearchParams,FormData,Headers,Request,AbortController,Intl,Date,console};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);return sandbox;
}
function seed(s){
 const raw={url:origin+'/bitrix/services/main/ajax.php?action=tasks.task.elapsedTime.add',method:'POST',body:JSON.stringify({sessid:'old',taskId:129769,fields:{SECONDS:28800,COMMENT_TEXT:C.MARKER,USER_ID:1178}})};
 const p=C.compile(raw,{taskId:129769},1178);p.receiptPath=['data','id'];
 s.store.set(prefix+'1178:profile',JSON.stringify(p));s.store.set(prefix+'1178:selected',JSON.stringify({id:129769,title:'Default task'}));s.store.set(prefix+'1178:timeZone',JSON.stringify('Europe/Moscow'));return raw;
}
function journal(s){return JSON.parse(s.store.get(prefix+'1178:journal') || '{}');}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function meetingsUI(r){
 const element=()=>({children:[],hidden:false,textContent:'',disabled:false,append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});
 r.document.createElement=element;
 const ui={meetingsList:element(),meetingsStatus:element()};
 r.__testRuntime.setMeetingsUI(ui);return ui;
}
function calendarFixture(s,uid=1178){
 const r=runtime(s,uid),calls=[],date=C.day(),yesterday=C.day(new Date(Date.now()-86400000));
 const event=(NAME,time,extra={})=>({NAME,DATE_FROM:`${date} ${time}:00`,DATE_TO:`${date} ${time}:00`,MEETING_STATUS:'Y',...extra});
 r.window.BX.rest={callMethod(method,params,done){
  calls.push({method,params});
  done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : [
   event('Zoom','11:00',{DESCRIPTION:'[url=https://zoom.us/j/123]Подключиться[/url]'}),
   event('Без ссылки','09:00'),
   event('Другая ссылка','10:00',{DESCRIPTION:'<a href="https://example.com/">Открыть</a>'}),
   event('Teams','12:00',{'~DESCRIPTION':'&lt;a href=&quot;https://teams.live.com/meet/123&quot;&gt;Подключиться&lt;/a&gt;'}),
   event('Отклонён','08:00',{MEETING_STATUS:'N'}),
   event('Вчера','07:00',{DATE_FROM:`${yesterday} 07:00:00`,DESCRIPTION:'https://zoom.us/j/999'})
  ]});
 }};
 return {r,calls};
}
test('calendar defaults to linked calls and renders all today events as disabled when enabled',async()=>{
 const s=shared(),{r,calls}=calendarFixture(s);await r.__testRuntime.loadMeetings();
 const ui=meetingsUI(r);r.__testRuntime.renderMeetings();
 const names=()=>ui.meetingsList.children.map(button=>button.children[1].textContent);
 assert.deepEqual(names(),['Zoom','Teams']);
 assert.equal(r.__testRuntime.getMeetingsState().items.length,4);
 s.store.set(prefix+'1178:showAllMeetings','true');r.__testRuntime.renderMeetings();
 assert.deepEqual(names(),['Без ссылки','Другая ссылка','Zoom','Teams']);
 const [missing,unsupported,zoom,teams]=ui.meetingsList.children;
 for(const button of [missing,unsupported]){assert.equal(button.disabled,true);assert.equal(button.onclick,undefined);assert.equal(button.children[0].children[1].textContent,'Без ссылки');}
 const opened=[];r.window.open=(...args)=>opened.push(args);zoom.onclick();teams.onclick();
 assert.equal(zoom.disabled,false);assert.equal(teams.disabled,false);
 assert.deepEqual(opened,[['https://zoom.us/j/123','_blank','noopener'],['https://teams.live.com/meet/123','_blank','noopener']]);
 await r.__testRuntime.loadMeetings();assert.equal(calls.filter(call=>call.method==='calendar.event.get').length,1);
 s.store.set(prefix+'1178:showAllMeetings','false');r.__testRuntime.renderMeetings();assert.deepEqual(names(),['Zoom','Teams']);
});
test('show-all preference survives reload and is stored separately for each account',()=>{
 const s=shared();s.store.set(prefix+'1178:showAllMeetings','true');
 assert.equal(runtime(s).__testRuntime.showAllMeetings(),true);
 assert.equal(runtime(s,999).__testRuntime.showAllMeetings(),false);
});
test('a preference changed while loading also applies to the received calendar',async()=>{
 const s=shared(),{r}=calendarFixture(s),original=r.window.BX.rest.callMethod,wait=deferred();
 r.window.BX.rest.callMethod=(method,params,done)=>{if(method==='calendar.event.get')void wait.promise.then(()=>original(method,params,done));else original(method,params,done);};
 const loading=r.__testRuntime.loadMeetings();await new Promise(resolve=>setImmediate(resolve));
 s.store.set(prefix+'1178:showAllMeetings','true');const ui=meetingsUI(r);wait.resolve();await loading;
 assert.equal(ui.meetingsList.children.length,4);assert.equal(ui.meetingsList.children[0].disabled,true);
});
test('empty calendar and REST failures show the appropriate status',async()=>{
 const s=shared(),r=runtime(s),ui=meetingsUI(r);
 r.window.BX.rest={callMethod(method,params,done){done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : []});}};
 await r.__testRuntime.loadMeetings();assert.match(ui.meetingsStatus.textContent,/нет событий со ссылкой/);
 s.store.set(prefix+'1178:showAllMeetings','true');r.__testRuntime.renderMeetings();assert.equal(ui.meetingsStatus.textContent,'На сегодня нет событий в календаре.');
 r.window.BX.rest.callMethod=(method,params,done)=>done({error:()=> 'access denied'});
 await r.__testRuntime.loadMeetings(true);assert.equal(r.__testRuntime.getMeetingsState().status,'error');assert.match(ui.meetingsStatus.textContent,/Не удалось загрузить календарь: access denied/);
});
test('double click sends exactly one request',async()=>{
 const s=shared();seed(s);const wait=deferred();s.fetch=async()=>{await wait.promise;return {ok:true,status:200,json:async()=>({data:{id:891},errors:[]})}};
 const t=runtime(s);const first=t.__testRuntime.addDay();await t.__testRuntime.addDay();assert.equal(s.calls.length,1);wait.resolve();await first;assert.equal(journal(s)[C.day()].status,'done');
});
test('two tabs and reload cannot duplicate a daily record',async()=>{
 const s=shared();seed(s);const wait=deferred();s.fetch=async()=>{await wait.promise;return {ok:true,status:200,json:async()=>({data:{id:891},errors:[]})}};
 const a=runtime(s),b=runtime(s);const first=a.__testRuntime.addDay();await b.__testRuntime.addDay();assert.equal(s.calls.length,1);wait.resolve();await first;
 await runtime(s).__testRuntime.addDay();assert.equal(s.calls.length,1);
});
test('network failure stays pending across tabs and reload',async()=>{
 const s=shared();seed(s);s.fetch=async()=>{throw Error('connection lost')};await runtime(s).__testRuntime.addDay();
 assert.equal(journal(s)[C.day()].status,'pending');await runtime(s).__testRuntime.addDay();assert.equal(s.calls.length,1);
});
test('HTTP 500, malformed response and missing ID remain pending',async()=>{
 for(const response of [{ok:false,status:500,json:async()=>({status:'error',errors:[{message:'server'}]})},{ok:true,status:200,json:async()=>{throw Error('HTML')}},{ok:true,status:200,json:async()=>({status:'success',data:true})}]){
  const s=shared();seed(s);s.fetch=async()=>response;await runtime(s).__testRuntime.addDay();assert.equal(journal(s)[C.day()].status,'pending');
 }
});
test('explicit server rejection can be retried; no automatic retry',async()=>{
 const s=shared();seed(s);s.fetch=async()=>({ok:false,status:403,json:async()=>({status:'error',errors:[{message:'access denied'}]})});
 const a=runtime(s);await a.__testRuntime.addDay();assert.equal(s.calls.length,1);assert.equal(journal(s)[C.day()],undefined);await a.__testRuntime.addDay();assert.equal(s.calls.length,2);
});
test('unresolved previous day blocks today as well',async()=>{
 const s=shared();seed(s);s.store.set(prefix+'1178:journal',JSON.stringify({'2026-09-30':{status:'pending',taskId:123}}));await runtime(s).__testRuntime.addDay();assert.equal(s.calls.length,0);
});
test('different account never uses the first account profile',async()=>{
 const s=shared();seed(s);await runtime(s,999).__testRuntime.addDay();assert.equal(s.calls.length,0);
});
test('recorded request uses current selected task and session',async()=>{
 const s=shared();seed(s);s.store.set(prefix+'1178:selected',JSON.stringify({id:777,title:'New default'}));await runtime(s).__testRuntime.addDay();
 const body=JSON.parse(s.calls[0].options.body);assert.equal(body.taskId,777);assert.equal(body.sessid,'csrf-1178');assert.equal(body.fields.SECONDS,28800);assert.equal(s.calls[0].options.credentials,'same-origin');
});
test('quick eight-hour record uses the same daily lock as timer mode',async()=>{
 const s=shared();seed(s);const r=runtime(s);await r.__testRuntime.addDay(28800);await r.__testRuntime.startWorkDay();
 assert.equal(s.calls.length,1);assert.equal(r.__testRuntime.timerState(),null);assert.equal(journal(s)[C.day()].status,'done');
});
test('quick record cannot run while a work timer is active',async()=>{
 const s=shared();seed(s);const r=runtime(s);await r.__testRuntime.startWorkDay();await r.__testRuntime.addDay(28800);
 assert.equal(s.calls.length,0);assert.equal(r.__testRuntime.timerState().status,'running');
});
test('configured user time zone controls the workday boundary',()=>{
 const s=shared();seed(s);const r=runtime(s),instant=new Date('2026-10-01T21:30:00Z');
 s.store.set(prefix+'1178:timeZone',JSON.stringify('America/Los_Angeles'));assert.equal(r.__testRuntime.workDay(instant,1178),'2026-10-01');
 s.store.set(prefix+'1178:timeZone',JSON.stringify('Asia/Vladivostok'));assert.equal(r.__testRuntime.workDay(instant,1178),'2026-10-02');
});
test('work timer starts on the selected task and survives reload',async()=>{
 const s=shared();seed(s);const a=runtime(s);await a.__testRuntime.startWorkDay();
 const first=a.__testRuntime.timerState();assert.equal(first.status,'running');assert.equal(first.task.id,129769);assert.equal(first.date,C.day());
 const reloaded=runtime(s).__testRuntime.timerState();assert.equal(reloaded.startedAt,first.startedAt);assert.equal(reloaded.task.title,'Default task');
});
test('pause freezes elapsed time and continue resumes it',async()=>{
 const s=shared();seed(s);const key=prefix+'1178:workTimer';
 s.store.set(key,JSON.stringify({version:1,status:'running',date:C.day(),task:{id:129769,title:'Default task'},startedAt:Date.now()-5000,accumulatedMs:1000}));
 const r=runtime(s);await r.__testRuntime.togglePause();let state=r.__testRuntime.timerState();
 assert.equal(state.status,'paused');assert(state.accumulatedMs>=5500 && state.accumulatedMs<8000);
 const frozen=r.__testRuntime.timerElapsedMs(state);await r.__testRuntime.togglePause();state=r.__testRuntime.timerState();
 assert.equal(state.status,'running');assert(r.__testRuntime.timerElapsedMs({...state,status:'paused'}),frozen);
});
test('finishing records the actual elapsed seconds and clears timer',async()=>{
 const s=shared();seed(s);const key=prefix+'1178:workTimer';
 s.store.set(key,JSON.stringify({version:1,status:'paused',date:C.day(),task:{id:129769,title:'Default task'},startedAt:null,accumulatedMs:3661000}));
 const r=runtime(s);await r.__testRuntime.finishWorkDay();
 const body=JSON.parse(s.calls[0].options.body);assert.equal(body.fields.SECONDS,3661);assert.equal(journal(s)[C.day()].status,'done');assert.equal(s.store.has(key),false);
});
test('no cross-tab lock support means no outgoing mutation',async()=>{
 const s=shared();seed(s);const r=runtime(s);r.navigator.locks=undefined;await r.__testRuntime.addDay();assert.equal(s.calls.length,0);
});
test('native manual save is observed once, marks day done, saves no old token',async()=>{
 const s=shared();const raw=seed(s);s.store.delete(prefix+'1178:profile');
 s.fetch=async()=>({ok:true,status:200,json:async()=>({data:{id:891}}),clone:()=>({text:async()=>JSON.stringify({status:'success',data:{id:891},errors:[]})})});
 const r=runtime(s);await r.__testRuntime.armLearning();await r.window.fetch(raw.url,{method:'POST',body:raw.body,headers:{'Content-Type':'application/json'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.calls.length,1);assert.equal(journal(s)[C.day()].status,'done');assert(!s.store.get(prefix+'1178:profile').includes('old'));await r.__testRuntime.addDay();assert.equal(s.calls.length,1);
});
test('unsupported manual payload still proceeds, but no profile or duplicate',async()=>{
 const s=shared();const raw=seed(s);s.store.delete(prefix+'1178:profile');
 const body=JSON.parse(raw.body);body.fields.SECONDS=60;
 s.fetch=async()=>({ok:true,status:200,clone:()=>({text:async()=>JSON.stringify({data:{id:891},errors:[]})})});
 const r=runtime(s);await r.__testRuntime.armLearning();await r.window.fetch(raw.url,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(s.calls.length,1);assert.equal(journal(s)[C.day()].status,'pending');assert.equal(s.store.has(prefix+'1178:profile'),false);
});
test('manual setup accepts a structured 2xx response without entry ID',async()=>{
 const s=shared();const raw=seed(s);s.store.delete(prefix+'1178:profile');
 s.fetch=async()=>({ok:true,status:200,clone:()=>({text:async()=>JSON.stringify({status:'success',data:{saved:true},errors:[]})})});
 const r=runtime(s);await r.__testRuntime.armLearning();await r.window.fetch(raw.url,{method:'POST',body:raw.body,headers:{'Content-Type':'application/json'}});
 await new Promise(resolve=>setImmediate(resolve));
 const profile=JSON.parse(s.store.get(prefix+'1178:profile'));assert.equal(profile.successMode,'structured2xx');assert.equal(profile.receiptPath,null);assert.equal(journal(s)[C.day()].status,'done');
});
test('learned structured 2xx mode confirms later records without entry ID',async()=>{
 const s=shared();seed(s);const profile=JSON.parse(s.store.get(prefix+'1178:profile'));profile.successMode='structured2xx';profile.receiptPath=null;s.store.set(prefix+'1178:profile',JSON.stringify(profile));
 s.fetch=async()=>({ok:true,status:200,json:async()=>({status:'success',data:{saved:true},errors:[]})});
 await runtime(s).__testRuntime.addDay();assert.equal(journal(s)[C.day()].status,'done');
});
test('confirming an existing record works without a browser dialog',async()=>{
 const s=shared();seed(s);s.store.set(prefix+'1178:journal',JSON.stringify({[C.day()]:{status:'pending',taskId:129769}}));
 const r=runtime(s);let confirms=0;r.window.confirm=()=>{confirms++;return false};r.__testRuntime.resolvePending(true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(confirms,0);assert.equal(journal(s)[C.day()].status,'done');
});
test('allowing a retry still requires explicit synchronous confirmation',async()=>{
 const s=shared();seed(s);s.store.set(prefix+'1178:journal',JSON.stringify({[C.day()]:{status:'pending',taskId:129769}}));
 const r=runtime(s);let confirms=0;r.window.confirm=()=>{confirms++;return false};r.__testRuntime.resolvePending(false);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(confirms,1);assert.equal(journal(s)[C.day()].status,'pending');
});
