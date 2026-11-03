# B/C/D 审查统计补充

更正统计口径；原 scoped PASS 不变。未重审代码、未改文件，仍固定 `01f59a33` → `21c06e80`。

**四指标**

| 指标 | 定义 | 值 |
|---|---|---:|
| records | `319-record-audit.json` / ledger 记录行数 | 319 |
| uniqueNames | 去重后的旧标识符文本 `old` | 268 |
| declarationKeys | 去重 `(file, old, kind)` | 308 |
| actual declaration positions | 去重 `(file, new, kind, line)`（audit 的 `currentNewDeclarations`） | 336 |

Ledger 与 audit 在 `records=319`、`uniqueOldText=268`、`uniqueFileOld=308`、`fileOldKind=308` 上一致；positions 只来自 audit，ledger 记录本身没有行号坐标。`unique (old, kind)` 同样是 268，因为本数据中每个旧文本只对应一种 kind。

**对我上一轮措辞的更正**

- 我上一轮写的 “308 unique symbols/names” 不准确。308 实际是 `(file, old, kind)` declaration keys；在本数据中也等于 `(file, old)` 和 `(file, old, new, kind)`，不是唯一文本数。唯一旧标识符文本是 268，与主控核算一致。
- `319 → 308`：11 条同一 `(file, old, kind)` 的多行 inventory 记录（`zcodeTaskService` 4 行、`zcodeBuiltin` 7 行、legacy `zcode` 2 行、`remoteZCodeAgentService` 2 行；额外 `3+6+1+1=11`）。
- `308 → 268`：20 个旧文本跨多个文件复用，例如 `zcodeTaskService` 出现在 8 个文件、`zcodeSessionService` 9 个文件、`zcodeEndpointOrigin` 4 个文件。这些是不同 file 的同名符号，不能按文本唯一值计。
- `308 → 336`：12 个 declaration key 对应多个实际声明位置，例如 `packages/provider/src/config-service.ts` 的 `zcodeBuiltin` 有 7 个位置、`packages/desktop/src/host/index.ts` 的 `zcodeTaskService` 有 4 个位置。
- 第四条指标必须保留 `file`：若只用 `(new, kind, line)` 去重会得到 335，存在跨文件同 `name/kind/line` 的碰撞。

**建议替代表述**

“319 条 ledger 记录，去重为 308 个 `(file, old, kind)` declaration keys、268 个唯一旧标识符文本、336 个 `(file, new, kind, line)` 实际声明位置。”

这样可避免把跨文件同名符号、同一 key 的多声明位置与文本唯一值混为一谈。原始 receipt 保留；原 scoped PASS 结论不变。
