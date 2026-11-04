import { describe, expect, it } from "vitest";

import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

describe("Markdown artifact image references", () => {
  it("extracts only image destinations and deduplicates them", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        [
          "![first](zody-artifact://session/a)",
          "[download](zody-artifact://session/not-an-image)",
          '![again](<zody-artifact://session/a> "preview")',
          "![second](zody-artifact://session/b 'title')",
        ].join("\n"),
      ),
    ).toEqual(["zody-artifact://session/a", "zody-artifact://session/b"]);
  });

  it("does not authorize image-looking text inside fenced code", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        "```md\n![secret](zody-artifact://session/secret)\n```\n![ok](zody-artifact://session/ok)",
      ),
    ).toEqual(["zody-artifact://session/ok"]);
  });

  it("rewrites artifact image destinations to a harden-safe relative source", () => {
    const rewritten = rewriteMarkdownArtifactImageSources(
      "before ![shot](zody-artifact://session/shot-1) after",
    );
    expect(rewritten).not.toContain("zcode-artifact://");
    const source = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1];
    expect(source).toBeTruthy();
    expect(decodeMarkdownArtifactImageSource(source ?? "")).toBe("zody-artifact://session/shot-1");
  });

  it("leaves normal images, links, and fenced examples unchanged", () => {
    const markdown = [
      "![web](https://example.com/image.png)",
      "[artifact](zcode-artifact://session/file)",
      "```md",
      "![example](zcode-artifact://session/example)",
      "```",
    ].join("\n");
    expect(rewriteMarkdownArtifactImageSources(markdown)).toBe(markdown);
  });
});
