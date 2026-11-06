# R21 Docker 修正验证

初始干净 detached 树 `0ed4aa34ffd611c3ec05a90a51759c25bb7a304f`，tree `6c31c03c6c100c07cef10180d5dfb8b0182e2ace`，工作树 `output/zody-rename-r21/docker-clean-0ed4aa34`。browser 真实失败后仅在该私有树提交原生构建工具补充 `1a705507520158d583a1f94f690720bacca24eda`，tree `87efed389fe0364f3a7323498eb4b39c716e5cff`；compact TS loader 入口补充后的私有候选 `cc648373cf612dd9ff8ad4123be14fc97b68fda7`，tree `9c42c70b0b3c37dbb13aa7acdbac8198e8f972c3`。相对 0ed4 最终两个 Dockerfile 的精确差异见 `output/zody-rename-r21/docker-correction/final-private-candidate.patch`；未修改主工作树产品。

真实串行构建日志及退出码：

- 根 cwd `docker build --progress=plain -t zody-r21-dockercorrection-0ed4-compact:local -f apps/zody-cli/e2e/compact-microcompact/Dockerfile .` 退出 0；Node 24.14.0、pnpm 10.33.2，根 frozen install 完成、CLI 23/23 build tasks 完成，image ID `sha256:1eca58532ef0fb7cffab64e1b77d20998c88a741093530ce06a405b3fa37c862`。构建选择 38 workspace 但 hoisted 第三方生命周期仍较广，electron postinstall 实际执行，cpu-features/koffi/ssh2 实际编译；日志 `build-0ed4-compact.log`。导出曾长时间无日志，最终退出 0。
- 0ed4 browser 同类构建退出 1：越过工作目录 EACCES 后，node-pty 缺 Python、cpu-features 缺编译器，见 `build-0ed4-browser.log`。私有候选加入 python3/make/g++ 后 `docker build --progress=plain -t zody-r21-dockercorrection-1a705507-browser:local -f apps/zody-cli/packages/browser-use-plugin/e2e/headless-linux.Dockerfile .` 退出 0，Node 24.14.0、pnpm 10.33.2，image ID `sha256:48de61f7f76c6cd139fe1568a2d2f770ceee2bf90d76803806347fe701b38a64`，日志 `build-1a705507-browser.log`。
- 在上述 browser 镜像 `docker run --rm zody-r21-dockercorrection-1a705507-browser:local` 首次退出 1，真实 headless 测试 30 秒超时；容器临时测试副本添加阶段日志后不改变 timeout 重试通过 1/1，fixture、broker、MCP bootstrap 和 interaction 均完成；原始未改测试再次运行退出 0，1/1 通过（3.26 秒）。首次超时原因未定位，不能仅凭重试通过声称已解决波动。日志 `browser-headless.log`、`browser-diagnostic.log`、`browser-headless-repeat.log`。
- 原 compact 镜像直接 `docker run --rm ... --case=fake` 与 `--case=background-bash` 均退出 1，Node 原生入口无法解析 shared TS 源导出的 JS 相对路径。将同镜像 `--entrypoint node` 显式传 `--import tsx` 后可进入真实用例，但 fake 5 项通过、background-bash 和 usage-anchor 失败；单独 background-bash 亦失败。background 断言期望裸通知，实际包含安全系统前缀；usage-anchor 报 `app.submitPrompt is not a function`。与 root-owner 改动前 83680ddc 对比：两个 case、core 的 incoming-message.ts 和 workflow-notification-copy.ts、bootstrap 的 create-app.ts 和 input-facade.ts 字节均相同；bootstrap index.ts 与 app/types.ts 存在类型名替换，不能称这些文件逐字节相同。此静态比较不等于固定 836 的完整运行基线，不能断言故障均非本批间接引入。见 `compact-fake*.log`、`compact-background*.log`。
- 私有 cc648373 将 compact Docker ENTRYPOINT 设为 `node --import tsx ...`。为避免重复大镜像导出，从已构建 0ed4 compact 镜像只改变 ENTRYPOINT 配置构建派生镜像 `sha256:d45d10d9b9d0f44f51f072e8cd07439c13e971d92261025476b15ca34e3da433`，构建退出 0，`derived-entrypoint.json` 核对实际配置。派生镜像直接运行 fake/background 均退出 1，仍为上述场景断言/接口问题；这证明配置及 loader 因果，不是从完整 cc648373 源码树重新 Docker build 的证据，也不代表场景通过。

以上容器未传 API key、未挂载真实 HOME；使用容器内临时目录。三枚本任务唯一镜像的 ID、版本和运行日志保存后，仅删除其明确 tag/image（`cleanup-unique-images.log`，退出 0），未执行广域 prune 或删除未知镜像缓存；工作卷可用由约 8.8 GiB 回到约 11 GiB。此前独立只读 `docker system df` session 最终退出 0，不以挂起阶段推断失败。没有向主分支提交或 cherry-pick，也未更新总账。

精确运行命令（cwd 均为上述独立工作树）：

```sh
docker run --rm zody-r21-dockercorrection-0ed4-compact:local --case=fake
docker run --rm zody-r21-dockercorrection-0ed4-compact:local --case=background-bash
docker run --rm --entrypoint node zody-r21-dockercorrection-0ed4-compact:local --import tsx apps/zody-cli/e2e/compact-microcompact/run.mjs --case=fake
docker run --rm --entrypoint node zody-r21-dockercorrection-0ed4-compact:local --import tsx apps/zody-cli/e2e/compact-microcompact/run.mjs --case=background-bash
docker build --progress=plain -t zody-r21-dockercorrection-cc648373-compact:local -f ../docker-correction/compact-derived.Dockerfile .
docker run --rm zody-r21-dockercorrection-cc648373-compact:local --case=fake
docker run --rm zody-r21-dockercorrection-cc648373-compact:local --case=background-bash
docker run --rm zody-r21-dockercorrection-1a705507-browser:local
docker run --rm -i --entrypoint sh zody-r21-dockercorrection-1a705507-browser:local -s < ../docker-correction/browser-diagnostic.sh
docker run --rm zody-r21-dockercorrection-1a705507-browser:local
```

最终私有候选 compact Dockerfile SHA-256 `362ea5772994b5bb694d85adb8b5474c81cb05a27b46221722350f2576760f38`。仅删除的唯一 image 标签为上述 0ed4 compact、1a705507 browser 和 cc648373 derived compact；日志记录 Docker 的删除结果。
