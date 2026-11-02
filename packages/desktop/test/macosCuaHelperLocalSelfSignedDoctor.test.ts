import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../../scripts/lib/cua-helper-local-cli.mjs";
import { FIXED_COMMANDS } from "../../../scripts/lib/cua-helper-local-commands.mjs";
import { parseDesignatedRequirementPolicy } from "../../../scripts/lib/cua-helper-local-profile.mjs";
import { runDoctor } from "../../../scripts/lib/cua-helper-local-result.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const BUNDLE_ID = "io.github.zclaudia.zody.cua-helper";
const EXE_NAME = "Zody Computer Use";
const EXE_BYTES = Buffer.from("zody cua helper synthetic executable\n", "utf8");
const EXE_SHA256 = createHash("sha256").update(EXE_BYTES).digest("hex");
const CERT_DER_BASE64 =
  "MIIDbTCCAlWgAwIBAgIUNMNpetkP8Z+BkyU0bBdkDp4zlZowDQYJKoZIhvcNAQELBQAwRjEqMCgGA1UEAwwhWm9keSBMb2NhbCBTZWxmIFNpZ25lZCBDVUEgSGVscGVyMRgwFgYDVQQKDA9ab2R5IExvY2FsIE9ubHkwHhcNMjYxMDI1MTY1MTA4WhcNMzYxMDIyMTY1MTA4WjBGMSowKAYDVQQDDCFab2R5IExvY2FsIFNlbGYgU2lnbmVkIENVQSBIZWxwZXIxGDAWBgNVBAoMD1pvZHkgTG9jYWwgT25seTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJ69/2uYRIXKiJMpz3HfjvVpqRzG9ULSUDd/tn/F3clBbYhplDg3urBPvDyn0v7KHMK1CTXvujU+XlsaLqloQ0b1pVR6XYuPDy8ZpVKjna3OGA2C4ZBHnn8RPcqT9mPnlxNzKn1JZ1HKyT7a7JFsOY9daM7BAXxXiMKYXKHd7SpLx1cmInPGjOX4M+iPsIpY04ioFt6FcPwcM2qZvWPVCB3JTuKKimGQaeLhqNo2nDHMxHMxk+HG98pCP1MCJIWtQgxm3D2twesDUMyajTHhYAbH3++lIl5Je2l3IfBl8rQVPUdO1kNzV9DkY1SKxUkh0yvuHDuSwTTy7RHbY+sl7xcCAwEAAaNTMFEwHQYDVR0OBBYEFPBIMJ3TxS8JgyMOx4iRDPEBr8tiMB8GA1UdIwQYMBaAFPBIMJ3TxS8JgyMOx4iRDPEBr8tiMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAJl7TDg8kiVDqMeA8zfS6EjTiXX0ohSJt6nztnQ8q6H3O148NtGXaPe3H6jG4/a9qt+jaDA8OL/fgC9ltx65rax+ZGZq/NWijH0e76LGN+okL2aYZ6II5eUIGtuZZounn+X7Jewl69t5zkWPx1tDl3DNqnTnxBn9g+3cYk3+AN3uiKm0A7XGzEFYVeSMzQrGVrt9hROG3RGU0JT2FhdORUE26UHcToFlJJ+Jxiekmk5TrAlf6uE0KFYfpQAElCaFVdh8KQDRSa/J3TLiDrgECExy+N/NHYyuQ9lO6LZGj4/ZrFfQb9Ec2gIEihr24Np6NQoq3q/tXpZmMsF5a2Wqwhc=";
const CERT_SHA1 = "90897774dee7e1cc146ec8525d0c72f8c4639697";
const CERT_SHA256 = "b689199b229778b300b8047fe6e472a54d5268ced02bc5b6bee14169483ab5de";
const DR = `identifier "${BUNDLE_ID}" and certificate leaf = H"${CERT_SHA1}"`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    profile: "local-self-signed",
    bundleId: BUNDLE_ID,
    executableName: EXE_NAME,
    bundleShortVersion: "0.1.0",
    bundleVersion: "1",
    architectures: ["arm64", "x86_64"],
    minimumMacOSVersion: "13.0",
    leafCertificateSha256: CERT_SHA256,
    designatedRequirement: DR,
    executableSha256: EXE_SHA256,
    entitlements: {},
    ...overrides,
  };
}

