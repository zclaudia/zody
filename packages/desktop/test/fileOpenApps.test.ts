import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileApplicationTarget } from "@zody/shared";
import {
  applyWindowsDefaultAssociation,
  type WindowsFileApplication,
} from "../src/main/file-open-apps/windows-default.js";
import {
  normalizeWindowsIconDataUrl,
  resolveWindowsAssociationIcon,
} from "../src/main/file-open-apps/windows-icon.js";
import { createFileApplicationService } from "../src/main/file-open-apps/index.js";
import type {
  FileApplicationNativeAdapter,
  NativeFileApplication,
} from "../src/main/file-open-apps/contract.js";

// F16 file-open-apps（upstream v3.17.1，来源 SHA a60ba6a7）：系统关联为唯一事实源；
// 产品规则见 docs/ui/file-open-apps.md。这里用可注入的 fake 原生适配器验证服务层
// 合同：失败关闭、去重排序、id 稳定与打开时重查匹配。
let caseRoot: string | null = null;

async function localFile(name = "target.docx"): Promise<string> {
  caseRoot ??= await mkdtemp(join(tmpdir(), "zody-file-open-apps-"));
  const path = join(caseRoot, name);
  await writeFile(path, "F16");
  return path;
}

afterEach(async () => {
  if (caseRoot) await rm(caseRoot, { recursive: true, force: true });
  caseRoot = null;
});

function fakeAdapter(applications: NativeFileApplication[]) {
  const query = vi.fn(async () => applications.map((app) => ({ ...app })));
  const open = vi.fn(async () => undefined);
  const adapter: FileApplicationNativeAdapter = { query, open };
  return { adapter, query, open };
}

function serviceWith(
  adapter: FileApplicationNativeAdapter,
  options: { logger?: { warn: (...args: unknown[]) => void } } = {},
) {
  return createFileApplicationService({ adapter, ...options });
}

