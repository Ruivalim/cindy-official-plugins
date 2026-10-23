// visionOS spatial selection. CoreSimulator/SimulatorKit are loaded from Xcode.
// The Paloma collection wire layout is verified against Xcode 27 / visionOS 27;
// no Apple executable or library is redistributed. See platform-support.md.
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <sys/file.h>
#import <fcntl.h>
#import <unistd.h>
#import <xpc/xpc.h>
#import <simd/simd.h>
#import <mach/mach_time.h>
#import <math.h>
#import <signal.h>
static volatile sig_atomic_t stopping=0;
static void interrupted(int sig){stopping=1;}
static void hold(double seconds){
 double until=NSProcessInfo.processInfo.systemUptime+seconds;
 while(!stopping){double left=until-NSProcessInfo.processInfo.systemUptime;if(left<=0)break;usleep((useconds_t)(fmin(left,0.01)*1000000));}
}
static BOOL sendEvent(id client, void *message) {
 if(!message)return NO;
 dispatch_semaphore_t done=dispatch_semaphore_create(0);
 __block BOOL ok=NO;
 void (^completion)(NSError *)=^(NSError *error){ok=(error==nil);dispatch_semaphore_signal(done);};
 ((void(*)(id,SEL,void*,BOOL,dispatch_queue_t,id))objc_msgSend)(client,NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:"),message,YES,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),completion);
 return dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC))==0 && ok;
}

