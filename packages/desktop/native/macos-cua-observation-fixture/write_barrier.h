#pragma once
#import <Foundation/Foundation.h>
@protocol WriteBarrierGate <NSObject>
- (BOOL)waitForRelease;
@end
@interface WriteBarrier : NSObject <WriteBarrierGate>
@property(nonatomic, readonly, copy) NSString *nonce;
- (instancetype)initWithDirectory:(NSString *)directory timeoutMilliseconds:(NSUInteger)milliseconds;
- (BOOL)waitForRelease;
@end
