import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_INSTRUCTIONS_MAX_BYTES, ZODY_DATA_ROOT_DIR_NAME } from "@zody/shared";
import type { ISettingService } from "../src/setting/setting.js";
// 跨树导入先例：packages/desktop/test/storagePreparationProtocol.test.ts 以相对路径引
// apps/zody-cli 源码做跨域契约测试；本文件用同一方式实测 CLI adapter 的真实读取路径，
// 避免「两侧上限同口径」只停留在常量比对（PZ07 源码扫描）而从未执行过 Agent 侧读取。
import { createNodeContextSourceAdapter } from "../../../apps/zody-cli/packages/adapters/src/context/index.js";

/**
 * 设置页「个性化」（用户自定义指令）服务层验收，对应 docs/ui/settings-personalization.md
 * 的 PZ01–PZ06。来源：上游 v3.17.1（commit a60ba6a7）settingService 语义，
 * 路径按本仓 ZODY 数据根（{home}/.zody/AGENTS.md）适配。
 */
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalDesktopHome = process.env.ZODY_DESKTOP_HOME_DIR;
const originalDataBaseDir = process.env.ZODY_DATA_BASE_DIR;
const tempHomes: string[] = [];

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeTempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  tempHomes.push(home);
  return home;
}

async function createSettingServiceInHome(home: string): Promise<ISettingService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/setting/settingService.js");
  return mod.createSettingService();
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvValue("HOME", originalHome);
  restoreEnvValue("USERPROFILE", originalUserProfile);
  restoreEnvValue("ZODY_DESKTOP_HOME_DIR", originalDesktopHome);
  restoreEnvValue("ZODY_DATA_BASE_DIR", originalDataBaseDir);

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("settingService user instructions（个性化指令）", () => {
  it("PZ01 空首次保存自动创建 {home}/.zody/AGENTS.md 并读写往返一致", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);
    const expectedPath = join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md");
    expect(existsSync(expectedPath)).toBe(false);

    const saved = await service.saveUserInstructions("每次回答末尾附一行总结");
    expect(saved.filePath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const loaded = await service.getUserInstructions();
    // 路径与 CLI adapter（context/index.ts findDefaultUserInstructionFile）同构：
    // join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md")，App 写的即 Agent 读的。
    expect(loaded).toEqual({ content: "每次回答末尾附一行总结", filePath: expectedPath });
  });

  it("PZ02 超 100KB（UTF-8 字节计，含多字节字符）保存被拒且文件不被写入/覆盖", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);

    // 100KB + 1 字节：多字节字符按 UTF-8 字节计（"ü" 为 2 字节）。
    const oversized = `${"ü".repeat(USER_INSTRUCTIONS_MAX_BYTES / 2)}a`;
    expect(Buffer.byteLength(oversized, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES + 1);

    const filePath = join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md");
    await expect(service.saveUserInstructions(oversized)).rejects.toMatchObject({
      code: "user_instructions_too_large",
    });
    expect(existsSync(filePath)).toBe(false);

    // 已有内容时超限保存同样拒绝，不覆盖旧内容。
    await service.saveUserInstructions("旧内容");
    await expect(service.saveUserInstructions(oversized)).rejects.toMatchObject({
      code: "user_instructions_too_large",
    });
    expect(readFileSync(filePath, "utf8")).toBe("旧内容");
  });

  it("PZ03 恰好 100KB（UTF-8 字节计）保存成功且读回完整不截断", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);

    // 多字节 + ASCII 混合，总字节数恰为上限：与 CLI adapter 读取口径（前 100KB）一致，
    // 保存侧不拒绝、读取侧不截断。2*(51200-2) + 4 = 102400。
    const atLimit = `${"ü".repeat(USER_INSTRUCTIONS_MAX_BYTES / 2 - 2)}abcd`;
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES);

    await service.saveUserInstructions(atLimit);
    const loaded = await service.getUserInstructions();
    expect(loaded.content).toBe(atLimit);
    expect(Buffer.byteLength(loaded.content, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES);
  });

  it("PZ04 文件不存在时 getUserInstructions 返回空内容不抛错", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);
    const expectedPath = join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md");

    await expect(service.getUserInstructions()).resolves.toEqual({
      content: "",
      filePath: expectedPath,
    });
  });

  it("PZ05 连续两次保存不同内容时 FIFO：最终文件为队尾（最后一次）内容", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);

    const first = service.saveUserInstructions("第一次保存");
    const second = service.saveUserInstructions("第二次保存");
    await Promise.all([first, second]);

    const filePath = join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md");
    expect(readFileSync(filePath, "utf8")).toBe("第二次保存");
    // 读取排空写队列后不能把旧内容当基线。
    expect((await service.getUserInstructions()).content).toBe("第二次保存");
  });

  it("PZ06 已有文件保存后权限固定私有 0600，不放宽既有权限", async () => {
    const home = makeTempHome("zody-user-instructions-");
    const service = await createSettingServiceInHome(home);
    const dataRoot = join(home, ZODY_DATA_ROOT_DIR_NAME);
    const filePath = join(dataRoot, "AGENTS.md");

    // 预置 0644 文件：rename 换 inode 的写入若不带 mode 会保持 umask 默认而非收紧。
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(filePath, "seed", { mode: 0o644 });
    await service.saveUserInstructions("私有内容");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("home 解析只认 HOME/USERPROFILE：忽略 ZODY_DESKTOP_HOME_DIR 与 ZODY_DATA_BASE_DIR", async () => {
    const agentHome = makeTempHome("zody-user-instructions-agent-");
    const desktopHome = makeTempHome("zody-user-instructions-desktop-");
    const dataBaseDir = makeTempHome("zody-user-instructions-basedir-");
    process.env.ZODY_DESKTOP_HOME_DIR = desktopHome;
    process.env.ZODY_DATA_BASE_DIR = dataBaseDir;
    const service = await createSettingServiceInHome(agentHome);

    // CLI adapter 读该文件时忽略这两个覆盖变量；App 写入若认它们会写错文件（分叉）。
    await service.saveUserInstructions("只落 agent home");
    expect(existsSync(join(agentHome, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(desktopHome, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dataBaseDir, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md"))).toBe(false);
  });

  it("HOME 缺失时回退 USERPROFILE（与 CLI adapter resolveUserHomeDir 一致）", async () => {
    const home = makeTempHome("zody-user-instructions-userprofile-");
    delete process.env.HOME;
    process.env.USERPROFILE = home;
    vi.resetModules();
    const mod = await import("../src/setting/settingService.js");
    const service = mod.createSettingService();

    await service.saveUserInstructions("userprofile instructions");
    expect(existsSync(join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md"))).toBe(true);
    expect((await service.getUserInstructions()).content).toBe("userprofile instructions");
  });
});

/**
 * 「两侧上限同口径」的实测补全（spec 验收口径：同一份 ≤100KB 内容经 saveUserInstructions
 * 保存后由 CLI adapter 实际读取必须完整不截断且路径一致）。
 * 修复原因：442b8000 落地的 PZ03 只经 settingService 自身 readFile 读回，同口径仅由
 * PZ07 的常量源码扫描间接保证，从未执行过 Agent 侧真实读取路径——若服务写路径与
 * adapter 读路径发生漂移（文件名/目录名/上限任一侧单独改动），现有测试无法发现
 * 「App 写的文件 Agent 读不到」。这里用 CLI adapter 公开入口
 * （apps/zody-cli/packages/adapters/src/context/index.ts，上游 a60ba6a7 语义，
 * 本仓 2026-11-06 校准路径）跨树实测（导入先例见文件头注释）。
 */
describe("与 CLI adapter 读取同口径（PZ03 实测）", () => {
  function makeAdapterHome(workspaceName: string): { home: string; workspace: string } {
    const home = makeTempHome("zody-user-instructions-adapter-");
    const workspace = join(home, workspaceName);
    mkdirSync(workspace, { recursive: true });
    return { home, workspace };
  }

  function readViaAdapter(home: string, workspace: string) {
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home } });
    return adapter.resolveContextSources({
      workingDirectory: workspace,
      userInstructions: { workingDirectory: workspace },
    });
  }

  it("saveUserInstructions 保存的 ≤100KB 内容经 CLI adapter 实际读取完整不截断且路径一致", async () => {
    const { home, workspace } = makeAdapterHome("workspace");
    const service = await createSettingServiceInHome(home);
    const expectedPath = join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md");

    // 常规中文内容：路径一致（App 写的即 Agent 读的）。
    await service.saveUserInstructions("每次回答末尾附一行总结");
    const plain = await readViaAdapter(home, workspace);
    expect(plain.userInstructions?.filePath).toBe(expectedPath);
    expect(plain.userInstructions?.content).toBe("每次回答末尾附一行总结");
    expect(plain.userInstructions?.truncated).toBe(false);
    expect(plain.userInstructions?.sources).toEqual([
      expect.objectContaining({ scope: "user", filePath: expectedPath, truncated: false }),
    ]);

    // 恰好 100KB（UTF-8 字节计，多字节 + ASCII 混合）：边界值两侧都不截断。
    const atLimit = `${"ü".repeat(USER_INSTRUCTIONS_MAX_BYTES / 2 - 2)}abcd`;
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES);
    await service.saveUserInstructions(atLimit);
    const boundary = await readViaAdapter(home, workspace);
    expect(boundary.userInstructions?.filePath).toBe(expectedPath);
    expect(boundary.userInstructions?.content).toBe(atLimit);
    expect(boundary.userInstructions?.truncated).toBe(false);
  });

  it("外部绕过保存侧写入的超限文件 adapter 只读前 100KB：保存侧拒绝、读取侧截断同口径", async () => {
    const { home, workspace } = makeAdapterHome("workspace");
    const service = await createSettingServiceInHome(home);

    // 100KB + 3 字节（尾字节为多字节字符），前 100KB 为纯 ASCII，截断结果可精确断言。
    const oversized = `${"a".repeat(USER_INSTRUCTIONS_MAX_BYTES)}尾`;
    expect(Buffer.byteLength(oversized, "utf8")).toBe(USER_INSTRUCTIONS_MAX_BYTES + 3);

    // 保存侧（最终防线）：同一内容直接硬拒，不落盘。
    await expect(service.saveUserInstructions(oversized)).rejects.toMatchObject({
      code: "user_instructions_too_large",
    });

    // 读取侧（Agent 实际语义）：用户手放大文件时 adapter 静默只读前 100KB 并标记 truncated。
    // 两侧行为不同但口径同值（100KB）：保存侧拒绝的正是读取侧不会完整读取的内容。
    mkdirSync(join(home, ZODY_DATA_ROOT_DIR_NAME), { recursive: true });
    writeFileSync(join(home, ZODY_DATA_ROOT_DIR_NAME, "AGENTS.md"), oversized, "utf8");
    const snapshot = await readViaAdapter(home, workspace);
    expect(snapshot.userInstructions?.truncated).toBe(true);
    expect(snapshot.userInstructions?.content).toBe("a".repeat(USER_INSTRUCTIONS_MAX_BYTES));
    expect(Buffer.byteLength(snapshot.userInstructions?.content ?? "", "utf8")).toBe(
      USER_INSTRUCTIONS_MAX_BYTES,
    );
  });
});
