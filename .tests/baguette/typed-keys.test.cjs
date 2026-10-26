const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {typeable,textChords,chord}=require('../../baguette-simulator/node/keys.cjs');
const udid='00000000-0000-4000-8000-000000000001';

// Independent US-layout reference: HID usage per physical key (page 7) and the Shift mask bit.
const ROWS=[ // [unshifted, shifted, usage]
 ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c,i)=>[c,c.toUpperCase(),4+i]),
 ['1','!',30],['2','@',31],['3','#',32],['4','$',33],['5','%',34],['6','^',35],['7','&',36],['8','*',37],['9','(',38],['0',')',39],
 [' ',' ',44],['-','_',45],['=','+',46],['[','{',47],[']','}',48],['\\','|',49],[';',':',51],["'",'"',52],['`','~',53],[',','<',54],['.','>',55],['/','?',56],
];
test('every printable US-layout ASCII character maps to its physical key, shifted symbols and capitals with Shift',()=>{
 const seen=new Set();
 for(const [lower,upper,usage] of ROWS){
  assert.deepEqual(Array.from(textChords(lower)[0]),[usage,0],lower);seen.add(lower);
  if(upper!==lower){assert.deepEqual(Array.from(textChords(upper)[0]),[usage,2],upper);seen.add(upper);}
 }
 assert.deepEqual(Array.from(textChords('\n')[0]),[40,0]);
 for(let c=0x20;c<=0x7e;c++)assert.ok(seen.has(String.fromCharCode(c)),'unmapped '+JSON.stringify(String.fromCharCode(c)));
 assert.equal(seen.size,95);
 // order is preserved and nothing is merged or dropped
 assert.equal(textChords('aa  bb').length,6);
 assert.deepEqual(textChords('Hi!').map(x=>Array.from(x)),[[11,2],[12,0],[30,2]]);
});
test('non-typeable text is refused instead of being mistyped',()=>{
 for(const text of ['中文','é','🙂','a\u0000b','ok\u007f'])assert.equal(typeable(text),false,String(text));
 for(const text of ['café','a\tb','',undefined,5])assert.throws(()=>textChords(text),String(text));
 assert.throws(()=>chord('Nope'));
});

function harness(){
 const calls=[];let typedAction;
 const context={module:{exports:{}},setTimeout,clearTimeout,__dirname:path.resolve('baguette-simulator/node'),process:{platform:'darwin',arch:'arm64',env:{}},require(name){
  if(name==='./viewer.cjs')return {openViewer:async(_b,_s,_c,_u,action)=>{typedAction=action;return {}}};
  if(name==='node:fs/promises')return {mkdir:async()=>{}};
  if(name==='node:child_process')return {execFile(file,args,options,callback){
   const call={file,args,options};calls.push(call);let output='';
   if(file.endsWith('/sw_vers'))output='27.0';
   if(file.endsWith('/xcode-select'))output='/Applications/Xcode.app/Contents/Developer';
   if(args.includes('--json'))output=JSON.stringify({devices:{runtime:[{udid,state:'Booted'}]}});
   queueMicrotask(()=>callback(null,output,''));
   return {stdin:{on(){},end(){}}};
  }};
  return require(name.startsWith('./')?path.resolve('baguette-simulator/node',name):name);
 }};
 vm.runInNewContext(fs.readFileSync(path.resolve('baguette-simulator/node/core.cjs'),'utf8'),context);
 return {calls,async action(p){if(!typedAction)await context.module.exports.dispatch('open_viewer',{udid});return typedAction({udid,...p});}};
}

