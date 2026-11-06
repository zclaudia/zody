# R21 容器入口修正

依据根 workspace/lock 是唯一安装所有者、保留 CLI task 和容器入口的现行合同；基线真实日志见 `output/zody-rename-r21/root-owner-implementation/clean-docker-{compact,browser}.log`。compact 的 38 包选择不保证 hoisted 第三方生命周期隔离：已实际看到 node-pty 缺 Python、koffi 缺 CMake、cpu-features 缺编译器；browser 在 install 前因 `/workspace` 的 root 所有权出现 EACCES，尚无法据此判定是否还缺其他构建依赖。

修改三个路径：compact Dockerfile 将默认 `node:24.14-alpine` 固定为 `node:24.14.0-alpine`，在 Alpine 安装 python3、make、g++、cmake；对 README 已支持的 Debian 系镜像覆盖提供 apt 同套工具，保留 frozen 根锁、过滤及 CLI build/entrypoint。compact README 同步准确默认值。browser Dockerfile 在切换 USER 前将 `/workspace` 本身赋给 node；其 COPY --chown 只覆盖复制内容，不改变 WORKDIR 本身的已有所有权。不改变 node-linker 或依赖/锁。

三个文件修改前后 SHA-256 在 `output/zody-rename-r21/docker-correction/files.json`；应用前均与预案 before hash 一致，应用后均与 after hash 一致。`git apply --check` 退出 0，10 条 Docker RUN shell 语法 `sh -n` 均退出 0，见 `static-check.json`。当前仅静态验证，未运行 Docker、安装或构建；镜像标签可用性、实际容器安装、原生编译、browser 构建和运行仍须在完整 clean candidate 验证，不能从静态检查宣称通过。

后续真实验证：原 `0ed4aa34` browser 已跨过工作目录权限检查，在 frozen install 的 node-pty 生命周期暴露缺 Python/编译工具。私有干净候选 `1a705507520158d583a1f94f690720bacca24eda`（tree `87efed389fe0364f3a7323498eb4b39c716e5cff`）仅在 browser apt 包列表增加 `python3 make g++`。主控逐字节核对唯一文件差异并整合到当前工作树；依赖、锁、linker 和 task 选择均不变。compact 和 browser 镜像构建现已实际退出 0；随后运行 case 的结果及额外修正，以独立 verification 报告为准，构建成功不代表运行通过。

compact 的实际 case 进一步证实 plain Node 无法解析 workspace TypeScript 源导出的 JS 相对引用。最终私有候选 `cc648373cf612dd9ff8ad4123be14fc97b68fda7` 仅将 ENTRYPOINT 增加 `--import tsx`；使用已锁定根依赖，未修改包 exports/锁文件。主控已核对最终文件 SHA 并整合同一差异。同原镜像的命令 override 与仅 ENTRYPOINT 不同的派生配置均能进入真实 case；仍有通知前缀断言与缺失 app.submitPrompt 的场景失败，详见 verification 原始结果。此结论不等于完整最终源码树重新构建，也不宣称完整 R21 通过。
