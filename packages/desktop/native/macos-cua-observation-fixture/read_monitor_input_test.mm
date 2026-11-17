#import "read_monitor_input.h"
#include <cassert>

int main() { @autoreleasepool {
  // 中文原因：旧尾部截取在中间输入四个1时会错误得到11\n\n；只按真实选区和文档验证，不能用按键内容造结果。
  assert([MonitorInsertedText(@"111111\n\n", NSMakeRange(2, 0), @"1111111111\n\n") isEqual:@"1111"]);
  assert([MonitorInsertedText(@"old", NSMakeRange(3, 0), @"old1111") isEqual:@"1111"]);
  assert([MonitorInsertedText(@"old", NSMakeRange(0, 0), @"1111old") isEqual:@"1111"]);
  assert([MonitorInsertedText(@"old", NSMakeRange(1, 1), @"o1111d") isEqual:@"1111"]);
  assert([MonitorInsertedText(@"old", NSMakeRange(1, 0), @"old") isEqual:@""]);
  assert(MonitorInsertedText(@"old", NSMakeRange(1, 0), @"o1111X") == nil);
  assert(MonitorInsertedText(@"old", NSMakeRange(1, 0), @"ld") == nil);
  assert(MonitorInsertedText(@"old", NSMakeRange(NSNotFound, 0), @"old1111") == nil);
  assert(MonitorInsertedText(@"old", NSMakeRange(1, NSUIntegerMax), @"old1111") == nil);
  assert([MonitorInsertedText(@"🙂尾", NSMakeRange(2, 0), @"🙂1111尾") isEqual:@"1111"]);
} }
