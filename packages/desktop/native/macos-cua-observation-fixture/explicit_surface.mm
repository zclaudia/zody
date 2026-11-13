#import "explicit_surface.h"
@implementation ExplicitWindow
- (NSArray *)accessibilityChildren { return self.contentView ? @[self.contentView] : @[]; }
@end
@implementation ExplicitContent
- (BOOL)isAccessibilityElement { return YES; }
- (NSAccessibilityRole)accessibilityRole { return NSAccessibilityGroupRole; }
- (id)accessibilityParent { return self.window; }
- (id)accessibilityWindow { return self.window; }
- (NSArray *)accessibilityChildren { return self.subviews; }
@end
@implementation ExplicitField
- (BOOL)isAccessibilityElement { return YES; }
- (NSAccessibilityRole)accessibilityRole { return NSAccessibilityStaticTextRole; }
- (id)accessibilityParent { return self.superview; }
- (id)accessibilityWindow { return self.window; }
- (NSArray *)accessibilityChildren { return @[]; }
- (id)accessibilityValue { return self.stringValue; }
@end
ExplicitWindow *ExplicitMakeWindow(NSRect frame, NSString *marker) {
  ExplicitWindow *window = [[ExplicitWindow alloc] initWithContentRect:frame
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
  window.title = @"Zody R1 Observation Fixture";
  window.releasedWhenClosed = NO;
  ExplicitContent *content = [[ExplicitContent alloc] initWithFrame:NSMakeRect(0,0,frame.size.width,frame.size.height)];
  window.contentView = content;
  ExplicitField *field = [[ExplicitField alloc] initWithFrame:NSMakeRect(20,35,260,28)];
  field.stringValue = marker;
  field.editable = NO;
  [field setAccessibilityLabel:@"R1 Fixture Body"];
  [content addSubview:field];
  return window;
}
