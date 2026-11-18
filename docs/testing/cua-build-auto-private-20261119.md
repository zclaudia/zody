# macOS arm64 CUA 自动准备与私有签名接线（2026-11-19）

状态：代码接线和本地真实依赖冷还原已完成。当前只使用既有 `Zody Local Computer Use / local-self-signed`，Developer ID 与 Apple 公证不是门槛。本轮未生成新App、签名、导出私钥、导入真实P12、触发CI、上传、发布或替换安装；不能据此宣称实际CI签名或最终安装包已通过。

## 当前入口

- `bundle`、直接tsup、electron-builder与 `prepare:runtime-assets` 都消费 `macos-cua-build-selection.mjs`；保留 `macos-cua-demo-defaults.mjs` 为纯选择/验证器，供restore及离线测试使用，不形成自动准备递归。
- 默认macOS arm64材料验证成功直接复用；仅manifest明确ENOENT时请求自动准备。显式manifest/profile、其他平台、损坏或不完整材料不触发默认下载。bundle dry-run只读。
- `macos-cua-auto-prepare.mjs` 是自动发布owner：同卷隔离临时repo复用原fetch/restore，完成归档、manifest、完整树与代码身份校验后，在独占发布锁内重查并原子发布完整目录。任何已有目录（包括空目录）不覆盖；竞争返回busy或校验胜方，不自动强拆锁/force。失败清理本次临时树。手动fetch/restore是维护入口，不应与打包并发执行，自动链不向真实槽传force。
- 本地显式准备命令：`pnpm --dir packages/desktop run prepare:macos-cua`。缺材料时用pin对应的同仓库GitHub release归档，或通过 `ZODY_CUA_NARROW_FROZEN_ARCHIVE` 指定本地归档。远端获取沿用gh，需要gh可用且能读取该仓库；CI使用自带contents:read token。本轮冷还原只使用本地已验收归档，没有访问发布API。
- fetch显式贯穿调用方env与源pin所在repo的cwd，临时repo的restore始终回到纯选择器复核。

## 私有签名与CI

macOS arm64的默认local CUA装配启用外层私有签名，`ZODY_MAC_PRIVATE_SIGN=0` 可明确关闭；CI arm64强制1。自定义 `mac.sign` hook的identity非null，避免electron-builder提前跳过自签证书；本轮实际加载配置已确认hook、私有identity、CUA资源和关闭notarize/DMG签名。

hook只对Frameworks下直接app、framework和外层App按顺序签署；使用固定证书leaf SHA1、runtime、timestamp=none及既有entitlements。外层DR精确绑定产品bundle id与leaf，签后复核leaf SHA256和deep/strict签名。前后再次完整核验cua-narrow，禁止重签Helper/Node、禁止施签deep。DMG容器不声明已签名、公证或Gatekeeper发布验收通过。

CI已取消 `CUA_NARROW_FROZEN_RESTORE` 可选门禁，arm64固定执行公共准备命令；随后导入签名材料、构建、always清理，再收集制品。其他平台构建行为保持。新增离线构建测试命令已接入validate job，不签名或读取真实私钥。

临时keychain使用runner下每次唯一目录，随机解锁口令、600权限owner marker及跨step所有权状态；always仅清理本次创建且核对通过的路径。setup未执行、既有无marker目录、错误owner均不删除。P12导入后立即移除，正常失败与后置cleanup都清理本次资源。不调用修改默认keychain、search list或trust的命令；不将原始命令错误、P12、私钥或口令写日志。

## 本轮实际证据

1. 真实已验收归档在隔离空repo完成冷还原：只取档一次，manifest为 `9bcea0ea2e21d81a7f4f930a24672839e14ad17b43f29cfaf33b5bf47371cfcd`，launcher为 `00c91110dfd0e10fe66c0c25fb7c8709fd19fb1b6bc3b49c3fa8c1cd134d61b2`，Helper树为 `1454cf0d439ea7eac3ee48f78224d1f4639e22d12d4ec9f00a7dda10773ca953`；20个树项通过真实签名与内容校验。第二次选择复用缓存，准备器没有再次调用，临时树与锁清理完成。
2. 实际加载electron-builder配置，确认私有identity与custom sign函数存在，notarize=false、dmg.sign=false，固定槽Helper和manifest进入extraResources；未调用签名hook。
3. 定向Node套件84项与相关Vitest 8项通过。先红后绿包括入口提前失败、CI步骤缺失、证书reader对象形状、keychain误清理；错误日志保留。独立Terra审阅发现的清理所有权阻断已修复，另补marker写失败清理。
4. 根typecheck、lint、架构检查通过；最终lint **318 warning / 0 error**；中途321/320条记录保留，新增控制字符正则warning已修，两个既有unused项因真实材料可用性守卫使用而消除。Linux validate中的默认开关单测不再要求本机output，真实材料由显式实物用例和macOS准备门禁验证；未用假工具结果替代实物证据。
5. 已验收候选与安装asar仍为 `2e7a965f10eebff39af1c94b8bef60f45b591b40d24d0dfcb55bc7fdcd407ac7`，安装CodeResources与候选一致；本地冻结pin原字节保持。没有重跑R1/R2/R3真机矩阵、SDK写动作或18笔输入。

证据位于 `output/cua-build-auto-private-20261119/`：`cold-restore-proof.json`、`config-load.log`、`focused-node-final2.log`、`focused-vitest-final.log`、根检查日志及 `protected-artifacts.json`。

## 需要用户一次配置的事项

在目标仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 内容 |
| --- | --- |
| `ZODY_MAC_PRIVATE_CERT_P12_BASE64` | 现有 `Zody Local Computer Use` 证书及对应私钥导出的、带密码P12文件的base64编码 |
| `ZODY_MAC_PRIVATE_CERT_PASSWORD` | 上述P12的导出密码，非Mac登录密码 |

证书必须与现有固定leaf匹配，SHA1为 `d2ad8f4bb39ad7dd13ceba3892cadb16659a4732`。用户在本机钥匙串手动导出并直接配置GitHub Secrets；私钥、P12、编码和密码不发到聊天或提交仓库。本轮没有执行导出或配置Secret。

此外，CI必须能够取得pin指定的 `cua-narrow-frozen-2026-11-16-r2-local / cua-narrow-frozen.tar.gz`。当前只有本地归档验收与还原证据，未验证远端资产可获取性，也未上传；这项在用户以后授权交付时处理。两个Secrets不替代冻结归档来源。

Secret和归档来源就绪后，只需一次受控CI arm64构建及最终包闭包/启动差异检查；不重复旧功能矩阵。当前不能将“代码接线完成”写成“CI release已成功”。
