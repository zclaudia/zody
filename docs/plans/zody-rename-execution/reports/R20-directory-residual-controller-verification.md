# 目录消费者和 manifest 测试：主控复核

基线 `7c4ff9113680a38e273032b09bee32ee6ba399af`。主控核对八个产品/测试/技能文件的 before/after SHA，与 Terra 清单完全一致；差异包括六个现行目录消费者、manifest 的精确目标断言和一处当前技能文案，另有目标格式化。

主控独立实际运行：CLI 四文件 26 测试通过、services modelTrajectory 7 测试通过、隔离手工数据路径 2 测试通过、根 typecheck 与 lint 退出 0（303 warnings），`git diff --check` 退出 0。日志 `output/zody-rename-validation/controller-directory-{cli,services,manual,types,lint}.log`。Terra 已运行增量架构检查、bootstrap 依赖闭包构建和目标格式检查，均退出 0。

DeepSeek 指出的 manifest 缺口已用精确临时 HOME 目标断言修正。主控审阅 mutation 日志：仅将隔离副本的 manifest 目标退回 `.zcode`，新断言实际失败；当前源码两项测试通过。未改动真实用户数据。

无桥 guard 同时更新目录与旧协议检测 regex，并检查非空扫描和路径正反例；删除模块 ENOENT 指向现行目录，避免旧目录消失带来虚绿。shadow-replay 真实动态导入使用现行 dist；原 plain Node 用法暴露 TS source export 的解析条件，改用已经实际验证的 `node --import tsx` 示例。空 synthetic DB 的加载/初始化成功不是会话回放证据，后续 runtime 门禁仍需覆盖实际会话。

本批未修改安装配置、env/wire 身份或冻结材料。冻结后交 DeepSeek C 复查 manifest 缺口并独立审查六个路径消费者；完整类型批和全量改名仍未完成。
