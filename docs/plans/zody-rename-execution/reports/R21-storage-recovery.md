# R21 4fac 候选安装前存储恢复

第一次创建新工作树前的12GiB预留检查失败（可用12,281,225,216bytes），未创建工作树或安装。主控随后只读确认旧854 Main检查副本的 `output/zody-rename-main-baseline/checkout/node_modules` 是本任务创建、可重建的依赖目录，约2.8GiB逻辑体积；它不是注册worktree，根目录本身不是symlink。源码输入 `854ddf60ac1be92428e3c32192ee325aab6acd25` 仍在本仓。

主控保存该依赖目录清单、.modules.yaml等存在的安装元数据与hash后，仅删除该目录。旧checkout源码/根锁和父目录原始检查日志完整保留，锁SHA复验相同；r02制品、7c/8df clean工作树、工具链及其他缓存未动。实际可用空间从12,257,173,504增至13,368,004,608bytes，不能用逻辑du体积夸大物理回收。元数据和清理前后记录位于 `output/zody-rename-r22/storage-cleanup/`，旧基线父目录另留时间侧车。

旧854检查的实际日志仍是历史证据，但现在不能立即复跑：需按保留源码/锁重新安装，离线cache完整性未保证。随后主控从完整4fac提交首次创建新detached工作树，安装另由该固定候选真实验证；没有复用旧node_modules或reset旧验证工作树。