async function createFixture({
  appName = "Zody Computer Use.app",
  profileOverrides = {},
  infoOverrides = {},
  executableBytes = EXE_BYTES,
}: {
  appName?: string;
  profileOverrides?: Record<string, unknown>;
  infoOverrides?: Record<string, unknown>;
  executableBytes?: Buffer;
} = {}) {
  const root = await makeTempDir("zody-cua-helper-doctor-test-");
  const appPath = join(root, appName);
  const contents = join(appPath, "Contents");
  const macOS = join(contents, "MacOS");
  await mkdir(macOS, { recursive: true });
  const info = {
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleExecutable: EXE_NAME,
    CFBundleShortVersionString: "0.1.0",
    CFBundleVersion: "1",
    ...infoOverrides,
  };
  const executableName = String(info.CFBundleExecutable);
  const executablePath = join(macOS, executableName);
  await writeFile(executablePath, executableBytes, { mode: 0o755 });
  await chmod(executablePath, 0o755);
  await writeFile(join(contents, "Info.plist"), "<plist/>", "utf8");
  const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
  const profile = makeProfile({
    executableSha256,
    ...profileOverrides,
  });
  const profilePath = join(root, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");
  return { root, appPath, profilePath, profile, info, executablePath, executableSha256 };
}

function otoolOutput(
  minosByArchitecture: Record<string, string> = { arm64: "13.0", x86_64: "13.0" },
) {
  return Object.entries(minosByArchitecture)
    .map(([architecture, minos]) =>
      [
        `fixture (architecture ${architecture}):`,
        "Load command 0",
        "      cmd LC_BUILD_VERSION",
        "  cmdsize 32",
        " platform 1",
        `    minos ${minos}`,
        "      sdk 15.0",
        "   ntools 1",
        "     tool 3",
        "  version 23.0",
      ].join("\n"),
    )
    .join("\n");
}

type FakeOverrides = {
  verifyOk?: boolean;
  drVerifyOk?: boolean;
  adhoc?: boolean;
  authorities?: string[];
  teamIdentifier?: string;
  certDer?: Buffer | null;
  certExtractOk?: boolean;
  actualDr?: string;
  entitlements?: Record<string, unknown>;
  entitlementsXml?: string;
  entitlementsJson?: string;
  entitlementsPlistError?: boolean;
  lipoOut?: string;
  otoolOut?: string;
  infoPlist?: Record<string, unknown>;
  missing?: Set<string>;
};

function createFakeAdapter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: FakeOverrides = {},
) {
  const state = {
    verifyOk: true,
    drVerifyOk: true,
    adhoc: false,
    authorities: ["Zody Local Self Signed CUA Helper"],
    teamIdentifier: "not set",
    certDer: Buffer.from(CERT_DER_BASE64, "base64"),
    certExtractOk: true,
    actualDr: fixture.profile.designatedRequirement,
    entitlements: {} as Record<string, unknown>,
    entitlementsXml: undefined as string | undefined,
    entitlementsJson: undefined as string | undefined,
    entitlementsPlistError: false,
    lipoOut: "arm64 x86_64\n",
    otoolOut: otoolOutput(),
    infoPlist: fixture.info,
    missing: new Set<string>(),
    ...overrides,
  };
  const calls: string[][] = [];
  const ok = (stdout = "", stderr = "") => ({ status: "ok", exitCode: 0, stdout, stderr });
  const failed = (stderr: string) => ({ status: "failed", exitCode: 1, stdout: "", stderr });

  const adapter = {
    async run(command: string, args: string[]) {
      calls.push([command, ...args]);
      if (state.missing.has(command)) {
        return {
          status: "missing",
          exitCode: null,
          stdout: "",
          stderr: "",
          message: `missing ${command}`,
        };
      }
      if (command === FIXED_COMMANDS.plutil) {
        const target = args[args.length - 1];
        if (target.endsWith("Info.plist")) {
          return ok(JSON.stringify(state.infoPlist));
        }
        if (target.endsWith("entitlements.plist")) {
          if (state.entitlementsPlistError) {
            return failed("plutil rejected entitlements");
          }
          return ok(state.entitlementsJson ?? JSON.stringify(state.entitlements));
        }
        return failed(`unexpected plutil target ${target}`);
      }
      if (command === FIXED_COMMANDS.lipo) {
        return ok(state.lipoOut);
      }
      if (command === FIXED_COMMANDS.otool) {
        return ok(state.otoolOut);
      }
      if (command === FIXED_COMMANDS.codesign) {
        if (args[0] === "--verify" && args.some((argument) => argument.startsWith("-R="))) {
          return state.drVerifyOk ? ok() : failed("requirement not satisfied");
        }
        if (args[0] === "--verify") {
          return state.verifyOk ? ok() : failed("codesign verify rejected");
        }
        if (args[0] === "-d" && args.includes("--verbose=4")) {
          const lines = [`Executable=${fixture.executablePath}`];
          if (state.adhoc) {
            lines.push("Signature=adhoc");
          } else {
            for (const authority of state.authorities) {
              lines.push(`Authority=${authority}`);
            }
          }
          lines.push(`TeamIdentifier=${state.teamIdentifier}`);
          return ok("", `${lines.join("\n")}\n`);
        }
        if (args[0] === "-d" && args.includes("-r-")) {
          return ok("", `Executable=${fixture.executablePath}\ndesignated => ${state.actualDr}\n`);
        }
        if (args[0] === "-d" && args[1] === "--extract-certificates") {
          return failed("separate --extract-certificates prefix is not the supported syntax");
        }
        if (
          args[0] === "-d" &&
          args.some((argument) => argument.startsWith("--extract-certificates="))
        ) {
          if (!state.certExtractOk) {
            return failed("certificate extraction rejected");
          }
          const prefix = args
            .find((argument) => argument.startsWith("--extract-certificates="))!
            .slice("--extract-certificates=".length);
          if (state.certDer) {
            await writeFile(`${prefix}0`, state.certDer, { mode: 0o600 });
          }
          return ok();
        }
        if (args[0] === "-d" && args.includes("--entitlements")) {
          const xml =
            state.entitlementsXml ??
            (Object.keys(state.entitlements).length > 0 ? "<plist><dict/></plist>" : "");
          return ok(xml, "warning: codesign diagnostics stay on stderr\n");
        }
      }
      return failed(`unexpected command ${command}`);
    },
  };
  return { adapter, calls, state };
}

