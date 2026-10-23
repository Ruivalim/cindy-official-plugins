'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http2=require('node:http2');
const A=path.resolve('baguette-simulator/node/android');
const {PNG}=require('../../baguette-simulator/vendor/android/deps.cjs');
const {host,repository,packageArchive,createSdk,extract}=require(path.join(A,'sdk.cjs'));
const {rpc,schema}=require(path.join(A,'grpc.cjs'));
const M=require('../../baguette-simulator/node/control-model.js');
const id='00000000-0000-4000-8000-000000000001';
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-android-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
function catalog(){return {license:[{'@_id':'license','#text':'SDK terms'}],remotePackage:[{'@_path':'emulator',channelRef:{'@_ref':'channel-0'},'display-name':'Emulator','uses-license':{'@_ref':'license'},archives:{archive:[['macosx','aarch64'],['macosx','x64'],['windows','x64'],['linux','x64']].map(([os,arch])=>({'host-os':os,'host-arch':arch,complete:{url:`emulator-${os}-${arch}.zip`,size:'100',checksum:{'@_type':'sha256','#text':'a'.repeat(64)}}}))}}]};}
test('Android downloads select stable archives for each supported host and require a license',()=>{
  for(const [platform,arch]of [['darwin','arm64'],['darwin','x64'],['win32','x64'],['linux','x64']]){
    const target=host(platform,arch),p=packageArchive(catalog(),'emulator','https://dl.google.com/android/repository/',target);assert.ok(p.url.includes(target.arch));assert.equal(p.license.text,'SDK terms');
  }
  assert.throws(()=>host('linux','arm64'),e=>e.code==='ANDROID_HOST_UNSUPPORTED');
  const noLicense=catalog();noLicense.license=[];assert.throws(()=>packageArchive(noLicense,'emulator','https://dl.google.com/android/repository/'),e=>e.code==='SDK_LICENSE_MISSING');
});
test('Android catalog rejects external URLs, bad checksums and XML entities',()=>{
  for(const change of [{url:'https://example.test/payload.zip'},{checksum:'bad'},{size:'-1'}]){
    const c=catalog();for(const archive of c.remotePackage[0].archives.archive)Object.assign(archive.complete,change);
    assert.throws(()=>packageArchive(c,'emulator','https://dl.google.com/android/repository/'));
  }
  assert.throws(()=>repository('<!DOCTYPE a><root/>'),e=>e.code==='SDK_CATALOG_INVALID');
});
test('SDK discovery reuses tools and images without downloads on Windows, Linux and Mac',async t=>{
  const root=await temp(t),sdkRoot=path.join(root,'existing'),image=path.join(sdkRoot,'system-images/android-36/google_apis/x86_64');
  for(const name of ['emulator/emulator','emulator/emulator.exe','platform-tools/adb','platform-tools/adb.exe','system-images/android-36/google_apis/x86_64/system.img']){const f=path.join(sdkRoot,name);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'');}
  for(const platform of ['darwin','win32','linux']){const sdk=createSdk(path.join(root,platform),{platform,arch:'x64',env:{ANDROID_HOME:sdkRoot},home:root});const actual=await sdk.inspect();assert.equal(actual.ready,true);assert.equal(actual.images[0].directory,image);assert.equal((await sdk.plan()).packages.length,0);await assert.rejects(sdk.install({planId:'invented',acceptLicenses:true}),e=>e.code==='SDK_CONFIRM_REQUIRED');}
});
test('mixed catalogs never offer Android models against iOS runtimes',()=>{
  const catalog={deviceTypes:[{identifier:'android:phone',platform:'android',name:'Android Phone'},{identifier:'iphone',platform:'ios',name:'iPhone'}],runtimes:[{identifier:'ios',platform:'ios',version:'27'},{identifier:'android',platform:'android',version:'36'}]};
  assert.deepEqual(M.runtimesFor(catalog,'android:phone').map(r=>r.identifier),['android']);assert.deepEqual(M.runtimesFor(catalog,'iphone').map(r=>r.identifier),['ios']);
});
async function emulator(t,handler){
  const server=http2.createServer(),sessions=new Set();server.on('session',s=>{sessions.add(s);s.on('close',()=>sessions.delete(s));});
  server.on('stream',async(stream,headers)=>{assert.equal(headers.authorization,'Bearer test-capability');stream.on('error',()=>{});let chunks=[];for await(const chunk of stream)chunks.push(chunk);await handler(stream,headers,Buffer.concat(chunks));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sessions)s.destroy();await new Promise(r=>server.close(r));});return {port:server.address().port,token:'test-capability'};
}
function send(stream,type,value,{status='0',fragment=false}={}){
  const payload=Buffer.from(schema.lookupType(type).encode(value).finish()),header=Buffer.alloc(5);header.writeUInt32BE(payload.length,1);const all=Buffer.concat([header,payload]);
  stream.respond({':status':200,'content-type':'application/grpc'},{waitForTrailers:true});stream.on('wantTrailers',()=>stream.sendTrailers({'grpc-status':status}));
  if(fragment){stream.write(all.subarray(0,2));stream.write(all.subarray(2,7));stream.end(all.subarray(7));}else stream.end(all);
}
test('gRPC authenticates, reassembles fragmented frames and rejects failed mutation results',async t=>{
  const endpoint=await emulator(t,(s,h)=>send(s,'ClipData',{text:'你好 Android'},{fragment:true}));assert.equal((await rpc(endpoint,'getClipboard')).text,'你好 Android');
  const rejected=await emulator(t,(s,h)=>send(s,'Empty',{}, {status:'7'}));await assert.rejects(rpc(rejected,'sendKey',{key:'Enter',eventType:2}),e=>e.execution==='unknown');
});
test('gRPC cancellation closes a live stream promptly',async t=>{
  const endpoint=await emulator(t,s=>s.respond({':status':200,'content-type':'application/grpc'}));const abort=new AbortController();const promise=rpc(endpoint,'streamScreenshot',{}, {signal:abort.signal});abort.abort();await assert.rejects(promise,/cancelled/);
});
function image(){const png=new PNG({width:108,height:240});png.data.fill(255);return PNG.sync.write(png);}
test('Android touch failures release all fingers and retain unknown execution',async t=>{
  const sent=[],endpoint=await emulator(t,(s,h,body)=>{
    const method=h[':path'].split('/').at(-1);
    if(method==='getScreenshot')return send(s,'Image',{format:{width:108,height:240,rotation:{rotation:0}},image:image()});
    const touch=schema.lookupType('TouchEvent').decode(body.subarray(5));sent.push(touch.touches);send(s,'Empty',{}, {status:sent.length===2?'13':'0'});
  });
  const root=await temp(t),agent=require(path.join(A,'agent.cjs')).createAgent({root,devices:{adb:async()=>({stdout:"Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 108, 240]"})},run:()=>{}});
  await assert.rejects(agent.gesture({udid:id,model:{density:160,width:108,height:240},endpoint},{kind:'swipe',from:[20,20],to:[40,40],duration:0.03,observe:'none'}),e=>e.execution==='unknown');
  assert.equal(sent.at(-1).length,10);assert.ok(sent.at(-1).every(t=>t.pressure===0));
});
test('Android screenshot crops in view points and never exposes emulator credentials',async t=>{
  const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:108,height:240,rotation:{rotation:0}},image:image()}));
  const root=await temp(t),agent=require(path.join(A,'agent.cjs')).createAgent({root,devices:{adb:async()=>({stdout:"Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 108, 240]"})},run:()=>{}}),result=await agent.screenshot({udid:id,name:'Test',model:{density:160},endpoint},{region:{x:10,y:20,width:40,height:50},scale:2,_inline:true});
  assert.deepEqual(result.pixels,{width:80,height:100});assert.ok(result._modelImages[0].data);assert.ok(!JSON.stringify(result).includes(endpoint.token));
});
test('private Android devices reject foreign IDs, validate model/runtime and preserve unique names',async t=>{
  const root=await temp(t),sdk={inspect:async()=>({ready:true,emulator:'/sdk/emulator',adb:'/sdk/adb',images:[{identifier:'android:test',directory:'/sdk/image',version:'36',abi:'x86_64'}]})};
  const devices=require(path.join(A,'devices.cjs')).createDevices({root,sdk,run:()=>{throw Error('No process should run');},children:new Set()});
  assert.equal(await devices.owns(id),false);await assert.rejects(devices.target({udid:id}),e=>e.code==='DEVICE_NOT_OWNED');await assert.rejects(devices.create({name:'Bad',deviceType:'iphone',runtime:'android:test'}),e=>e.code==='INVALID_ARGUMENT');
  const one=await devices.create({name:'Android',deviceType:'android:phone',runtime:'android:test'}),two=await devices.create({name:'Android',deviceType:'android:phone',runtime:'android:test'});
  assert.equal(one.name,'Android');assert.equal(two.name,'Android 2');assert.equal(await devices.owns(one.udid),true);assert.equal((await devices.devices()).length,2);
});
test('Android viewer requires capability, origin and a plugin-owned opened device',async t=>{
  const root=await temp(t),d={udid:id,endpoint:{port:1,token:'private'},model:{density:160,width:108,height:240}};
  const viewer=require(path.join(A,'viewer.cjs')).createViewer({root,devices:{target:async p=>{assert.equal(p.udid,id);return d;}},agent:{}});t.after(()=>viewer.close());
  viewer.configure({status:async()=>({devices:[{udid:id,state:'Booted'}]}),assertEnabled:async()=>{},touch:()=>{}});
  const opened=await viewer.open(id,'en'),url=new URL(opened.url),token=new URLSearchParams(url.hash.slice(1)).get('cindyClipboard').split('.')[1];
  const post=(headers,body)=>fetch(url.origin+'/control-api',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post({Origin:url.origin},{action:'status',udid:id})).status,403);
  assert.equal((await post({Origin:'https://example.test','X-Cindy-Clipboard':token},{action:'status',udid:id})).status,403);
  const good=await post({Origin:url.origin,'X-Cindy-Clipboard':token},{action:'status',udid:id});assert.equal(good.status,200);assert.equal((await good.json()).device.udid,id);
  assert.equal((await post({Origin:url.origin,'X-Cindy-Clipboard':token},{action:'status',udid:'foreign'})).status,404);
});
test('Android touch coordinates match all four display rotations',()=>{
  const {toNative}=require(path.join(A,'geometry.cjs')),model={width:1080,height:2400};
  assert.deepEqual(toNative(model,0,200,300),{x:200,y:300});
  assert.deepEqual(toNative(model,1,1200,637),{x:442,y:1200});
  assert.deepEqual(toNative(model,2,200,300),{x:879,y:2099});
  assert.deepEqual(toNative(model,3,1200,637),{x:637,y:1199});
});
test('Android pixel rotation preserves asymmetric content in every direction',()=>{
  const {rotateImage}=require(path.join(A,'geometry.cjs'));
  const image={width:2,height:3,data:Buffer.from([1,2,3,4,5,6].flatMap(n=>[n,0,0,255]))};
  for(const [turns,width,height,expected]of [[0,2,3,[1,2,3,4,5,6]],[1,3,2,[5,3,1,6,4,2]],[2,2,3,[6,5,4,3,2,1]],[3,3,2,[2,4,6,1,3,5]]]){
    const out=rotateImage(image,turns);assert.equal(out.width,width);assert.equal(out.height,height);assert.deepEqual([...out.data].filter((_,i)=>i%4===0),expected);
  }
});
test('Android orientation uses the primary display and refuses missing display metadata',async()=>{
  const {displayRotation}=require(path.join(A,'geometry.cjs'));
  assert.equal(await displayRotation({adb:async()=>({stdout:'Viewport INTERNAL: displayId=1, orientation=2\nViewport INTERNAL: displayId=0, orientation=1, logicalFrame=[]'})},{}),1);
  await assert.rejects(displayRotation({adb:async()=>({stdout:'SurfaceOrientation: 2'})},{}),e=>e.code==='SCREEN_UNAVAILABLE');
});
test('Android screenshots follow the locked display even when the sensor is upside down',async t=>{
  const png=new PNG({width:2,height:3});png.data=Buffer.from([6,5,4,3,2,1].flatMap(n=>[n,0,0,255]));
  const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:2,height:3,rotation:{rotation:2}},image:PNG.sync.write(png)}));
  const agent=require(path.join(A,'agent.cjs')).createAgent({root:await temp(t),devices:{adb:async()=>({stdout:'Viewport INTERNAL: displayId=0, orientation=0'})}});
  const f=await agent.frame({endpoint,model:{density:160,width:2,height:3}});
  assert.equal(f.screen.rotation,0);assert.equal(f.screen.orientation,'portrait');
  assert.deepEqual([...PNG.sync.read(f.bytes).data].filter((_,i)=>i%4===0),[1,2,3,4,5,6]);
});
test('Android screenshots reject a display change during capture',async t=>{
  const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:108,height:240},image:image()}));let reads=0;
  const agent=require(path.join(A,'agent.cjs')).createAgent({root:await temp(t),devices:{adb:async()=>({stdout:'Viewport INTERNAL: displayId=0, orientation='+reads++})}});
  await assert.rejects(agent.frame({endpoint,model:{density:160}}),e=>e.code==='SCREEN_CHANGED'&&e.execution==='not_executed');
});
test('Android viewer rejects stale rotated touches and maps current display coordinates',async t=>{
  const touches=[],endpoint=await emulator(t,(s,h,body)=>{touches.push(schema.lookupType('TouchEvent').decode(body.subarray(5)).touches);send(s,'Empty',{});});
  let orientationReads=0;
  const d={udid:id,endpoint,model:{width:1080,height:2400}},viewer=require(path.join(A,'viewer.cjs')).createViewer({root:await temp(t),devices:{target:async()=>d},agent:{displayRotation:async()=>{orientationReads++;return 0;}}});t.after(()=>viewer.close());
  viewer.configure({assertEnabled:async()=>{},touch:()=>{},exclusive:fn=>fn()});
  const u=new URL((await viewer.open(id,'en')).url),token=new URLSearchParams(u.hash.slice(1)).get('cindyClipboard').split('.')[1];
  const post=(rotation,start=true,pressure=1024,deviceRotation=rotation)=>fetch(u.origin+'/android-input',{method:'POST',headers:{Origin:u.origin,'Content-Type':'application/json','X-Cindy-Clipboard':token},body:JSON.stringify({udid:id,action:'touch',rotation,deviceRotation,start,touches:[{identifier:0,pressure,x:0.25,y:0.1}]})});
  const stale=await post(2);assert.equal(stale.status,409);assert.equal((await stale.json()).errorCode,'SCREEN_CHANGED');assert.equal(touches.length,0);
  assert.equal((await post(0)).status,200);assert.equal(touches[0][0].x,270);assert.equal(touches[0][0].y,240);
  assert.equal((await post(0,false)).status,200);assert.equal((await post(0,false,0)).status,200);assert.equal(orientationReads,2,'move and release must not wait for another Android shell command');assert.equal(touches.at(-1)[0].pressure,0);
  for(const [pose,x,y]of [[1,971,600],[2,809,2159],[3,108,1799]]){
    assert.equal((await post(0,true,1024,pose)).status,200);
    assert.equal(touches.at(-1)[0].x,x);assert.equal(touches.at(-1)[0].y,y);
  }
  assert.equal((await post(0,true,1024,4)).status,409);
  assert.equal((await post(4,false)).status,409);
});
function storedZip(entries){
  const local=[],central=[];let offset=0;
  for(const [name,value,mode=0o100644]of entries){
    const filename=Buffer.from(name),data=Buffer.from(value);let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(filename.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE((mode*65536)>>>0,38);c.writeUInt32LE(offset,42);
    local.push(l,filename,data);central.push(c,filename);offset+=l.length+filename.length+data.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(Buffer.concat(central).length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,...central,end]);
}
test('SDK extraction rejects traversal, external links and duplicate file replacement',async t=>{
  const root=await temp(t);
  for(const [i,entries]of [[['../escape','bad']],[['safe/link','../../escape',0o120777]],[['same','one'],['same','two']]].entries()){
    const archive=path.join(root,i+'.zip');await fs.writeFile(archive,storedZip(entries));await assert.rejects(extract(archive,path.join(root,'out'+i)));
  }
  const archive=path.join(root,'good.zip');await fs.writeFile(archive,storedZip([['bin/tool','tool',0o100755]]));await extract(archive,path.join(root,'good'));assert.equal(await fs.readFile(path.join(root,'good/bin/tool'),'utf8'),'tool');
});
test('SDK installation requires exact consent, verifies bytes and installs only its own directory',async t=>{
  const root=await temp(t),existing=path.join(root,'existing');
  for(const name of ['emulator/emulator','platform-tools/adb']){await fs.mkdir(path.dirname(path.join(existing,name)),{recursive:true});await fs.writeFile(path.join(existing,name),'existing');}
  const bytes=storedZip([['x86_64/system.img','test image']]),hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const xml=`<repository><license id="sdk-license">Test license</license><remotePackage path="system-images;android-36;google_apis;x86_64"><channelRef ref="channel-0"/><display-name>Test image</display-name><uses-license ref="sdk-license"/><archives><archive><complete><url>test-image.zip</url><size>${bytes.length}</size><checksum type="sha256">${hash}</checksum></complete></archive></archives></remotePackage></repository>`;
  t.mock.method(globalThis,'fetch',async url=>new Response(String(url).endsWith('.xml')?xml:bytes));
  const sdk=createSdk(path.join(root,'private'),{platform:'linux',arch:'x64',home:root,env:{ANDROID_HOME:existing}}),plan=await sdk.plan();
  await assert.rejects(sdk.install({planId:plan.id,acceptLicenses:false}),e=>e.code==='SDK_CONFIRM_REQUIRED');
  await sdk.install({planId:plan.id,acceptLicenses:true});await sdk.pending();assert.equal(sdk.status().state,'done');assert.equal((await sdk.inspect()).ready,true);
  assert.equal(await fs.readFile(path.join(existing,'emulator/emulator'),'utf8'),'existing');assert.equal(await fs.readFile(path.join(root,'private/sdk/system-images/android-36/google_apis/x86_64/system.img'),'utf8'),'test image');
});
test('APK binary manifest parser rejects truncated and invalid chunks without executing content',()=>{
  const {manifest,packageId}=require(path.join(A,'apps.cjs'));
  for(const buffer of [Buffer.alloc(0),Buffer.from([3,0,8,0,0,0,0,0,1]),Buffer.from([3,0,8,0,16,0,0,0,1,0,20,0,8,0,0,0])])assert.throws(()=>manifest(buffer),e=>e.code==='INVALID_APK');
  for(const value of ['com.test;echo bad','../app','com.test\n'])assert.throws(()=>packageId(value));
});
test('capture retains a completed action when the final observation fails',async t=>{
  const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:108,height:240},image:image()})),root=await temp(t);let calls=0;
  const result=await require(path.join(A,'capture.cjs')).capture({d:{udid:id,endpoint,model:{width:108,height:240,density:160}},p:{seconds:0.5,action:{tool:'press'}},root,agent:{frame:async()=>{if(++calls>2)throw Object.assign(Error('Screen unavailable'),{code:'SCREEN_UNAVAILABLE'});return {screen:{width:108,height:240}};}},perform:async()=>({execution:'executed'})});
  assert.equal(result.execution,'executed');assert.equal(result.captureError.code,'SCREEN_UNAVAILABLE');assert.equal(result.sheet,undefined);
});
test('Android viewer rotation keeps the portrait body size and caps only a narrow-window overflow',async()=>{
  const listeners={},frame={style:{}},canvas={width:720,height:1600,getContext:()=>({}),addEventListener:()=>{}};
  const context={URLSearchParams,location:{pathname:'/simulators/'+id,search:''},window:{},
    parent:{document:{documentElement:{lang:'en'}}},innerWidth:900,innerHeight:800,
    document:{getElementById:name=>name==='display'?canvas:name==='nativeDeviceFrame'?frame:{}},
    matchMedia:()=>({matches:false}),addEventListener:(name,fn)=>{listeners[name]=fn;},fetch:()=>new Promise(()=>{})};
  require('node:vm').runInNewContext(await fs.readFile(path.join(A,'screen.js'),'utf8'),context);
  const size=(width,height)=>{Object.assign(canvas,{width,height});listeners.resize();return [parseFloat(frame.style.width),parseFloat(frame.style.height)];};
  const portrait=size(720,1600),landscape=size(720,324);
  assert.deepEqual(landscape,[portrait[1],portrait[0]],'rotation swaps edges without growing the device');
  assert.deepEqual(size(360,800),portrait,'stream resolution must not change the rendered body size');
  context.innerWidth=360;context.innerHeight=740;
  const narrowPortrait=size(720,1600),narrowLandscape=size(720,324);
  assert.equal(narrowLandscape[0],336);assert.ok(narrowLandscape[1]<narrowPortrait[0]);
  assert.ok(narrowPortrait[0]<=336&&narrowPortrait[1]<=716);
});
test('state changes retain executed outcome when the resulting screen is unavailable',async()=>{
  const actions=[],setState=require(path.join(A,'state.cjs')).createState({devices:{adb:async(d,args)=>actions.push(args)},agent:{frame:async()=>{throw Object.assign(Error('No frame'),{code:'SCREEN_UNAVAILABLE'});}}});
  const result=await setState({udid:id},{appearance:'dark'});assert.equal(actions.length,1);assert.equal(result.execution,'executed');assert.equal(result.observationError.code,'SCREEN_UNAVAILABLE');
});
test('Android rotation changes physical pose and lets activities choose their display orientation',async t=>{
  const poses=[],commands=[],endpoint=await emulator(t,(s,h,body)=>{assert.ok(h[':path'].endsWith('/setPhysicalModel'));poses.push(schema.lookupType('PhysicalModelValue').decode(body.subarray(5)));send(s,'Empty',{});});
  const state=require(path.join(A,'state.cjs')).createState({devices:{adb:async(d,args)=>commands.push(args)},agent:{frame:async()=>({screen:{rotation:0}})}});
  for(const orientation of ['portrait','landscape-left','portrait-upside-down','landscape-right'])assert.equal((await state({endpoint},{orientation})).execution,'executed');
  assert.deepEqual(poses.map(p=>p.value.data),[[0,0,0],[0,0,90],[0,0,180],[0,0,270]]);
  assert.ok(poses.every(p=>p.target===1&&p.interpolation===1));
  assert.deepEqual(commands,Array.from({length:4},()=>['shell','settings','put','system','accelerometer_rotation','1']));
});
for(const broken of [false,true])test(`Android shake restores the original physical orientation after ${broken?'failure':'success'}`,async t=>{
  const poses=[],samples=[],endpoint=await emulator(t,(s,h,body)=>{
    const name=h[':path'].split('/').at(-1);
    if(name==='getPhysicalModel')return send(s,'PhysicalModelValue',{target:1,value:{data:[0,0,90]}});
    if(name==='getSensor')return send(s,'SensorValue',{target:0,value:{data:[9.81,0,0]}});
    if(name==='setPhysicalModel'){poses.push(schema.lookupType('PhysicalModelValue').decode(body.subarray(5)));return send(s,'Empty',{});}
    assert.equal(name,'setSensor');samples.push(schema.lookupType('SensorValue').decode(body.subarray(5)));send(s,'Empty',{}, {status:broken?'13':'0'});
  });
  const agent=require(path.join(A,'agent.cjs')).createAgent({root:await temp(t),devices:{}}),action=agent.press({endpoint},{button:'shake'});
  if(broken)await assert.rejects(action,e=>e.execution==='unknown');else assert.equal((await action).execution,'executed');
  assert.equal(samples.length,broken?1:6);assert.ok(samples.every(s=>s.value.data[1]===0));assert.equal(poses.length,1);assert.deepEqual(poses[0].value.data,[0,0,90]);assert.equal(poses[0].interpolation,1);
});

