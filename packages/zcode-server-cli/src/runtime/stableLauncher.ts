import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServicePlatform } from "../platform/serviceManager.js";
import type { ServerLayout } from "./paths.js";

export interface StableLauncherBootstrap {
  command: string;
  entry: string;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stablePosixLauncher(bootstrap?: StableLauncherBootstrap): string {
  const fallback = bootstrap
    ? `exec ${quoteShell(bootstrap.command)} ${quoteShell(bootstrap.entry)} "$@"`
    : 'echo "No current Zody Server release" >&2; exit 1';
  return `#!/bin/sh
ROOT=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)
RELEASE_DIR=$(sed -n 's/.*"releaseDir"[[:space:]]*:[[:space:]]*"\\([^"\\]*\\)".*/\\1/p' "$ROOT/current.json")
if [ -n "$RELEASE_DIR" ]; then
  # I11: current.json 与入口可能经不同的符号链接别名访问（symlink HOME/安装根），
  # 逻辑路径前缀比较会把同一物理 release 判成越界，也会放过 releases/ 内指向外部的链接。
  # 入口根已用 pwd -P 物理化；<root>/releases 与 releaseDir 也必须 cd -P 物理化后再比较，
  # 因为 releases 本身也可能是指向其他目录的符号链接（写入侧 assertReleaseDir 同样 realpath releasesDir）。
  # 无法解析（相对路径、不存在、链接失效）时同样 fail-closed。
  case "$RELEASE_DIR" in
    /*) ;;
    *) echo "Invalid current Zody Server release" >&2; exit 1 ;;
  esac
  RELEASES_PHYSICAL=$(CDPATH= cd -P -- "$ROOT/releases" 2>/dev/null && pwd -P)
  RELEASE_PHYSICAL=$(CDPATH= cd -P -- "$RELEASE_DIR" 2>/dev/null && pwd -P)
  if [ -z "$RELEASES_PHYSICAL" ] || [ -z "$RELEASE_PHYSICAL" ]; then
    echo "Invalid current Zody Server release" >&2
    exit 1
  fi
  case "$RELEASE_PHYSICAL" in
    "$RELEASES_PHYSICAL"/*) ;;
    *) echo "Invalid current Zody Server release" >&2; exit 1 ;;
  esac
  exec "$RELEASE_PHYSICAL/runtime/node" "$RELEASE_PHYSICAL/runtime/server-cli.js" "$@"
fi
${fallback}
`;
}

function quoteBatch(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableWindowsLauncher(bootstrap?: StableLauncherBootstrap): string {
  const fallback = bootstrap
    ? `${quoteBatch(bootstrap.command)} ${quoteBatch(bootstrap.entry)} %*\r\n`
    : "echo No current Zody Server release 1>&2\r\nexit /b 1\r\n";
  return `@echo off\r
set "ROOT=%~dp0.."\r
set "ZCODE_SERVER_ROOT=%ROOT%"\r
rem I11: current.json 与入口可能经不同的符号链接/联接点访问，路径也可能含空格。\r
rem GetFullPath 只做字符串规范化、不解析链接，不能单独作为归属判断依据；\r
rem 这里逐段解析入口根与 releaseDir 的链接目标（含中间目录），再按物理路径比较归属。\r
rem 解析失败（相对路径、不存在、链接失效）或物理上越出 releases/ 时输出哨兵 fail-closed。\r
set "RELEASE_DIR="\r
for /f "delims=" %%I in ('powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $script:d=0; function P([string]$p){if($script:d -gt 40){return $null}; $script:d++; try {$f=[IO.Path]::GetFullPath($p); $r=[IO.Path]::GetPathRoot($f); $cur=$r; foreach($part in $f.Substring($r.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar),[StringSplitOptions]::RemoveEmptyEntries)){$n=[IO.Path]::Combine($cur,$part); $o=Get-Item -LiteralPath $n -Force -ErrorAction SilentlyContinue; if(-not $o){return $null}; $t=$null; if($o.PSObject.Methods['ResolveLinkTarget']){$l=$o.ResolveLinkTarget($false); if($l){$t=$l.FullName}} else {$q=@($o.Target)[0]; if($q){if(-not [IO.Path]::IsPathRooted([string]$q)){$q=Join-Path (Split-Path -Parent $n) ([string]$q)}; $t=[IO.Path]::GetFullPath([string]$q)}}; if($t){$cur=P $t; if(-not $cur){return $null}} else {$cur=$n}}; return $cur} finally {$script:d--}}; try {$root=P $env:ZCODE_SERVER_ROOT; $result=''; if(-not $root){$result='ZCODE_INVALID_RELEASE'} else {$c=Join-Path $root 'current.json'; if(Test-Path -LiteralPath $c){$j=Get-Content -Raw -LiteralPath $c ^| ConvertFrom-Json; if($j.releaseDir){$raw=[string]$j.releaseDir; $rel=P $raw; $rs=P (Join-Path $root 'releases'); if([IO.Path]::IsPathRooted($raw) -and $rel -and $rs -and $rel.StartsWith($rs + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){$result=$rel} else {$result='ZCODE_INVALID_RELEASE'}}}}; if($result){Write-Output $result}} catch {Write-Output 'ZCODE_INVALID_RELEASE'}"') do set "RELEASE_DIR=%%I"\r
if /i "%RELEASE_DIR%"=="ZCODE_INVALID_RELEASE" (\r
  echo Invalid current Zody Server release 1>&2\r
  exit /b 1\r
)\r
if not "%RELEASE_DIR%"=="" (\r
  "%RELEASE_DIR%\\runtime\\node.exe" "%RELEASE_DIR%\\runtime\\server-cli.js" %*\r
  exit /b %ERRORLEVEL%\r
)\r
${fallback}`;
}

export async function writeStableLauncher(
  layout: ServerLayout,
  platform: ServicePlatform,
  bootstrap?: StableLauncherBootstrap,
): Promise<string> {
  await mkdir(layout.stableBinDir, { recursive: true, mode: 0o700 });
  const launcherPath = join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode");
  const temporaryPath = `${launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    platform === "win32" ? stableWindowsLauncher(bootstrap) : stablePosixLauncher(bootstrap),
    platform === "win32" ? "utf8" : { encoding: "utf8", mode: 0o755 },
  );
  await rename(temporaryPath, launcherPath);
  return launcherPath;
}
