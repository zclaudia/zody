# 内部 binding 名称闭包

本批仅将冻结的 94 个内部 `ZCODE_*` 声明、导入、导出、alias 与实际引用同步为对应 `ZODY_*` 标识符；包括共享数据根、provider/runtime、诊断、CLI 及两个 CUA alias。唯一状态所有者、协议与数据流不变。显式的外部字段、环境键、插件身份、MCP metadata、错误码、遥测 schema、路径、数值及历史记录原字节不变；不得因为内部名字改变而迁移数据或赋予旧授权。DWF 隐藏命令和持久插件 host argv 由对应 owner 独立原子处理。

静态 source assertion 中仅三处随源码标识符更新；模拟内部模块 export 的两个对象键随被引用的 export 更新，其他外部对象键保持。远程部署文档仅更新当前 binding 名称并保留真实路径；已删除分享功能的历史文档只更正顶部状态，正文保持原字节。

node-repl-host 声明产物使用原 tsconfig 的逻辑 rootDir/outDir 和自定义 writeFile 隔离生成，完整比较 48 个 tracked 输出；除 result.d.ts 与其 map 外的 46 项必须与基线完全一致，result 二项只有实际变化时才提升。保持独立 process 控制旗标及其声明产物不变。验证实际共享导出、真实消费者、插件与运行时边界，并记录源文本/值和声明输出比较。

macOS release doctor 的两个脚本内部 binding 分别由 `ZCODE_HOME_DIR`、`ZCODE_HOME_HELPER_APP_PATH` 改为 `ZODY_DOCTOR_HOME_DIR`、`ZODY_DOCTOR_HOME_HELPER_APP_PATH`。唯一输入仍为 `ZODY_HOME` 或 `HOME/.zody`，显式 `ZODY_CUA_HELPER_APP_PATH` 优先，Helper 文件名、路径与签名检查不变；脚本不新增 export/unset。在调用者预先导出旧局部变量时，新脚本不再覆盖旧变量；未发现此内部变量的外部消费者。Bash 会保留预先导出的同名新变量属性，不能声称所有调用环境下变量均不被子进程继承。
