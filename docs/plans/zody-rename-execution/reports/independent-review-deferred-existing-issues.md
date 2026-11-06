# 独立 review：既有问题单独登记

登记：2026-11-06。来源：主工作区 `output/zody-independent-review-20261106/review.md` F4/F5；改名前基线 `033f91783901e6adaf968d3d4b8ca34c41d89442`，审查候选 `277f9fb034e6485f4a998b22fb7c932185844e43`。

用户本轮明确只修复三个改名引入问题与测试门禁遗漏；下列两项保持未修复，未修改对应源码或断言，不记通过。

| ID / 严重性 | 触发、影响与位置 | 既有依据 / 复现证据 | 后续验收 |
|---|---|---|---|
| F4 / P2 | Agent NDJSON 的 UTF-8 字节跨 stdin chunk，逐片解码使“中”变成替换字符；`apps/zody-cli/packages/bootstrap/src/zody-protocol/transport.ts:120` | base 旧路径已有同一实现；原独立review `controller/utf8-repro.log` | 连续decoder、EOF flush及跨字节回归，另行授权 |
| F5 / P2 | 同Agent generation页面重挂时旧subscribe在途，迟到成功重登旧URI；`packages/ui/src/plugin-ui/app/pluginUiResourceSubscriptions.ts:70/123`，controller重挂入口`:146` | base模块仅包import改名；原review `controller/resource-race.log` | attachment epoch、迟到退订、真实controller重挂/在途退订回归，另行授权 |

本轮纳入默认门禁的 hostController 既有测试不覆盖 F5 的延迟成功顺序，不能据其通过关闭 F5。发布仍受此前 R60/R61 缺口约束。
