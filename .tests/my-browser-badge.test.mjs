import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../my-browser/extension/background.js',import.meta.url),'utf8');

function harness() {
  const noop={addListener(){}};
  const badges=new Map(),calls=[];
  let failed=false,closed=false,updated;
  const chrome={
    runtime:{getManifest:()=>({version:'0.4.23'}),onStartup:noop,onInstalled:noop,onMessage:noop},
    storage:{local:{get:async()=>({clientId:'fixture'}),set:async()=>{}},session:{get:async()=>({}),set:async()=>{}}},
    tabs:{onRemoved:noop,onActivated:noop,onUpdated:{addListener(fn){updated=fn;}},
      async sendMessage(tabId,message){calls.push({tabId,message});if(failed)throw Error('Receiving end does not exist');}},
    alarms:{create(){},onAlarm:noop},
    action:{async setBadgeText({tabId,text}){if(closed&&tabId!==undefined)throw Error('No tab');if(text===null)badges.delete(tabId);else badges.set(tabId,text);},async setBadgeBackgroundColor(){}},
  };
  const context={chrome,MyBrowserNetwork:{create:()=>({})},navigator:{userAgent:'Chrome'},URL,crypto:globalThis.crypto,setTimeout,clearTimeout};
  vm.runInNewContext(source.replace(/\nchain\(\);\s*$/,'')+'\nglobalThis.badgeTest={openOnTab,connection};',context);
  return {...context.badgeTest,calls,updated,badge:tabId=>badges.get(tabId)??badges.get(undefined)??'',fail:value=>{failed=value;},close:()=>{closed=true;}};
}

test('page failure stays on its tab and a later successful click clears it',async()=>{
  const h=harness();await h.connection({connected:true});h.fail(true);
  await h.openOnTab(1);
  assert.equal(h.badge(1),'!');assert.equal(h.badge(2),'');assert.equal(h.badge(undefined),'');
  h.fail(false);await h.openOnTab(1);
  assert.equal(h.badge(1),'');assert.equal(h.calls.length,2,'each user click is dispatched only once');
});

for(const change of [{status:'loading'},{url:'https://example.test/next'}])test('refresh/navigation clears the previous document warning: '+JSON.stringify(change),async()=>{
  const h=harness();await h.connection({connected:true});h.fail(true);await h.openOnTab(1);
  h.updated(1,change);await Promise.resolve();assert.equal(h.badge(1),'');
});

test('unrelated tab updates retain the warning and clearing inherits real connection state',async()=>{
  const h=harness();await h.connection({connected:true});h.fail(true);await h.openOnTab(1);
  h.updated(1,{title:'Still the same page'});assert.equal(h.badge(1),'!');
  await h.connection({connected:false});h.fail(false);await h.openOnTab(1);
  assert.equal(h.badge(1),'!','opening a local panel does not prove Cindy is connected');
  await h.connection({connected:true});assert.equal(h.badge(1),'','reconnection remains visible after clearing the tab override');
});

test('a tab closing during a click or navigation does not reject or replay the action',async()=>{
  const h=harness();h.close();await h.openOnTab(1);h.updated(1,{status:'loading'});
  await Promise.resolve();assert.equal(h.calls.length,1);
});
