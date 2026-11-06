// sealed session-entry.mjs：由 native 以可选 fd6/7 启动的协议会话入口。
import { createReadStream, createWriteStream } from "node:fs";
import { runCuaLaunchSession } from "../../../../../apps/zody-cli/packages/cli/src/cua-launch-session.js";

const control = createReadStream(null, { fd: 3, autoClose: false });
const input = createReadStream(null, { fd: 6, autoClose: false });
const output = createWriteStream(null, { fd: 7, autoClose: false });

await runCuaLaunchSession({
  entryName: "session-entry.mjs",
  control,
  input,
  output,
});
