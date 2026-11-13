#import <AppKit/AppKit.h>
@interface ExplicitWindow : NSWindow
@end
@interface ExplicitContent : NSView
@end
@interface ExplicitField : NSTextField
@end
ExplicitWindow *ExplicitMakeWindow(NSRect frame, NSString *marker);
