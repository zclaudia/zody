import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createBuildTimeConfigDefines, resolveBuildTimeConfig } from "../build-time-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时能力全部关闭、下载页为空", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    downloadPageUrl: "",
    feedbackIssueUrl: "",
  });
});

test("私有默认配置包含 ARMS 或事件上报端点时构建失败", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    ZODY_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
  });
  await assert.rejects(
    resolveBuildTimeConfig({}, { defaultsPath }),
    /ZODY_ARMS_RUM_ENDPOINT is disabled for Zody release builds/,
  );
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZODY_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /ZODY_TELEMETRY_REPORT_ENDPOINT is disabled for Zody release builds/,
  );
});

// 构建护栏（specs/fork-official-backend-runtime-dependencies.md「自动更新」规则 4）：
// fork 尚无自有更新源，ZODY_AUTO_UPDATE 为真会让构建意外启用指向官方 manifest 的更新器，必须直接报错。
test("私有默认配置把 ZODY_AUTO_UPDATE 配为真值时直接报错", async () => {
  const defaultsPath = await writeDefaults("auto-update-defaults.json", {
    ZODY_AUTO_UPDATE: "1",
  });
  await assert.rejects(
    resolveBuildTimeConfig({}, { defaultsPath }),
    /fork-official-backend-runtime-dependencies/,
  );
});

test("环境变量 ZODY_AUTO_UPDATE=1 时直接报错并指向阶段 2 细则", async () => {
  await assert.rejects(
    resolveBuildTimeConfig({ ZODY_AUTO_UPDATE: "1" }, { defaultsPath: join(dir, "missing.json") }),
    /specs\/fork-official-backend-runtime-dependencies\.md/,
  );
});

test("私有默认遥测 endpoint 即使被环境变量置空也会 fail-fast", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    ZODY_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    ZODY_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    // defaults 里的真值被环境变量 "0" 覆盖后不再触发护栏
    ZODY_AUTO_UPDATE: "true",
  });
  await assert.rejects(
    resolveBuildTimeConfig(
      {
        ZODY_ARMS_RUM_ENDPOINT: "",
        ZODY_TELEMETRY_REPORT_ENDPOINT: "",
        ZODY_AUTO_UPDATE: "0",
      },
      { defaultsPath },
    ),
    /is disabled for Zody release builds/,
  );
});

test("ZODY_DOWNLOAD_PAGE_URL 合法 https 地址按配置返回", async () => {
  const config = await resolveBuildTimeConfig(
    { ZODY_DOWNLOAD_PAGE_URL: " https://example.com/download " },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.downloadPageUrl, "https://example.com/download");
});

test("ZODY_DOWNLOAD_PAGE_URL 非 loopback 的 http 地址构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZODY_DOWNLOAD_PAGE_URL: "http://example.com" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /仅 loopback 允许 http/,
  );
});

test("ZODY_DOWNLOAD_PAGE_URL loopback 允许 http，仅用于本机测试", async () => {
  for (const url of [
    "http://127.0.0.1:3000/download",
    "http://localhost:8080/",
    "http://[::1]:4173/download",
    "http://127.0.0.2/download",
  ]) {
    const config = await resolveBuildTimeConfig(
      { ZODY_DOWNLOAD_PAGE_URL: url },
      { defaultsPath: join(dir, "missing.json") },
    );
    assert.equal(config.downloadPageUrl, url);
  }
});

test("ZODY_DOWNLOAD_PAGE_URL 非法 URL 构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZODY_DOWNLOAD_PAGE_URL: "not a url" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /不是合法 URL/,
  );
});

// fork（F2.9）：问题反馈地址与下载页共用同一校验规则；未配置为空串，反馈入口不显示。
test("ZODY_FEEDBACK_ISSUE_URL 合法 https 地址按配置返回", async () => {
  const config = await resolveBuildTimeConfig(
    { ZODY_FEEDBACK_ISSUE_URL: " https://example.com/feedback " },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.feedbackIssueUrl, "https://example.com/feedback");
});

test("ZODY_FEEDBACK_ISSUE_URL 非 loopback 的 http 地址构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZODY_FEEDBACK_ISSUE_URL: "http://example.com/issues" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /ZODY_FEEDBACK_ISSUE_URL 必须是完整 https URL/,
  );
});

test("ZODY_FEEDBACK_ISSUE_URL loopback 允许 http，仅用于本机测试", async () => {
  const config = await resolveBuildTimeConfig(
    { ZODY_FEEDBACK_ISSUE_URL: "http://127.0.0.1:3000/issues" },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.feedbackIssueUrl, "http://127.0.0.1:3000/issues");
});

test("ZODY_FEEDBACK_ISSUE_URL 非法 URL 构建失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZODY_FEEDBACK_ISSUE_URL: "not a url" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /ZODY_FEEDBACK_ISSUE_URL 不是合法 URL/,
  );
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig({}, { defaultsPath }), /必须是 JSON 对象/);
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
      downloadPageUrl: "https://example.com/download",
      feedbackIssueUrl: "https://example.com/feedback",
    }),
    {
      __ZODY_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __ZODY_TELEMETRY_REPORT_ENDPOINT__: '""',
      __ZODY_AUTO_UPDATE_ENABLED__: "true",
      __ZODY_DOWNLOAD_PAGE_URL__: '"https://example.com/download"',
      __ZODY_FEEDBACK_ISSUE_URL__: '"https://example.com/feedback"',
    },
  );
});