async function runFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: FakeOverrides = {},
) {
  const fake = createFakeAdapter(fixture, overrides);
  const result = await runDoctor({
    appPath: fixture.appPath,
    profilePath: fixture.profilePath,
    adapter: fake.adapter,
    platform: "darwin",
  });
  return { result, ...fake };
}

function getCheck(result: any, id: string) {
  const check = result.checks.find((entry: any) => entry.id === id);
  expect(check, `missing check ${id}`).toBeTruthy();
  return check;
}

describe("macOS CUA Helper local-self-signed doctor", () => {
  it("非 macOS 返回 blocked 且不调用任何命令", async () => {
    let called = false;
    const result = await runDoctor({
      appPath: "/tmp/Helper.app",
      profilePath: "/tmp/profile.json",
      platform: "linux",
      adapter: {
        async run() {
          called = true;
          throw new Error("must not run");
        },
      },
    });
    expect(result.status).toBe("blocked");
    expect(getCheck(result, "platform.macos").status).toBe("blocked");
    expect(called).toBe(false);
  });

  it("示例 profile 使用 canonical bundle id 且空待填项必须 blocked", async () => {
    const example = JSON.parse(
      await readFile(join(REPO_ROOT, "config/cua-helper-local-self-signed.example.json"), "utf8"),
    );
    expect(example.bundleId).toBe(BUNDLE_ID);
    expect(example.bundleId).not.toContain("dev.zcode");
    expect(example.entitlements).toEqual({});
    expect(example.leafCertificateSha256).toBe("");
    expect(example.executableSha256).toBe("");
    expect(example.designatedRequirement).toBe("");
    expect(example.minimumMacOSVersion).toBe("");

    const fixture = await createFixture();
    await writeFile(fixture.profilePath, JSON.stringify(example, null, 2), "utf8");
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("blocked");
    expect(getCheck(result, "profile.required-values").status).toBe("blocked");
    expect(getCheck(result, "app.bundle-identity").status).toBe("blocked");
    expect(getCheck(result, "signature.leaf-sha256").status).toBe("blocked");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("blocked");
    expect(getCheck(result, "binary.minimum-macos").status).toBe("blocked");
    expect(getCheck(result, "binary.executable-sha256").status).toBe("blocked");
  });

  it("完整合成 fixture 通过，真实命令走固定 /usr/bin 路径并清理临时证书目录", async () => {
    const fixture = await createFixture();
    const { result, calls } = await runFixture(fixture);
    expect(result.status).toBe("pass");
    expect(result.summary).toEqual({ pass: expect.any(Number), fail: 0, blocked: 0 });
    expect(calls.every((call) => call[0].startsWith("/usr/bin/"))).toBe(true);
    expect(FIXED_COMMANDS).toEqual({
      codesign: "/usr/bin/codesign",
      lipo: "/usr/bin/lipo",
      otool: "/usr/bin/otool",
      plutil: "/usr/bin/plutil",
    });

    const lines = calls.map((call) => call.join(" "));
    const resolvedExecutablePath = await realpath(fixture.executablePath);
    expect(lines).toContain(
      `${FIXED_COMMANDS.codesign} --verify --deep --strict --verbose=2 ${fixture.appPath}`,
    );
    expect(lines).toContain(
      `${FIXED_COMMANDS.codesign} --verify --strict -R=${DR} ${fixture.appPath}`,
    );
    expect(lines).toContain(`${FIXED_COMMANDS.lipo} -archs ${resolvedExecutablePath}`);
    expect(lines).toContain(`${FIXED_COMMANDS.otool} -arch all -l ${resolvedExecutablePath}`);

    const certCall = calls.find(
      (call) =>
        call[0] === FIXED_COMMANDS.codesign &&
        call[1] === "-d" &&
        call[2].startsWith("--extract-certificates="),
    );
    expect(certCall).toBeTruthy();
    expect(certCall![3]).toBe(fixture.appPath);
    const certPrefix = certCall![2].slice("--extract-certificates=".length);
    expect(existsSync(dirname(certPrefix))).toBe(false);
    expect(getCheck(result, "doctor.cleanup").status).toBe("pass");
    expect(getCheck(result, "signature.authority").details.teamIdentifier).toBe("not set");
    expect(getCheck(result, "signature.designated-requirement").details.certificateSha1).toBe(
      CERT_SHA1,
    );
  });

  it("真实 codesign 布局：display/DR 在 stderr，entitlements 在 stdout", async () => {
    const entitlements = { "com.apple.security.network.client": true };
    const fixture = await createFixture({ profileOverrides: { entitlements } });
    const { result } = await runFixture(fixture, { entitlements, entitlementsXml: "<plist/>" });
    expect(result.status).toBe("pass");
    expect(getCheck(result, "signature.authority").status).toBe("pass");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("pass");
    expect(getCheck(result, "signature.entitlements").status).toBe("pass");
  });

  it("ad-hoc 签名失败而不是自签名通过", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, { adhoc: true, authorities: [], certDer: null });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.authority").status).toBe("fail");
    expect(getCheck(result, "signature.leaf-certificate").status).toBe("fail");
  });

  it("证书叶 SHA-256 不匹配失败", async () => {
    const fixture = await createFixture({
      profileOverrides: { leafCertificateSha256: "0".repeat(64) },
    });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.leaf-sha256").status).toBe("fail");
  });

  it("DR 的 -R= 验证失败时失败", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, {
      drVerifyOk: false,
      actualDr: `identifier "${BUNDLE_ID}" and certificate leaf = H"${"0".repeat(40)}"`,
    });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("fail");
  });

  it("DR 语法正确但 40 位 SHA-1 与实际证书叶不一致时失败", async () => {
    const fixture = await createFixture({
      profileOverrides: {
        designatedRequirement: `identifier "${BUNDLE_ID}" and certificate leaf = H"${"0".repeat(40)}"`,
      },
    });
    const { result, calls } = await runFixture(fixture, { drVerifyOk: true });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("fail");
    expect(calls.some((call) => call.some((argument) => argument.startsWith("-R=")))).toBe(false);
  });

  it.each([
    `identifier "${BUNDLE_ID}"`,
    `cdhash H"35d594ff563992e91b0cf727f1aa77bd5fb1e7f9"`,
    `identifier "${BUNDLE_ID}" and certificate leaf = H"${"0".repeat(40)}"`,
  ])("artifact 内嵌 DR 不是窄身份约束时失败: %s", async (actualDr) => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, { actualDr, drVerifyOk: true });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("fail");
  });

  it("artifact 内嵌 DR 与 profile 窄语法等价时通过", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, {
      actualDr: `identifier   "${BUNDLE_ID}"   and   certificate   leaf = H"${CERT_SHA1}"`,
      drVerifyOk: true,
    });
    expect(result.status).toBe("pass");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("pass");
  });

  it.each([
    `identifier "${BUNDLE_ID}" or certificate leaf = H"${CERT_SHA1}"`,
    `true or identifier "${BUNDLE_ID}" and certificate leaf = H"${CERT_SHA1}"`,
    `identifier "${BUNDLE_ID}" and certificate leaf = H"${CERT_SHA1}" and anchor apple`,
    `identifier "io.github.zclaudia.other" and certificate leaf = H"${CERT_SHA1}"`,
  ])("拒绝 DR 绕过语法: %s", async (designatedRequirement) => {
    const fixture = await createFixture({ profileOverrides: { designatedRequirement } });
    const { result } = await runFixture(fixture, { drVerifyOk: true });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "profile.identity-policy").status).toBe("fail");
    expect(getCheck(result, "signature.designated-requirement").status).toBe("fail");
  });

  it.each([
    ["CFBundleIdentifier", "dev.zcode.cua-helper"],
    ["CFBundleExecutable", "Other Helper"],
    ["CFBundleShortVersionString", "9.9.9"],
    ["CFBundleVersion", "999"],
  ])("Info.plist %s 不一致失败", async (field, value) => {
    const fixture = await createFixture({ infoOverrides: { [field]: value } });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "app.bundle-identity").status).toBe("fail");
  });

  it("架构集合不一致失败", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, { lipoOut: "arm64\n" });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "binary.architectures").status).toBe("fail");
  });

  it("每架构最低 macOS 不一致失败", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, {
      otoolOut: otoolOutput({ arm64: "12.0", x86_64: "13.0" }),
    });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "binary.minimum-macos").status).toBe("fail");
  });

  it("executable SHA-256 不一致失败", async () => {
    const fixture = await createFixture({ profileOverrides: { executableSha256: "0".repeat(64) } });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "binary.executable-sha256").status).toBe("fail");
  });

  it("旧 Node JIT/宽 entitlements 对空静态 Rust profile 失败", async () => {
    const fixture = await createFixture();
    const entitlements = {
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.cs.disable-library-validation": true,
    };
    const { result } = await runFixture(fixture, { entitlements, entitlementsXml: "<plist/>" });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "signature.entitlements").status).toBe("fail");
    expect(getCheck(result, "signature.entitlements-policy").status).toBe("fail");
  });

  it("profile 显式冻结禁止 entitlements 仍然失败", async () => {
    const entitlements = { "com.apple.security.cs.disable-library-validation": true };
    const fixture = await createFixture({ profileOverrides: { entitlements } });
    const { result } = await runFixture(fixture, { entitlements, entitlementsXml: "<plist/>" });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "profile.identity-policy").status).toBe("fail");
    expect(getCheck(result, "signature.entitlements").status).toBe("pass");
    expect(getCheck(result, "signature.entitlements-policy").status).toBe("fail");
  });

  it("必需工具缺失返回 blocked，不是 fail", async () => {
    const fixture = await createFixture();
    const { result } = await runFixture(fixture, {
      missing: new Set([FIXED_COMMANDS.codesign]),
    });
    expect(result.status).toBe("blocked");
    expect(getCheck(result, "signature.verify").status).toBe("blocked");
  });

  it("缺失 .app 返回 blocked 且不执行命令", async () => {
    const fixture = await createFixture();
    const fake = createFakeAdapter(fixture);
    const result = await runDoctor({
      appPath: join(fixture.root, "Missing Helper.app"),
      profilePath: fixture.profilePath,
      adapter: fake.adapter,
      platform: "darwin",
    });
    expect(result.status).toBe("blocked");
    expect(getCheck(result, "app.bundle").status).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("profile 的 teamId 字段失败，不假装自签名有 Apple Team", async () => {
    const fixture = await createFixture({ profileOverrides: { teamId: "TEAM123" } });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    const schemaCheck = getCheck(result, "profile.schema");
    expect(schemaCheck.status).toBe("fail");
    expect(JSON.stringify(schemaCheck.details)).toContain("Team ID");
  });

  it("executable symlink 逃出 .app 时失败", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-helper");
    await writeFile(outside, EXE_BYTES, { mode: 0o755 });
    await rm(fixture.executablePath);
    await symlink(outside, fixture.executablePath);
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "app.executable").status).toBe("fail");
  });

  it("版本号超过 Number.MAX_SAFE_INTEGER 失败", async () => {
    const fixture = await createFixture({
      profileOverrides: { bundleVersion: "9007199254740992" },
    });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "profile.schema").status).toBe("fail");
  });

  it("超大 profile 失败，不解析无界输入", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.profilePath, `{"pad":"${"a".repeat(1024 * 1024)}"}`, "utf8");
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "profile.file").status).toBe("fail");
  });

  it("过深 entitlements 失败而不递归溢出", async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 40; index += 1) {
      deep = { nested: deep };
    }
    const fixture = await createFixture({ profileOverrides: { entitlements: deep } });
    const { result } = await runFixture(fixture);
    expect(result.status).toBe("fail");
    expect(getCheck(result, "profile.schema").status).toBe("fail");
  });

  it("含 shell 元字符的 app 路径作为单个 argv 传递", async () => {
    const fixture = await createFixture({ appName: "Zody $(touch PWNED).app" });
    const { result, calls } = await runFixture(fixture);
    expect(result.status).toBe("pass");
    expect(calls.some((call) => call.includes(fixture.appPath))).toBe(true);
    expect(existsSync(join(fixture.root, "PWNED"))).toBe(false);
    const source = await readFile(
      join(REPO_ROOT, "scripts/lib/cua-helper-local-commands.mjs"),
      "utf8",
    );
    expect(source).toContain("execFile");
    expect(source).not.toMatch(/shell:\s*true/u);
    expect(source).not.toMatch(/\bexec\(/u);
  });

  it("相对 --app 路径按 input.arguments 失败", async () => {
    const fixture = await createFixture();
    const fake = createFakeAdapter(fixture);
    const result = await runDoctor({
      appPath: "relative/Zody Computer Use.app",
      profilePath: fixture.profilePath,
      adapter: fake.adapter,
      platform: "darwin",
    });
    expect(result.status).toBe("fail");
    expect(getCheck(result, "input.arguments").status).toBe("fail");
  });

  it("CLI 显式 --app --profile --json 输出结构化 JSON，缺参与非 macOS 退出码正确", async () => {
    const fixture = await createFixture();
    const fake = createFakeAdapter(fixture);
    const capture = () => {
      let output = "";
      return {
        stream: {
          write(chunk: string) {
            output += chunk;
            return true;
          },
        },
        read() {
          return output;
        },
      };
    };

    const success = capture();
    const successExit = await runCli(
      ["--app", fixture.appPath, "--profile", fixture.profilePath, "--json"],
      { stdout: success.stream as any, adapter: fake.adapter, platform: "darwin" },
    );
    expect(successExit).toBe(0);
    const successResult = JSON.parse(success.read());
    expect(successResult.status).toBe("pass");
    expect(successResult.kind).toBe("macos-cua-helper-local-doctor");

    const missing = capture();
    const missingExit = await runCli(["--json"], {
      stdout: missing.stream as any,
      platform: "darwin",
    });
    expect(missingExit).toBe(1);
    expect(JSON.parse(missing.read()).status).toBe("fail");

    const nonMac = capture();
    const nonMacExit = await runCli(
      ["--app", fixture.appPath, "--profile", fixture.profilePath, "--json"],
      { stdout: nonMac.stream as any, adapter: fake.adapter, platform: "linux" },
    );
    expect(nonMacExit).toBe(2);
    expect(JSON.parse(nonMac.read()).status).toBe("blocked");
  });

  it("DR policy 解析器只接受窄语法", () => {
    expect(parseDesignatedRequirementPolicy(DR, BUNDLE_ID)).toMatchObject({
      ok: true,
      identifier: BUNDLE_ID,
      certificateSha1: CERT_SHA1,
    });
    expect(parseDesignatedRequirementPolicy(`true or ${DR}`, BUNDLE_ID).ok).toBe(false);
    expect(
      parseDesignatedRequirementPolicy(
        `identifier "io.github.zclaudia.other" and certificate leaf = H"${CERT_SHA1}"`,
        BUNDLE_ID,
      ).ok,
    ).toBe(false);
  });
});