test('state progress preserves every completed step within a partially applied field',async()=>{
  const {createState}=require(path.join(A,'state.cjs'));
  for(const profile of ['offline','wifi','clear'])for(const failAt of Array.from({length:profile==='offline'?3:5},(_,i)=>i)){
    let calls=0;const state=createState({devices:{adb:async()=>{if(calls++===failAt)throw Object.assign(Error('budget'),{code:'TIME_BUDGET_EXHAUSTED',execution:'not_executed'});}},agent:{frame:async()=>({screen:{}})}});
    const result=await state({udid:id},{network:profile,appearance:'dark'});
    // appearance is the first step; network includes two or four substeps.
    assert.equal(result.stateError.code,'TIME_BUDGET_EXHAUSTED');assert.equal(result.appliedSteps.length,failAt);
    assert.equal(result.execution,failAt?'unknown':'not_executed');
    assert.equal(result.applied.includes('network'),false);assert.equal(calls,failAt+1);
  }
  const calls=[],state=createState({devices:{adb:async(d,args)=>calls.push(args)},agent:{frame:async()=>({screen:{}})}});
  assert.deepEqual((await state({udid:id},{network:'wifi'})).applied,['network']);assert.ok(calls.some(a=>a.join(' ')==='emu network speed full'));
  calls.length=0;
  await assert.rejects(state({udid:id},{appearance:'dark',privacy:{action:'reset',service:'camera',bundleId:'test.example.app'}}),e=>e.code==='INVALID_ARGUMENT'&&e.execution==='not_executed');assert.equal(calls.length,0,'unsupported reset is rejected before any field changes');
});

