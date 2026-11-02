import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { sha256Buffer } from "./cua-driver-closure-core.mjs";

const MAX_MATERIAL_BYTES = 2 * 1024 * 1024;
// 代码/配置文件的文件名可能以 copying/license 开头（例如 copying.rs、
// copyrights.yml）。这里按扩展名先排除，避免把实现文件误当许可正文。
const REJECTED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".go",
  ".h",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".m",
  ".mdx",
  ".py",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
]);
const LICENSE_NAME = /^(?:license|licence)(?:[-._][a-z0-9][a-z0-9._+-]*)?$/i;
const NOTICE_NAME = /^(?:copying|copyright|notice|unlicense)(?:[-._][a-z0-9][a-z0-9._+-]*)?$/i;

function has(text, value) {
  return text
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ")
    .includes(value);
}

function completeMit(text) {
  // MIT 必须同时具备授权、保留通知条件和完整免责声明；只有标题或
  // 版权通知的短文件不能算正文。
  return (
    text.length >= 700 &&
    has(text, "Permission is hereby granted, free of charge") &&
    has(text, "The above copyright notice and this permission notice") &&
    has(text, 'THE SOFTWARE IS PROVIDED "AS IS"') &&
    has(text, "WITHOUT WARRANTY OF ANY KIND") &&
    has(text, "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE")
  );
}

function completeMpl(text) {
  // MPL 必须包含全部必要章节和 Exhibit；只有第 1/2.1 节的截断文本
  // 不能作为完整正文闭合材料。
  const sections = [
    "1. Definitions",
    "2. License Grants and Conditions",
    "3. Responsibilities",
    "4. Inability to Comply Due to Statute or Regulation",
    "5. Termination",
    "6. Disclaimer of Warranty",
    "7. Limitation of Liability",
    "8. Litigation",
    "9. Miscellaneous",
    "10. Versions of the License",
  ];
  return (
    text.length >= 12_000 &&
    has(text, "Mozilla Public License Version 2.0") &&
    sections.every((section) => has(text, section)) &&
    has(text, "Exhibit A - Source Code Form License Notice") &&
    has(text, 'Exhibit B - "Incompatible With Secondary Licenses" Notice')
  );
}

function completeApache(text) {
  return (
    text.length >= 9_000 &&
    has(text, "Apache License") &&
    has(text, "Version 2.0, January 2004") &&
    has(text, "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") &&
    has(text, "1. Definitions") &&
    has(text, "9. Accepting Warranty or Additional Liability") &&
    has(text, "END OF TERMS AND CONDITIONS")
  );
}

function completeBsd(text) {
  return (
    text.length >= 900 &&
    has(text, "Redistribution and use in source and binary forms") &&
    has(text, "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS") &&
    has(text, "DISCLAIMED")
  );
}

function completeIsc(text) {
  return (
    text.length >= 500 &&
    has(text, "Permission to use, copy, modify, and/or distribute this software for any purpose") &&
    // ISC 与 0BSD 的前半段授权文字非常接近，区别在于 ISC 要求保留版权和
    // 许可通知；没有这条就不能判为 ISC，避免把 0BSD 正文串型识别。
    has(
      text,
      "provided that the above copyright notice and this permission notice appear in all copies",
    ) &&
    has(text, "THE SOFTWARE IS PROVIDED") &&
    // ISC 常见正文用 DISCLAIMS，部分变体用 DISCLAIMED；两者都要求完整免责声明。
    /DISCLAIM(?:S|ED)/.test(text)
  );
}

function completeZlib(text) {
  return (
    text.length >= 500 &&
    has(text, "This software is provided 'as-is'") &&
    has(text, "origin of this software must not be misrepresented") &&
    has(text, "This notice may not be removed or altered")
  );
}

function completeUnlicense(text) {
  return (
    text.length >= 700 &&
    has(text, "This is free and unencumbered software released into the public domain") &&
    has(text, 'THE SOFTWARE IS PROVIDED "AS IS"') &&
    has(text, "IN NO EVENT SHALL THE AUTHORS BE LIABLE")
  );
}