test('type action sends one helper process with every chord, in order, without touching the pasteboard',async()=>{
 const h=harness();
 const result=await h.action({action:'type',text:'Hi, 1!'});
 const keyboard=h.calls.filter(c=>c.file.endsWith('/native/keyboard'));
 assert.equal(keyboard.length,1,'one process for the whole run');
 const args=Array.from(keyboard[0].args);
 assert.deepEqual(args.slice(3),['11','2','12','0','54','0','44','0','30','0','30','2']);
 assert.ok(!h.calls.some(c=>c.args.includes('pbcopy')||c.args[0]==='devicectl'),'no pasteboard');
 assert.ok(h.calls.every(c=>!c.args.includes('Hi, 1!')),'text never appears in arguments');
 assert.ok(result.timing&&typeof result.timing.total==='number'&&'type' in result.timing&&!JSON.stringify(result).includes('Hi'));
});
test('type action rejects non-typeable or oversized text before any helper runs',async()=>{
 for(const text of ['中文','a\tb','x'.repeat(257),'']){
  const h=harness();
  await assert.rejects(h.action({action:'type',text}),e=>e.code==='INVALID_ARGUMENT',JSON.stringify(text).slice(0,20));
  assert.ok(!h.calls.some(c=>c.file.endsWith('/native/keyboard')));
 }
});

test('the bridge accepts type with a 256-character limit and keeps the other limits',async()=>{
 const {createClipboard}=require('../../baguette-simulator/node/clipboard.cjs');
 const origin='http://127.0.0.1:49114';const seen=[];
 const bridge=await createClipboard(origin,async p=>{seen.push(p);});bridge.devices.add(udid);
 try{
  const [port,token]=bridge.fragment.split('=')[1].split('.');
  const send=body=>fetch(`http://127.0.0.1:${port}/clipboard`,{method:'POST',headers:{Origin:origin,'X-Cindy-Clipboard':token},body:JSON.stringify({udid,...body})});
  assert.equal((await send({action:'type',text:'a'.repeat(256)})).status,200);
  for(const body of [{action:'type',text:'a'.repeat(257)},{action:'type',text:''},{action:'type'},{action:'type',text:'a\u0000'},{action:'bogus',text:'a'}])
   assert.equal((await send(body)).status,400,JSON.stringify(body).slice(0,30));
  assert.equal((await send({action:'paste',text:'中'.repeat(300)})).status,200);
  assert.equal(seen.length,2);
 }finally{bridge.close();}
});

test('native helper delivers a sequence of chords in order and stops at the first failure',{skip:process.platform!=='darwin'},()=>{
 const os=require('node:os'),{execFileSync}=require('node:child_process');
 const source=fs.readFileSync('baguette-simulator/native/keyboard.m','utf8');
 const production=source.slice(0,source.indexOf('\nint main('));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'baguette-chords-'));
 try{
  fs.writeFileSync(path.join(dir,'test.m'),production+`
#include <assert.h>
static NSMutableArray *events;
static void *hid(uint32_t type,uint32_t page,uint32_t key,uint32_t state){assert(type==0x32&&page==7);return (void *)(uintptr_t)(key*16+state);}
@interface FakeClient : NSObject
@property int failAtKey;
@end
@implementation FakeClient
-(void)sendWithMessage:(void *)message freeWhenDone:(BOOL)freeMessage completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion {
 int code=(int)(uintptr_t)message,key=code/16,state=code%16;
 [events addObject:[NSString stringWithFormat:@"%d%@",key,state==1?@"v":@"^"]];
 NSError *error=(state==1&&key==self.failAtKey)?[NSError errorWithDomain:@"fixture" code:1 userInfo:nil]:nil;
 dispatch_async(queue,^{completion(error);});
}
@end
int main(void){@autoreleasepool{
 events=[NSMutableArray array];FakeClient *c=[FakeClient new];
 assert(deliverChord(c,hid,4,2)); assert(deliverChord(c,hid,5,0));
 assert([[events componentsJoinedByString:@" "] isEqualToString:@"225v 4v 4^ 227^ 226^ 225^ 224^ 5v 5^ 227^ 226^ 225^ 224^"]);
 events=[NSMutableArray array];c.failAtKey=4;
 assert(!deliverChord(c,hid,4,2)); // key-down failed: still releases the key and every modifier
 assert([[events componentsJoinedByString:@" "] isEqualToString:@"225v 4v 4^ 227^ 226^ 225^ 224^"]);
 return 0;
}}
`);
  execFileSync('xcrun',['clang','-fobjc-arc','-fblocks','-framework','Foundation',path.join(dir,'test.m'),'-o',path.join(dir,'test')]);
  execFileSync(path.join(dir,'test'),[],{timeout:10000});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