test('scoped logs distinguish absent processes, exact matches and query failures',async()=>{
  const create=adb=>require(path.join(A,'agent.cjs')).createAgent({devices:{adb}}),d={udid:id};
  for(const code of ['DEVICE_NOT_OWNED','COMMAND_FAILED','TIME_BUDGET_EXHAUSTED']){
    const agent=create(async()=>{throw Object.assign(Error('query failed'),{code});});
    await assert.rejects(agent.logs(d,{process:'test.example.app'}),e=>e.code===code);
    if(code!=='TIME_BUDGET_EXHAUSTED')await assert.rejects(agent.waitFor(d,{log:'ready',process:'test.example.app',timeout:.1}),e=>e.code===code);
  }
  assert.equal((await create(async()=>({stdout:'PID NAME\n1 init\n8 test.example.app.other'})).logs(d,{process:'test.example.app'})).lines.length,0);
  let scope;
  const result=await create(async(d,args)=>{if(args.includes('ps'))return {stdout:'PID NAME\n7 test.example.app\n8 test.example.app.other'};scope=args;return {stdout:Date.now()/1000+' 7 7 I test: ready'};}).logs(d,{process:'test.example.app'});
  assert.ok(scope.includes('--pid=7'));assert.equal(result.lines.length,1);
  await assert.rejects(create(async()=>({stdout:''})).logs(d,{process:'test.example.app'}),e=>e.code==='PROCESS_QUERY_FAILED');
});

