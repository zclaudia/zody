type Identity = { ok: boolean; pid?: number; launchDate?: unknown };
type DriverClient = {
  capabilities: Record<string, any>;
  sessionId: string;
  options: { protocol?: string; hostname?: string; port?: number; path?: string };
};
export function sameR1ProcessIdentity(
  before: Identity | null,
  after: Identity | null,
  pid: number,
): boolean;
export function r1LoopbackDebugger(address: unknown): URL;
export type R1DriverBinding = {
  pid: number;
  identity: Identity;
  debuggerAddress: string;
  driver: { hostname: string; port: number; protocol: string; path: string };
};
export function captureR1DriverBinding(input: {
  browser: DriverClient;
  pid: number;
  inspectProcess: (pid: number) => Promise<Identity>;
}): Promise<R1DriverBinding>;
export function reattachR1Driver(input: {
  browser: DriverClient;
  binding: R1DriverBinding;
  inspectProcess: (pid: number) => Promise<Identity>;
}): Promise<{
  beforeSessionId: string;
  afterSessionId: string;
  pid: number;
  sameProcess: boolean;
  applicationRestarted: boolean;
}>;
