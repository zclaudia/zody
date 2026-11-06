import { describe, expect, it } from "vitest";
import {
  selectBrowserForUrl,
  selectDefaultBrowser,
  type BrowserInfo,
} from "../src/browser-client/index.js";

function info(
  id: string,
  type: BrowserInfo["type"],
  metadata?: Record<string, string>,
): BrowserInfo {
  return {
    id,
    generation: 1,
    type,
    name: id,
    capabilities: {},
    ...(metadata ? { metadata } : {}),
  };
}

describe("browser backend selection", () => {
  const iab = info("iab-1", "iab");
  const extension = info("ext-1", "extension");
  const preferredExtension = info("ext-2", "extension", { preferred: "true" });
  const cdp = info("cdp-1", "cdp");

  it("selects the default browser by backend priority", () => {
    expect(selectDefaultBrowser([cdp, extension, preferredExtension, iab])).toBe(iab);
    expect(selectDefaultBrowser([cdp, extension, preferredExtension])).toBe(preferredExtension);
    expect(selectDefaultBrowser([cdp, extension])).toBe(extension);
    expect(selectDefaultBrowser([cdp])).toBe(cdp);
    expect(selectDefaultBrowser([])).toBeUndefined();
    expect(
      selectDefaultBrowser([
        extension,
        info("ext-live", "extension", { profileIsLastUsed: "true" }),
      ])?.id,
    ).toBe("ext-live");
    expect(
      selectDefaultBrowser([extension, info("ext-first", "extension", { profileOrdering: "0" })])
        ?.id,
    ).toBe("ext-first");
  });

  it("routes localhost and file targets to IAB", () => {
    const tabs = new Map<string, string[]>();
    expect(selectBrowserForUrl([extension, iab], "http://localhost:3000", tabs)).toBe(iab);
    expect(selectBrowserForUrl([extension, iab], "file:///tmp/index.html", tabs)).toBe(iab);
  });

  it("never leaves IAB for a matching extension URL unless the extension is the explicit default", () => {
    const infos = [iab, extension, preferredExtension, cdp];
    const exact = new Map<string, string[]>([
      [iab.id, ["https://example.com/other"]],
      [extension.id, ["https://example.com/app?q=1#old"]],
      [preferredExtension.id, ["https://child.example.com/app"]],
    ]);
    expect(selectBrowserForUrl(infos, "https://example.com/app?q=1#new", exact)).toBe(iab);
    expect(
      selectBrowserForUrl(infos, "https://example.com/app?q=1#new", exact, {
        defaultBrowserId: extension.id,
      }),
    ).toBe(extension);
    // 显式默认只认具体 browserId；type 字符串不是默认身份，且不能静默迁回 IAB。
    expect(() =>
      selectBrowserForUrl(infos, "https://example.com/app?q=1#new", exact, {
        defaultBrowserId: "extension",
      }),
    ).toThrow(/Configured default browser backend 'extension' is unavailable/);
  });

  it("ranks extension tabs by exact, path, host, then host hierarchy when IAB is absent", () => {
    const infos = [extension, preferredExtension, cdp];
    const exact = new Map<string, string[]>([
      [extension.id, ["https://example.com/app?q=1#old"]],
      [preferredExtension.id, ["https://child.example.com/app"]],
    ]);
    expect(selectBrowserForUrl(infos, "https://example.com/app?q=1#new", exact)).toBe(extension);

    const hierarchy = new Map<string, string[]>([
      [extension.id, ["https://www.example.com/home"]],
      [preferredExtension.id, ["https://unrelated.test/"]],
    ]);
    expect(selectBrowserForUrl(infos, "https://example.com/path", hierarchy)).toBe(extension);
  });

  it("uses backend priority to break equal matches and parses URLs only without IAB", () => {
    const equal = new Map<string, string[]>([[preferredExtension.id, ["https://example.com/"]]]);
    expect(selectBrowserForUrl([preferredExtension, iab], "https://example.com/", equal)).toBe(iab);
    // IAB 短路不需要解析 URL；extension-only 选择仍拒绝非法目标。
    expect(selectBrowserForUrl([iab, extension], "not a url", new Map())).toBe(iab);
    expect(() => selectBrowserForUrl([extension], "not a url", new Map())).not.toThrow();
    expect(() => selectBrowserForUrl([extension, cdp], "not a url", new Map())).toThrow(
      /Invalid browser target URL/,
    );
  });

  it("does not treat single-label hosts as parent/child hostnames", () => {
    expect(
      selectBrowserForUrl(
        [cdp, extension],
        "https://x.localhost/",
        new Map([[cdp.id, ["https://localhost/"]]]),
      ),
    ).toBe(extension);
  });
});
