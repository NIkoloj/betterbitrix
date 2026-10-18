const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(require.resolve('../extension/background.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function worker() {
  const sent=[],executions=[],listeners={},tabs=new Map([[1,{id:1,active:true,url:'https://b24.entgld.com/home'}],[2,{id:2,active:false,url:'https://b24.entgld.com/tasks'}]]);
  let saved={},hold=null, nextUid=1178;
  const state=()=>({protocol:1,uid:nextUid,observedAt:Date.now(),meetingsStatus:'ready',meetings:[]});
  const port={postMessage:message=>sent.push(message),disconnect(){},onDisconnect:{addListener:fn=>listeners.disconnect=fn},onMessage:{addListener:fn=>listeners.native=fn}};
  const chrome={
    runtime:{connectNative:()=>port,onStartup:{addListener(){}},onInstalled:{addListener(){}},lastError:null},
    tabs:{get:async id=>{if(!tabs.has(id))throw Error('missing tab');return tabs.get(id);},query:async()=>[...tabs.values()],create:async value=>listeners.created=value},
    storage:{session:{get:async()=>saved,set:async value=>saved=value}},
    scripting:{executeScript:async options=>{
      if(options.files) return [];
      executions.push({tabId:options.target.tabId,command:options.args[0],params:options.args[1],expectedUid:options.args[2]});
      if(hold && options.args[0]==='finish') await hold;
      if(options.args[0]!=='state' && options.args[2]!==nextUid) return [{result:{error:'Пользователь Bitrix изменился.'}}];
      return [{result:{state:state()}}];
    }},
    action:{onClicked:{addListener:fn=>listeners.clicked=fn}},
    alarms:{create:async()=>{},onAlarm:{addListener:fn=>listeners.alarm=fn}}
  };
  const context={chrome,setInterval:fn=>{listeners.poll=fn;return 1;},clearInterval(){},Date,console};vm.createContext(context);vm.runInContext(source,context);await flush();await flush();
  return {sent,executions,listeners,tabs,setUid:uid=>nextUid=uid,holdFinish:promise=>hold=promise};
}
test('worker publishes current identity/calendar, pins a tab and never asks for cookies permission',async()=>{
  const w=await worker();assert.equal(w.sent[0].state.uid,1178);
  assert.equal(w.executions.filter(item=>item.command==='meetings').length,1);
  w.tabs.get(1).active=false;w.tabs.get(2).active=true;
  await w.listeners.poll();await flush();assert.equal(w.executions.at(-1).tabId,1);
  await w.listeners.clicked(w.tabs.get(2));await flush();assert.equal(w.executions.at(-1).tabId,2);
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../extension/manifest.json'),'utf8'));
  assert.equal(manifest.permissions.includes('cookies'),false);assert.equal(manifest.content_scripts[0].world,'MAIN');
  assert.equal(manifest.content_scripts[0].all_frames,true);
});
test('worker forwards identity guards and reports an account change to the pending request',async()=>{
  const w=await worker();w.setUid(999);
  await w.listeners.native({type:'command',id:'first',command:'start',expectedUid:1178,params:{}});
  const result=w.sent.find(item=>item.id==='first');assert.match(result.error,/Пользователь Bitrix изменился/);
});
test('worker rejects overlapping write commands and does not retry a command on disconnect',async()=>{
  const w=await worker();let release;w.holdFinish(new Promise(resolve=>release=resolve));
  const finishing=w.listeners.native({type:'command',id:'finish',command:'finish',expectedUid:1178,params:{}});
  await flush();await w.listeners.native({type:'command',id:'again',command:'finish',expectedUid:1178,params:{}});
  assert.match(w.sent.find(item=>item.id==='again').error,/ещё выполняется/);
  release();await finishing;w.listeners.disconnect();await flush();
  assert.equal(w.executions.filter(item=>item.command==='finish').length,1);
});
test('missing Bitrix tab publishes an offline state',async()=>{
  const w=await worker();w.tabs.clear();await w.listeners.poll();await flush();
  assert.equal(w.sent.at(-1).type,'offline');assert.match(w.sent.at(-1).error,/Откройте Bitrix/);
});
test('extension identity is stable and matches the installer without manual ID input',()=>{
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../extension/manifest.json'),'utf8'));
  const identity=JSON.parse(fs.readFileSync(require.resolve('../extension/identity.json'),'utf8'));
  const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,x=>String.fromCharCode(97+parseInt(x,16)));
  assert.equal(id,identity.id);
  const generated=fs.readFileSync(require.resolve('../Shared/ExtensionIdentity.cs'),'utf8');
  assert.ok(generated.includes(`Id = "${id}"`));assert.ok(generated.includes(`Version = "${manifest.version}"`));
});