test('directional swipes preserve explicit starts and pan defaults to the screen center',async t=>{
  const touches=[],png=new PNG({width:400,height:800});png.data.fill(255);
  const endpoint=await emulator(t,(s,h,body)=>{const name=h[':path'].split('/').at(-1);
    if(name==='getScreenshot')return send(s,'Image',{format:{width:400,height:800},image:PNG.sync.write(png)});
    assert.equal(name,'sendTouch');touches.push(schema.lookupType('TouchEvent').decode(body.subarray(5)).touches);send(s,'Empty',{});
  });
  const agent=require(path.join(A,'agent.cjs')).createAgent({devices:{adb:async()=>({stdout:'Viewport INTERNAL: displayId=0, orientation=0'})}}),d={udid:id,endpoint,model:{width:400,height:800,density:160}};
  await agent.gesture(d,{kind:'swipe',direction:'up',from:[100,500],distance:100,duration:.01,observe:'none'});
  assert.deepEqual([touches[0][0].x,touches[0][0].y],[100,500]);assert.ok(touches.some(ts=>ts[0]?.y===400));touches.length=0;
  await agent.gesture(d,{kind:'pan',by:[0,100],duration:.01,observe:'none'});
  assert.deepEqual(touches[0].map(p=>[p.x,p.y]),[[180,400],[220,400]]);assert.ok(touches.some(ts=>ts.length===2&&ts.every(p=>p.y===500)));
});

