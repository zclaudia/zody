/**
 * I16：后台 Bash 输出统一为 `<toolCallId>/stdout.log`，只取 basename 会让所有标签都叫
 * `stdout.log`。代码查看器标题保留最后两段，确保并发任务仍可区分。
 */
export function backgroundBashOutputTitle(path: string): string {
  const segments = path.split(/[\\/]/u).filter(Boolean);
  return segments.slice(-2).join("/") || path;
}
