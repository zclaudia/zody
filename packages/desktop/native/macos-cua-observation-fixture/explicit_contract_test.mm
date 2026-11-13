#import <AppKit/AppKit.h>
#import "explicit_surface.h"
#include <cassert>
int main() { @autoreleasepool {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  ExplicitWindow *a=ExplicitMakeWindow(NSMakeRect(0,0,300,130), @"target");
  ExplicitWindow *b=ExplicitMakeWindow(NSMakeRect(0,0,300,130), @"sibling");
  ExplicitContent *av=(ExplicitContent*)a.contentView, *bv=(ExplicitContent*)b.contentView;
  assert(a != b && a.title && [a.title isEqual:b.title]);
  assert(a.accessibilityChildren.count == 1 && a.accessibilityChildren[0] == av);
  assert(b.accessibilityChildren.count == 1 && b.accessibilityChildren[0] == bv);
  assert(av.isAccessibilityElement && [av.accessibilityRole isEqual:NSAccessibilityGroupRole]);
  assert(av.accessibilityParent == a && av.accessibilityWindow == a);
  assert(bv.accessibilityParent == b && bv.accessibilityWindow == b);
  assert(av.accessibilityChildren.count == 1 && bv.accessibilityChildren.count == 1);
  ExplicitField *af=(ExplicitField*)av.accessibilityChildren[0], *bf=(ExplicitField*)bv.accessibilityChildren[0];
  assert(af != bf && af.superview == av && bf.superview == bv);
  assert(af.isAccessibilityElement && [af.accessibilityRole isEqual:NSAccessibilityStaticTextRole]);
  assert(af.accessibilityParent == av && af.accessibilityWindow == a);
  assert(bf.accessibilityParent == bv && bf.accessibilityWindow == b);
  assert([af.stringValue isEqual:@"target"] && [bf.stringValue isEqual:@"sibling"]);
  assert([af.accessibilityValue isEqual:@"target"] && [bf.accessibilityValue isEqual:@"sibling"]);
  assert(![av.accessibilityChildren containsObject:bf] && ![bv.accessibilityChildren containsObject:af]);
  [a close]; [b close];
} return 0; }
