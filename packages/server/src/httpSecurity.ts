export interface HttpBindingOptions {
  host?: string;
  authToken?: string;
  authRequired?: boolean;
}

export function resolveHttpBinding(options: HttpBindingOptions) {
  const host = options.host?.trim() || "127.0.0.1";
  const authToken = options.authToken?.trim() || undefined;
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
  // 修复依据：空 hostname 会被 Node 绑定到全部接口；capability 不能在无认证网络入口签发。
  if (options.authRequired && !authToken) {
    throw new Error("authRequired requires an authToken");
  }
  if (!isLoopback && !authToken) {
    throw new Error("Non-loopback HTTP listeners require an authToken");
  }
  return { host, authToken, authRequired: Boolean(authToken) };
}

/** Browser origins cannot grant access to local services or trust proxy headers. */
export function isAllowedHttpRequest(
  url: string,
  origin: string | undefined,
  authenticated: boolean,
  hostHeader?: string,
): boolean {
  try {
    const request = new URL(url);
    const authority = hostHeader ?? request.host;
    const actualHost = new URL(`http://${authority}`);
    // 修复依据：只绑定回环仍会遭 DNS 重绑定，未鉴权入口还须拒绝外域 Host。
    if (
      !authenticated &&
      !["127.0.0.1", "[::1]", "localhost"].includes(actualHost.hostname.toLowerCase())
    ) {
      return false;
    }
    if (origin === undefined) return true;
    const source = new URL(origin);
    return (
      ["http:", "https:"].includes(source.protocol) &&
      !source.username &&
      !source.password &&
      source.host === new URL(`${source.protocol}//${authority}`).host
    );
  } catch {
    return false;
  }
}
