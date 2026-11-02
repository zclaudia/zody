import type { HostApiNetworkTransportDependencies } from "@zody/services/node";

const UNSUPPORTED_REASON =
  "Proxy and custom CA are not supported by the signed Node candidate network transport";

/**
 * Candidate-only network capability boundary.
 *
 * The sealed wrapper installs its own `globalThis.fetch` before the Host entry starts,
 * so direct requests keep using that implementation. npm undici's dispatcher path is
 * unavailable under the signed Node `--jitless` runtime (no WebAssembly), therefore
 * proxy/custom-CA requests explicitly fail instead of silently falling back to direct.
 *
 * This is capability wiring, not an OS trust proof.
 */
export function createCandidateNetworkTransportDependencies(): HostApiNetworkTransportDependencies {
  const reject = async (): Promise<never> => {
    throw new Error(UNSUPPORTED_REASON);
  };
  return {
    createDispatcher: reject,
    fetchWithDispatcher: reject,
  };
}
