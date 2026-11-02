// sealed cli-entry.mjs：fd3 控制/ready，fd6 app-server input，fd7 output。
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCuaNodeReplMcpPortFactory } from "@zcode/node-repl-host/cua-node-repl-mcp-port";
import { runCuaLaunchSession } from "../../../../../apps/zcode-cli/packages/cli/src/cua-launch-session.js";
import { installCandidateFetch } from "../runtime/candidate-fetch.js";
import { installFatalReporting } from "./entry-fatal.js";

// builder 在封装 cli-entry 时写入实际 node-repl-server.mjs 的钉值；资源路径只能由
// 本次实际签名 Node 的 execPath 推导固定同级名，不接受 UI/env/argv 注入。
declare const __CUA_NODE_REPL_SERVER_SHA256__: string;
declare const __CUA_NODE_REPL_SERVER_MAX_BYTES__: number;

const NODE_REPL_SERVER_NAME = "node-repl-server.mjs";

// 边界：serverPath 在 hash 校验后按路径交给 cell 子进程，校验与 exec 之间存在
// TOCTOU 窗口；cell 本身不受信且不继承 authority fd，只拥有 per-call broker
// capability。本轮不新增隔离机制，也不宣称完整 D06 隔离。

async function verifyNodeReplServer(): Promise<string> {
  const path = join(dirname(process.execPath), NODE_REPL_SERVER_NAME);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("cua_node_repl_server_not_regular");
    if (info.uid !== process.getuid()) throw new Error("cua_node_repl_server_owner_mismatch");
    if ((info.mode & 0o022) !== 0) throw new Error("cua_node_repl_server_writable");
    if (info.size <= 0 || info.size > __CUA_NODE_REPL_SERVER_MAX_BYTES__) {
      throw new Error("cua_node_repl_server_size_out_of_bounds");
    }
    const bytes = await handle.readFile();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== __CUA_NODE_REPL_SERVER_SHA256__) {
      throw new Error("cua_node_repl_server_sha_mismatch");
    }
  } finally {
    await handle.close();
  }
  return path;
}

installFatalReporting();
// candidate CLI 在 app-server composition 前安装真实 node-fetch 适配。
installCandidateFetch();

const control = createReadStream(null, { fd: 3, autoClose: false });
const input = createReadStream(null, { fd: 6, autoClose: false });
const output = createWriteStream(null, { fd: 7, autoClose: false });
const serverPath = await verifyNodeReplServer();

await runCuaLaunchSession({
  entryName: "cli-entry.mjs",
  control,
  input,
  output,
  cuaNodeReplMcpPortFactory: createCuaNodeReplMcpPortFactory({ serverPath }),
});
