import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { arch as readOsArch, release as readOsRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderEndpointRoutingSourceHeaders } from "../src/provider-endpoint-routing-source-headers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("createProviderEndpointRoutingSourceHeaders", () => {
  it("adds runtime attribution and never emits device or source identity headers", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-source-headers-"),
    );
    tempDirs.push(dataBaseDir);
    const stateDir = join(dataBaseDir, ".zcode", "v2");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "mid-routing-1" }),
      "utf8",
    );

    const headers = await createProviderEndpointRoutingSourceHeaders({
      appVersion: "1.2.3",
      env: {
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_ENV: "test",
        ZCODE_TEST_BASE_URL: "https://routing-config.example.test",
      },
      sourceTitle: "electron",
    });

    expect(headers).toMatchObject({
      "User-Agent": "ZCode/1.2.3",
      "X-Client-Language": expect.any(String),
      "X-Client-Timezone": expect.any(String),
      "X-Os-Category": osCategory(process.platform),
      "X-Os-Version": readOsRelease(),
      "X-Platform": `${process.platform}-${readOsArch()}`,
      "X-Release-Channel": "test",
      "X-ZCode-App-Version": "1.2.3",
    });
    // F2.10：设备标识与来源标识停发——即使 telemetry-state.json 里有 deviceMid 也不发送。
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("HTTP-Referer");
    expect(headers).not.toHaveProperty("X-Title");
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("defaults to CLI attribution and does not create a missing device identity", async () => {
    const dataBaseDir = await mkdtemp(
      join(tmpdir(), "zcode-routing-no-device-mid-"),
    );
    tempDirs.push(dataBaseDir);

    const headers = await createProviderEndpointRoutingSourceHeaders({
      env: {
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_ENV: "production",
        ZCODE_APP_VERSION: "2.0.0",
      },
    });

    expect(headers).toMatchObject({
      "User-Agent": "ZCode/2.0.0",
      "X-Release-Channel": "production",
    });
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("HTTP-Referer");
    expect(headers).not.toHaveProperty("X-Title");
  });
});

function osCategory(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}