static BOOL scalar(const char *raw,double *out,double low,double high){
 NSScanner *s=[NSScanner scannerWithString:@(raw)];return [s scanDouble:out]&&s.isAtEnd&&isfinite(*out)&&*out>=low&&*out<=high;
}
static BOOL cameraPose(id device,simd_float4x4 *pose){
 typedef xpc_endpoint_t(*Endpoint)(mach_port_t,uint64_t,uint64_t);typedef void(*Enable)(xpc_connection_t);
 Endpoint endpoint=(Endpoint)dlsym(RTLD_DEFAULT,"xpc_endpoint_create_mach_port_4sim");Enable enable=(Enable)dlsym(RTLD_DEFAULT,"xpc_connection_enable_sim2host_4sim");if(!endpoint||!enable)return NO;
 NSError *error=nil;mach_port_t port=((mach_port_t(*)(id,SEL,id,NSError**))objc_msgSend)(device,NSSelectorFromString(@"lookup:error:"),@"com.apple.vhmdd",&error);if(!port)return NO;
 xpc_endpoint_t ep=endpoint(port,0,0);if(!ep)return NO;
 xpc_connection_t c=xpc_connection_create_from_endpoint(ep);if(!c)return NO;enable(c);
 dispatch_queue_t q=dispatch_queue_create("cindy.spatial.camera",DISPATCH_QUEUE_SERIAL);
 xpc_connection_set_target_queue(c,q);xpc_connection_set_event_handler(c,^(xpc_object_t e){});xpc_connection_resume(c);
 xpc_object_t request=xpc_dictionary_create(NULL,NULL,0);xpc_dictionary_set_string(request,"cmd","get_pose");
 dispatch_semaphore_t done=dispatch_semaphore_create(0);__block NSData *data=nil;
 xpc_connection_send_message_with_reply(c,request,q,^(xpc_object_t reply){
  if(xpc_get_type(reply)==XPC_TYPE_DICTIONARY){size_t size=0;const void *p=xpc_dictionary_get_data(reply,"pose",&size);if(p&&size==sizeof(simd_float4x4))data=[NSData dataWithBytes:p length:size];}
  dispatch_semaphore_signal(done);
 });
 BOOL ready=dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0;
 xpc_connection_cancel(c);if(!ready||!data)return NO;memcpy(pose,data.bytes,sizeof(*pose));
 for(int i=0;i<4;i++)for(int j=0;j<4;j++)if(!isfinite(pose->columns[i][j]))return NO;
 return fabsf(pose->columns[3].w-1)<0.001;
}
static void put32(unsigned char *p,size_t at,uint32_t n){memcpy(p+at,&n,4);}
static void putFloat(unsigned char *p,size_t at,float n){memcpy(p+at,&n,4);}
static void *selection(simd_float3 origin,simd_float3 direction,BOOL down){
 unsigned char *m=calloc(1,192);if(!m)return NULL;
 // Indigo event header followed by one Paloma manipulator collection.
 put32(m,0x18,160);m[0x1c]=1;put32(m,0x20,1);uint64_t stamp=mach_absolute_time();memcpy(m+0x24,&stamp,8);put32(m,0x30,302);
 // Left pinch + left contact; right hand stays released. These are paired
 // pinch/contact states per hand, not two independently pressed hands.
 put32(m,0x34,3);m[0x38]=down;m[0x39]=2;m[0x3a]=down;put32(m,0x3b,3);m[0x3f]=0;m[0x40]=1;m[0x41]=0;
 for(int i=0;i<3;i++){putFloat(m,0x47+i*4,origin[i]);putFloat(m,0x57+i*4,direction[i]);putFloat(m,0x67+i*4,origin[i]);putFloat(m,0x87+i*4,origin[i]);}
 // Identity hand quaternions; gaze ray supplies the selection location.
 putFloat(m,0x83,1);putFloat(m,0xa3,1);return m;
}
int main(int argc,const char **argv){@autoreleasepool{
 signal(SIGTERM,interrupted);signal(SIGINT,interrupted);
 // set, UDID, developer dir, normalized x/y, framebuffer aspect, hold, count
 if(argc!=9)return 2;double x,y,aspect,duration,count;
 if(!scalar(argv[4],&x,0,1)||!scalar(argv[5],&y,0,1)||!scalar(argv[6],&aspect,0.5,4)||!scalar(argv[7],&duration,0.02,10)||!scalar(argv[8],&count,1,3)||floor(count)!=count)return 2;
 NSString *setPath=@(argv[1]),*udid=@(argv[2]),*dev=@(argv[3]);
 if(![[NSUUID alloc]initWithUUIDString:udid])return 2;
 int lock=open([[setPath stringByAppendingPathComponent:[NSString stringWithFormat:@".keyboard-%@.lock",udid]]fileSystemRepresentation],O_CREAT|O_RDWR,0600);
 if(lock<0||flock(lock,LOCK_EX|LOCK_NB)!=0)return 3;
 if(!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",RTLD_NOW|RTLD_GLOBAL))return 4;
 void *kit=NULL;for(NSString *relative in @[@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit"]){kit=dlopen([[dev stringByAppendingPathComponent:relative]fileSystemRepresentation],RTLD_NOW|RTLD_GLOBAL);if(kit)break;}if(!kit)return 4;
 NSError *error=nil;id context=((id(*)(id,SEL,id,NSError**))objc_msgSend)(NSClassFromString(@"SimServiceContext"),NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"),dev,&error);if(!context)return 4;
 id set=((id(*)(id,SEL,id,NSError**))objc_msgSend)(context,NSSelectorFromString(@"deviceSetWithPath:error:"),setPath,&error);if(!set)return 4;
 id device=nil;for(id d in [set valueForKey:@"availableDevices"])if([[[d valueForKey:@"UDID"]UUIDString]caseInsensitiveCompare:udid]==NSOrderedSame){device=d;break;}
 if(!device||[[device valueForKey:@"state"]intValue]!=3)return 4;
 simd_float4x4 pose;if(!cameraPose(device,&pose)){fprintf(stderr,"Vision Pro camera pose unavailable\n");return 4;}
 id cls=NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient");if(!cls)return 4;
 id client=((id(*)(id,SEL,id,NSError**))objc_msgSend)([cls alloc],NSSelectorFromString(@"initWithDevice:error:"),device,&error);if(!client)return 4;
 // The simulator's rectangular camera has a 90-degree horizontal field of
 // view. Convert image coordinates to a camera ray, then to current world pose.
 simd_float4 o=simd_mul(pose,(simd_float4){0,0,0,1});
 simd_float4 d=simd_mul(pose,(simd_float4){(float)(2*x-1),(float)((1-2*y)/aspect),-1,0});
 if(!isfinite(simd_length(d.xyz))||simd_length(d.xyz)<0.0001)return 4;
 simd_float3 origin=o.xyz,direction=simd_normalize(d.xyz);
 if(stopping)return 5;
 if(!sendEvent(client,selection(origin,direction,NO)))return 5;
 usleep(100000);
 for(int i=0;i<(int)count;i++){
  if(stopping)break;
  BOOL pressed=sendEvent(client,selection(origin,direction,YES));
  if(pressed)hold(duration);
  BOOL released=sendEvent(client,selection(origin,direction,NO));
  if(!pressed||!released){fprintf(stderr,"Spatial selection delivery not confirmed\n");return 5;}
  usleep(150000);
 }
 close(lock);return stopping?5:0;
}}
