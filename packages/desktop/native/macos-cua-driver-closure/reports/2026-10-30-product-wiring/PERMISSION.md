# 独立 Helper 屏幕录制权限

2026-10-30，用户明确批准为固定签名 Helper 开启屏幕录制权限，并在系统认证框自行完成密码确认。controller 通过系统设置 Add 选择签名已逐文件复核的 R11 app；随后 AX 确认 `Zody CUA Helper Round11_Toggle` 为 on。未改变其他应用开关、辅助功能、输入权限或证书。

同一 app 经 LaunchServices 独立启动完成 captured-and-revoked，生成2400×1600 PNG，226542字节，SHA256 `0eeb531bbd146014010ab4fb92eb49dad09ab320c612390f4e8cccf198ff4692`。controller 打开图确认真实非空 Zody 单窗口，并在结束后独立重新取得同一机器锁。tccd日志的responsible/subject是 `io.github.zclaudia.zody.cua-helper`，这次没有依赖控制器作为权限主体。

本次仍是 R11 开发 authority 入口，不是生产 runtime 接线成功，也不是输入 Fenced 或产品采用结论。PNG只留本地 `output/cua-helper-product-integration/independent-permission/zody.png`；参数、结果、TCC主体及复核证据见 evidence/independent-permission。R11签名候选和冻结归档未修改。
