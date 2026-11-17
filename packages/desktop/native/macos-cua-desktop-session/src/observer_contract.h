#pragma once
#import <Foundation/Foundation.h>
namespace zody::cua::desktop_session {
// 只接受已认证 bootstrap 的有界观察意图；不读取正文或执行任何 AX 操作。
bool observer_request_valid(id request);
bool control_request_valid(id request);
}
