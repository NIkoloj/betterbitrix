const HOST = 'com.betterbitrix.desktop';
const PORTAL = 'https://b24.entgld.com/';
let nativePort = null, pollTimer = null, polling = false, commandBusy = false;
let targetId = null, retryAt = 0;
let pageQueue=Promise.resolve(), calendarUid=null, calendarAt=0;

async function portalTab() {
  if(targetId !== null) {
    try {const tab=await chrome.tabs.get(targetId);if(tab.url?.startsWith(PORTAL)) return tab;} catch {}
    targetId=null;
  }
  const saved=(await chrome.storage.session.get('targetId')).targetId;
  if(Number.isInteger(saved)) {
    try {const tab=await chrome.tabs.get(saved);if(tab.url?.startsWith(PORTAL)){targetId=saved;return tab;}} catch {}
  }
  const tabs=await chrome.tabs.query({url:PORTAL+'*'});
  tabs.sort((a,b)=>Number(b.active)-Number(a.active) || (b.lastAccessed || 0)-(a.lastAccessed || 0));
  if(!tabs.length) throw Error('Откройте Bitrix в браузере и войдите в свою учётную запись.');
  targetId=tabs[0].id;
  await chrome.storage.session.set({targetId});
  return tabs[0];
}

function execute(command,params={},expectedUid=null) {
  const result=pageQueue.then(()=>executePage(command,params,expectedUid));
  pageQueue=result.catch(()=>{});
  return result;
}
async function executePage(command,params={},expectedUid=null) {
  const tab=await portalTab();
  // Reinject for tabs that were open before installation. The runtime is idempotent.
  // Declarative content scripts cover matching portal frames after a reload.
  // Reinjection targets only the top frame; unrelated embedded sites need no permission.
  await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['runtime.js']});
  const results=await chrome.scripting.executeScript({
    target:{tabId:tab.id},world:'MAIN',
    func:async(command,params,expectedUid)=>{
      try {return {state:await window.__betterBitrixDesktop.execute(command,params,expectedUid)};}
      catch(error) {return {error:error.message || 'Ошибка Bitrix.'};}
    },args:[command,params,expectedUid]
  });
  const result=results[0]?.result;
  if(!result) throw Error('Страница Bitrix ещё загружается.');
  if(result.error) throw Error(result.error);
  return result.state;
}

function send(message) {try {nativePort?.postMessage(message);} catch {disconnect();}}
function disconnect() {
  const port=nativePort;nativePort=null;
  if(pollTimer) clearInterval(pollTimer);pollTimer=null;
  retryAt=Date.now()+15000;
  try {port?.disconnect();} catch {}
}
async function poll() {
  if(!nativePort || polling || commandBusy) return;
  polling=true;
  try {
    const state=await execute('state');send({type:'state',state});
    if(state.uid && (calendarUid!==state.uid || Date.now()-calendarAt>300000 || state.meetingsStatus==='idle')) {
      calendarUid=state.uid;calendarAt=Date.now();
      send({type:'state',state:await execute('meetings',{},state.uid)});
    }
  }
  catch(error) {send({type:'offline',error:error.message});}
  finally {polling=false;}
}
function connect() {
  if(nativePort || Date.now()<retryAt) return;
  nativePort=chrome.runtime.connectNative(HOST);
  nativePort.onDisconnect.addListener(()=>{void chrome.runtime.lastError;disconnect();});
  nativePort.onMessage.addListener(async request=>{
    if(request?.type!=='command' || typeof request.id!=='string') return;
    if(commandBusy) {send({type:'result',id:request.id,error:'Предыдущая команда ещё выполняется.'});return;}
    commandBusy=true;
    try {send({type:'result',id:request.id,state:await execute(request.command,request.params,request.expectedUid)});}
    catch(error) {send({type:'result',id:request.id,error:error.message});}
    finally {commandBusy=false;}
  });
  pollTimer=setInterval(()=>void poll(),2000);
  void poll();
}
chrome.action.onClicked.addListener(async tab=>{
  if(!tab.url?.startsWith(PORTAL)) {await chrome.tabs.create({url:PORTAL});return;}
  if(commandBusy) return;
  targetId=tab.id;await chrome.storage.session.set({targetId});retryAt=0;connect();await poll();
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='reconnect') connect();});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(()=>{void chrome.alarms.create('reconnect',{periodInMinutes:0.5});connect();});
// Native ports keep the worker alive. The alarm reconnects after app/browser restarts.
void chrome.alarms.create('reconnect',{periodInMinutes:0.5});
connect();