test('capture preflight failures always retain the capture result shape without executing an action',async()=>{
  const {capture}=require(path.join(A,'capture.cjs'));let actions=0;
  for(const code of ['SCREEN_UNAVAILABLE','SCREEN_CHANGED','TIME_BUDGET_EXHAUSTED']){
    const result=await capture({d:{udid:id,model:{width:2,height:3,density:160}},p:{seconds:.5,action:{tool:'press'}},agent:{frame:async()=>{throw Object.assign(Error('preflight'),{code});}},perform:async()=>{actions++;}});
    assert.equal(result.captureError.code,code);assert.equal(result.execution,'not_executed');assert.equal(result.sheet,undefined);
  }
  assert.equal(actions,0);
});

test('contact-sheet frame bytes use locked display orientation before saving and rendering',async t=>{
  const png=new PNG({width:2,height:3});png.data=Buffer.from([1,2,3,4,5,6].flatMap(n=>[n,0,0,255]));
  for(const [rotation,sensor,expected,width,height]of [[0,2,[6,5,4,3,2,1],2,3],[1,0,[2,4,6,1,3,5],3,2]]){
    const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:2,height:3,rotation:{rotation:sensor}},image:PNG.sync.write(png)})),screen={width,height,rotation},root=await temp(t);
    const result=await require(path.join(A,'capture.cjs')).capture({d:{udid:id,endpoint,model:{width:2,height:3,density:160}},p:{seconds:.5},root,agent:{frame:async()=>({screen})}});
    assert.equal(result.captureError,undefined);assert.deepEqual(result.screen,screen);const frame=PNG.sync.read(await fs.readFile(result.frames[0].path));assert.equal(frame.width,width);assert.equal(frame.height,height);
    assert.deepEqual([...frame.data].filter((_,i)=>i%4===0),expected);assert.ok((await fs.stat(result.sheet)).size>0);
  }
});

