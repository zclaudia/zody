import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listMobileDirectoryEntries,
  MOBILE_DIRECTORY_LISTING_MAX_ENTRIES,
} from "../src/main/remote-access/mobileDirectoryListing.js";

/** 第二批 E3：Main 侧目录列表的边界与错误分类（真实临时目录）。 */
describe("listMobileDirectoryEntries", () => {
  it("path 省略时列出 homedir；resolvedPath 回填绝对路径", async () => {
    const result = await listMobileDirectoryEntries();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(homedir());
      expect(Array.isArray(result.entries)).toBe(true);
    }
  });

  it("相对路径回 path-invalid", async () => {
    await expect(listMobileDirectoryEntries("relative/path")).resolves.toEqual({
      ok: false,
      error: "path-invalid",
    });
  });

  it("不存在的路径回 not-found；文件路径回 not-directory", async () => {
    await expect(
      listMobileDirectoryEntries("/nonexistent-zody-mobile-listing"),
    ).resolves.toEqual({ ok: false, error: "not-found" });

    const base = await mkdtemp(join(tmpdir(), "zody-listing-"));
    const file = join(base, "file.txt");
    await writeFile(file, "x", "utf8");
    await expect(listMobileDirectoryEntries(file)).resolves.toEqual({
      ok: false,
      error: "not-directory",
    });
  });

  it("只收录目录、符号链接跟随目标、按码点排序并给出 parentPath", async () => {
    const base = await mkdtemp(join(tmpdir(), "zody-listing-"));
    await mkdir(join(base, "beta"));
    await mkdir(join(base, "Alpha"));
    await writeFile(join(base, "note.txt"), "x", "utf8");
    await symlink(join(base, "beta"), join(base, "zlink"));

    const result = await listMobileDirectoryEntries(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.name)).toEqual(["Alpha", "beta", "zlink"]);
    const link = result.entries.find((entry) => entry.name === "zlink");
    expect(link?.isSymbolicLink).toBe(true);
    expect(result.parentPath).toBe(join(base, ".."));
  });

  it("目录条目超过上限时回 too-large，不截断伪称完整", async () => {
    const base = await mkdtemp(join(tmpdir(), "zody-listing-"));
    // 上限检查在读取第 MAX+1 项时触发；只创建 MAX+1 个目录成本可控（无嵌套）。
    await Promise.all(
      Array.from({ length: MOBILE_DIRECTORY_LISTING_MAX_ENTRIES + 1 }, (_, index) =>
        mkdir(join(base, `d${String(index).padStart(5, "0")}`)),
      ),
    );
    await expect(listMobileDirectoryEntries(base)).resolves.toEqual({
      ok: false,
      error: "too-large",
    });
  });
});
