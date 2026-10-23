const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const C=require('../../BetterBitrix.user.js');
const runtimeSource=fs.readFileSync(path.join(__dirname,'../extension/runtime.js'),'utf8');
const browserSource=fs.readFileSync(path.join(__dirname,'../../BetterBitrix.user.js'),'utf8').replace(/\}\)\(\);\s*$/, 'window.__browser={startWorkDay,togglePause,finishWorkDay,addDay};})();');
const prefix='b24-eight-hours-v1:';
const origin='https://b24.entgld.com';
function fixture(order=['desktop']) {
  const store=new Map(),locks=new Set(),calls=[];
  // Start in the morning so elapsed-duration checks cannot cross midnight accidentally.
  let uid=1178, now=Date.parse(C.day(new Date(),'Europe/Moscow')+'T06:00:00Z'), response=async()=>({ok:true,status:200,json:async()=>({data:{id:891},errors:[]})});
  class Clock extends Date {constructor(...args){super(...(args.length ? args : [now]));}static now(){return now;}}
  class XHR {open(){}send(){}setRequestHeader(){}addEventListener(){}}
  const window={BX:{message:()=>uid,bitrix_sessid:()=>`secret-csrf-${uid}`},fetch:async(url,options)=>{calls.push({url,options});return response();},addEventListener(){}};
  window.top=window;
  const document={readyState:'loading',body:null,addEventListener(){},querySelectorAll:()=>[],querySelector:()=>({textContent:'Проект'}),getElementById:()=>null};
  const sandbox={window,location:{origin,href:origin+'/company/personal/user/1178/tasks/task/view/129769/',pathname:'/company/personal/user/1178/tasks/task/view/129769/'},document,localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},XMLHttpRequest:XHR,navigator:{locks:{request:async(key,opts,fn)=>{if(locks.has(key))return fn(null);locks.add(key);try{return await fn({name:key});}finally{locks.delete(key);}}}},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,URL,URLSearchParams,FormData,Headers,Request,AbortController,Intl,Date:Clock,console};
  vm.createContext(sandbox);
  for(const name of order) vm.runInContext(name==='desktop' ? runtimeSource : browserSource,sandbox);
  const raw={url:origin+'/bitrix/services/main/ajax.php?action=tasks.task.elapsedTime.add',method:'POST',body:JSON.stringify({sessid:'old-secret',taskId:129769,fields:{SECONDS:28800,COMMENT_TEXT:C.MARKER,USER_ID:1178}})};
  const profile=C.compile(raw,{taskId:129769},1178);profile.receiptPath=['data','id'];
  store.set(prefix+'1178:profile',JSON.stringify(profile));store.set(prefix+'1178:selected',JSON.stringify({id:129769,title:'Проект'}));store.set(prefix+'1178:timeZone',JSON.stringify('Europe/Moscow'));
  const execute=(command,params={},expectedUid=uid)=>window.__betterBitrixDesktop.execute(command,params,expectedUid);
  return {store,calls,window,sandbox,execute,advance:ms=>now+=ms,setUid:value=>uid=value,setResponse:fn=>response=fn};
}
test('desktop snapshot contains no profile, cookies or CSRF and does not mount/change browser UI',async()=>{
  const f=fixture();const before=[...f.store];const state=await f.execute('state');
  assert.equal(state.uid,1178);assert.equal(state.canPrimary,true);assert.deepEqual([...f.store],before);
  assert.doesNotMatch(JSON.stringify(state),/secret|sessid|receiptPath|encoding|cookie/i);
  assert.equal(f.window.__b24EightHoursInstalled,undefined);
  assert.equal(f.sandbox.document.body,null);
});
test('Windows bridge includes Teams cloud meetings and saves the same daily URL',async()=>{
 const f=fixture(),url='https://teams.cloud.microsoft/meet/123456789?p=AbCd_12-xy';
 f.window.BX.rest={callMethod(method,params,done){done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : [
  {NAME:'Teams cloud',DATE_FROM:C.day()+' 10:00:00',DESCRIPTION:`[url=${url}]Присоединиться[/url]`}
 ]});}};
 const state=await f.execute('meetings');
 assert.equal(state.meetings.length,1);assert.equal(state.meetings[0].url,url);
 assert.equal(state.meetings[0].provider,'Teams');
 const settings=await f.execute('settings',{dailyUrl:url,timeZone:'Europe/Moscow'});
 assert.equal(settings.dailyUrl,url);
});
test('desktop timer survives runtime recreation and records exact elapsed duration',async()=>{
  const f=fixture();await f.execute('start');f.advance(3600000);await f.execute('pause');
  f.advance(1800000);await f.execute('pause');f.advance(60000);
  vm.runInContext(runtimeSource,f.sandbox);await f.execute('finish');
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].options.body).fields.SECONDS,3660);
  assert.equal((await f.execute('state')).dayDone,true);assert.equal((await f.execute('state')).timer,null);
  await assert.rejects(f.execute('quickAdd'),/недоступно/);
});
for(const order of [['browser','desktop'],['desktop','browser']]) {
  test(`browser and desktop share one timer and one daily write (${order.join(' first, ')})`,async()=>{
    const f=fixture(order);await f.window.__browser.startWorkDay();
    assert.equal((await f.execute('state')).timer.status,'running');
    f.advance(30000);
    let done;f.setResponse(()=>new Promise(resolve=>done=()=>resolve({ok:true,status:200,json:async()=>({data:{id:891},errors:[]})})));
    const finishing=f.execute('finish');
    await new Promise(resolve=>setImmediate(resolve));
    await f.window.__browser.finishWorkDay();assert.equal(f.calls.length,1);
    done();await finishing;await f.window.__browser.addDay();assert.equal(f.calls.length,1);
  });
}
test('account switch rejects stale commands before changing storage or sending requests',async()=>{
  const f=fixture();f.setUid(999);const before=[...f.store];
  await assert.rejects(f.execute('start',{},1178),/Пользователь Bitrix изменился/);
  assert.deepEqual([...f.store],before);assert.equal(f.calls.length,0);
  assert.equal((await f.execute('state')).uid,999);
});
test('ambiguous write blocks both interfaces until explicit verified resolution',async()=>{
  const f=fixture(['desktop','browser']);await f.execute('start');f.advance(10000);
  f.setResponse(async()=>{throw Error('network failure');});await f.execute('finish');
  assert.equal((await f.execute('state')).pending,true);
  await assert.rejects(f.execute('quickAdd'),/недоступно/);
  await f.window.__browser.addDay();assert.equal(f.calls.length,1);
  await assert.rejects(f.execute('resolve',{exists:false}),/проверьте/);
  await f.execute('resolve',{exists:false,verified:true});
  assert.equal((await f.execute('state')).pending,false);assert.equal((await f.execute('state')).timer.status,'paused');
});
test('settings reject unsafe URLs and preserve the workday zone during an active timer',async()=>{
  const f=fixture();await assert.rejects(f.execute('settings',{dailyUrl:'https://evil.example/',timeZone:'UTC'}),/HTTPS/);
  await f.execute('start');
  await assert.rejects(f.execute('settings',{dailyUrl:'https://zoom.us/j/123',timeZone:'UTC'}),/недоступно/);
  await f.execute('settings',{dailyUrl:'https://zoom.us/j/123',timeZone:'Europe/Moscow',showAllMeetings:true});
  const state=await f.execute('state');assert.equal(state.dailyUrl,'https://zoom.us/j/123');assert.equal(state.showAllMeetings,true);
});
test('calendar serializes titles and disabled unlinked events for the Windows panel',async()=>{
  const f=fixture();const date=C.day(new Date(), 'Europe/Moscow');
  f.window.BX.rest={callMethod(method,params,done){done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : [
    {NAME:'Дейлик',DATE_FROM:date+' 10:00:00',DATE_TO:date+' 10:30:00',MEETING_STATUS:'Y',DESCRIPTION:'[url=https://zoom.us/j/123]Войти[/url]'},
    {NAME:'Планирование',DATE_FROM:date+' 11:00:00',MEETING_STATUS:'Y'},
    {NAME:'Отклонён',DATE_FROM:date+' 12:00:00',MEETING_STATUS:'N',DESCRIPTION:'https://zoom.us/j/999'}
  ]});}};
  let state=await f.execute('meetings');assert.equal(state.meetings.length,1);assert.equal(state.meetings[0].title,'Дейлик');
  await f.execute('settings',{timeZone:'Europe/Moscow',showAllMeetings:true});state=await f.execute('state');
  assert.equal(state.meetings.length,2);assert.equal(state.meetings[1].url,'');
});

