# 第十一轮直接审查记录

以下来自实际 diff 和独立执行，不是新增验收矩阵。代码修复与真实签名组合验收分别记账。

- 早期native缺ino_t声明、callback签名/unused编译错误、peer缺libbsm：均已修复；controller最终bundle真实编译链接通过，没有跳过native源或忽略未解析符号。
- 锁域原含轮次：改为稳定每用户产品namespace，不随workspace/轮次改变；真实两进程busy及同inode释放后再取得通过。
- authority异常关闭未撤销owner、背压/flush不退出：统一失效路径先producerLost/dispose，限制输出，异常destroy；controller首次5项测试4通过1失败，修复后同5项通过。
- peer核验原只比较DR文本：已调用Security实际requirement核验，固定实际audit token、expected PID/UID、leaf、identifier、hardened runtime及空entitlements。真实local-self-signed正例尚未执行。
- 资源执行字节：JS用校验后的内存快照经stdin执行，Node核验已加载CDHash；FD归一化避免dup2冲突。签名产物的真实加载仍待确认后验证。
- operation裸指针跨线程及destroy后revoke/EOF UAF：publish/cancel/detach统一mutex；callback context为持久对象，资源未知时保留；PNG commit与已观察撤销串行。Swift归还和Rust最终callback完成都满足才交还context。
- supervisor退出后Helper可能成为仍有权限的孤儿：已认证peer断开触发authority shutdown，既有reader取消并让真实owner失效；monitor先join再清理，不另造授权状态。
- 失败清理可能删除调用前已存在的PNG路径：只对本次成功创建的PNG回滚，O_EXCL失败不删除旧文件。
- ECHILD/未确认退出：不继续向可能复用PID发信号，不记清理成功；supervisor成功同时要求真实结果、撤销、资源归还、锁释放和Node回收事实。进程退出不记native屏障。
- 视觉patch初稿不能apply、取消后仍可取PNG、Swift归还早于Rust callback：固定patch重建并修复；独立43项Rust纯测试及3项真实构建包装测试通过。
- 最终构建原manifest指向已删除staging资源、dist可能陈旧：改最终路径，刷新core并按公开export打包，记录实际输入与头文件摘要。controller重建、资源逐项hash复核及3项Lease/拒绝测试通过。

最终源码与证据以SOURCE-MANIFEST.json和ACCEPTANCE.md为准。上述修复没有被写成真实截图、签名peer正例或产品通过。

## 用户批准后的续验收

上述“尚未执行”的签名正例已推进：冻结源码不变，带真实身份 pins 重建并签名，Security preflight 与一次真实 captured-and-revoked 成功，PNG及锁释放独立检查通过。见 SIGNING-ACCEPTANCE.md；仍不认定生产接线、独立 TCC 归属或输入 Fenced。