describe("createFileApplicationService 失败关闭边界", () => {
  it.each([
    [
      "远端身份 workspaceIdentity",
      (path: string): FileApplicationTarget => ({
        path,
        pathKind: "file",
        workspaceIdentity: "ws-1",
      }),
    ],
    [
      "远端 remoteTarget",
      (path: string): FileApplicationTarget => ({
        path,
        pathKind: "file",
        remoteTarget: { kind: "ssh", host: "h", username: "u" } as never,
      }),
    ],
    ["目录 pathKind", (path: string): FileApplicationTarget => ({ path, pathKind: "directory" })],
    ["相对路径", (): FileApplicationTarget => ({ path: "relative/report.docx", pathKind: "file" })],
    [
      "不存在的本机路径",
      (): FileApplicationTarget => ({ path: "/definitely/not/existing.docx", pathKind: "file" }),
    ],
  ])("非法目标（%s）返回空列表且不触发原生查询", async (_name, build) => {
    const path = await localFile();
    const { adapter, query } = fakeAdapter([
      { key: "/Applications/A.app", name: "A", isDefault: true },
    ]);
    const service = serviceWith(adapter);
    await expect(service.getFileApplications(build(path))).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("系统查询抛错按失败关闭返回空列表", async () => {
    const path = await localFile();
    const adapter: FileApplicationNativeAdapter = {
      query: vi.fn(async () => {
        throw new Error("boom");
      }),
      open: vi.fn(),
    };
    const logger = { warn: vi.fn() };
    const service = serviceWith(adapter, { logger });
    await expect(service.getFileApplications({ path, pathKind: "file" })).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("createFileApplicationService 查询去重与排序", () => {
  it("同身份多安装副本只保留一条且默认项在前，id 跨查询稳定", async () => {
    const path = await localFile();
    const { adapter } = fakeAdapter([
      {
        key: "/Applications/Chromium.app",
        name: "Chromium",
        isDefault: false,
        identity: "darwin-bundle:org.chromium",
      },
      {
        key: "/Users/u/Applications/Chromium.app",
        name: "Chromium",
        isDefault: false,
        identity: "darwin-bundle:org.chromium",
      },
      {
        key: "/Applications/WPS.app",
        name: "WPS Office",
        isDefault: true,
        identity: "darwin-bundle:cn.wps",
      },
    ]);
    const service = serviceWith(adapter);
    const first = await service.getFileApplications({ path, pathKind: "file" });
    expect(first.map((app) => app.name)).toEqual(["WPS Office", "Chromium"]);
    expect(first[0]!.isDefault).toBe(true);
    expect(first[1]!.isDefault).toBe(false);
    // id 是宿主摘要：同一 key 跨查询得到同一 id，菜单项与打开时匹配的是同一实例。
    const second = await service.getFileApplications({ path, pathKind: "file" });
    expect(second.map((app) => app.id)).toEqual(first.map((app) => app.id));
    expect(first[0]!.id).toMatch(/^file-app:[0-9a-f]{64}$/);
  });

  it("显示名重复时追加身份消歧", async () => {
    const path = await localFile();
    const { adapter } = fakeAdapter([
      {
        key: "/Applications/Twin.app",
        name: "Twin",
        isDefault: false,
        identity: "darwin-bundle:a",
      },
      {
        key: "/Users/u/Applications/Twin.app",
        name: "Twin",
        isDefault: false,
        identity: "darwin-bundle:b",
      },
    ]);
    const service = serviceWith(adapter);
    const apps = await service.getFileApplications({ path, pathKind: "file" });
    expect(apps.map((app) => app.name).some((name) => name.includes("("))).toBe(true);
  });
});

describe("createFileApplicationService 打开时重查匹配", () => {
  it("按 id 匹配当前关联并启动；打开查询不取图标", async () => {
    const path = await localFile();
    const { adapter, query, open } = fakeAdapter([
      {
        key: "/Applications/WPS.app",
        name: "WPS Office",
        isDefault: true,
        identity: "darwin-bundle:cn.wps",
      },
    ]);
    const service = serviceWith(adapter);
    const [app] = await service.getFileApplications({ path, pathKind: "file" });
    query.mockClear();
    const result = await service.openFileWithApplication(app!.id, { path, pathKind: "file" });
    expect(result).toEqual({ success: true });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ key: "/Applications/WPS.app" }),
      path,
    );
    // 打开链路不把图标解码耗时/失败引入（SHA a60ba6a7）。
    expect(query).toHaveBeenCalledWith(path, { includeIcons: false });
  });

  it("id 失配（应用已卸载/默认变更）不执行旧命令", async () => {
    const path = await localFile();
    const { adapter, open } = fakeAdapter([
      {
        key: "/Applications/WPS.app",
        name: "WPS Office",
        isDefault: true,
        identity: "darwin-bundle:cn.wps",
      },
    ]);
    const service = serviceWith(adapter);
    await expect(
      service.openFileWithApplication("file-app:unknown", { path, pathKind: "file" }),
    ).resolves.toEqual({ success: false, error: "application_not_available" });
    expect(open).not.toHaveBeenCalled();
  });

  it("非法目标打开直接拒绝", async () => {
    const path = await localFile();
    const { adapter, open } = fakeAdapter([
      { key: "/Applications/WPS.app", name: "WPS Office", isDefault: true },
    ]);
    const service = serviceWith(adapter);
    await expect(
      service.openFileWithApplication("file-app:any", {
        path,
        pathKind: "file",
        workspaceIdentity: "ws-1",
      }),
    ).resolves.toEqual({ success: false, error: "unsupported_file_target" });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("Windows 默认关联与图标身份", () => {
  it("只用 Shell 生效默认身份标记默认项，无法唯一确认时不标", () => {
    const apps: WindowsFileApplication[] = [
      {
        key: "C:\\Program Files\\A\\a.exe",
        name: "A",
        isDefault: true,
        progId: "A.x",
        appId: "A.1",
      },
      {
        key: "C:\\Program Files\\B\\b.exe",
        name: "B",
        isDefault: false,
        progId: "B.y",
        appId: "B.2",
      },
    ];
    const marked = applyWindowsDefaultAssociation(apps, {
      progId: "B.Y",
      appId: "",
      executable: "",
    });
    expect(marked.map((app) => app.isDefault)).toEqual([false, true]);
    // 无关联信息时不借用旧标记或同名应用。
    const untouched = applyWindowsDefaultAssociation(apps, null);
    expect(untouched.every((app) => app.isDefault === false)).toBe(true);
  });

  it("WPS 套件优先独立套件图标，普通 handler 图标必须过 PNG 结构校验", () => {
    const suite = resolveWindowsAssociationIcon({
      key: "C:\\Program Files\\Kingsoft\\wps-office\\office6\\wps.exe",
      name: "WPS Office",
      isDefault: true,
      appId: "Kingsoft.Office.KPrometheus",
      suiteIconPath: "C:\\Program Files\\Kingsoft\\suite\\wps.exe",
      suiteIconDataUrl: "data:image/png;base64,not-png",
    });
    // 套件图标数据非法时保持无图，不回退 Writer 图标冒充套件入口。
    expect(suite.iconDataUrl).toBeNull();
    expect(normalizeWindowsIconDataUrl("data:image/png;base64,!!!")).toBeNull();
    expect(normalizeWindowsIconDataUrl("https://example.com/icon.png")).toBeNull();
  });
});