test('calibration and unknown commands have explicit guards',async()=>{
  const f=fixture();await f.execute('start');await assert.rejects(f.execute('configure'),/недоступно/);
  await assert.rejects(f.execute('arbitraryFetch',{url:'https://example.com'}),/Неизвестная/);
});
test('calendar drops yesterday events at midnight before the next refresh',async()=>{
  const f=fixture();const date=C.day(new Date(),'Europe/Moscow');
  f.window.BX.rest={callMethod(method,params,done){done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : [{NAME:'Сегодня',DATE_FROM:date+' 10:00:00',DESCRIPTION:'https://zoom.us/j/123'}]});}};
  assert.equal((await f.execute('meetings')).meetings.length,1);
  f.advance(86400000);const state=await f.execute('state');assert.equal(state.meetings.length,0);assert.equal(state.meetingsStatus,'idle');
});

test('Windows receives each weekly occurrence with the original series UTC timestamp',async()=>{
 const f=fixture(),first=C.day(new Date(),'Europe/Moscow'),stamp=Date.parse(first+'T07:00:00Z')/1000;
 f.window.BX.rest={callMethod(method,params,done){done({data:()=>method==='calendar.user.settings.get' ? {timezoneName:'Europe/Moscow'} : [
  {NAME:'Повтор',DATE_FROM:params.from+' 10:00:00',DATE_TO:params.from+' 10:30:00',DATE_FROM_TS_UTC:stamp,ORIGINAL_DATE_FROM:first+' 10:00:00',RRULE:{FREQ:'WEEKLY'},DESCRIPTION:'https://zoom.us/j/123'}
 ]});}};
 for(let week=0;week<3;week++){
  const state=await f.execute('meetings');assert.equal(state.meetings.length,1);assert.equal(state.meetings[0].time,'10:00–10:30');
  f.advance(7*86400000);
 }
});
for(const order of [['browser','desktop'],['desktop','browser']]) {
  test(`manual calibration is observed once with both runtimes (${order.join(', ')})`,async()=>{
    const f=fixture(order);f.store.delete(prefix+'1178:profile');await f.execute('configure');
    f.setResponse(async()=>new Response(JSON.stringify({data:{id:891},errors:[]}),{status:200,headers:{'Content-Type':'application/json'}}));
    const body=JSON.stringify({sessid:'secret-live',taskId:129769,fields:{SECONDS:28800,COMMENT_TEXT:C.MARKER,USER_ID:1178}});
    await f.window.fetch(origin+'/bitrix/services/main/ajax.php?action=tasks.task.elapsedTime.add',{method:'POST',body});
    await new Promise(resolve=>setImmediate(resolve));
    const state=await f.execute('state');assert.equal(state.dayDone,true);assert.equal(state.pending,false);assert.equal(f.calls.length,1);
    assert.doesNotMatch(f.store.get(prefix+'1178:profile'),/secret-live/);
  });
}
  test('desktop runtime includes the current browser calendar core',()=>{
    const browser=fs.readFileSync(path.join(__dirname,'../../BetterBitrix.user.js'),'utf8');
    assert.ok(runtimeSource.includes(browser.slice(browser.indexOf('  function decodeLinkEntities'),browser.indexOf('  const Core='))));
});
