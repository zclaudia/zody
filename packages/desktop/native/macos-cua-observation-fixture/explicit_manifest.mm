#import "explicit_manifest.h"
@implementation ExplicitManifestWriter {
  dispatch_queue_t _queue;
}
- (instancetype)init {
  if ((self=[super init])) _queue=dispatch_queue_create("org.zody.cua.explicit-manifest", DISPATCH_QUEUE_SERIAL);
  return self;
}
- (void)writeData:(NSData *)data path:(NSString *)path completion:(void (^)(BOOL))completion {
  NSData *snapshot=[data copy]; NSString *destination=[path copy];
  dispatch_async(_queue, ^{
    BOOL ok=[snapshot writeToFile:destination options:NSDataWritingAtomic error:nil];
    if (completion) completion(ok);
  });
}
- (void)flush { dispatch_sync(_queue, ^{}); }
@end
