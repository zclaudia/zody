import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

import { NATIVE_ROOT } from "./lib/cua-desktop-session-config.mjs";

async function loadCandidateFetch() {
  const dir = await mkdtemp(join(tmpdir(), "cua-candidate-fetch-"));
  const outfile = join(dir, "candidate-fetch.mjs");
  await build({
    entryPoints: [join(NATIVE_ROOT, "runtime", "candidate-fetch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  const module = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  return { dir, module };
}

async function startServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/final" });
        response.end();
        return;
      }
      if (request.url === "/final") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("redirected");
        return;
      }
      if (request.url === "/empty") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === "/slow") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("late");
        }, 5_000);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "x-server": "candidate" });
      response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, base: `http://127.0.0.1:${server.address().port}` };
}

test("candidate fetch performs real localhost requests through node-fetch", async (t) => {
  const { dir, module } = await loadCandidateFetch();
  let started;
  try {
    started = await startServer();
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if (error?.code === "EPERM") {
      t.skip("sandbox denies loopback listen; run this test outside the sandbox");
      return;
    }
    throw error;
  }
  const { server, requests, base } = started;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const getResponse = await module.candidateFetch(`${base}/echo?x=1`, {
    headers: { "x-test": "yes" },
  });
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.ok, true);
  assert.equal(getResponse.url, `${base}/echo?x=1`);
  assert.equal(getResponse.headers.get("x-server"), "candidate");
  const getBody = JSON.parse(await getResponse.text());
  assert.equal(getBody.headers["x-test"], "yes");

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("stream-body"));
      controller.close();
    },
  });
  const request = new Request(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-request": "object" },
    body: stream,
    duplex: "half",
  });
  const postResponse = await module.candidateFetch(request);
  const postBody = JSON.parse(await postResponse.text());
  assert.equal(postBody.method, "POST");
  assert.equal(postBody.body, "stream-body");
  assert.equal(postBody.headers["x-request"], "object");

  const redirect = await module.candidateFetch(new URL(`${base}/redirect`));
  assert.equal(redirect.status, 200);
  assert.equal(redirect.url, `${base}/final`);
  assert.equal(redirect.redirected, true);
  assert.equal(redirect.bodyUsed, false);
  const cloned = redirect.clone();
  assert.equal(cloned.url, `${base}/final`);
  assert.equal(cloned.redirected, true);
  assert.equal(await redirect.text(), "redirected");
  assert.equal(await cloned.text(), "redirected");

  const manual = await module.candidateFetch(`${base}/redirect`, { redirect: "manual" });
  assert.equal(manual.status, 302);
  assert.equal(manual.redirected, false);
  assert.equal(manual.headers.get("location"), "/final");

  const empty = await module.candidateFetch(`${base}/empty`);
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  assert.equal(await empty.text(), "");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => module.candidateFetch(`${base}/slow`, { signal: controller.signal }),
    (error) => error.name === "AbortError",
  );

  const beforeProxy = requests.length;
  await assert.rejects(
    () => module.candidateFetch(`${base}/echo`, { dispatcher: {} }),
    (error) => error.code === "ERR_CANDIDATE_FETCH_UNSUPPORTED",
  );
  await assert.rejects(
    () => module.candidateFetch(`${base}/echo`, { ca: "custom-ca" }),
    (error) => error.code === "ERR_CANDIDATE_FETCH_UNSUPPORTED",
  );
  assert.equal(requests.length, beforeProxy, "unsupported proxy/CA must not fall back to a direct request");

  module.installCandidateFetch();
  const installed = await globalThis.fetch(`${base}/echo?installed=1`);
  assert.equal(installed.status, 200);
});

test("candidate fetch rejects proxy/CA and real node-fetch handles data URIs", async () => {
  const { dir, module } = await loadCandidateFetch();
  try {
    const response = await module.candidateFetch("data:text/plain,candidate-body");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "candidate-body");

    await assert.rejects(
      () => module.candidateFetch("http://127.0.0.1:9/", { dispatcher: {} }),
      (error) => error.code === "ERR_CANDIDATE_FETCH_UNSUPPORTED",
    );
    await assert.rejects(
      () => module.candidateFetch("http://127.0.0.1:9/", { ca: "custom-ca" }),
      (error) => error.code === "ERR_CANDIDATE_FETCH_UNSUPPORTED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
