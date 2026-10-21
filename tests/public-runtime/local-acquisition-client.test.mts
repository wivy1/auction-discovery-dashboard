import assert from "node:assert/strict";
import test from "node:test";
import { triggerLocalSourceAcquisition } from "../../lib/sources/local-acquisition.ts";

const revision = `sha256:${"a".repeat(64)}`;
const schema = "auction-discovery-runtime-revision-v1";
const companion = "http://127.0.0.1:32110";
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
const appReady = () => Response.json({ schemaVersion: schema, revision });
const companionReady = () => Response.json({ status: "ready", runtimeRevisionSchema: schema, runtimeRevision: revision });
const result = {
  sourceId: "fixture_html", mode: "catalog", status: "completed", browserPages: 1,
  catalog: {
    runId: "fixture-run", status: "completed", discovered: 0, newListings: 0,
    accepted: 0, excluded: 0, detailsFetched: 0, imageAttempts: 0,
    imagesArchived: 0, imageFailures: 0, sourceWorkSelected: 0,
    deferredCandidates: 0, sourceErrors: [], publishedSourceIds: ["fixture_html"],
  },
  continuation: null, skipReason: null,
};

async function withFetch(
  respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

function readyWithPost(post: Response) {
  return (url: string, init: RequestInit | undefined) => {
    if (init?.method === "POST") return post;
    return url === "/api/internal/runtime-revision" ? appReady() : companionReady();
  };
}

test("generic acquisition preflights matching ready runtimes and forwards their revision", async () => {
  await withFetch(readyWithPost(Response.json(result)), async () => {
    const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
    assert.equal(value.state, "completed");
    assert.equal(value.catalog?.runId, "fixture-run");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.slice(0, 2).map(({ url }) => url).sort(), [
      "/api/internal/runtime-revision", `${companion}/v1/health`,
    ].sort());
    for (const { init } of calls.slice(0, 2)) {
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
    }
    const mutation = calls[2]!;
    assert.equal(mutation.url, `${companion}/v1/source-acquisition`);
    assert.equal(new Headers(mutation.init?.headers).get("x-auction-discovery-runtime-revision"), revision);
    assert.equal(mutation.init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(mutation.init?.body)), {
      sourceId: "fixture_html", mode: "catalog", trigger: "manual",
    });
  });
});

test("invalid, mismatched, unavailable or unready preflight cannot start acquisition", async () => {
  const cases = [
    { app: { schemaVersion: "wrong", revision }, health: { status: "ready", runtimeRevisionSchema: schema, runtimeRevision: revision }, code: "runtime_revision_unavailable" },
    { app: { schemaVersion: schema, revision: "sha256:invalid" }, health: { status: "ready", runtimeRevisionSchema: schema, runtimeRevision: revision }, code: "runtime_revision_unavailable" },
    { app: { schemaVersion: schema, revision }, health: { status: "starting", runtimeRevisionSchema: schema, runtimeRevision: revision }, code: "runtime_revision_unavailable" },
    { app: { schemaVersion: schema, revision }, health: { status: "ready", runtimeRevisionSchema: "wrong", runtimeRevision: revision }, code: "runtime_revision_unavailable" },
    { app: { schemaVersion: schema, revision }, health: { status: "ready", runtimeRevisionSchema: schema, runtimeRevision: `sha256:${"b".repeat(64)}` }, code: "runtime_revision_mismatch" },
  ];
  for (const scenario of cases) {
    await withFetch((url) => Response.json(url === "/api/internal/runtime-revision" ? scenario.app : scenario.health), async () => {
      const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
      assert.equal(value.state, "unavailable");
      assert.equal(value.errorCode, scenario.code);
      assert.equal(calls.length, 2);
      assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
    });
  }
  await withFetch((url) => url === "/api/internal/runtime-revision"
    ? Response.json({}, { status: 503 }) : companionReady(), async () => {
    assert.equal((await triggerLocalSourceAcquisition("fixture_html", "catalog")).errorCode, "runtime_revision_unavailable");
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
  });
  await withFetch(() => { throw new Error("private transport error"); }, async () => {
    assert.equal((await triggerLocalSourceAcquisition("fixture_html", "catalog")).errorCode, "runtime_revision_unavailable");
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
  });
});

test("preflight JSON byte limits reject oversized and malformed responses before POST", async () => {
  for (const response of [
    new Response("x".repeat(65 * 1024), { headers: { "content-length": String(65 * 1024) } }),
    new Response("x".repeat(65 * 1024)),
    new Response("not-json"),
  ]) {
    await withFetch((url) => url === "/api/internal/runtime-revision" ? response : companionReady(), async () => {
      const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
      assert.equal(value.errorCode, "runtime_revision_unavailable");
      assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
    });
  }
});

test("a failed preflight cancels its pending sibling request", async () => {
  let siblingAborted = false;
  await withFetch((url, init) => {
    if (url === "/api/internal/runtime-revision") throw new Error("unavailable");
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        siblingAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  }, async () => {
    assert.equal((await triggerLocalSourceAcquisition("fixture_html", "catalog")).errorCode, "runtime_revision_unavailable");
    assert.equal(siblingAborted, true);
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
  });
});

test("only explicit companion busy codes map 409 responses to busy", async () => {
  for (const [code, state] of [
    ["source_acquisition_busy", "busy"],
    ["companion_mutation_busy", "busy"],
    ["runtime_revision_mismatch", "unavailable"],
    ["other_conflict", "unavailable"],
  ] as const) {
    await withFetch(readyWithPost(Response.json({ code }, { status: 409 })), async () => {
      const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
      assert.equal(value.state, state);
      assert.equal(value.errorCode, code);
    });
  }
  await withFetch(readyWithPost(Response.json({}, { status: 409 })), async () => {
    const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
    assert.equal(value.state, "unavailable");
    assert.equal(value.errorCode, "source_acquisition_http_409");
  });
});

test("successful preflight preserves acquisition errors and strict result parsing", async () => {
  await withFetch(readyWithPost(Response.json({ code: "source_bootstrap_failed" }, { status: 422 })), async () => {
    const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
    assert.equal(value.state, "unavailable");
    assert.equal(value.errorCode, "source_bootstrap_failed");
  });
  await withFetch(readyWithPost(Response.json({ ...result, sourceId: "different_source" })), async () => {
    assert.equal((await triggerLocalSourceAcquisition("fixture_html", "catalog")).errorCode, "source_acquisition_contract_mismatch");
  });
});

test("invalid acquisition options make no preflight or mutation request", async () => {
  await withFetch(() => { throw new Error("must not fetch"); }, async () => {
    assert.equal((await triggerLocalSourceAcquisition("invalid source", "catalog")).errorCode, "invalid_source_id");
    assert.equal((await triggerLocalSourceAcquisition("fixture_html", "catalog", { retryFailedImages: true })).errorCode, "invalid_source_image_repair_mode");
    assert.equal(calls.length, 0);
  });
});

test("runtime preflight has a short independent timeout before acquisition", { timeout: 8_000 }, async () => {
  await withFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), async () => {
    const start = performance.now();
    const value = await triggerLocalSourceAcquisition("fixture_html", "catalog");
    assert.equal(value.errorCode, "runtime_revision_unavailable");
    assert.ok(performance.now() - start < 7_000);
    assert.equal(calls.length, 2);
    assert.equal(calls.some(({ init }) => init?.method === "POST"), false);
  });
});