test('capture rechecks the display after its first stream frame before executing the action',async t=>{
  const endpoint=await emulator(t,s=>send(s,'Image',{format:{width:108,height:240},image:image()}));let reads=0,actions=0;
  const result=await require(path.join(A,'capture.cjs')).capture({d:{udid:id,endpoint,model:{width:108,height:240,density:160}},p:{seconds:.5,action:{tool:'press'}},root:await temp(t),agent:{frame:async()=>({screen:{rotation:reads++?1:0}})},perform:async()=>{actions++;return {execution:'executed'};}});
  assert.equal(result.captureError.code,'SCREEN_CHANGED');assert.equal(result.execution,'not_executed');assert.equal(actions,0);
});

async function privateAndroid(t){
  const root=await temp(t),runtime='android:android-36:google_apis:arm64-v8a';
  const sdk={inspect:async()=>({ready:true,images:[{identifier:runtime,directory:path.join(root,'image'),abi:'arm64-v8a',version:'36'}]})};
  const devices=require(path.join(A,'devices.cjs')).createDevices({root,sdk,run:async()=>{throw Error('Unexpected host command');},children:new Set()});
  const created=await devices.create({name:'Lifecycle fixture',runtime,deviceType:'android:phone'}),d=await devices.target({udid:created.udid},false);
  await fs.writeFile(path.join(d.directory,'one.img'),'one');await fs.writeFile(path.join(d.directory,'two.img'),'two');
  return {root,devices,d};
}
test('device removal reports each completed step and preserves records when a later deletion fails',async t=>{
  for(const action of ['delete_device','erase_device'])for(let failure=0;failure<(action==='delete_device'?3:2);failure++)await t.test(action+' step '+failure,async t=>{
    const {devices,d}=await privateAndroid(t),remove=fs.rm;let writes=0;
    const spy=t.mock.method(fs,'rm',async(target,options)=>{if(String(target).startsWith(path.dirname(d.directory))){if(writes++===failure)throw Object.assign(Error('disk denied'),{code:'EACCES'});}return remove(target,options);});
    const result=await devices.manage(action,{udid:d.udid});spy.mock.restore();
    assert.equal(result.outcome,'partial');assert.equal(result.execution,'unknown');assert.equal(result.completedSteps.length,failure+1);assert.equal(writes,failure+1);assert.equal(result.deviceError.code,'EACCES');
    assert.equal(result.shutdown.state,'Shutdown');assert.equal(await devices.owns(d.udid),true,'partial changes retain device identity');
    if(action==='erase_device')assert.ok(await fs.stat(path.join(d.directory,'config.ini')));
  });
});
test('a completed shutdown remains visible when the subsequent AVD listing fails',async t=>{
  const {devices,d}=await privateAndroid(t);let running=true;
  const endpoint=await emulator(t,s=>{running=false;send(s,'Empty',{});}),name='pid_'+process.pid+'.ini',read=fs.readFile,list=fs.readdir;
  t.mock.method(fs,'readFile',async(file,...args)=>path.basename(String(file))===name?`avd.id=${d.avdName}\navd.dir=${d.directory}\ngrpc.port=${endpoint.port}\ngrpc.token=test-capability\nport.serial=5554\n`:read(file,...args));
  const spy=t.mock.method(fs,'readdir',async(dir,...args)=>{
    if(String(dir).endsWith(path.join('avd','running')))return running?[name]:[];
    if(String(dir)===d.directory)throw Object.assign(Error('cannot list'),{code:'EACCES'});
    return list(dir,...args);
  });
  const result=await devices.manage('erase_device',{udid:d.udid});spy.mock.restore();
  assert.equal(result.execution,'unknown');assert.equal(result.failedStep,'list-avd-data');assert.equal(result.shutdown.execution,'executed');assert.deepEqual(result.completedSteps,[{step:'shutdown',execution:'executed'}]);
});
test('new-device rollback and rename failures never claim a disk write was not executed',async t=>{
  const {devices,d}=await privateAndroid(t),write=fs.writeFile;
  const spy=t.mock.method(fs,'writeFile',async(file,...args)=>{
    if(String(file).endsWith('config.ini'))throw Object.assign(Error('config denied'),{code:'EACCES'});
    if(String(file).endsWith(d.udid+'.json'))throw Object.assign(Error('rename denied'),{code:'EACCES'});
    return write(file,...args);
  });
  await assert.rejects(devices.create({name:'Failed fixture',runtime:d.runtime,deviceType:d.deviceType}),e=>e.execution==='unknown'&&/rollback completed/.test(e.message));
  await assert.rejects(devices.manage('rename_device',{udid:d.udid,name:'Changed'}),e=>e.execution==='unknown');spy.mock.restore();
});
test('App relaunch preserves force-stop evidence across later budget and connection failures',async()=>{
  const {createApps}=require(path.join(A,'apps.cjs'));
  for(const relaunch of [undefined,false])for(const code of ['TIME_BUDGET_EXHAUSTED','COMMAND_FAILED']){
    const apps=createApps({devices:{adb:async(d,args)=>{
      if(args.includes('resolve-activity'))return {stdout:'test.example/.Main'};
      if(args.includes('force-stop'))return {stdout:''};
      throw Object.assign(Error('start unavailable'),{code,execution:code==='TIME_BUDGET_EXHAUSTED'?'not_executed':'unknown'});
    }}});
    const result=await apps.launch({udid:id},{bundleId:'test.example',relaunch});
    assert.equal(result.appTerminated,relaunch!==false);assert.equal(result.appLaunched,false);assert.equal(result.outcome,'partial');assert.equal(result.launchError.code,code);
    assert.equal(result.execution,relaunch===false&&code==='TIME_BUDGET_EXHAUSTED'?'not_executed':'unknown');
  }
});
test('partial launch and destruction do not change successful App records or task bindings',async t=>{
  const root=await temp(t),file=path.join(root,'settings.json'),record=file+'.apps.json';let binds=0,forgets=0;
  await fs.writeFile(record,JSON.stringify({[id]:'test.previous'}));
  const partial={udid:id,execution:'unknown',outcome:'partial',appLaunched:false,appTerminated:true,launchError:{code:'TIME_BUDGET_EXHAUSTED'}};
  const runtime=require('../../baguette-simulator/node/runtime.cjs').createRuntime({settingsFile:file,dispatch:async()=>partial,tasks:{bind:async()=>{binds++;},forgetDevice:async()=>{forgets++;},activity(){}}});
  for(const method of ['launch_app','delete_device','erase_device'])assert.equal((await runtime.request(method,{udid:id,bundleId:'test.next',session_context:{session_id:id}})).outcome,'partial');
  assert.equal(binds,0);assert.equal(forgets,0);assert.deepEqual(JSON.parse(await fs.readFile(record)),{[id]:'test.previous'});
});
test('Android launch adaptation preserves a partial App result and never opens a preview for it',async()=>{
  const partial={udid:id,execution:'unknown',outcome:'partial',appLaunched:false,appTerminated:true},source=await fs.readFile(path.join(A,'index.cjs'),'utf8');let opens=0;
  const modules={
    './sdk.cjs':{createSdk:()=>({})},'./devices.cjs':{createDevices:()=>({target:async()=>({udid:id})})},
    './agent.cjs':{createAgent:()=>({})},'./apps.cjs':{createApps:()=>({launch:async()=>partial})},
    './state.cjs':{createState:()=>({})},'./viewer.cjs':{createViewer:()=>({open:async()=>{opens++;}})}
  },context={module:{exports:{}},require:name=>modules[name]||require(name)};
  require('node:vm').runInNewContext(source,context);
  const android=context.module.exports.createAndroid({root:'/fixture',children:new Set()});
  const result=await android.dispatch('launch_app',{udid:id,bundleId:'test.example'});assert.equal(result.appLaunched,false);assert.equal(result.appTerminated,true);assert.equal(opens,0);
});

test('successful device removal/erase and App launch still produce confirmed outcomes',async t=>{
  for(const method of ['erase_device','delete_device']){
    const {devices,d}=await privateAndroid(t),result=await devices.manage(method,{udid:d.udid});
    assert.equal(result.execution,'executed');assert.equal(result.outcome,undefined);
    if(method==='erase_device'){assert.deepEqual(await fs.readdir(d.directory),['config.ini']);assert.equal(await devices.owns(d.udid),true);}
    else assert.equal(await devices.owns(d.udid),false);
  }
  const {createApps}=require(path.join(A,'apps.cjs'));
  for(const relaunch of [true,false]){
    const calls=[],apps=createApps({devices:{adb:async(d,args)=>{calls.push(args);return {stdout:args.includes('resolve-activity')?'test.example/.Main':'Status: ok'};}}});
    const result=await apps.launch({udid:id},{bundleId:'test.example',relaunch});assert.equal(result.appLaunched,true);assert.equal(result.appTerminated,relaunch);assert.equal(result.execution,'executed');
    assert.equal(calls.some(args=>args.includes('force-stop')),relaunch);
  }
});
