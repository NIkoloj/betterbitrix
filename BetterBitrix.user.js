// ==UserScript==
// @name         BetterBitrix
// @namespace    local.bitrix-eight-hours
// @version      2.3.0
// @description  Рабочий таймер, быстрые 8 часов и ссылки на созвоны из календаря Bitrix.
// @homepageURL  https://nikoloj.github.io/betterbitrix/
// @supportURL   https://github.com/NIkoloj/betterbitrix/issues
// @updateURL    https://nikoloj.github.io/betterbitrix/BetterBitrix.meta.js
// @downloadURL  https://nikoloj.github.io/betterbitrix/BetterBitrix.user.js
// @match        https://b24.entgld.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  const MARKER = 'Работа над проектом';
  const PREFIX = 'b24-eight-hours-v1:';
  const ORIGIN = 'https://b24.entgld.com';
  const clone = value => JSON.parse(JSON.stringify(value));
  const positive = value => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
  const day = (date = new Date(), timeZone = 'Europe/Moscow') => new Intl.DateTimeFormat('sv-SE', {timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
  function isValidTimeZone(value) {
    if(typeof value!=='string' || !value) return false;
    try { new Intl.DateTimeFormat('en',{timeZone:value}).format(); return true; } catch { return false; }
  }
  const token = kind => ({__b24hToken: kind});
  const kind = key => String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  function walk(value, visitor, path = []) {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], visitor, [...path, key]);
    } else visitor(value, path);
  }
  function get(object, path) { return path.reduce((value, key) => value?.[key], object); }
  function set(object, path, value) {
    const parent = get(object, path.slice(0,-1));
    parent[path.at(-1)] = value;
  }
  function decodeValue(value) {
    if (typeof value !== 'string') return value;
    if (/^\s*[\[{]/.test(value)) {
      try { return {__b24hJson: JSON.parse(value)}; } catch { /* plain text */ }
    }
    return value;
  }
  function decodeBody(body, contentType = '') {
    if (typeof body === 'string' && body.length > 150000) throw Error('Слишком большой запрос.');
    if (typeof body === 'string' && /^\s*\{/.test(body)) return {encoding:'json', tree:JSON.parse(body)};
    let pairs;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      pairs = [...body.entries()];
      if (pairs.some(([,value]) => typeof value !== 'string')) throw Error('Запрос с файлами не поддерживается.');
    } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) pairs = [...body.entries()];
    else if (typeof body === 'string' && (body.includes('=') || /urlencoded/.test(contentType))) pairs = [...new URLSearchParams(body).entries()];
    else throw Error('Неизвестный формат запроса.');
    // Ordered entries preserve duplicate form keys and PHP bracket notation.
    return {encoding: body instanceof FormData ? 'form' : 'urlencoded', tree:pairs.map(([key,value]) => ({key, value:decodeValue(value)}))};
  }
  function leafKey(tree, path) {
    // Flattened forms use the original field name; nested JSON uses its own key.
    if (path.length === 2 && path[1] === 'value' && Array.isArray(tree)) return tree[path[0]].key;
    return path.at(-1);
  }
  function receipt(json) {
    if (!json || typeof json !== 'object') return null;
    const failed = [];
    walk(json, (value, path) => {
      const key = kind(path.at(-1));
      if ((key === 'error' || key === 'errors') && value && value !== '0') failed.push(value);
      if ((key === 'status' || key === 'success') && (value === 'error' || value === false)) failed.push(value);
    });
    // Arrays/objects of errors need a separate check (walk only visits leaves).
    function errors(value) {
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(([key,v]) =>
        (/^errors?$/i.test(key) && Boolean(v) && (typeof v !== 'object' || Object.keys(v).length > 0)) || errors(v));
    }
    if (failed.length || errors(json)) return null;
    const paths = [['result'],['data'],['data','id'],['data','ID'],['data','elapsedTime','id'],['data','elapsedItem','id'],['result','id']];
    for (const path of paths) if (positive(get(json,path))) return {path, id:Number(get(json,path))};
    // Native Tasks dispatcher: one command only, result must be an entry ID.
    for (const root of ['result','data','DATA','RESULT']) {
      const list = json[root];
      if (Array.isArray(list) && list.length === 1) {
        for (const key of ['result','RESULT','data','DATA']) {
          const value = list[0]?.[key];
          if (positive(value)) return {path:[root,'0',key],id:Number(value)};
          if (positive(value?.ID)) return {path:[root,'0',key,'ID'],id:Number(value.ID)};
          if (positive(value?.id)) return {path:[root,'0',key,'id'],id:Number(value.id)};
        }
      }
    }
    return null;
  }
  function definiteError(json) {
    // Only a structured rejection; network failures and HTTP 500 remain uncertain.
    if (!json || typeof json !== 'object') return false;
    let rejected=false;
    const scan=(value,key='')=>{
      const normalized=kind(key);
      if ((normalized === 'status' && String(value).toLowerCase() === 'error') ||
          (normalized === 'success' && value === false) ||
          (/^errors?(?:description|message)?$/.test(normalized) && Boolean(value) &&
            (typeof value !== 'object' || Object.keys(value).length > 0))) rejected=true;
      if(value && typeof value === 'object') for(const [childKey,child] of Object.entries(value)) scan(child,childKey);
    };
    scan(json);
    return rejected && !receipt(json);
  }
  const structuredSuccess=(status,json)=>status >= 200 && status < 300 && json && typeof json === 'object' && Object.keys(json).length > 0 && !definiteError(json);
  function compile(raw, arm, userId) {
    const url = new URL(raw.url, ORIGIN);
    if (url.origin !== ORIGIN || !/^\/(?:bitrix\/|company\/|workgroups\/)/.test(url.pathname) || url.username || url.password) throw Error('Не штатный адрес Bitrix.');
    if (raw.method !== 'POST') throw Error('Поддерживаются только POST-запросы.');
    const parsed = decodeBody(raw.body, raw.contentType);
    const tree = parsed.tree;
    if (!JSON.stringify(tree).includes(MARKER)) return null;
    // Never learn a combined batch that could also post a comment/change a task.
    let actionCount = 0;
    let operation = url.searchParams.get('action') || '';
    walk(tree, (value,path) => {
      const key = kind(leafKey(tree,path));
      if (['action','method','command'].includes(key) && typeof value === 'string') { actionCount++; operation += ' ' + value; }
    });
    if (actionCount > 1) throw Error('Bitrix объединил несколько действий. Такой запрос не повторяется.');
    const allowed = /(?:task\.elapseditem\.add|tasks\.(?:task\.)?(?:elapsedtime|elapseditem|time(?:spent)?)\.add|addelapsed(?:time|item))/i;
    if (!allowed.test(operation)) throw Error('Не распознан отдельный метод добавления трудозатрат.');
    let tasks=0, comments=0, times=0, csrf=raw.csrfHeader ? 1 : 0;
    const fields=[];
    walk(tree, (value,path) => fields.push({value,path,key:kind(leafKey(tree,path))}));
    for (const {value,path,key} of fields) {
      if (['auth','authorization','accesstoken','refreshtoken','password','webhook','token'].includes(key)) throw Error('Запрос содержит постоянный ключ доступа и не будет сохранён.');
      if (key === 'key' && path.length === 2 && Array.isArray(tree)) continue;
      if (key === 'sessid' || key === 'csrftoken' || key === 'bxcsrf') { set(tree,path,token('csrf')); csrf++; continue; }
      if (['taskid','task','itemid'].includes(key) || /(?:taskid|task)\d*$/.test(key)) {
        if (String(value) !== String(arm.taskId)) throw Error('ID задачи не совпадает с задачей настройки.');
        set(tree,path,token(typeof value === 'number' ? 'taskNumber' : 'task')); tasks++; continue;
      }
      // Legacy dispatcher positional argument 0: [taskId, {SECONDS, COMMENT_TEXT}].
      if (path.at(-1) === '0' && Array.isArray(get(tree,path.slice(0,-1))) &&
          /(?:args|arguments|parameters|params)/i.test(path.slice(0,-1).join('.')) && String(value) === String(arm.taskId)) {
        set(tree,path,token(typeof value === 'number' ? 'taskNumber' : 'task')); tasks++; continue;
      }
      if (['seconds','minutes','hours'].includes(key) || /(?:seconds|minutes|hours)$/.test(key)) continue;
      if (['userid','authorid'].includes(key) && positive(value) && Number(value) !== Number(userId)) throw Error('Запись предназначена другому пользователю.');
      if (typeof value === 'string' && value.includes(MARKER)) {
        if (!/comment|description/.test(key)) throw Error('Метка находится не в комментарии к времени.');
        set(tree,path,token('comment')); comments++; continue;
      }
      if (/^(?:createddate|date|datestart|datestop|dateend|startdate|enddate)$/.test(key) && value) {
        // Only an explicit record date, never stale start/stop ranges.
        if (key !== 'createddate' && key !== 'date') throw Error('Запрос содержит интервал дат. Эта форма пока не поддерживается.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !/^\d{2}\.\d{2}\.\d{4}$/.test(value)) throw Error('Неизвестный формат даты записи.');
        const capturedDate=value.includes('.') ? value.split('.').reverse().join('-') : value;
        if(arm.date && capturedDate!==arm.date) throw Error('Для настройки нужна сегодняшняя дата записи.');
        set(tree,path,token(value.includes('.') ? 'dateRU' : 'date'));
      }
    }
    const timeFields=fields.filter(({key})=>['seconds','minutes','hours'].includes(key) || /(?:seconds|minutes|hours)$/.test(key));
    const seconds=timeFields.find(({key,value})=>key.endsWith('seconds') && Number(value)===28800);
    const totalMinutes=timeFields.find(({key,value})=>key.endsWith('minutes') && Number(value)===480);
    const hours=timeFields.find(({key,value})=>key.endsWith('hours') && Number(value)===8);
    if(seconds) { set(tree,seconds.path,token('elapsedSeconds')); times=1; }
    else if(totalMinutes) { set(tree,totalMinutes.path,token('elapsedMinutes')); times=1; }
    else if(hours) {
      set(tree,hours.path,token('elapsedHourPart'));
      const minutePart=timeFields.find(({key,value})=>key.endsWith('minutes') && Number(value)===0);
      if(minutePart) set(tree,minutePart.path,token('elapsedMinutePart'));
      times=1;
    }
    if(!times && timeFields.length) throw Error('Для настройки нужно сохранить ровно 8 часов (0 минут).');
    for (const [key,value] of [...url.searchParams]) {
      if (/^(sessid|csrf_token)$/i.test(key)) { url.searchParams.set(key,'__B24H_CSRF__'); csrf++; }
      if (/^(auth|token|access_token)$/i.test(key)) throw Error('Адрес содержит ключ доступа.');
      if (/^(taskId|task_id|TASKID)$/i.test(key)) {
        if (String(value) !== String(arm.taskId)) throw Error('В адресе другая задача.');
        url.searchParams.set(key,'__B24H_TASK__'); tasks++;
      }
    }
    if (tasks < 1 || times < 1 || comments !== 1) throw Error('Не удалось однозначно выделить задачу, 8 часов и комментарий.');
    if (!csrf) throw Error('В запросе не найден штатный sessid. Повтор без проверки сессии запрещён.');
    const taskPath=url.pathname.match(/\/tasks\/task\/view\/(\d+)(?:\/|$)/);
    if (taskPath) {
      if (taskPath[1] !== String(arm.taskId)) throw Error('В адресе запроса другая задача.');
      url.pathname=url.pathname.replace(`/task/view/${arm.taskId}`, '/task/view/__B24H_TASK__');
    }
    return {version:2,userId:Number(userId),encoding:parsed.encoding,tree,url:url.pathname+url.search,operation:operation.trim(),csrfHeader:!!raw.csrfHeader,receiptPath:null};
  }
  function render(profile, taskId, sessid, date = day(), elapsedSeconds = 28800) {
    if (!positive(taskId) || !sessid) throw Error('Нет задачи или активной сессии.');
    if (!positive(elapsedSeconds)) throw Error('Нет отработанного времени.');
    const roundedSeconds=Math.max(1,Math.round(Number(elapsedSeconds)));
    const roundedMinutes=Math.max(1,Math.round(roundedSeconds/60));
    function expand(value) {
      if (value && typeof value === 'object') {
        if (value.__b24hToken) {
          const types = {
            csrf:sessid, task:String(taskId),taskNumber:Number(taskId),comment:MARKER,date,dateRU:date.split('-').reverse().join('.'),
            elapsedSeconds:roundedSeconds,
            elapsedMinutes:roundedMinutes,
            elapsedHourPart:Math.floor(roundedMinutes/60),
            elapsedMinutePart:roundedMinutes%60
          };
          if (!(value.__b24hToken in types)) throw Error('Неизвестное поле профиля.');
          return types[value.__b24hToken];
        }
        if (Object.keys(value).length === 1 && value.__b24hJson) return JSON.stringify(expand(value.__b24hJson));
        if (Array.isArray(value)) return value.map(expand);
        return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,expand(v)]));
      }
      return value;
    }
    const tree=expand(clone(profile.tree));
    let body;
    if (profile.encoding === 'json') body=JSON.stringify(tree);
    else {
      body=profile.encoding === 'form' ? new FormData() : new URLSearchParams();
      for (const entry of tree) body.append(entry.key,String(entry.value));
    }
    const url=profile.url.replaceAll('__B24H_CSRF__',encodeURIComponent(sessid)).replaceAll('__B24H_TASK__',String(taskId));
    return {url,body};
  }
  function migrateProfile(profile) {
    if(!profile || profile.version===2) return profile;
    if(profile.version!==1 || !profile.tree) return null;
    const next=clone(profile), fields=[];
    walk(next.tree,(value,path)=>fields.push({value,path,key:kind(leafKey(next.tree,path))}));
    const timeFields=fields.filter(({key})=>['seconds','minutes','hours'].includes(key) || /(?:seconds|minutes|hours)$/.test(key));
    const seconds=timeFields.find(({key,value})=>key.endsWith('seconds') && Number(value)===28800);
    const totalMinutes=timeFields.find(({key,value})=>key.endsWith('minutes') && Number(value)===480);
    const hours=timeFields.find(({key,value})=>key.endsWith('hours') && Number(value)===8);
    if(seconds) set(next.tree,seconds.path,token('elapsedSeconds'));
    else if(totalMinutes) set(next.tree,totalMinutes.path,token('elapsedMinutes'));
    else if(hours) {
      set(next.tree,hours.path,token('elapsedHourPart'));
      const minutePart=timeFields.find(({key,value})=>key.endsWith('minutes') && Number(value)===0);
      if(minutePart) set(next.tree,minutePart.path,token('elapsedMinutePart'));
    } else return null;
    next.version=2;
    return next;
  }
  function safeCallUrl(value) {
    if(typeof value!=='string') return null;
    const decoded=value.replaceAll('&amp;','&').replaceAll('&#38;','&').replaceAll('&quot;','"');
    let url; try { url=new URL(decoded); } catch { return null; }
    if(url.protocol!=='https:' || url.username || url.password) return null;
    const host=url.hostname.toLowerCase();
    if(host==='zoom.us' || host.endsWith('.zoom.us') || host==='teams.microsoft.com' || host==='teams.live.com') return url.href;
    return null;
  }
  function callLinks(value) {
    const strings=[];
    const collect=item=>{
      if(typeof item==='string') strings.push(item);
      else if(Array.isArray(item)) item.forEach(collect);
      else if(item && typeof item==='object') Object.values(item).forEach(collect);
    };
    collect(value);
    const links=new Set();
    for(const source of strings) {
      const decoded=source.replaceAll('&amp;','&').replaceAll('&#38;','&').replaceAll('&quot;','"');
      for(const match of decoded.matchAll(/https:\/\/[^\s<>"']+/gi)) {
        const candidate=match[0].replace(/[),.;\]}]+$/,'');
        const safe=safeCallUrl(candidate); if(safe) links.add(safe);
      }
    }
    return [...links];
  }
  function calendarClockInfo(value) {
    const text=String(value || '').trim();
    const match=text.match(/(?:^|[T\s])(\d{1,2}:\d{2})(?::\d{2})?\s*([ap]m)?/i) || text.match(/(\d{1,2}:\d{2})(?::\d{2})?\s*([ap]m)?/i);
    if(!match) return null;
    const [hourText,minuteText]=match[1].split(':');
    let hour=Number(hourText), minute=Number(minuteText);
    const period=match[2]?.toUpperCase() || '';
    if(period==='AM' && hour===12) hour=0;
    if(period==='PM' && hour<12) hour+=12;
    if(hour<0 || hour>23 || minute<0 || minute>59) return null;
    return {label:`${match[1]}${period ? ` ${period}` : ''}`,minutes:hour*60+minute};
  }
  const calendarClock=value=>calendarClockInfo(value)?.label || '';
  function calendarEventMinutes(event) {
    if(String(event?.DT_SKIP_TIME).toUpperCase()==='Y') return -1;
    return (calendarClockInfo(event?.DATE_FROM) || calendarClockInfo(event?.DATE_FROM_FORMATTED))?.minutes ?? 1440;
  }
  function calendarEventTime(event) {
    if(String(event?.DT_SKIP_TIME).toUpperCase()==='Y') return 'Весь день';
    const from=calendarClock(event?.DATE_FROM) || calendarClock(event?.DATE_FROM_FORMATTED);
    const to=calendarClock(event?.DATE_TO) || calendarClock(event?.DATE_TO_FORMATTED);
    if(!from) return 'Время не указано';
    return to && to!==from ? `${from}–${to}` : from;
  }
  function calendarContext(settings={},now=new Date()) {
    const zone=[settings?.timezoneName,settings?.TIMEZONE_NAME,settings?.timezoneDefaultName,settings?.TIMEZONE_DEFAULT_NAME].find(isValidTimeZone) || '';
    const offsetValue=settings?.timezoneOffsetUTC ?? settings?.TIMEZONE_OFFSET_UTC;
    const offsetSeconds=offsetValue==='' || offsetValue==null ? null : Number(offsetValue);
    if(zone) return {date:day(now,zone),zone,offsetSeconds:Number.isFinite(offsetSeconds) ? offsetSeconds : null};
    if(Number.isFinite(offsetSeconds)) return {date:new Date(now.getTime()+offsetSeconds*1000).toISOString().slice(0,10),zone:'',offsetSeconds};
    throw Error('Bitrix не вернул часовой пояс календаря.');
  }
  function calendarEventOnDay(event,expectedDate,context) {
    const rawTimestamp=Number(event?.DATE_FROM_TS_UTC);
    if(Number.isFinite(rawTimestamp) && rawTimestamp>0) {
      const timestamp=rawTimestamp>1e12 ? rawTimestamp : rawTimestamp*1000;
      const instant=new Date(timestamp);
      if(context?.zone && isValidTimeZone(context.zone)) return day(instant,context.zone)===expectedDate;
      if(Number.isFinite(context?.offsetSeconds)) return new Date(timestamp+context.offsetSeconds*1000).toISOString().slice(0,10)===expectedDate;
    }
    const raw=String(event?.DATE_FROM || event?.DATE_FROM_FORMATTED || '');
    const [year,month,datePart]=String(expectedDate).split('-');
    return new RegExp(`(?:^|\\D)${year}[-./]${month}[-./]${datePart}(?:\\D|$)`).test(raw) ||
      new RegExp(`(?:^|\\D)${datePart}[-./]${month}[-./]${year}(?:\\D|$)`).test(raw) ||
      new RegExp(`(?:^|\\D)${month}[-./]${datePart}[-./]${year}(?:\\D|$)`).test(raw);
  }
  const Core={compile,render,migrateProfile,decodeBody,receipt,definiteError,day,positive,get,safeCallUrl,callLinks,calendarClock,calendarEventMinutes,calendarEventTime,calendarContext,calendarEventOnDay,MARKER};
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') { module.exports=Core; return; }
  if (location.origin !== ORIGIN || window.__b24EightHoursInstalled) return;
  window.__b24EightHoursInstalled=true;
  const originalFetch=window.fetch.bind(window);
  const read=key=>{ try { return JSON.parse(localStorage.getItem(PREFIX+key)); } catch { return null; } };
  const write=(key,value)=>{ localStorage.setItem(PREFIX+key,JSON.stringify(value)); refresh(); };
  const remove=key=>{ localStorage.removeItem(PREFIX+key); refresh(); };
  let ui=null, busy=false, taskCache=[], message='', lastIdentity=null;
  let meetingsState={key:'',status:'idle',items:[],error:''};
  function identity() {
    try {
      const id=window.BX?.message?.('USER_ID');
      if (positive(id)) { lastIdentity=Number(id); return lastIdentity; }
      if (window.top !== window && positive(window.top.BX?.message?.('USER_ID'))) return Number(window.top.BX.message('USER_ID'));
    } catch { /* no same-origin top */ }
    return null; // URL user ID is not proof of the logged-in identity.
  }
  const keyFor=(name,uid=identity())=>`${uid}:${name}`;
  function validTimeZone(value) {
    return isValidTimeZone(value);
  }
  const browserTimeZone=()=>{
    const value=Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimeZone(value) ? value : 'UTC';
  };
  function timeZoneFor(uid=identity()) {
    const saved=uid && read(keyFor('timeZone',uid));
    return saved && saved!=='auto' && validTimeZone(saved) ? saved : browserTimeZone();
  }
  const workDay=(date=new Date(),uid=identity())=>day(date,timeZoneFor(uid));
  let restLoader=null;
  async function ensureRestClient() {
    if(window.BX?.rest?.callMethod) return;
    if(!restLoader) restLoader=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/bitrix/js/rest/client/rest.client.js'; script.async=true;
      script.onload=()=>window.BX?.rest?.callMethod ? resolve() : reject(Error('REST-клиент Bitrix не запустился.'));
      script.onerror=()=>reject(Error('REST-клиент календаря недоступен.'));
      (document.head || document.documentElement).appendChild(script);
    });
    await restLoader;
  }
  async function callBitrix(method,params) {
    await ensureRestClient();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const timeout=setTimeout(()=>{if(!settled){settled=true;reject(Error('Календарь Bitrix не ответил вовремя.'));}},15000);
      const done=result=>{
        if(settled) return; settled=true; clearTimeout(timeout);
        try {
          const error=typeof result?.error==='function' ? result.error() : result?.error;
          if(error) throw Error(typeof result?.error_description==='function' ? result.error_description() : result?.error_description || String(error));
          const data=typeof result?.data==='function' ? result.data() : result;
          resolve(data?.result ?? data);
        } catch(problem) { reject(problem); }
      };
      try { window.BX.rest.callMethod(method,params,done); } catch(problem) { clearTimeout(timeout);settled=true;reject(problem); }
    });
  }
  function renderMeetings() {
    if(!ui) return;
    ui.meetingsList.replaceChildren();
    ui.meetingsStatus.hidden=false;
    if(meetingsState.status==='loading') { ui.meetingsStatus.textContent='Загружаю календарь…'; return; }
    if(meetingsState.status==='error') { ui.meetingsStatus.textContent=meetingsState.error; return; }
    if(!meetingsState.items.length) { ui.meetingsStatus.textContent='На сегодня нет событий со ссылкой Zoom или Teams в описании.'; return; }
    ui.meetingsStatus.hidden=true;
    for(const meeting of meetingsState.items) {
      const button=document.createElement('button'); button.className='meeting-item'; button.type='button';
      const top=document.createElement('span'); top.className='meeting-top';
      const time=document.createElement('span'); time.className='meeting-time'; time.textContent=meeting.time;
      const provider=document.createElement('span'); provider.className='meeting-provider'; provider.textContent=meeting.provider;
      const name=document.createElement('span'); name.className='meeting-name'; name.textContent=meeting.name;
      top.append(time,provider); button.append(top,name);
      button.onclick=()=>window.open(meeting.url,'_blank','noopener');
      ui.meetingsList.append(button);
    }
  }
  async function loadMeetings(force=false) {
    const uid=identity(); if(!uid) return;
    if(meetingsState.status==='loading') return;
    const previous=meetingsState;
    meetingsState={key:`${uid}:loading`,status:'loading',items:[],error:''}; renderMeetings();
    try {
      const settings=await callBitrix('calendar.user.settings.get',{});
      const context=calendarContext(settings,new Date());
      const date=context.date, key=`${uid}:${date}:${context.zone || `UTC${context.offsetSeconds}`}`;
      if(!force && previous.key===key && previous.status==='ready') { meetingsState=previous;renderMeetings();return; }
      const data=await callBitrix('calendar.event.get',{type:'user',ownerId:uid,from:date,to:date});
      const events=Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
      const items=[];
      for(const event of events) {
        if(String(event?.MEETING_STATUS).toUpperCase()==='N') continue;
        if(!calendarEventOnDay(event,date,context)) continue;
        const url=callLinks([event?.DESCRIPTION,event?.['~DESCRIPTION']])[0]; if(!url) continue;
        const start=calendarEventMinutes(event);
        items.push({name:String(event?.NAME || 'Созвон'),time:calendarEventTime(event),provider:new URL(url).hostname.includes('zoom') ? 'Zoom' : 'Teams',url,start});
      }
      items.sort((a,b)=>a.start-b.start || a.name.localeCompare(b.name,'ru'));
      meetingsState={key,status:'ready',items,error:''}; renderMeetings();
    } catch(problem) {
      meetingsState={key,status:'error',items:[],error:`Не удалось загрузить календарь: ${problem?.message || problem}`}; renderMeetings();
    }
  }
  const journal=(uid=identity())=>read(keyFor('journal',uid)) || {};
  function profileFor(uid=identity()) {
    if(!uid) return null;
    const stored=read(keyFor('profile',uid));
    if(stored?.version===2) return stored;
    const migrated=migrateProfile(stored);
    if(migrated) localStorage.setItem(PREFIX+keyFor('profile',uid),JSON.stringify(migrated));
    return migrated;
  }
  function pending(uid=identity()) { return Object.entries(journal(uid)).find(([,r])=>r.status==='pending'); }
  function note(text) { message=text; refresh(); }
  function mark(uid,date,record) {
    const records=journal(uid);
    records[date]=record;
    // Keep all unresolved operations; limit completed history only.
    for (const [old,r] of Object.entries(records)) if (r.status!=='pending' && old < workDay(new Date(Date.now()-90*86400000),uid)) delete records[old];
    write(keyFor('journal',uid),records);
  }
  function currentTask() {
    const contexts=[{path:location.pathname,doc:document}];
    try {
      for(const frame of [...document.querySelectorAll('iframe')].reverse()) {
        if(frame.getBoundingClientRect().height>0 && frame.contentDocument) contexts.push({path:frame.contentWindow.location.pathname,doc:frame.contentDocument});
      }
    } catch { /* cross-origin frames are not inspected */ }
    for(const context of contexts) {
      const id=context.path.match(/\/tasks\/task\/view\/(\d+)(?:\/|$)/)?.[1];
      if(!positive(id)) continue;
      const title=(context.doc.querySelector('.task-detail-title, .tasks-task-title, #pagetitle, h1')?.textContent || `Задача #${id}`).trim();
      return {id:Number(id),title:title.slice(0,180)};
    }
    return null;
  }
  function taskLinks(doc) {
    const results=new Map();
    for (const link of doc.querySelectorAll('a[href*="/tasks/task/view/"]')) {
      const match=link.getAttribute('href').match(/\/tasks\/task\/view\/(\d+)(?:\/|$|\?)/);
      const title=link.textContent.replace(/\s+/g,' ').trim();
      if (match && positive(match[1]) && title && !/^\d+$/.test(title)) results.set(Number(match[1]),{id:Number(match[1]),title:title.slice(0,180)});
    }
    return [...results.values()];
  }
  function discover() {
    const uid=identity();
    if (!uid) return;
    const saved=read(keyFor('tasks')) || [];
    const map=new Map(saved.map(task=>[task.id,task]));
    for (const task of taskLinks(document)) map.set(task.id,task);
    try { for (const frame of document.querySelectorAll('iframe')) for (const task of taskLinks(frame.contentDocument || document)) map.set(task.id,task); } catch { /* cross-origin ignored */ }
    const here=currentTask(); if(here) map.set(here.id,here);
    taskCache=[...map.values()].slice(-300);
    localStorage.setItem(PREFIX+keyFor('tasks'),JSON.stringify(taskCache));
    refreshTasks();
  }
  function selected() { return read(keyFor('selected')); }
  function refreshTasks() {
    if (!ui) return;
    const value=selected();
    const search=ui.search.value.trim().toLowerCase();
    const list=taskCache.filter(task=>!search || `${task.id} ${task.title}`.toLowerCase().includes(search));
    ui.select.replaceChildren(new Option('Выбери задачу', ''));
    if (value && !list.some(task=>task.id===value.id)) list.unshift(value);
    for (const task of list) ui.select.add(new Option(`#${task.id} · ${task.title}`,String(task.id)));
    ui.select.value=value ? String(value.id) : '';
  }
  async function exclusive(uid, fn) {
    if (!navigator.locks?.request) throw Error('Защита вкладок недоступна. Используй актуальный Chrome, Edge или Firefox.');
    return navigator.locks.request(PREFIX+uid, {mode:'exclusive',ifAvailable:true}, lock=>{
      if (!lock) throw Error('Запись или настройка уже выполняется в другой вкладке.');
      return fn();
    });
  }
  function candidate(raw) {
    const arm=read('arm');
    if (!arm || arm.until<Date.now() || arm.claimed || arm.userId!==identity()) return null;
    arm.date=workDay(new Date(),arm.userId); // Reserve the day in this user's selected time zone.
    try {
      const profile=compile(raw,arm,identity());
      if (!profile) return null;
      return {profile,arm};
    } catch(error) {
      // Only candidate requests bearing the marker may surface a compatibility error.
      let body=''; try { body=typeof raw.body==='string' ? decodeURIComponent(raw.body.replaceAll('+',' ')) : JSON.stringify([...raw.body.entries()]); } catch { /* ignored */ }
      if (body.includes(MARKER) && raw.method==='POST' && new URL(raw.url,ORIGIN).origin===ORIGIN) return {profile:null,arm,unsupported:error.message};
      return null;
    }
  }
  async function learn(result, rawResponse) {
    const {profile,arm}=result;
    // The manual save happened already. Unknown outcomes are blocked as well.
    let json; try { json=JSON.parse(rawResponse.text); } catch { json=null; }
    const created=rawResponse.status >= 200 && rawResponse.status < 300 ? receipt(json) : null;
    const accepted=structuredSuccess(rawResponse.status,json);
    if (rawResponse.status > 0 && rawResponse.status < 500 && definiteError(json)) {
      const records=journal(arm.userId); delete records[arm.date]; write(keyFor('journal',arm.userId),records);
      remove('arm'); write('learnMessage',{uid:arm.userId,text:'Bitrix отклонил ручную запись. Исправь ошибку в форме и настрой заново.'}); return;
    }
    try {
      await exclusive(arm.userId,async()=>{
        const records=journal(arm.userId);
        if (records[arm.date]?.status==='done') throw Error('За этот день запись уже отмечена.');
        if (accepted && profile && !result.unsupported) {
          profile.receiptPath=created?.path || null;
          profile.successMode=created ? 'entryId' : 'structured2xx';
          write(keyFor('profile',arm.userId),profile);
          const task=(read(keyFor('tasks',arm.userId)) || []).find(t=>t.id===arm.taskId) || {id:arm.taskId,title:`Задача #${arm.taskId}`};
          write(keyFor('selected',arm.userId),task);
          mark(arm.userId,arm.date,{status:'done',taskId:arm.taskId,...(created ? {entryId:created.id} : {}),at:Date.now(),manual:true});
          write('learnMessage',{uid:arm.userId,text:'Настроено. Сегодняшние 8 часов уже записаны вручную. Кнопка доступна со следующего дня.'});
        } else {
          mark(arm.userId,arm.date,{status:'pending',taskId:arm.taskId,at:Date.now(),manual:true});
          write('learnMessage',{uid:arm.userId,text:result.unsupported ? `Скрипт не научился: ${result.unsupported} Проверь, что именно записалось в задачу. Повтор заблокирован до проверки.` : 'Не удалось распознать ответ Bitrix. Проверь трудозатраты. Профиль не сохранён, повторная запись заблокирована.'});
        }
      });
    } catch(error) { write('learnMessage',{uid:arm.userId,text:error.message}); }
    remove('arm');
  }
  function claim(result) {
    const arm=read('arm');
    if (!arm || arm.claimed || arm.userId!==result.arm.userId) return false;
    arm.claimed=true; arm.date=result.arm.date;
    // Reserve synchronously before the user's native request leaves this frame.
    localStorage.setItem(PREFIX+'arm',JSON.stringify(arm));
    mark(arm.userId,arm.date,{status:'pending',taskId:arm.taskId,at:Date.now(),manual:true});
    return true;
  }
  // Observe only explicitly armed, same-origin, marker-bearing time saves. Never cancel native requests.
  const xhrOpen=XMLHttpRequest.prototype.open;
  const xhrSend=XMLHttpRequest.prototype.send;
  const xhrHeader=XMLHttpRequest.prototype.setRequestHeader;
  const xhrInfo=new WeakMap();
  XMLHttpRequest.prototype.open=function(method,url,...rest) { xhrInfo.set(this,{method:String(method).toUpperCase(),url:String(url),contentType:'',csrfHeader:false}); return xhrOpen.call(this,method,url,...rest); };
  XMLHttpRequest.prototype.setRequestHeader=function(name,value) { if (xhrInfo.has(this)) {if (String(name).toLowerCase()==='content-type') xhrInfo.get(this).contentType=String(value);if(String(name).toLowerCase()==='x-bitrix-csrf-token') xhrInfo.get(this).csrfHeader=true;} return xhrHeader.call(this,name,value); };
  XMLHttpRequest.prototype.send=function(body) {
    const info=xhrInfo.get(this);
    let result=null; try { if (info) result=candidate({...info,body}); } catch { /* observer never blocks Bitrix */ }
    let claimed=false; try { if(result) claimed=claim(result); } catch { /* storage failure never prevents the native save */ }
    if (claimed) this.addEventListener('loadend',()=>{
      let response=''; try { response=this.responseType==='json' ? JSON.stringify(this.response) : this.responseText; } catch { /* unknown */ }
      void learn(result,{text:response,status:this.status});
    },{once:true});
    return xhrSend.call(this,body);
  };
  window.fetch=async function(input,options) {
    let result=null;
    try {
      if (read('arm') && !(input instanceof Request)) result=candidate({url:String(input),method:String(options?.method || 'GET').toUpperCase(),body:options?.body,csrfHeader:new Headers(options?.headers).has('x-bitrix-csrf-token'),contentType:new Headers(options?.headers).get('content-type') || ''});
      else if (read('arm') && input instanceof Request) {
        const body=options?.body ?? await input.clone().text();
        result=candidate({url:input.url,method:String(options?.method || input.method).toUpperCase(),body,csrfHeader:new Headers(options?.headers || input.headers).has('x-bitrix-csrf-token'),contentType:new Headers(options?.headers || input.headers).get('content-type') || ''});
      }
    } catch { /* untouched native request */ }
    let claimed=false; try { if(result) claimed=claim(result); } catch { /* native fetch still goes ahead */ }
    try {
      const response=await originalFetch(input,options);
      if (claimed) response.clone().text().then(text=>learn(result,{text,status:response.status})).catch(()=>learn(result,{text:'',status:0}));
      return response;
    } catch(error) { if (claimed) void learn(result,{text:'',status:0}); throw error; }
  };
  async function armLearning() {
    const uid=identity(), task=selected();
    if (!uid || !task) throw Error('Сначала выбери задачу.');
    await exclusive(uid,async()=>{
      if (pending(uid) || journal(uid)[workDay(new Date(),uid)]?.status==='done') throw Error('Сегодняшняя запись уже есть или её результат требует проверки.');
      const old=read('arm');
      if (old?.until>Date.now()) throw Error('Настройка уже включена.');
      write('arm',{userId:uid,taskId:task.id,date:workDay(new Date(),uid),until:Date.now()+10*60*1000,claimed:false});
      remove('learnMessage');
    });
    note(`Открой задачу #${task.id}. В её учёте времени вручную сохрани 8 часов, 0 минут, комментарий «${MARKER}». Это уже будет сегодняшняя запись.`);
  }
  const timerState=(uid=identity())=>uid ? read(keyFor('workTimer',uid)) : null;
  const timerElapsedMs=(state,now=Date.now())=>state ? Math.max(0,Number(state.accumulatedMs)||0)+(state.status==='running' ? Math.max(0,now-Number(state.startedAt||now)) : 0) : 0;
  function formatClock(milliseconds) {
    const seconds=Math.max(0,Math.floor(milliseconds/1000));
    const hours=Math.floor(seconds/3600), minutes=Math.floor((seconds%3600)/60), rest=seconds%60;
    return [hours,minutes,rest].map(value=>String(value).padStart(2,'0')).join(':');
  }
  function formatDuration(seconds) {
    const total=Math.max(1,Math.round(Number(seconds)||0));
    const hours=Math.floor(total/3600), minutes=Math.floor((total%3600)/60), rest=total%60;
    return [hours&&`${hours} ч`,minutes&&`${minutes} мин`,rest&&`${rest} сек`].filter(Boolean).join(' ') || '1 сек';
  }
  async function startWorkDay() {
    const uid=identity();
    if(!uid) return note('Не удалось определить пользователя Bitrix.');
    try {
      await exclusive(uid,async()=>{
        const task=read(keyFor('selected',uid)), profile=profileFor(uid), date=workDay(new Date(),uid);
        if(timerState(uid)) throw Error('Рабочий день уже запущен.');
        if(pending(uid)) throw Error('Сначала проверь результат предыдущей записи.');
        if(journal(uid)[date]?.status==='done') throw Error('Сегодняшний рабочий день уже записан.');
        if(!task) throw Error('Сначала выбери задачу в настройках.');
        if(!profile || profile.userId!==uid || profile.version!==2) throw Error('Открой настройки и выполни настройку Bitrix для версии таймера.');
        write(keyFor('workTimer',uid),{version:1,status:'running',date,task:{id:task.id,title:task.title},startedAt:Date.now(),accumulatedMs:0});
        message='';
      });
    } catch(error) { note(error.message); }
    refresh();
  }
  async function togglePause() {
    const uid=identity(); if(!uid) return;
    try {
      await exclusive(uid,async()=>{
        const state=timerState(uid); if(!state || !['running','paused'].includes(state.status)) return;
        if(state.status==='running') {
          state.accumulatedMs=timerElapsedMs(state); state.startedAt=null; state.status='paused';
        } else { state.startedAt=Date.now(); state.status='running'; }
        write(keyFor('workTimer',uid),state); message='';
      });
    } catch(error) { note(error.message); }
  }
  async function finishWorkDay() {
    const uid=identity(); if(!uid || busy) return;
    let snapshot=null;
    try {
      await exclusive(uid,async()=>{
        const state=timerState(uid); if(!state || !['running','paused'].includes(state.status)) return;
        state.accumulatedMs=timerElapsedMs(state); state.startedAt=null; state.status='submitting';
        write(keyFor('workTimer',uid),state); snapshot=clone(state);
      });
      if(!snapshot) return;
      const seconds=Math.max(1,Math.round(snapshot.accumulatedMs/1000));
      await addDay(seconds,snapshot.task,snapshot.date);
      const record=journal(uid)[snapshot.date], current=timerState(uid);
      if(record?.status==='done') remove(keyFor('workTimer',uid));
      else if(current) {
        current.status=record?.status==='pending' ? 'pending' : 'paused';
        write(keyFor('workTimer',uid),current);
      }
    } catch(error) {
      const current=timerState(uid); if(current?.status==='submitting'){current.status='paused';write(keyFor('workTimer',uid),current);}
      note(error.message);
    }
  }
  async function addDay(elapsedSeconds=28800, taskOverride=null, dateOverride=null) {
    if (busy) return;
    busy=true; refresh();
    try {
      const uid=identity();
      if (!uid) throw Error('Не удалось определить пользователя. Открой авторизованный Bitrix.');
      await exclusive(uid,async()=>{
        const date=dateOverride || workDay(new Date(),uid), task=taskOverride || read(keyFor('selected',uid)), profile=profileFor(uid);
        if(!taskOverride && timerState(uid)) throw Error('Сначала заверши активный таймер рабочего дня.');
        if (pending(uid)) throw Error('Сначала проверь результат предыдущей записи.');
        if (journal(uid)[date]?.status==='done') throw Error('Этот рабочий день уже записан.');
        if (read('arm')?.until>Date.now()) throw Error('Заверши или отмени настройку.');
        if (!task || !profile || profile.userId!==uid || profile.version!==2) throw Error('Сначала выбери задачу и заново выполни настройку для таймера.');
        const sessid=window.BX?.bitrix_sessid?.();
        const request=render(profile,task.id,sessid,date,elapsedSeconds);
        const url=new URL(request.url,ORIGIN);
        if (url.origin!==ORIGIN || !/^\/(?:bitrix\/|company\/|workgroups\/)/.test(url.pathname)) throw Error('Некорректный адрес профиля. Настрой заново.');
        // Validate local storage is writable before any mutation request.
        mark(uid,date,{status:'pending',taskId:task.id,at:Date.now()});
        const headers={'X-Requested-With':'XMLHttpRequest'};
        if(profile.csrfHeader) headers['X-Bitrix-Csrf-Token']=sessid;
        if (profile.encoding==='json') headers['Content-Type']='application/json';
        if (profile.encoding==='urlencoded') headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),25000);
        let response,json;
        try {
          response=await originalFetch(url.href,{method:'POST',body:request.body,headers,credentials:'same-origin',redirect:'error',signal:controller.signal});
          try { json=await response.json(); } catch { throw Error('Неизвестный ответ сервера.'); }
        } catch {
          throw Error('Результат неизвестен. Проверь трудозатраты в задаче; повтор заблокирован.');
        } finally { clearTimeout(timeout); }
        const created=receipt(json);
        const entryConfirmed=profile.receiptPath && created && positive(get(json,profile.receiptPath));
        const responseConfirmed=profile.successMode==='structured2xx' && structuredSuccess(response.status,json);
        if (response.ok && (entryConfirmed || responseConfirmed)) {
          mark(uid,date,{status:'done',taskId:task.id,...(entryConfirmed ? {entryId:Number(get(json,profile.receiptPath))} : {}),at:Date.now()});
          note(`В задачу #${task.id} записано ${formatDuration(elapsedSeconds)}. Обнови карточку, чтобы увидеть запись.`);
        } else if (response.status<500 && definiteError(json)) {
          const records=journal(uid); delete records[date]; write(keyFor('journal',uid),records);
          throw Error('Bitrix отклонил запись. Обнови страницу и проверь право добавлять время в эту задачу.');
        } else throw Error('Ответ не подтверждает запись. Проверь трудозатраты; повтор заблокирован.');
      });
    } catch(error) { note(error.message); }
    finally { busy=false; refresh(); }
  }
  function resolvePending(exists) {
    const uid=identity();
    const item=pending(uid); if(!item) return;
    // Keep confirmation in the original click event. Browsers may suppress dialogs
    // opened only after an asynchronous Web Locks callback starts.
    if(!exists && !window.confirm(`Проверь трудозатраты задачи #${item[1].taskId}. Подтверждаешь, что запись за ${item[0]} НЕ появилась? Только после проверки разрешается повтор.`)) return;
    void exclusive(uid,async()=>{
      const current=pending(uid); if(!current || current[0]!==item[0]) return;
      const records=journal(uid);
      if(exists) records[item[0]]={...item[1],status:'done',verifiedManually:true};
      else delete records[item[0]];
      write(keyFor('journal',uid),records);
      const state=timerState(uid);
      if(state && state.date===item[0] && state.task?.id===item[1].taskId) {
        if(exists) remove(keyFor('workTimer',uid));
        else { state.status='paused'; state.startedAt=null; write(keyFor('workTimer',uid),state); }
      }
      remove('learnMessage'); note(exists ? 'Запись отмечена как подтверждённая.' : 'Результат проверен. Можно повторить запись или настройку.');
    }).catch(error=>note(error.message));
  }
  function refresh() {
    if(!ui) return;
    const uid=identity(), profile=uid && profileFor(uid), today=uid && journal(uid)[workDay(new Date(),uid)], unresolved=uid && pending(uid), arm=read('arm');
    const active=arm?.userId===uid && arm.until>Date.now();
    const task=uid && selected(), state=uid && timerState(uid), stateStatus=state?.status || 'idle';
    const isPaused=stateStatus==='paused', isSubmitting=['submitting','pending'].includes(stateStatus);
    const clock=formatClock(timerElapsedMs(state));
    const blocked=busy || !uid || !!unresolved || !!active || isSubmitting || !profile || !task || today?.status==='done';
    ui.primary.disabled=busy || !uid || !!unresolved || !!active || isSubmitting || (!state && (!profile || !task || today?.status==='done'));
    if(state && (busy || stateStatus==='submitting')) ui.primary.textContent=`Сохраняю… · ${clock}`;
    else ui.primary.textContent=state ? `■  Завершить · ${clock}` : today?.status==='done' ? '✓ Рабочий день завершён' : '▷  Начать рабочий день';
    ui.quickAdd.disabled=blocked || !!state;
    ui.pause.hidden=!state || !['running','paused'].includes(stateStatus);
    ui.pause.disabled=busy;
    ui.pause.textContent=isPaused ? '▷  Продолжить' : 'Ⅱ  Пауза';
    const workTask=state?.task || task;
    ui.taskLine.textContent=workTask ? `${state ? 'Сейчас' : 'По умолчанию'}: #${workTask.id} · ${workTask.title}` : 'Выбери задачу в настройках';
    ui.selected.textContent=task ? `По умолчанию: #${task.id} · ${task.title}` : 'Задача по умолчанию не выбрана';
    const learned=read('learnMessage');
    ui.status.textContent=learned?.uid===uid ? learned.text : message || (unresolved ? 'Нужно проверить результат записи в задаче.' : active ? `Настройка: сохрани 8 часов с комментарием «${MARKER}» через форму Bitrix.` : !profile ? 'Первый запуск: выбери задачу и выполни настройку Bitrix.' : !task ? 'Выбери задачу по умолчанию.' : '');
    ui.status.hidden=!ui.status.textContent;
    ui.resolve.hidden=!unresolved;
    if((!profile || !task) && !ui.settingsPane.dataset.autoOpened) {
      ui.settingsPane.hidden=false;
      ui.settingsPane.dataset.autoOpened='true';
    }
    if(unresolved) {
      ui.settingsPane.hidden=false;
      ui.panel.classList.remove('compact');
      ui.collapse.textContent='−';
      ui.collapse.title='Свернуть панель';
    }
    const settingsOpen=!ui.settingsPane.hidden;
    ui.settingsToggle.title=settingsOpen ? 'Скрыть настройки' : 'Настройки';
    ui.settingsToggle.setAttribute('aria-label',settingsOpen ? 'Скрыть настройки' : 'Настройки');
    ui.settingsToggle.classList.toggle('active',settingsOpen);
    ui.configure.disabled=busy || !uid || !!unresolved || today?.status==='done' || !!active || !!state;
    ui.cancel.hidden=!active || arm.claimed;
    ui.open.disabled=!task;
    ui.current.disabled=!currentTask() || !!state;
    ui.select.disabled=!!state;
    const storedZone=uid && read(keyFor('timeZone',uid)) || 'auto';
    ui.timeZone.value=[...ui.timeZone.options].some(option=>option.value===storedZone) ? storedZone : 'auto';
    ui.timeZone.disabled=busy || !uid || !!state || !!unresolved || today?.status==='done' || !!active;
    ui.zoneHint.textContent=uid ? `Новый день начинается в 00:00 · ${timeZoneFor(uid)}` : 'Часовой пояс определится после входа в Bitrix.';
    const dailyUrl=uid && safeCallUrl(read(keyFor('dailyUrl',uid)) || '');
    if(ui.dailyUrl.dataset.uid!==String(uid || '')) { ui.dailyUrl.dataset.uid=String(uid || '');ui.dailyUrl.value=dailyUrl || ''; }
    ui.daily.disabled=!uid;
    ui.daily.title=dailyUrl ? 'Открыть дейлик' : 'Настроить ссылку на дейлик';
    ui.daily.classList.toggle('active',!!dailyUrl);
    ui.meetingsToggle.classList.toggle('active',!ui.meetingsPane.hidden);
  }
  function mount() {
    if(window.top!==window || !document.body || document.getElementById('b24-eight-hours-panel')) return;
    const host=document.createElement('div'); host.id='b24-eight-hours-panel';
    host.style.cssText='position:fixed;left:16px;top:42px;z-index:2147483647;';
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>
      :host{all:initial;font-family:Arial,sans-serif;color:#202b38}*{box-sizing:border-box}
      .panel{width:330px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:12px;background:#fff;border:1px solid #dce3ea;border-radius:12px;box-shadow:0 5px 20px #1d39581f;font-size:12px}
      .panel.compact{width:310px;padding:9px}.panel.compact .aux{display:none!important}
      header{display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:grab;user-select:none;touch-action:none}header:active{cursor:grabbing}
      .title{font-size:13px;font-weight:700}.tools{display:flex;align-items:center;gap:7px}
      .link{border:0;background:transparent;color:#1683d8;padding:4px 0;font-weight:600}.link:hover{background:transparent;color:#056bb9;text-decoration:underline}
      button{font:inherit;cursor:pointer;border:1px solid #ccd6e0;background:#f5f7fa;color:#2c3d50;border-radius:8px;padding:7px}button:hover{background:#eaf0f5}button:disabled{opacity:.52;cursor:default}
      .icon,.collapse{width:27px;height:27px;padding:0;display:grid;place-items:center}.collapse{font-size:17px;line-height:1}.icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.icon.active{color:#0876c7;background:#e4f2fb;border-color:#afd4ec}
      .actions{display:flex;gap:7px;align-items:stretch}.primary{flex:1;min-width:0;padding:11px;margin-top:10px;background:#0d83dd;color:#fff;border:0;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}.primary:hover{background:#0874c4}.primary:disabled{background:#7196b2;opacity:.78}
      .quick{flex:0 0 42px;margin-top:10px;padding:8px;background:#eef7fd;color:#0876c7;border-color:#b8d9ef}.quick:hover{background:#dceffa}.quick svg{display:block;width:22px;height:22px;margin:auto;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .pause{width:100%;margin-top:7px;background:#fff;font-weight:600}
      .taskline{font-size:11px;color:#6a7786;line-height:1.4;margin-top:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .status{line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px;padding:9px 10px;background:#fff8e7;border-radius:8px;color:#684f18}
      .meetings{margin-top:9px;padding:9px;background:#f7f9fb;border:1px solid #e1e7ed;border-radius:9px}.meetings-head{display:flex;align-items:center;justify-content:space-between;font-weight:700}.meetings-head button{padding:3px 7px}.meetings-status{font-size:11px;line-height:1.4;color:#687789;margin-top:7px}.meetings-list{display:grid;gap:6px;margin-top:7px}.meeting-item{width:100%;text-align:left;background:#fff;padding:8px}.meeting-top{display:flex;justify-content:space-between;gap:8px;color:#617184;font-size:11px}.meeting-time{font-variant-numeric:tabular-nums;font-weight:700;color:#26394c}.meeting-provider{color:#0876c7}.meeting-name{display:block;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
      .settings{border-top:1px solid #e4e9ef;margin-top:12px;padding-top:5px}.chosen{line-height:1.4;overflow-wrap:anywhere;color:#42546a;margin:7px 0}
      input,select{font:inherit;width:100%;padding:9px;border:1px solid #cbd4df;border-radius:7px;margin-top:7px;background:#fff;color:#19202b}select{max-width:100%}.field-label{display:block;margin-top:10px;font-weight:700;color:#42546a}
      .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.hint{font-size:11px;line-height:1.45;color:#718091;margin-top:8px}.resolve{padding:8px 0 2px}[hidden]{display:none!important}
    </style><section class="panel" id="panel" aria-label="Таймер рабочего дня Bitrix">
      <header id="dragHandle" title="Перетащи панель в удобное место">
        <span class="title">BetterBitrix</span>
        <span class="tools"><button class="icon" id="meetingsToggle" title="Созвоны сегодня" aria-label="Созвоны сегодня"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 18h3"></path></svg></button><button class="icon" id="daily" title="Открыть дейлик" aria-label="Открыть дейлик"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"></rect><path d="m16 10 5-3v10l-5-3z"></path></svg></button><button class="icon" id="settingsToggle" title="Настройки" aria-label="Настройки"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1z"></path></svg></button><button class="collapse" id="collapse" title="Свернуть панель">−</button></span>
      </header>
      <div class="meetings aux" id="meetingsPane" hidden><div class="meetings-head"><span>Созвоны сегодня</span><button id="refreshMeetings" title="Обновить календарь">↻</button></div><div class="meetings-status" id="meetingsStatus"></div><div class="meetings-list" id="meetingsList"></div></div>
      <div class="actions"><button class="primary" id="primary">▷  Начать рабочий день</button><button class="quick" id="quickAdd" title="Записать 8 часов сразу" aria-label="Записать 8 часов сразу"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="12" r="7"></circle><path d="M10 8v4l2.5 1.5M17 5v6M14 8h6"></path></svg></button></div>
      <button class="pause" id="pause" hidden>Ⅱ  Пауза</button>
      <div class="taskline aux" id="taskLine"></div>
      <div class="status aux" id="status" role="status" aria-live="polite" hidden></div>
      <div class="settings aux" id="settingsPane" hidden>
        <div class="resolve" id="resolve" hidden><div class="hint">Сначала проверь журнал времени в задаче.</div><div class="row"><button id="exists">Проверил: записано</button><button id="absent">Проверил: записи нет</button></div></div>
        <div class="chosen" id="selected"></div>
        <input id="search" type="search" placeholder="Найти задачу по названию или ID" aria-label="Поиск задачи">
        <select id="select" aria-label="Задача по умолчанию"></select>
        <div class="row"><button id="collect">Обновить список</button><button id="current">Текущая задача</button><button id="open">Открыть задачу</button></div>
        <div class="hint">Открой в Bitrix список назначенных тебе задач и нажми «Обновить список». Выбранная задача сохраняется для следующих дней. Во время запущенного таймера она не меняется.</div>
        <label class="field-label" for="timeZone">Часовой пояс рабочего дня</label>
        <select id="timeZone" aria-label="Часовой пояс рабочего дня"><option value="auto">Автоматически — по браузеру</option><option value="UTC">UTC</option><option value="Europe/London">Europe/London</option><option value="Europe/Berlin">Europe/Berlin</option><option value="Europe/Helsinki">Europe/Helsinki</option><option value="Europe/Kaliningrad">Europe/Kaliningrad</option><option value="Europe/Moscow">Europe/Moscow</option><option value="Europe/Samara">Europe/Samara</option><option value="Asia/Yekaterinburg">Asia/Yekaterinburg</option><option value="Asia/Omsk">Asia/Omsk</option><option value="Asia/Krasnoyarsk">Asia/Krasnoyarsk</option><option value="Asia/Irkutsk">Asia/Irkutsk</option><option value="Asia/Yakutsk">Asia/Yakutsk</option><option value="Asia/Vladivostok">Asia/Vladivostok</option><option value="Asia/Magadan">Asia/Magadan</option><option value="Asia/Kamchatka">Asia/Kamchatka</option><option value="Asia/Dubai">Asia/Dubai</option><option value="Asia/Tbilisi">Asia/Tbilisi</option><option value="Asia/Almaty">Asia/Almaty</option><option value="Asia/Tashkent">Asia/Tashkent</option><option value="America/New_York">America/New_York</option><option value="America/Los_Angeles">America/Los_Angeles</option></select>
        <div class="hint" id="zoneHint"></div>
        <label class="field-label" for="dailyUrl">Ссылка на дейлик</label><input id="dailyUrl" type="url" inputmode="url" placeholder="https://…zoom.us/j/…" aria-label="Ссылка на дейлик Zoom или Teams"><div class="hint">Сохраняется только в этом браузере. После вставки нажми Enter или кликни вне поля.</div>
        <div class="row"><button id="configure">Настроить Bitrix</button><button id="cancel" hidden>Отменить настройку</button><button id="resetPosition">Сбросить позицию</button></div>
        <div class="hint">Если старая настройка сохранилась, заново настраивать ничего не нужно. Иначе один раз сохрани через штатную форму 8 часов с комментарием «${MARKER}» — скрипт запомнит формат записи.</div>
      </div>
    </section>`;
    document.body.appendChild(host);
    ui=Object.fromEntries([...shadow.querySelectorAll('[id]')].map(el=>[el.id,el]));
    ui.timeZone.options[0].textContent=`Автоматически — ${browserTimeZone()}`;
    if(typeof Intl.supportedValuesOf==='function') {
      const existing=new Set([...ui.timeZone.options].map(option=>option.value));
      for(const zone of Intl.supportedValuesOf('timeZone')) if(!existing.has(zone)) ui.timeZone.add(new Option(zone,zone));
    }
    const clampPosition=(left,top)=>({
      left:Math.max(8,Math.min(left,window.innerWidth-host.offsetWidth-8)),
      top:Math.max(8,Math.min(top,window.innerHeight-Math.min(host.offsetHeight,80)-8))
    });
    const place=(left,top,save=false)=>{
      const position=clampPosition(left,top);
      host.style.left=`${position.left}px`; host.style.top=`${position.top}px`;
      host.style.right='auto';
      if(save) write('layout',{...(read('layout') || {}),...position});
    };
    const layout=read('layout') || {};
    requestAnimationFrame(()=>place(Number.isFinite(layout.left) ? layout.left : 16,Number.isFinite(layout.top) ? layout.top : 42));
    let drag=null;
    ui.dragHandle.onpointerdown=event=>{
      if(event.button!==0 || event.target.closest('button')) return;
      const box=host.getBoundingClientRect();
      drag={dx:event.clientX-box.left,dy:event.clientY-box.top};
      ui.dragHandle.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    ui.dragHandle.onpointermove=event=>{if(drag) place(event.clientX-drag.dx,event.clientY-drag.dy);};
    const finishDrag=event=>{
      if(!drag) return;
      drag=null;
      try { ui.dragHandle.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      const box=host.getBoundingClientRect(); place(box.left,box.top,true);
    };
    ui.dragHandle.onpointerup=finishDrag; ui.dragHandle.onpointercancel=finishDrag;
    const setCompact=(compact,save=true)=>{
      ui.panel.classList.toggle('compact',compact);
      if(compact) { ui.settingsPane.hidden=true;ui.meetingsPane.hidden=true; }
      ui.collapse.textContent=compact ? '+' : '−';
      ui.collapse.title=compact ? 'Развернуть панель' : 'Свернуть панель';
      if(save) write('layout',{...(read('layout') || {}),compact});
      requestAnimationFrame(()=>{const box=host.getBoundingClientRect();place(box.left,box.top);});
    };
    ui.primary.onclick=()=>timerState() ? finishWorkDay() : startWorkDay();
    ui.quickAdd.onclick=()=>addDay(28800);
    ui.pause.onclick=togglePause;
    ui.meetingsToggle.onclick=()=>{
      if(ui.panel.classList.contains('compact')) setCompact(false);
      ui.meetingsPane.hidden=!ui.meetingsPane.hidden;
      if(!ui.meetingsPane.hidden) { ui.settingsPane.hidden=true;void loadMeetings(); }
      refresh();
    };
    ui.refreshMeetings.onclick=()=>loadMeetings(true);
    ui.daily.onclick=()=>{
      const uid=identity(), url=uid && safeCallUrl(read(keyFor('dailyUrl',uid)) || '');
      if(url) return void window.open(url,'_blank','noopener');
      if(ui.panel.classList.contains('compact')) setCompact(false);
      ui.meetingsPane.hidden=true;ui.settingsPane.hidden=false;refresh();ui.dailyUrl.focus();
      note('Вставь ссылку Zoom или Teams для дейлика.');
    };
    ui.settingsToggle.onclick=()=>{
      if(ui.panel.classList.contains('compact')) { setCompact(false); ui.settingsPane.hidden=false; }
      else ui.settingsPane.hidden=!ui.settingsPane.hidden;
      if(!ui.settingsPane.hidden) ui.meetingsPane.hidden=true;
      refresh();
    };
    ui.collapse.onclick=()=>setCompact(!ui.panel.classList.contains('compact'));
    ui.configure.onclick=()=>armLearning().catch(error=>note(error.message));
    ui.cancel.onclick=()=>{const arm=read('arm');if(arm?.userId===identity() && !arm.claimed){remove('arm');note('Настройка отменена.');}};
    ui.collect.onclick=()=>{discover();note(`В списке ${taskCache.length} задач из открытых страниц. Выбор сохраняется автоматически.`);};
    ui.search.oninput=refreshTasks;
    ui.timeZone.onchange=()=>{
      const uid=identity(); if(!uid) return;
      write(keyFor('timeZone',uid),ui.timeZone.value);
      note(`Часовой пояс сохранён: ${timeZoneFor(uid)}. Новый рабочий день начинается в 00:00 по этому времени.`);
    };
    ui.dailyUrl.onchange=()=>{
      const uid=identity(); if(!uid) return;
      const entered=ui.dailyUrl.value.trim();
      if(!entered) { remove(keyFor('dailyUrl',uid));note('Ссылка на дейлик удалена.');return; }
      const safe=safeCallUrl(entered);
      if(!safe) return note('Нужна корректная HTTPS-ссылка Zoom или Microsoft Teams.');
      ui.dailyUrl.value=safe;write(keyFor('dailyUrl',uid),safe);note('Ссылка на дейлик сохранена.');
    };
    ui.dailyUrl.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();ui.dailyUrl.blur();}};
    ui.select.onchange=()=>{
      const task=taskCache.find(task=>String(task.id)===ui.select.value) || selected();
      if (ui.select.value && task) write(keyFor('selected'),task); else remove(keyFor('selected'));
      refresh();
    };
    ui.current.onclick=()=>{const task=currentTask();if(task){write(keyFor('selected'),task);discover();}};
    ui.open.onclick=()=>{const task=selected(),uid=identity();if(task && uid) window.open(`${ORIGIN}/company/personal/user/${uid}/tasks/task/view/${task.id}/`,'_blank','noopener');};
    ui.exists.onclick=()=>resolvePending(true);ui.absent.onclick=()=>resolvePending(false);
    ui.resetPosition.onclick=()=>{place(16,42,true);note('Позиция панели сброшена.');};
    window.addEventListener('resize',()=>{const box=host.getBoundingClientRect();place(box.left,box.top);});
    discover(); refresh();
    if(layout.compact && !pending()) setCompact(true,false);
  }
  window.addEventListener('storage',event=>{
    if(event.key?.startsWith(PREFIX)) { const uid=identity();if(uid){taskCache=read(keyFor('tasks'))||[];refreshTasks();}refresh(); }
  });
  document.addEventListener('DOMContentLoaded',mount,{once:true});
  const timer=setInterval(()=>{
    mount(); refresh();
    const uid=identity();
    if(ui && uid && lastIdentity!==ui.lastUid) { ui.lastUid=uid; discover(); const task=currentTask();if(!selected() && task) write(keyFor('selected'),task);refreshTasks(); }
  },250);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  if(document.readyState!=='loading') mount();
})();
