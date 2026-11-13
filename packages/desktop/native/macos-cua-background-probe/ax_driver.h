#pragma once

#import <Foundation/Foundation.h>
#include <stdint.h>
#include <sys/types.h>

// The caller owns authorization of the PID and runs this off the main thread.
NSDictionary *RunBackgroundAXProbe(pid_t pid, uint32_t windowID, BOOL (^allowDispatch)(void),
                                   BOOL (^awaitNextForegroundKey)(void));
