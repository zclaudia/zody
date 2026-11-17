export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts";

const REQUIRED_SSH_E2E_ENV = [
  "ZODY_E2E_SSH_HOST",
  "ZODY_E2E_SSH_USERNAME",
  "ZODY_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

export function isSshFormalSpec(spec) {
  return spec
    .replaceAll("\\", "/")
    .includes("/conversation-session/conversation-session-ssh-remote");
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // 修复原因：SSH P0 依赖真实服务器，默认全量在无凭据时纳入只会把环境缺失
  // 误记为三个产品失败；显式定向运行仍保留 helper 的缺变量 fail-closed 提示。
  return [
    ...(!targeted && !hasRequiredSshE2EEnvironment(env) ? [SSH_FORMAL_SPEC_GLOB] : []),
    // 中文原因：R1/R2 formal 仍依赖签名候选与用户真实操作；晋升不能让默认全量自动进入真机写入/电源验收。
    ...(!targeted
      ? [
          "./test/e2e/conversation-session/conversation-session-cua-r1-*.test.ts",
          "./test/e2e/conversation-session/conversation-session-cua-r2-*.test.ts",
        ]
      : []),
  ];
}
