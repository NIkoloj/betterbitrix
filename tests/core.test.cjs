const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const C=require('../BetterBitrix.user.js');
const arm={taskId:129769,userId:1178,date:'2026-10-01'};
const base={url:'https://b24.entgld.com/bitrix/services/main/ajax.php?action=tasks.task.elapsedTime.add',method:'POST',contentType:'application/json',body:JSON.stringify({sessid:'old-secret',taskId:129769,fields:{SECONDS:28800,COMMENT_TEXT:C.MARKER,USER_ID:1178}})};
const compile=(raw=base)=>C.compile(raw,arm,1178);
test('change task and current CSRF without preserving the old token',()=>{
 const p=compile();assert(!JSON.stringify(p).includes('old-secret'));
 const r=C.render(p,555,'new-secret','2026-10-02');const body=JSON.parse(r.body);
 assert.equal(body.taskId,555);assert.equal(body.sessid,'new-secret');assert.equal(body.fields.SECONDS,28800);assert.equal(body.fields.COMMENT_TEXT,'Работа над проектом');assert.equal(body.fields.USER_ID,1178);
});
test('recorded duration is rendered from the timer',()=>{
 const p=compile();
 const body=JSON.parse(C.render(p,555,'new-secret','2026-10-02',3661).body);
 assert.equal(body.fields.SECONDS,3661);
});
test('minute and hour-minute forms receive the actual timer duration',()=>{
 const minutesRaw={...base,body:JSON.stringify({sessid:'old',taskId:129769,fields:{MINUTES:480,COMMENT_TEXT:C.MARKER,USER_ID:1178}})};
 const minutes=JSON.parse(C.render(compile(minutesRaw),555,'new','2026-10-02',3690).body);
 assert.equal(minutes.fields.MINUTES,62);
 const partsRaw={...base,body:JSON.stringify({sessid:'old',taskId:129769,fields:{HOURS:8,MINUTES:0,COMMENT_TEXT:C.MARKER,USER_ID:1178}})};
 const parts=JSON.parse(C.render(compile(partsRaw),555,'new','2026-10-02',34201).body);
 assert.equal(parts.fields.HOURS,9);assert.equal(parts.fields.MINUTES,30);
});
test('version 1 learned profile migrates without losing settings',()=>{
 const old=compile();old.version=1;old.tree.fields.SECONDS=28800;
 const migrated=C.migrateProfile(old);
 assert.equal(migrated.version,2);
 assert.equal(JSON.parse(C.render(migrated,555,'new','2026-10-02',1234).body).fields.SECONDS,1234);
});
test('PHP bracket fields and duplicate fields survive encoding',()=>{
 const body=new URLSearchParams([['sessid','old'],['taskId','129769'],['data[SECONDS]','28800'],['data[COMMENT_TEXT]',C.MARKER],['x[]','a'],['x[]','b']]);
 const r=C.render(compile({...base,body,contentType:'application/x-www-form-urlencoded'}),222,'fresh','2026-10-02');
 assert.equal(r.body.get('taskId'),'222');assert.equal(r.body.get('data[SECONDS]'),'28800');assert.deepEqual(r.body.getAll('x[]'),['a','b']);assert.equal(r.body.get('sessid'),'fresh');
});
test('legacy single-action query JSON inside a form',()=>{
 const query=[{method:'task.elapseditem.add',arguments:[129769,{SECONDS:28800,COMMENT_TEXT:C.MARKER}]}];
 const body=new URLSearchParams({sessid:'old',QUERY:JSON.stringify(query)});
 const p=compile({...base,url:'https://b24.entgld.com/bitrix/components/bitrix/tasks.task/ajax.php',body});
 const output=C.render(p,444,'fresh','2026-10-02');
 const changed=JSON.parse(output.body.get('QUERY'));assert.equal(changed[0].arguments[0],444);assert.equal(changed[0].arguments[1].SECONDS,28800);
});
test('header-only CSRF request can be learned without storing headers',()=>{
 const input=JSON.parse(base.body);delete input.sessid;
 const p=compile({...base,body:JSON.stringify(input),csrfHeader:true});assert.equal(p.csrfHeader,true);
 assert.throws(()=>compile({...base,body:JSON.stringify(input)}),/sessid/);
});
test('reject wrong task, wrong user and duration',()=>{
 for(const [field,value] of [['taskId',999],['user',900],['seconds',60]]){
  const body=JSON.parse(base.body);if(field==='user')body.fields.USER_ID=value;else if(field==='seconds')body.fields.SECONDS=value;else body[field]=value;
  assert.throws(()=>compile({...base,body:JSON.stringify(body)}));
 }
});
test('reject cross-origin, REST secrets and multi-action requests',()=>{
 assert.throws(()=>compile({...base,url:'https://evil.example/bitrix/services/main/ajax.php?action=tasks.task.elapsedTime.add'}));
 assert.throws(()=>compile({...base,url:'https://b24.entgld.com/rest/1178/secret/task.elapseditem.add'}));
 const body=JSON.parse(base.body);body.auth='secret';assert.throws(()=>compile({...base,body:JSON.stringify(body)}));
 const query=[{method:'task.elapseditem.add',arguments:[129769,{SECONDS:28800,COMMENT_TEXT:C.MARKER}]},{method:'task.update',arguments:[129769,{STATUS:5}]}];
 assert.throws(()=>compile({...base,body:new URLSearchParams({QUERY:JSON.stringify(query),sessid:'old'})}),/несколько/);
});
test('date changes but interval replay is refused',()=>{
 const body=JSON.parse(base.body);body.fields.CREATED_DATE='01.10.2026';
 const output=JSON.parse(C.render(compile({...base,body:JSON.stringify(body)}),555,'new','2026-10-02').body);
 assert.equal(output.fields.CREATED_DATE,'02.10.2026');
 body.fields.DATE_START='2026-10-01T09:00:00';assert.throws(()=>compile({...base,body:JSON.stringify(body)}),/интервал/);
});
test('task ID in native page endpoint changes too',()=>{
 const p=compile({...base,url:'https://b24.entgld.com/company/personal/user/1178/tasks/task/view/129769/?action=tasks.task.elapsedTime.add'});
 assert.match(C.render(p,999,'new').url,/\/task\/view\/999\//);
});
test('only concrete entry ID is success, failures and booleans are not',()=>{
 for(const json of [{result:789},{status:'success',data:{id:'789'},errors:[]},{DATA:[{RESULT:789,ERRORS:[]}]}])assert.equal(C.receipt(json).id,789);
 for(const json of [{status:'success',data:true},{status:'error',data:{id:789},errors:[{message:'no'}]},{result:0},{result:[{result:789},{result:790}]},{result:789,ERRORS:['oops']},{result:true}]) assert.equal(C.receipt(json),null);
});
test('daily rollover uses Moscow time',()=>{
 assert.equal(C.day(new Date('2026-10-01T20:59:59Z')),'2026-10-01');assert.equal(C.day(new Date('2026-10-01T21:00:00Z')),'2026-10-02');
});
test('day boundary supports each user time zone',()=>{
 const instant=new Date('2026-10-01T21:30:00Z');
 assert.equal(C.day(instant,'America/Los_Angeles'),'2026-10-01');assert.equal(C.day(instant,'Asia/Vladivostok'),'2026-10-02');
});
test('only HTTPS Zoom and Teams links are accepted from event descriptions',()=>{
 assert.match(C.safeCallUrl('https://company.zoom.us/j/123?pwd=abc'),/zoom\.us/);
 assert.match(C.safeCallUrl('https://teams.microsoft.com/l/meetup-join/abc'),/teams\.microsoft\.com/);
 for(const value of ['http://zoom.us/j/123','https://zoom.us.evil.test/j/123','javascript:alert(1)','https://user:pass@zoom.us/j/123']) assert.equal(C.safeCallUrl(value),null);
 const links=C.callLinks({DESCRIPTION:'Join <a href="https://company.zoom.us/j/123?pwd=a&amp;b=2">call</a>'});
 assert.equal(links.length,1);assert.match(links[0],/pwd=a&b=2/);
});
test('HTML hyperlink targets work with quotes, escaped markup and numeric entities',()=>{
 const expected='https://company.zoom.us/j/123?pwd=a&b=2';
 for(const description of [
  '<a class="join" title="Время > 10:00" href="https://company.zoom.us/j/123?pwd=a&amp;b=2">Подключиться</a>',
  "<A HREF='https://company.zoom.us/j/123?pwd=a&#x26;b=2'>Подключиться</A>",
  '<a href=https://company.zoom.us/j/123?pwd=a&#38;b=2 target=_blank>Подключиться</a>',
  '&lt;a href=&quot;https://company.zoom.us/j/123?pwd=a&amp;amp;b=2&quot;&gt;Подключиться&lt;/a&gt;',
  '&#60;a href=&#34;https&#58;&#47;&#47;company.zoom.us/j/123?pwd=a&#38;b=2&#34;&#62;Подключиться&#60;/a&#62;'
 ]) assert.deepEqual(C.callLinks(description),[expected]);
});
test('BBCode hyperlinks return their target without markup or label text',()=>{
 const zoom='https://zoom.us/j/123?pwd=abc',teams='https://teams.microsoft.com/l/meetup-join/abc?context=a&b=2';
 for(const description of [
  `[URL=${zoom}]Подключиться[/URL]`,
  `[url="${zoom}"]Подключиться[/url]`,
  `[url='${zoom}']Подключиться[/url]`,
  `[url]${zoom}[/url]`
 ]) assert.deepEqual(C.callLinks(description),[zoom]);
 assert.deepEqual(C.callLinks({DESCRIPTION:`[url=${teams.replace('&','&amp;')}]Teams[/url]`,'~DESCRIPTION':teams}),[teams]);
 assert.deepEqual(C.callLinks(`[b]${zoom}[/b]`),[zoom]);
});
test('hyperlink labels cannot substitute a different or unsafe target',()=>{
 const expected='https://teams.live.com/meet/123';
 assert.deepEqual(C.callLinks(`<a title=" href='https://zoom.us/j/999' " href="${expected}">Подключиться</a>`),[expected]);
 assert.deepEqual(C.callLinks(`<https://zoom.us/j/123>`),['https://zoom.us/j/123']);
 assert.deepEqual(C.callLinks(`<a href="${expected}">https://zoom.us/j/999</a>`),[expected]);
 assert.deepEqual(C.callLinks(`[url=${expected}]https://zoom.us/j/999[/url]`),[expected]);
 for(const target of ['javascript:alert(1)','http://zoom.us/j/123','https://zoom.us.evil.test/j/123','https://user:pass@zoom.us/j/123']) {
  assert.deepEqual(C.callLinks(`<a href="${target}">https://zoom.us/j/999</a>`),[]);
  assert.deepEqual(C.callLinks(`[url=${target}]https://zoom.us/j/999[/url]`),[]);
 }
});
test('meeting time is copied from Bitrix calendar strings without timezone conversion',()=>{
 assert.equal(C.calendarEventTime({DATE_FROM:'02.10.2026 09:15:00',DATE_TO:'02.10.2026 10:00:00',DATE_FROM_TS_UTC:'1'}),'09:15–10:00');
 assert.equal(C.calendarEventTime({DATE_FROM:'10/02/2026 05:30:00 pm',DATE_TO:'10/02/2026 06:15:00 pm'}),'05:30 PM–06:15 PM');
 assert.equal(C.calendarEventTime({DT_SKIP_TIME:'Y'}),'Весь день');
});
test('meeting day follows Bitrix calendar settings, not timer or browser timezone',()=>{
 const now=new Date('2026-10-01T21:30:00Z');
 const context=C.calendarContext({timezoneName:'Asia/Vladivostok',timezoneOffsetUTC:36000},now);
 assert.deepEqual(context,{date:'2026-10-02',zone:'Asia/Vladivostok',offsetSeconds:36000});
 assert.equal(C.calendarEventOnDay({DATE_FROM_TS_UTC:String(Date.parse('2026-10-02T00:15:00+10:00')/1000)},context.date,context),true);
 assert.equal(C.calendarEventOnDay({DATE_FROM_TS_UTC:String(Date.parse('2026-10-01T18:00:00+10:00')/1000)},context.date,context),false);
});
test('meetings sort by the clock shown by Bitrix instead of UTC timestamp',()=>{
 assert.equal(C.calendarEventMinutes({DATE_FROM:'02.10.2026 09:15:00'}),555);
 assert.equal(C.calendarEventMinutes({DATE_FROM:'10/02/2026 05:30:00 pm'}),1050);
 assert.equal(C.calendarEventMinutes({DT_SKIP_TIME:'Y'}),-1);
});
test('compact UI keeps timer on the main button and exposes collapse control',()=>{
 const source=fs.readFileSync(require.resolve('../BetterBitrix.user.js'),'utf8');
 assert.match(source,/@name\s+BetterBitrix/);assert.match(source,/@version\s+2\.3\.1/);assert.match(source,/<span class="title">BetterBitrix<\/span>/);
 assert.match(source,/@updateURL\s+https:\/\/nikoloj\.github\.io\/betterbitrix\/BetterBitrix\.meta\.js/);
 assert.match(source,/@downloadURL\s+https:\/\/nikoloj\.github\.io\/betterbitrix\/BetterBitrix\.user\.js/);
 assert.match(source,/id="collapse"/);assert.match(source,/ui\.collapse\.onclick/);
 assert.match(source,/class="icon" id="settingsToggle"[^>]+aria-label="Настройки"/);assert.doesNotMatch(source,/id="settingsToggle"[^>]*>Настройки<\/button>/);
 assert.match(source,/`■  Завершить · \$\{clock\}`/);assert.doesNotMatch(source,/id="workState"|id="elapsed"/);
});
test('UI exposes icon-only quick eight-hour action',()=>{
 const source=fs.readFileSync(require.resolve('../BetterBitrix.user.js'),'utf8');
 assert.match(source,/id="quickAdd"[^>]+aria-label="Записать 8 часов сразу"/);assert.match(source,/ui\.quickAdd\.onclick=\(\)=>addDay\(28800\)/);
});
test('UI exposes calendar and locally configured daily-call actions',()=>{
 const source=fs.readFileSync(require.resolve('../BetterBitrix.user.js'),'utf8');
 assert.match(source,/id="meetingsToggle"/);assert.match(source,/calendar\.event\.get/);assert.match(source,/event\?\.DESCRIPTION,event\?\.\['~DESCRIPTION'\]/);
 assert.match(source,/id="daily"/);assert.match(source,/id="dailyUrl"/);
});
