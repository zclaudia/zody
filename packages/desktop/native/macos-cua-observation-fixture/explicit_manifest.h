#import <Foundation/Foundation.h>
@interface ExplicitManifestWriter : NSObject
- (void)writeData:(NSData *)data path:(NSString *)path completion:(void (^)(BOOL))completion;
// 仅供不在写入队列上的测试确定性等待；生产不阻塞主线程。
- (void)flush;
@end
