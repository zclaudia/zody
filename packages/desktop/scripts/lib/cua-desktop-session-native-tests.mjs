// native 单测编译/执行清单；与构建编排分离，入口只调用一次。
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_ROOT } from "./cua-desktop-session-config.mjs";
import { sessionTestCompileArgs } from "./cua-desktop-session-source.mjs";
import { compile, run, sha256File } from "./cua-desktop-session-toolchain.mjs";

const TEST_CASES = [
  {
    name: "session-binding-confirmation",
    source: "session_binding_test.mm",
    sources: ["session_binding.mm", "confirmation_state.mm"],
  },
  {
    name: "session-control",
    source: "session_control_test.mm",
    sources: ["session_control.mm"],
  },
  {
    name: "session-capture-file",
    source: "session_capture_file_test.mm",
    sources: ["session_capture_file.mm"],
  },
  {
    name: "session-authority-fd",
    source: "session_authority_fd_test.mm",
    sources: ["session_authority_fd.mm", "authority_client.mm"],
  },
  {
    name: "session-exit-policy",
    source: "session_exit_policy_test.mm",
    sources: [],
  },
  {
    name: "session-workspace-handoff",
    source: "session_workspace_handoff_test.mm",
    sources: ["session_workspace_handoff.mm"],
  },
  {
    name: "session-cell-protocol",
    source: "session_cell_protocol_test.mm",
    sources: ["session_cell_protocol.mm", "session_transport_auth.mm"],
  },
  {
    name: "session-cell-identity",
    source: "session_cell_identity_test.mm",
    sources: ["session_node_process.mm", "bundle_paths.mm", "r11_self_identity.mm"],
  },
  {
    name: "session-cell-relay",
    source: "session_cell_relay_test.mm",
    sources: ["session_cell_relay.mm"],
  },
  {
    name: "session-transport-auth",
    source: "session_transport_auth_test.mm",
    sources: ["session_transport_auth.mm"],
  },
  {
    name: "confirmation-app-decision",
    source: "confirmation_app_decision_test.mm",
    sources: [
      "confirmation_state.mm",
      "confirmation.mm",
      "session_binding.mm",
      "window_identity.mm",
      "session_node_process.mm",
      "session_capture_file.mm",
      "session_control.mm",
      "session_authority_fd.mm",
      "session_launcher.mm",
      "session_cell_protocol.mm",
      "session_cell_relay.mm",
      "session_cell_transport.mm",
      "session_transport_auth.mm",
      "session_workspace_handoff.mm",
      "session_workspace_runtime.mm",
      "session_supervisor.mm",
      "authority_client.mm",
      "bundle_paths.mm",
      "capture_owner.mm",
      "machine_lease.mm",
      "peer_auth.mm",
      "r11_self_identity.mm",
      "../r10/src/peer_socket.mm",
      "../r10/src/peer_frame.mm",
      "../r10/src/security_identity.mm",
      "../r10/src/profile.mm",
    ],
  },
];

export async function pathIsReadable(path) {
  return access(path, fsConstants.R_OK)
    .then(() => true)
    .catch(() => false);
}

export async function runNativeTests(toolchain, { srcDir, includeRoot, visualRoot, testRoot }) {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  // 中文原因：confirmation-app-decision 会编译 session_supervisor.mm，其头文件链
  //（session_launcher.h / session_cell_transport.h / peer_auth.h）引用 R10 的
  // peer_socket.h。正常构建由 sessionCompileArgs 的 -I r10SrcDir 提供；测试编译参数
  // 只接收 srcDir，manifest 里用 ../r10/src 只能补源码，补不了头文件搜索路径。
  const r10IncludeRoot = join(srcDir, "..", "r10", "src");
  const results = [];
  for (const testCase of TEST_CASES) {
    const output = join(testRoot, testCase.name);
    const args = sessionTestCompileArgs(toolchain, {
      srcDir,
      includeRoot,
      visualRoot,
      testSource: join(NATIVE_ROOT, "tests", testCase.source),
      sources: testCase.sources,
      output,
    });
    args.unshift("-I", r10IncludeRoot);
    await compile(toolchain, args, `test-${testCase.name}`, srcDir);
    const result = await run(output, [], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new Error(
        `native test ${testCase.name} failed\n${result.stdout}\n${result.stderr}`.trim(),
      );
    }
    results.push({
      name: testCase.name,
      status: "pass",
      stdout: result.stdout.trim(),
      sha256: await sha256File(output),
    });
  }
  return results;
}
