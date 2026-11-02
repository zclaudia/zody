export async function waitForWebResponse(
  child,
  address,
  output,
  { fetchImpl = fetch, intervalMs = 100, timeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Web runner exited ${child.exitCode}: ${output.join("")}`);
    }
    try {
      return await fetchImpl(address);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
    }
  }
  throw new Error(
    `Web server did not accept HTTP connections: ${lastError?.message ?? output.join("")}`,
  );
}
