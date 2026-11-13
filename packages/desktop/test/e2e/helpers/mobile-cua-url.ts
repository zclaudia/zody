/** 将 gateway 地址映射到浏览器同源 HTTP(S) 地址，不降级安全协议。 */
export function mobileCuaGatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Unsupported gateway protocol");
  return url.origin;
}

/** 测试宿主桥使用无闭包源码，避免序列化后丢失编译辅助函数。 */
export function mobileCuaBridgeScript(context: unknown): string {
  return `(function(){const context=${JSON.stringify(context)};globalThis.ZodyRemoteBridge={getSessionContext:function(){return JSON.stringify({schemaVersion:1,ok:true,context:context})},markRemoteReady:function(){return JSON.stringify({schemaVersion:1,ok:true})},returnShell:function(){}}})()`;
}
