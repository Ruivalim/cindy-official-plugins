// SimulatorKit HID adapter. Protocol and loading based on Baguette v0.1.98
// (Apache-2.0). Unlike its fire-and-forget CLI, wait for every delivery.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <sys/file.h>
#import <fcntl.h>
#import <unistd.h>
typedef void *(*HID)(uint32_t,uint32_t,uint32_t,uint32_t);
static BOOL sendEvent(id client, void *message) {
 if(!message)return NO;
 dispatch_semaphore_t done=dispatch_semaphore_create(0);
 __block BOOL ok=NO;
 void (^completion)(NSError *)=^(NSError *error){ok=(error==nil);dispatch_semaphore_signal(done);};
 ((void(*)(id,SEL,void*,BOOL,dispatch_queue_t,id))objc_msgSend)(client,NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:"),message,YES,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),completion);
 return dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC))==0 && ok;
}
static BOOL releaseKeys(id client,HID hid){
 dispatch_group_t pending=dispatch_group_create();
 dispatch_queue_t callbacks=dispatch_queue_create("cindy.keyboard.release",DISPATCH_QUEUE_SERIAL);
 __block BOOL delivered=YES;
 BOOL created=YES;
 // Submit every key-up first. A missing callback must not delay later usages.
 for(uint32_t key=4;key<=231;key++){
  void *message=hid(0x32,7,key,2);
  if(!message){created=NO;continue;}
  dispatch_group_enter(pending);
  void (^completion)(NSError *)=^(NSError *error){
   if(error)delivered=NO;
   dispatch_group_leave(pending);
  };
  ((void(*)(id,SEL,void*,BOOL,dispatch_queue_t,id))objc_msgSend)(client,NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:"),message,YES,callbacks,completion);
 }
 // One shared deadline for all 228 deliveries. On timeout, do not read state
 // that a late callback may still be writing; its block retains its resources.
 return dispatch_group_wait(pending,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC))==0 && created && delivered;
}
// One chord: modifiers down, key down, hold, key up, modifiers up. The full
// release is always attempted, including after a partial failure.
static BOOL deliverChord(id client,HID hid,int key,int mask){
 BOOL ok=YES;
 for(int i=0;i<4;i++)if(mask&(1<<i))if(!sendEvent(client,hid(0x32,7,224+i,1)))ok=NO;
 if(ok)ok=sendEvent(client,hid(0x32,7,key,1));
 usleep(20000);
 if(!sendEvent(client,hid(0x32,7,key,2)))ok=NO;
 for(int i=3;i>=0;i--)if(!sendEvent(client,hid(0x32,7,224+i,2)))ok=NO;
 return ok;
}
int main(int argc,const char **argv){@autoreleasepool{
 // device set, UDID, developer dir, then (HID usage, modifier bitmask) pairs; one pair
 // with usage 0 is a plain release, up to 256 pairs type a sequence in one process.
 if(argc<6||(argc-4)%2!=0||(argc-4)/2>256)return 2;
 NSString *setPath=@(argv[1]),*udid=@(argv[2]),*dev=@(argv[3]);int pairs=(argc-4)/2;
 for(int i=0;i<pairs;i++){int k=atoi(argv[4+2*i]),m=atoi(argv[5+2*i]);if(k<0||k>103||m<0||m>15||(k==0&&pairs>1))return 2;}
 if(![[NSUUID alloc]initWithUUIDString:udid])return 2;
 int lock=open([[setPath stringByAppendingPathComponent:[NSString stringWithFormat:@".keyboard-%@.lock",udid]]fileSystemRepresentation],O_CREAT|O_RDWR,0600);
 if(lock<0||flock(lock,LOCK_EX|LOCK_NB)!=0)return 3;
 if(!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",RTLD_NOW|RTLD_GLOBAL))return 4;
 void *kit=NULL;for(NSString *relative in @[@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit"]){kit=dlopen([[dev stringByAppendingPathComponent:relative]fileSystemRepresentation],RTLD_NOW|RTLD_GLOBAL);if(kit)break;}if(!kit)return 4;
 NSError *error=nil;id context=((id(*)(id,SEL,id,NSError**))objc_msgSend)(NSClassFromString(@"SimServiceContext"),NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"),dev,&error);
 if(!context)return 4;
 id set=((id(*)(id,SEL,id,NSError**))objc_msgSend)(context,NSSelectorFromString(@"deviceSetWithPath:error:"),setPath,&error);if(!set)return 4;
 id device=nil;for(id d in [set valueForKey:@"availableDevices"])if([[[d valueForKey:@"UDID"]UUIDString]caseInsensitiveCompare:udid]==NSOrderedSame){device=d;break;}
 if(!device||[[device valueForKey:@"state"]intValue]!=3)return 4;
 id cls=NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient");if(!cls)return 4;
 id client=((id(*)(id,SEL,id,NSError**))objc_msgSend)([cls alloc],NSSelectorFromString(@"initWithDevice:error:"),device,&error);
 HID hid=(HID)dlsym(kit,"IndigoHIDMessageForHIDArbitrary");if(!client||!hid)return 4;
 BOOL ok=YES;
 // Release existing latched keys before any new chord. No key-down during recovery.
 if(!releaseKeys(client,hid))return 5;
 // Stop at the first failed chord: a partially typed sequence is reported, never continued.
 for(int i=0;i<pairs;i++){
  int key=atoi(argv[4+2*i]),mask=atoi(argv[5+2*i]);
  if(key&&!deliverChord(client,hid,key,mask)){ok=NO;break;}
 }
 if(!ok)releaseKeys(client,hid);
 close(lock);return ok?0:5;
}}
