// ==UserScript==
// @name         BetterBitrix Portable — мост
// @namespace    local.betterbitrix-portable
// @version      0.3.4
// @homepageURL  https://nikoloj.github.io/betterbitrix/
// @updateURL    https://nikoloj.github.io/betterbitrix/windows/companion/BetterBitrixPortable.meta.js
// @downloadURL  https://nikoloj.github.io/betterbitrix/windows/companion/BetterBitrixPortable.user.js
// @description  Связывает portable-панель Windows с текущей сессией Bitrix. Установите рядом с BetterBitrix.
// @match        https://b24.entgld.com/*
// @run-at       document-start
// @sandbox      raw
// @connect      127.0.0.1
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
const window=unsafeWindow, XMLHttpRequest=window.XMLHttpRequest, navigator=window.navigator;
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
  function decodeLinkEntities(value) {
    const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:'\u00a0',colon:':',sol:'/'};
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|colon|sol);/gi,(entity,name)=>{
      if(name[0]!=='#') return named[name.toLowerCase()];
      const code=name[1].toLowerCase()==='x' ? parseInt(name.slice(2),16) : Number(name.slice(1));
      return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : entity;
    });
  }
  function callUrlInfo(value,depth=0) {
    if(typeof value!=='string') return null;
    const decoded=decodeLinkEntities(value);
    let url; try { url=new URL(decoded); } catch { return null; }
    if(url.protocol!=='https:' || url.username || url.password) return null;
    const host=url.hostname.toLowerCase();
    if(host==='zoom.us' || host.endsWith('.zoom.us')) return {url:url.href,provider:'Zoom'};
    if(host==='teams.microsoft.com' || host==='teams.live.com' || host==='teams.cloud.microsoft') return {url:url.href,provider:'Teams'};
    if(depth<3 && host.endsWith('.safelinks.protection.outlook.com')) {
      const targets=url.searchParams.getAll('url');
      const destination=targets.length===1 && callUrlInfo(targets[0],depth+1);
      // Keep the protected URL for opening; do not bypass Outlook's click-time check.
      if(destination) return {url:url.href,provider:destination.provider};
    }
    return null;
  }
  const safeCallUrl=value=>callUrlInfo(value)?.url || null;
  function callLinks(value) {
    const strings=[];
    const collect=item=>{
      if(typeof item==='string') strings.push(item);
      else if(Array.isArray(item)) item.forEach(collect);
      else if(item && typeof item==='object') Object.values(item).forEach(collect);
    };
    collect(value);
    const links=new Set();
    const add=value=>{ const safe=safeCallUrl(value.trim()); if(safe) links.add(safe); };
    for(const source of strings) {
      // Read hyperlink targets instead of their visible labels. Bitrix may return
      // HTML, escaped HTML or BBCode in either description field.
      const text=decodeLinkEntities(source)
        .replace(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>[\s\S]*?<\/a\s*>/gi,(_,attributes)=>{
          const href=[...attributes.matchAll(/(?:^|\s)([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g)]
            .find(attribute=>attribute[1].toLowerCase()==='href');
          if(href) add(href[2] ?? href[3] ?? href[4]);
          return ' ';
        })
        .replace(/\[url(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]([\s\S]*?)\[\/url\]/gi,(_,doubleQuoted,singleQuoted,unquoted,label)=>{
          add(doubleQuoted ?? singleQuoted ?? unquoted ?? label);
          return ' ';
        });
      for(const match of text.matchAll(/https:\/\/[^\s<>"'\[\]]+/gi)) {
        const candidate=match[0].replace(/[),.;\]}]+$/,'');
        add(candidate);
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
    // Expanded occurrences can retain the series master's UTC timestamp.
    // DATE_FROM is the occurrence date returned for the requested range.
    const recurring=!!event?.RRULE?.FREQ || (typeof event?.RRULE==='string' && !!event.RRULE) || !!event?.ORIGINAL_DATE_FROM || positive(event?.RECURRENCE_ID);
    if(recurring && (event?.DATE_FROM || event?.DATE_FROM_FORMATTED)) return calendarDateMatches(event,expectedDate);
    const rawTimestamp=Number(event?.DATE_FROM_TS_UTC);
    if(Number.isFinite(rawTimestamp) && rawTimestamp>0) {
      const timestamp=rawTimestamp>1e12 ? rawTimestamp : rawTimestamp*1000;
      const instant=new Date(timestamp);
      if(context?.zone && isValidTimeZone(context.zone)) return day(instant,context.zone)===expectedDate;
      if(Number.isFinite(context?.offsetSeconds)) return new Date(timestamp+context.offsetSeconds*1000).toISOString().slice(0,10)===expectedDate;
    }
    return calendarDateMatches(event,expectedDate);
  }
  function calendarDateMatches(event,expectedDate) {
    // Bitrix also supplies strings such as "Mon Oct 19 2026 10:00:00".
    const raw=String(event?.DATE_FROM || event?.DATE_FROM_FORMATTED || '');
    const text=String(event?.DATE_FROM_FORMATTED || raw);
    if(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(text)) {
      const parsed=new Date(text);
      if(Number.isFinite(parsed.getTime())) return `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}`===expectedDate;
    }
    let parts=raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\D|$)/);
    if(parts) return `${parts[1]}-${parts[2].padStart(2,'0')}-${parts[3].padStart(2,'0')}`===expectedDate;
    parts=raw.match(/^(\d{1,2})([-./])(\d{1,2})\2(\d{4})(?:\D|$)/);
    if(!parts) return false;
    // Slash dates in REST use month/day/year; dot dates use day.month.year.
    const monthFirst=parts[2]==='/' && Number(parts[1])<=12;
    const month=monthFirst ? parts[1] : parts[3],date=monthFirst ? parts[3] : parts[1];
    return `${parts[4]}-${month.padStart(2,'0')}-${date.padStart(2,'0')}`===expectedDate;
  }
  const Core={compile,render,migrateProfile,decodeBody,receipt,definiteError,day,positive,get,safeCallUrl,callLinks,calendarClock,calendarEventMinutes,calendarEventTime,calendarContext,calendarEventOnDay,MARKER};
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') { module.exports=Core; return; }
  if (location.origin !== ORIGIN || window.__betterBitrixDesktopInstalled) return;
  window.__betterBitrixDesktopInstalled=true;
  const originalFetch=window.fetch.bind(window);
  const read=key=>{ try { return JSON.parse(localStorage.getItem(PREFIX+key)); } catch { return null; } };
  const write=(key,value)=>{ localStorage.setItem(PREFIX+key,JSON.stringify(value)); refresh(); };
  const remove=key=>{ localStorage.removeItem(PREFIX+key); refresh(); };
  let ui=null, busy=false, taskCache=[], message='', lastIdentity=null;
  let meetingsState={key:'',status:'idle',items:[],error:''};
  let meetingsCheckedAt=0;
  let meetingsContext=null;
  function identity() {
    try {
      const id=window.BX?.message?.('USER_ID');
      if (positive(id)) { lastIdentity=Number(id); return lastIdentity; }
      if (window.top !== window && positive(window.top.BX?.message?.('USER_ID'))) return Number(window.top.BX.message('USER_ID'));
    } catch { /* no same-origin top */ }
    return null; // URL user ID is not proof of the logged-in identity.
  }
  const keyFor=(name,uid=identity())=>`${uid}:${name}`;
  const showAllMeetings=(uid=identity())=>!!uid && read(keyFor('showAllMeetings',uid))===true;
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
    const showAll=showAllMeetings(),items=meetingsState.items.filter(meeting=>meeting.url || showAll);
    if(!items.length) { ui.meetingsStatus.textContent=showAll ? 'На сегодня нет событий в календаре.' : 'На сегодня нет событий со ссылкой Zoom или Teams в описании.'; return; }
    ui.meetingsStatus.hidden=true;
    for(const meeting of items) {
      const button=document.createElement('button'); button.className='meeting-item'; button.type='button';
      const top=document.createElement('span'); top.className='meeting-top';
      const time=document.createElement('span'); time.className='meeting-time'; time.textContent=meeting.time;
      const provider=document.createElement('span'); provider.className='meeting-provider'; provider.textContent=meeting.provider;
      const name=document.createElement('span'); name.className='meeting-name'; name.textContent=meeting.name;
      top.append(time,provider); button.append(top,name);
      button.disabled=!meeting.url;
      button.title=meeting.url ? 'Открыть созвон' : 'В описании нет ссылки Zoom или Teams';
      if(meeting.url) button.onclick=()=>window.open(meeting.url,'_blank','noopener');
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
      meetingsContext=context;
      desktopCalendarContext=context;
      const date=context.date, key=`${uid}:${date}:${context.zone || `UTC${context.offsetSeconds}`}`;
      if(!force && previous.key===key && previous.status==='ready' && Date.now()-meetingsCheckedAt<300000) { meetingsState=previous;renderMeetings();return; }
      const data=await callBitrix('calendar.event.get',{type:'user',ownerId:uid,from:date,to:date});
      const events=Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [];
      const items=[];
      for(const event of events) {
        if(String(event?.MEETING_STATUS).toUpperCase()==='N' || String(event?.DELETED).toUpperCase()==='Y') continue;
        if(!calendarEventOnDay(event,date,context)) continue;
        const url=callLinks([event?.DESCRIPTION,event?.['~DESCRIPTION'],event?.LOCATION,event?.['~LOCATION']])[0] || null;
        const start=calendarEventMinutes(event);
        items.push({name:String(event?.NAME || 'Созвон'),time:calendarEventTime(event),provider:callUrlInfo(url)?.provider || 'Без ссылки',url,start});
      }
      items.sort((a,b)=>a.start-b.start || a.name.localeCompare(b.name,'ru'));
      if(identity()!==uid) { meetingsState={key:'',status:'idle',items:[],error:''};return; }
      meetingsCheckedAt=Date.now();
      meetingsState={key,status:'ready',items,error:''}; renderMeetings();
    } catch(problem) {
      meetingsCheckedAt=Date.now();
      meetingsState={key:meetingsState.key,status:'error',items:[],error:`Не удалось загрузить календарь: ${problem?.message || problem}`}; renderMeetings();
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
  // This runs in the portal page. Credentials and CSRF tokens never leave it.
  // No extra DOM panel is mounted and no browser release source is modified.
  function refresh() {}
  let desktopCalendarContext=null;
  function desktopState() {
    const uid=identity();
    if(!uid) return {protocol:1,uid:null,observedAt:Date.now(),status:'Войдите в Bitrix в браузере.'};
    const state=timerState(uid), task=selected(), profile=profileFor(uid);
    const unresolved=pending(uid), today=journal(uid)[workDay(new Date(),uid)];
    const arm=read('arm'), active=arm?.userId===uid && arm.until>Date.now();
    const submitting=['submitting','pending'].includes(state?.status);
    const blocked=busy || desktopBusy || !!unresolved || !!active || submitting;
    const learned=read('learnMessage');
    const calendarDate=desktopCalendarContext?.zone ? day(new Date(),desktopCalendarContext.zone) : desktopCalendarContext ? new Date(Date.now()+desktopCalendarContext.offsetSeconds*1000).toISOString().slice(0,10) : '';
    const calendarFresh=!!calendarDate && meetingsState.key?.startsWith(`${uid}:${calendarDate}:`);
    const safeTask=value=>value ? {id:Number(value.id),title:String(value.title || '').slice(0,180)} : null;
    return {
      protocol:1,uid,observedAt:Date.now(),
      timer:state ? {status:state.status,startedAt:state.startedAt,accumulatedMs:state.accumulatedMs,task:safeTask(state.task),date:state.date} : null,
      selected:safeTask(task),tasks:(read(keyFor('tasks',uid)) || []).slice(-300).map(safeTask),
      dailyUrl:safeCallUrl(read(keyFor('dailyUrl',uid)) || '') || '',
      timeZone:read(keyFor('timeZone',uid)) || 'auto',resolvedTimeZone:timeZoneFor(uid),
      showAllMeetings:showAllMeetings(uid),dayDone:today?.status==='done',pending:!!unresolved,
      canPrimary:!blocked && (!!state || (!!profile && !!task && today?.status!=='done')),
      canPause:!blocked && ['running','paused'].includes(state?.status),
      canQuickAdd:!blocked && !state && !!profile && !!task && today?.status!=='done',
      canConfigure:!blocked && !state && !!task && today?.status!=='done',
      canChangeTask:!blocked && !state,
      canChangeTimeZone:!blocked && !state && today?.status!=='done',
      configuring:!!active,canCancel:!!active && !arm.claimed,
      status:learned?.uid===uid ? learned.text : message || (unresolved ? 'Проверьте результат записи в задаче.' : active ? `Сохраните 8 часов через форму Bitrix с комментарием «${MARKER}».` : !profile ? 'Выберите задачу и настройте Bitrix.' : !task ? 'Выберите задачу.' : ''),
      meetings:calendarFresh ? meetingsState.items.filter(item=>item.url || showAllMeetings(uid)).map(item=>({title:item.name,time:item.time,url:item.url || '',provider:item.provider})) : [],
      meetingsDate:calendarFresh ? calendarDate : '',meetingsTimeZone:desktopCalendarContext?.zone || '',meetingsOffsetSeconds:desktopCalendarContext?.offsetSeconds ?? null,
      meetingsStatus:calendarFresh ? meetingsState.status : meetingsState.status==='error' ? 'error' : 'idle',meetingsError:meetingsState.error || ''
    };
  }
  let desktopBusy=false;
  async function desktopExecute(command,params={},expectedUid=null) {
    if(command==='state') return desktopState();
    const before=desktopState();
    if(!before.uid || expectedUid!==before.uid) throw Error('Пользователь Bitrix изменился. Обновите подключение.');
    if(desktopBusy) throw Error('Предыдущая команда ещё выполняется.');
    desktopBusy=true;
    try {
      const requireAllowed=flag=>{if(!before[flag]) throw Error('Действие сейчас недоступно. Обновите состояние.');};
      switch(command) {
        case 'start': requireAllowed('canPrimary');if(before.timer) throw Error('Таймер уже запущен.');await startWorkDay();break;
        case 'finish': requireAllowed('canPrimary');if(!before.timer) throw Error('Таймер не запущен.');await finishWorkDay();break;
        case 'pause': requireAllowed('canPause');await togglePause();break;
        case 'quickAdd': requireAllowed('canQuickAdd');await addDay(28800);break;
        case 'meetings': await loadMeetings(true);break;
        case 'discover': discover();break;
        case 'currentTask': {
          requireAllowed('canChangeTask');const task=currentTask();
          if(!task) throw Error('Откройте карточку задачи в подключённой вкладке Bitrix.');
          write(keyFor('selected'),task);discover();break;
        }
        case 'selectTask': {
          requireAllowed('canChangeTask');
          const task=(read(keyFor('tasks')) || []).find(item=>item.id===params.taskId);
          if(!task) throw Error('Задача не найдена. Обновите список из страницы Bitrix.');
          write(keyFor('selected'),task);break;
        }
        case 'settings': {
          const entered=String(params.dailyUrl || '').trim();
          const daily=entered ? safeCallUrl(entered) : '';
          if(entered && !daily) throw Error('Нужна HTTPS-ссылка Zoom или Teams.');
          const zone=String(params.timeZone || 'auto');
          if(zone!=='auto' && !validTimeZone(zone)) throw Error('Некорректный часовой пояс.');
          if(zone!==before.timeZone) requireAllowed('canChangeTimeZone');
          write(keyFor('dailyUrl'),daily);write(keyFor('showAllMeetings'),params.showAllMeetings===true);
          if(zone!==before.timeZone) write(keyFor('timeZone'),zone);
          note('Настройки сохранены.');break;
        }
        case 'configure': requireAllowed('canConfigure');await armLearning();break;
        case 'cancel': {
          requireAllowed('canCancel');const arm=read('arm');
          if(arm?.userId===identity() && !arm.claimed) remove('arm');break;
        }
        case 'resolve': {
          if(!before.pending || typeof params.exists!=='boolean' || params.verified!==true) throw Error('Сначала проверьте журнал времени в Bitrix.');
          // Confirmation is shown in the Windows window; no suppressed browser dialog.
          await exclusive(before.uid,async()=>{
            const item=pending(before.uid);if(!item) return;
            const records=journal(before.uid);
            if(params.exists) records[item[0]]={...item[1],status:'done',verifiedManually:true};
            else delete records[item[0]];
            write(keyFor('journal'),records);
            const state=timerState();
            if(state && state.date===item[0] && state.task?.id===item[1].taskId) {
              if(params.exists) remove(keyFor('workTimer'));
              else {state.status='paused';state.startedAt=null;write(keyFor('workTimer'),state);}
            }
            remove('learnMessage');note('Результат отмечен после ручной проверки.');
          });break;
        }
        default: throw Error('Неизвестная команда.');
      }
      return desktopState();
    } finally {desktopBusy=false;}
  }
  Object.defineProperty(window,'__betterBitrixDesktop',{value:Object.freeze({execute:desktopExecute}),configurable:false});
})();

// Kept in the userscript scope: pairing credentials are never put into page storage.
(() => {
  'use strict';
  if (unsafeWindow.top !== unsafeWindow || location.origin !== 'https://b24.entgld.com') return;
  const api = unsafeWindow.__betterBitrixDesktop;
  if (!api || !navigator.locks) return;
  const clientId = crypto.randomUUID();
  let stopped = false, polling = false, executing = false, lastCalendar = 0;
  let pendingResults = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  unsafeWindow.addEventListener('pagehide', () => { stopped = true; });
  function request(port, path, body, token = '') {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(Error('Некорректный порт.'));
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: `http://127.0.0.1:${port}${path}`, anonymous: true, timeout: 5000,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      data: JSON.stringify(body),
      onload: response => {
        if (response.status !== 200) return reject(Error(`Portable: ${response.status}`));
        try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(error); }
      },
      ontimeout: () => reject(Error('Portable не отвечает.')),
      onerror: () => reject(Error('Portable недоступен.'))
    }));
  }
  async function pairFromHash() {
    const match = /^#betterbitrix-pair=(\d{4,5})\.([A-F0-9]{48})$/.exec(location.hash);
    if (!match) return;
    const port = Number(match[1]), nonce = match[2];
    // Remove only our own fragment. Do not leave even the short-lived nonce in history.
    history.replaceState(history.state, '', location.pathname + location.search);
    const until = Date.now() + 120000;
    while (!stopped && Date.now() < until) {
      const state = await api.execute('state');
      if (state.uid) {
        try {
          const linked = await request(port, '/pair', { nonce, state });
          if (/^[A-F0-9]{64}$/.test(linked.token) && linked.uid === state.uid)
            GM_setValue('portablePair', { port, token: linked.token, uid: linked.uid });
          return;
        } catch { /* App not ready, permission prompt, or identity still loading. */ }
      }
      await sleep(1000);
    }
  }
  unsafeWindow.addEventListener('hashchange', () => { void pairFromHash(); });
  GM_registerMenuCommand('Связать с BetterBitrix Portable', () => {
    alert('Откройте настройки portable-приложения и нажмите «Связать с браузером». Оно откроет Bitrix с одноразовым ключом.');
  });
  void pairFromHash();
  async function execute(command, uid) {
    if (executing || command.expectedUid !== uid || typeof command.id !== 'string' || typeof command.command !== 'string') return;
    const completed = GM_getValue('portableCompleted', []);
    const existing = completed.find(item => item.id === command.id);
    if (existing) { pendingResults.push(existing);return; }
    // Mark before any side effect. A duplicate ID is never executed after reload.
    const result = { type: 'result', id: command.id, error: 'Выполнение было прервано. Проверьте состояние Bitrix.' };
    GM_setValue('portableCompleted', [...completed.slice(-7), result]);
    executing = true;
    try { await api.execute(command.command, command.params || {}, command.expectedUid);result.error = null; }
    catch (error) { result.error = String(error.message || error).slice(0, 1000); }
    finally {
      GM_setValue('portableCompleted', [...completed.slice(-7), result]);
      pendingResults.push(result);executing = false;
    }
  }
  async function tick() {
    if (polling || stopped) return;
    const linked = GM_getValue('portablePair', null);
    if (!linked?.token || !linked.port) return;
    polling = true;
    try {
      const state = await api.execute('state');
      if (!state.uid || state.uid !== linked.uid) return;
      const sentResults = pendingResults.slice(0, 8);
      const response = await request(linked.port, '/exchange', { clientId, state, results: sentResults }, linked.token);
      pendingResults.splice(0, sentResults.length);
      if (response.command) void execute(response.command, state.uid);
      if (!executing && (Date.now() - lastCalendar > 300000 || state.meetingsStatus === 'idle') && state.meetingsStatus !== 'loading') {
        lastCalendar = Date.now();
        // Calendar fetch may be slow; the transport heartbeat must continue.
        void api.execute('meetings', {}, state.uid).catch(() => {});
      }
    } catch { /* Keep the timer in portal storage; reconnect on the next heartbeat. */ }
    finally { polling = false; }
  }
  async function lead() {
    while (!stopped) {
      await navigator.locks.request('betterbitrix-portable-transport-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) return;
        while (!stopped) { await tick();await sleep(2000); }
      });
      if (!stopped) await sleep(2000);
    }
  }
  void lead();
})();

})();
