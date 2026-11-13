// sealed cli-entry.mjs：fd3 控制/ready，fd6 app-server input，fd7 output。
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import {
  createCuaNodeReplMcpPortFactory,
  readSealedResourceSnapshot,
} from "@zody/node-repl-host/cua-node-repl-mcp-port";
import { runCuaLaunchSession } from "../../../../../apps/zody-cli/packages/cli/src/cua-launch-session.js";
import { installCandidateFetch } from "../runtime/candidate-fetch.js";
import { installFatalReporting } from "./entry-fatal.js";

// builder 在封装 cli-entry 时写入实际 node-repl-server.mjs 的钉值；资源路径只能由
// 本次实际签名 Node 的 execPath 推导固定同级名，不接受 UI/env/argv 注入。
declare const __CUA_SDK_CLIENT_SHA256__: string;
declare const __CUA_SDK_CLIENT_MAX_BYTES__: number;
declare const __CUA_SDK_DOC_SHA256__: string;
declare const __CUA_SDK_DOC_MAX_BYTES__: number;
declare const __CUA_NODE_REPL_SERVER_SHA256__: string;
declare const __CUA_NODE_REPL_SERVER_MAX_BYTES__: number;

const NODE_REPL_SERVER_NAME = "node-repl-server.mjs";

// Bug 原因：旧实现只校验 path 的 bytes 后返回 path，subprocess-launch 再按 path 打开，
// 校验与执行之间存在 rename/原位改写/unlink 替换窗口。修复依据：在同一 O_NOFOLLOW
// 句柄上有界读取、核验摘要并把同一份 UTF-8 内容冻结为私有快照；cell 只从 stdin 执行
// 该快照，不再重新打开 serverPath。cell 本身不受信且不继承 authority fd，只拥有
// per-call broker capability；本轮不宣称完整 D06 隔离，固定 Node 二进制仍按路径启动。
installFatalReporting();
// candidate CLI 在 app-server composition 前安装真实 node-fetch 适配。
installCandidateFetch();

const control = createReadStream(null, { fd: 3, autoClose: false });
const input = createReadStream(null, { fd: 6, autoClose: false });
const output = createWriteStream(null, { fd: 7, autoClose: false });
const serverPath = join(dirname(process.execPath), NODE_REPL_SERVER_NAME);
const snapshot = await readSealedResourceSnapshot({
  path: serverPath,
  expectedSha256: __CUA_NODE_REPL_SERVER_SHA256__,
  maxBytes: __CUA_NODE_REPL_SERVER_MAX_BYTES__,
  expectedUid: process.getuid?.(),
});

// SDK 和文档均在同一固定资源目录以同句柄验证；cell 只接收不可变快照。
const sdkRoot = join(dirname(process.execPath), "computer-use-sdk");
const [sdkClient, sdkDoc] = await Promise.all([
  readSealedResourceSnapshot({
    path: join(sdkRoot, "scripts", "computer-use-client.mjs"),
    expectedSha256: __CUA_SDK_CLIENT_SHA256__,
    maxBytes: __CUA_SDK_CLIENT_MAX_BYTES__,
  }),
  readSealedResourceSnapshot({
    path: join(sdkRoot, "docs", "computer-use.md"),
    expectedSha256: __CUA_SDK_DOC_SHA256__,
    maxBytes: __CUA_SDK_DOC_MAX_BYTES__,
  }),
]);

// ready 严格解析后才由 Helper 提供私有 cell.sock；factory 只持有 getter，
// 缺失时 transport 明确 fail closed，不回退到按 serverPath spawn。
let cellEndpoint: string | undefined;
let transportAuthenticationKey: string | undefined;

await runCuaLaunchSession({
  entryName: "cli-entry.mjs",
  control,
  input,
  output,
  cuaNodeReplMcpPortFactory: createCuaNodeReplMcpPortFactory({
    serverPath,
    sourceSnapshot: snapshot.source,
    subprocess: {
      cuaSdk: {
        root: sdkRoot,
        clientSource: sdkClient.source,
        documentationSource: sdkDoc.source,
      },
    },
    cellEndpoint: () => cellEndpoint,
    transportAuthenticationKey: () => transportAuthenticationKey,
  }),
  onSessionReady: (ready) => {
    cellEndpoint = ready.cellEndpoint;
    transportAuthenticationKey = ready.transportAuthenticationKey;
  },
});
