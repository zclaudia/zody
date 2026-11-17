#import <Foundation/Foundation.h>

static NSString *MonitorInsertedText(NSString *before, NSRange selection, NSString *after) {
  // 中文原因：用户可以在已有文本中点击；用真实选区推导插入并核对未编辑的前后文，不能假定只在末尾追加。
  if (!before || !after || selection.location > before.length ||
      selection.length > before.length - selection.location) return nil;
  const NSUInteger retained = before.length - selection.length;
  if (after.length < retained) return nil;
  const NSUInteger insertedLength = after.length - retained;
  NSString *prefix = [before substringToIndex:selection.location];
  NSString *suffix = [before substringFromIndex:selection.location + selection.length];
  if (![[after substringToIndex:selection.location] isEqual:prefix] ||
      ![[after substringFromIndex:selection.location + insertedLength] isEqual:suffix]) return nil;
  return [after substringWithRange:NSMakeRange(selection.location, insertedLength)];
}
