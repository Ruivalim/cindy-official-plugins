'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const base=path.resolve('baguette-simulator/node/android'),id='00000000-0000-4000-8000-000000000001';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'android-parity-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('media import uses generated guest paths, verifies bytes and preserves copied outcomes',async t=>{
 const root=await temp(t),file=path.join(root,'photo; $(ignored).png');await fs.writeFile(file,'test');
 const {importMedia}=require(path.join(base,'files.cjs')),calls=[];
 const devices={adb:async(d,args)=>{calls.push(args);return {stdout:args.includes('stat')?'4':''};}};
 const result=await importMedia(devices,{udid:id},{path:file});assert.equal(result.copied,true);assert.equal(result.scanRequested,true);assert.match(result.path,/^\/sdcard\/Download\/cindy-[a-f0-9-]+\.png$/);assert.equal(calls[0][1],await fs.realpath(file));
 const partial=await importMedia({adb:async(d,args)=>{if(args.includes('stat'))return {stdout:'4'};if(args.includes('broadcast'))throw Error('scan unavailable');return {stdout:''};}},{udid:id},{path:file});
 assert.equal(partial.execution,'executed');assert.equal(partial.copied,true);assert.equal(partial.outcome,'partial');assert.match(partial.nextAction,/do not copy/);
 await assert.rejects(importMedia(devices,{udid:id},{path:'relative.png'}),e=>e.code==='INVALID_ARGUMENT');
});
test('partial Android state changes retain completed fields and do not run later fields',async()=>{
 const calls=[],setState=require(path.join(base,'state.cjs')).createState({devices:{adb:async(d,args)=>{calls.push(args);if(args.includes('high_text_contrast_enabled'))throw Object.assign(Error('not allowed'),{code:'DENIED',execution:'unknown'});return {stdout:''};}},agent:{frame:async()=>{throw Error('must not observe after failure');}}});
 const result=await setState({udid:id},{appearance:'dark',contrast:true,text_size:'large'});
 assert.deepEqual(result.applied,['appearance']);assert.equal(result.stateError.field,'contrast');assert.equal(result.execution,'unknown');assert.equal(calls.length,2);
});
test('failed APK fingerprint reads are unconfirmed, never evidence for reinstall',async()=>{
 const {createApps}=require(path.join(base,'apps.cjs'));
 const apps=createApps({devices:{adb:async(d,args)=>{if(args.includes('dumpsys'))return {stdout:'versionCode=12\nversionName=1.2'};throw Object.assign(Error('permission denied'),{code:'ADB_FAILED'});}}});
 const result=await apps.info({udid:id},{bundleId:'test.example.app'});assert.equal(result.installed,true);assert.equal(result.verification,'unconfirmed');assert.equal(result.comparisonError.code,'ADB_FAILED');assert.equal(result.fingerprint,null);
});
test('viewer upload requires origin, capability, opened device and a supported file type',async t=>{
 const requests=[],viewer=require(path.join(base,'viewer.cjs')).createViewer({root:await temp(t),devices:{target:async()=>({udid:id})},agent:{}});t.after(()=>viewer.close());
 viewer.configure({assertEnabled:async()=>{},request:async(method,p)=>{requests.push({method,p,bytes:await fs.readFile(p.path)});return {copied:true,execution:'executed'};}});
 const u=new URL((await viewer.open(id)).url),token=new URLSearchParams(u.hash.slice(1)).get('cindyClipboard').split('.')[1];
 const upload=(headers,name='photo.png',device=id)=>fetch(u.origin+'/android-file?udid='+device+'&name='+name,{method:'POST',headers,body:'image'});
 assert.equal((await upload({Origin:u.origin})).status,403);
 assert.equal((await upload({'X-Cindy-Clipboard':token,Origin:'https://example.test'})).status,403);
 assert.equal((await upload({'X-Cindy-Clipboard':token,Origin:u.origin},'script.sh')).status,409);
 assert.equal((await upload({'X-Cindy-Clipboard':token,Origin:u.origin},'photo.png','unknown')).status,404);
 assert.equal(requests.length,0);
 assert.equal((await upload({'X-Cindy-Clipboard':token,Origin:u.origin})).status,200);assert.equal(requests[0].method,'import_media');assert.equal(requests[0].bytes.toString(),'image');await assert.rejects(fs.stat(requests[0].p.path),e=>e.code==='ENOENT');
});
test('wheel motion survives a slow initial touch and releases after intermediate moves',async()=>{
 const handlers={},nodes={},pointers=new Map(),sent=[];
 const node=()=>({hidden:true,addEventListener(){},getBoundingClientRect:()=>({width:400,height:800}),getAnimations:()=>[],focus(){}});
 const canvas=node();canvas.addEventListener=(name,fn)=>{handlers[name]=fn;};
 const context={window:{},document:{getElementById:id=>nodes[id]||(nodes[id]=node()),addEventListener(){}},location:{pathname:'/simulators/'+id,search:'?cindyViewer=test'},URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,addEventListener(){}};
 vm.runInNewContext(await fs.readFile(path.join(base,'screen-actions.js'),'utf8'),context);
 context.window.androidScreenActions({canvas,frame:node(),pointers,zh:false,input:async()=>{},flush:async start=>{sent.push([...pointers.values()].map(p=>({...p})));await new Promise(r=>setTimeout(r,start?180:5));for(const [key,p] of pointers)if(p.pressure===0)pointers.delete(key);}});
 handlers.wheel({preventDefault(){},stopPropagation(){},deltaY:160,deltaX:0,deltaMode:0,ctrlKey:false});
 for(let i=0;i<100&&(!sent.length||pointers.size);i++)await new Promise(r=>setTimeout(r,20));
 assert.ok(sent.length>=5);assert.equal(sent[0][0].y,.5);assert.ok(sent.some(t=>t[0]?.pressure===1024&&t[0].y<.5&&t[0].y>.3));assert.equal(sent.at(-1)[0].pressure,0);assert.equal(pointers.size,0);
});