function completeBsll(text) {
  return (
    text.length >= 700 &&
    has(text, "Boost Software License - Version 1.0") &&
    has(text, "Permission is hereby granted, free of charge, to any person or organization") &&
    has(text, 'THE SOFTWARE IS PROVIDED "AS IS"')
  );
}

function completeUnicode(text) {
  return (
    text.length >= 1_000 &&
    /UNICODE(?:, INC\.)? LICENSE(?: AGREEMENT)?/i.test(text) &&
    has(text, "COPYRIGHT AND PERMISSION NOTICE") &&
    has(text, "Permission is hereby granted, free of charge")
  );
}

function completeMit0(text) {
  return (
    text.length >= 650 &&
    (has(text, "MIT No Attribution") || has(text, "MIT-0")) &&
    has(text, "Permission is hereby granted, free of charge") &&
    has(text, 'THE SOFTWARE IS PROVIDED "AS IS"') &&
    has(text, "WITHOUT WARRANTY OF ANY KIND") &&
    // MIT-0 也必须包含完整的责任限制末段；只截到授权/免责声明的文件
    // 不能当完整正文。
    has(text, "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE") &&
    has(
      text,
      "ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS",
    )
  );
}

function complete0bsd(text) {
  return (
    text.length >= 550 &&
    // 0BSD 的授权句以句号结束；ISC 在 granted 后接 “provided that ...” 条件，
    // 因此这里用带句号的句子并显式排除 ISC 条件，避免互相吞正文。
    has(text, "for any purpose with or without fee is hereby granted.") &&
    !has(
      text,
      "provided that the above copyright notice and this permission notice appear in all copies",
    ) &&
    has(text, "THE SOFTWARE IS PROVIDED") &&
    /DISCLAIMS? ALL WARRANTIES/i.test(text) &&
    has(text, "IN NO EVENT SHALL THE AUTHOR BE LIABLE")
  );
}

export function detectLicenseIdentifiers(value) {
  if (typeof value !== "string") return [];
  const text = value.replaceAll("\r\n", "\n");
  const identifiers = [];
  if (completeMit0(text)) identifiers.push("MIT-0");
  if (complete0bsd(text)) identifiers.push("0BSD");
  if (completeMit(text)) identifiers.push("MIT");
  if (completeApache(text)) identifiers.push("Apache-2.0");
  if (completeMpl(text)) identifiers.push("MPL-2.0");
  if (completeBsd(text))
    identifiers.push(has(text, "Neither the name") ? "BSD-3-Clause" : "BSD-2-Clause");
  if (completeIsc(text)) identifiers.push("ISC");
  if (completeZlib(text)) identifiers.push("Zlib");
  if (completeUnlicense(text)) identifiers.push("Unlicense");
  if (completeBsll(text)) identifiers.push("BSL-1.0");
  if (completeUnicode(text)) identifiers.push("Unicode-3.0");
  if (completeApache(text) && /LLVM Exceptions/i.test(text)) identifiers.push("LLVM-exception");
  return identifiers;
}

export function isStrictLicenseMaterialPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const name = basename(path);
  if (REJECTED_EXTENSIONS.has(extname(name).toLowerCase())) return false;
  return LICENSE_NAME.test(name) || NOTICE_NAME.test(name);
}

export function isCopyrightNotice(value) {
  // 通知文件只作为 notice 记录，不参与 license body 计数；通知不能替代
  // 许可正文，缺失正文时仍应报告 missingMaterials。
  if (typeof value !== "string" || value.length < 120 || value.length > MAX_MATERIAL_BYTES) {
    return false;
  }
  return (
    /copyright\s+(?:\(c\)|©)?\s*\d{4}/i.test(value) &&
    /(?:all rights reserved|permission|license|notice)/i.test(value)
  );
}

export async function readLicenseMaterial(path) {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MATERIAL_BYTES) {
    throw new Error("license material is empty or exceeds the size limit");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("license material is not valid UTF-8 text");
  }
  const identifiers = detectLicenseIdentifiers(text);
  return {
    bytes: bytes.byteLength,
    sha256: sha256Buffer(bytes),
    text,
    identifiers,
    notice: isCopyrightNotice(text),
    // isLicense 只由完整正文识别结果决定，路径命中或 SPDX token 均不够。
    isLicense: identifiers.length > 0,
  };
}
