import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { D1 } from "./support/d1.js";
import { api } from "../worker/index.js";
import { youtubeURL, options, authorization } from "../worker/domain.js";
const auth = () => ({
  approved: true,
  license: "owned",
  method: "direct_https",
  media_url: "https://media.example.org/talk.mp4",
  sha256: "a".repeat(64),
  evidence: "Channel owner owns this original recording and all audio.",
  attribution:
    "Original recording by channel owner. Edited excerpt; subtitles added.",
  all_components_cleared: true,
  platform_download_permitted: true,
});
const input = () => ({
  url: "https://youtu.be/abcdefghijk",
  source_kind: "video",
  options: {
    count: 3,
    duration: 40,
    aspect: "9:16",
    caption_style: "bold",
    language: "en",
  },
});
function context() {
  const DB = new D1();
  // Existing tests start with a successful isolated development probe.
  DB.db
    .prepare(
      "INSERT INTO worker_heartbeats(id,last_seen,credential_hash,storage_verified_at) VALUES('cpu',?,?,?)",
    )
    .run(
      new Date().toISOString(),
      createHash("sha256").update("worker-test-secret").digest("hex"),
      new Date().toISOString(),
    );
  return {
    DB,
    WORKER_TOKEN: "worker-test-secret",
    // Isolated development/test harness, not provider authorization for production.
    ACTIONS_APP_USE_AUTHORIZED: "true",
    FREE_TIER_VERIFIED: "true",
    GITHUB_DISPATCH_TOKEN: "test-token",
    WORKER_CONNECTION_VERIFIED_AT: new Date().toISOString(),
    BUCKET: {
      async put() {},
      async delete() {},
      async get() {
        return null;
      },
    },
  };
}
function request(
  path,
  method = "GET",
  data = null,
  user = "owner",
  headers = {},
) {
  return new Request("https://purffle.test" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "oai-authenticated-user-id": user } : {}),
      ...(method !== "GET" ? { Origin: "https://purffle.test" } : {}),
      ...headers,
    },
    body: data === null ? undefined : JSON.stringify(data),
  });
}
async function call(
  env,
  path,
  method = "GET",
  data = null,
  user = "owner",
  headers = {},
) {
  return api(request(path, method, data, user, headers), env);
}
const workerHeaders = { Authorization: "Bearer worker-test-secret" };
const stageHeaders = (lease) => ({ ...workerHeaders, "x-job-lease": lease });
// Metadata availability must never be needed to create or authorize a job.
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/repos/Saisathwik045/purffle-shorts"))
    return Response.json({
      private: false,
      full_name: "Saisathwik045/purffle-shorts",
      default_branch: "main",
    });
  if (String(url).endsWith("/dispatches"))
    return new Response(null, { status: 204 });
  throw new Error("Metadata unavailable");
};
test("canonical URLs and options reject ambiguous or unsupported input", () => {
  assert.equal(
    youtubeURL("https://www.youtube.com/live/abcdefghijk?si=tracking").url,
    youtubeURL("https://youtu.be/abcdefghijk").url,
  );
  for (const value of [
    "http://youtube.com/watch?v=abcdefghijk",
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "https://youtube.com/@channel",
    "https://youtube.com/playlist?list=123",
  ])
    assert.throws(() => youtubeURL(value));
  for (const value of [
    { count: 11 },
    { count: 0 },
    { duration: 999 },
    { caption_style: "unknown" },
    { language: "xss" },
    { aspect: "custom" },
  ])
    assert.throws(() => options(value));
});
test("rights are explicit, comprehensive and expire", () => {
  assert.equal(authorization({ approved: false }, "owner"), null);
  for (const change of [
    { method: "youtube_download" },
    { license: "Standard YouTube" },
    { all_components_cleared: false },
    { platform_download_permitted: false },
    { evidence: "" },
    { sha256: "x" },
    { media_url: "https://127.0.0.1/source.mp4" },
    { media_url: "https://www.youtube.com/watch?v=abcdefghijk" },
    { expires_on: "2020-01-01" },
  ])
    assert.throws(() => authorization({ ...auth(), ...change }, "owner"));
  assert.equal(authorization(auth(), "owner").reviewed_by, "owner");
});
test("authentication and CSRF boundaries are enforced", async () => {
  const env = context();
  await assert.rejects(
    call(env, "/api/bootstrap", "GET", null, null),
    (e) => e.status === 401,
  );
  await assert.rejects(
    call(env, "/api/jobs", "POST", input(), "owner", {
      Origin: "https://evil.test",
    }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    call(env, "/api/worker/claim", "POST", {}, null),
    (e) => e.status === 401,
  );
});
test("unauthorized sources persist outside queue; duplicates are prevented", async () => {
  const env = context();
  const r = await (await call(env, "/api/jobs", "POST", input())).json();
  assert.equal(r.state, "AWAITING_SOURCE_AUTHORIZATION");
  const claim = await (
    await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
  ).json();
  assert.equal(claim.job, null);
  const duplicate = await call(env, "/api/jobs", "POST", {
    ...input(),
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).existing_job, r.id);
  await assert.rejects(
    call(env, `/api/jobs/${r.id}`, "GET", null, "other-owner"),
    (e) => e.status === 404,
  );
  const history = await (await call(env, `/api/jobs/${r.id}`)).json();
  assert.deepEqual(
    history.events.map((e) => e.state),
    ["CREATED", "VALIDATING", "AWAITING_SOURCE_AUTHORIZATION"],
  );
  assert.equal("progress" in history.job, false);
});
test("authorization, atomic worker claim and state transitions are real", async () => {
  const env = context();
  const { id } = await (await call(env, "/api/jobs", "POST", input())).json();
  await call(env, `/api/jobs/${id}/authorization`, "POST", auth());
  const claim = await (
    await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
  ).json();
  const lease = claim.job.lease_id;
  assert.equal(claim.job.id, id);
  assert.equal(
    (
      await (
        await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
      ).json()
    ).job,
    null,
  );
  await assert.rejects(
    call(
      env,
      `/api/worker/jobs/${id}/stage`,
      "POST",
      { state: "READY_FOR_REVIEW" },
      null,
      stageHeaders(lease),
    ),
    (e) => e.status === 409,
  );
  for (const state of [
    "TRANSCRIBING",
    "SELECTING_HIGHLIGHTS",
    "RENDERING",
    "GENERATING_METADATA",
  ])
    await call(
      env,
      `/api/worker/jobs/${id}/stage`,
      "POST",
      { state },
      null,
      stageHeaders(lease),
    );
  await assert.rejects(
    call(
      env,
      `/api/worker/jobs/${id}/complete`,
      "POST",
      {},
      null,
      stageHeaders(lease),
    ),
    (e) => e.status === 409,
  );
  const c = await (
    await call(
      env,
      `/api/worker/jobs/${id}/clips`,
      "POST",
      {
        position: 1,
        title: "A real generated clip",
        duration: 30,
        description: "Clip metadata",
      },
      null,
      stageHeaders(lease),
    )
  ).json();
  await env.DB.prepare("UPDATE clips SET video_key=?,subtitle_key=? WHERE id=?")
    .bind("video", "subtitles", c.id)
    .run();
  await call(
    env,
    `/api/worker/jobs/${id}/complete`,
    "POST",
    {},
    null,
    stageHeaders(lease),
  );
  const bootstrap = await (await call(env, "/api/bootstrap")).json();
  assert.equal(bootstrap.jobs[0].state, "READY_FOR_REVIEW");
  assert.equal(bootstrap.clips.length, 1);
  assert.equal(bootstrap.publications.length, 0);
  assert.equal(bootstrap.publishing_enabled, false);
  assert.equal(bootstrap.jobs[0].lease_id, undefined);
  await assert.rejects(
    call(
      env,
      `/api/clips/${c.id}/review`,
      "POST",
      { decision: "APPROVED" },
      "other-owner",
    ),
    (e) => e.status === 404,
  );
  await call(env, `/api/clips/${c.id}/review`, "POST", {
    decision: "APPROVED",
  });
  assert.equal(
    (await (await call(env, "/api/bootstrap")).json()).jobs[0].state,
    "APPROVED",
  );
  await assert.rejects(
    call(env, `/api/clips/${c.id}/publish`, "POST", {}),
    (e) => e.status === 403,
  );
});
test("failed processing is visible and safely retryable, never by a stale worker", async () => {
  const env = context();
  const { id } = await (
    await call(env, "/api/jobs", "POST", { ...input(), authorization: auth() })
  ).json();
  const j = (
    await (
      await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
    ).json()
  ).job;
  await assert.rejects(
    call(env, `/api/jobs/${id}/retry`, "POST", {}),
    (e) => e.status === 409,
  );
  await call(
    env,
    `/api/worker/jobs/${id}/fail`,
    "POST",
    { error: "Model download unavailable" },
    null,
    stageHeaders(j.lease_id),
  );
  await call(env, `/api/jobs/${id}/retry`, "POST", {});
  await assert.rejects(
    call(env, `/api/jobs/${id}/retry`, "POST", {}),
    (e) => e.status === 409,
  );
  await assert.rejects(
    call(
      env,
      `/api/worker/jobs/${id}/stage`,
      "POST",
      { state: "RENDERING" },
      null,
      stageHeaders(j.lease_id),
    ),
    (e) => e.status === 409,
  );
  const history = await (await call(env, `/api/jobs/${id}`)).json();
  assert.equal(history.job.attempt, 2);
  assert(history.events.some((e) => e.state === "FAILED"));
});
test("preferences persist and account tokens never enter API responses", async () => {
  const env = context();
  await call(env, "/api/settings", "POST", {
    ...input().options,
    count: 7,
    publishing_enabled: true,
  });
  await env.DB.prepare(
    "INSERT INTO youtube_accounts(owner,channel_id,channel_title,encrypted_tokens,connected_at) VALUES(?,?,?,?,?)",
  )
    .bind("owner", "channel", "My channel", "TOKEN_SECRET", "2026-11-18")
    .run();
  const response = await (await call(env, "/api/bootstrap")).json();
  assert.equal(response.preferences.count, 7);
  assert.equal(response.publishing_enabled, false);
  assert(!JSON.stringify(response).includes("TOKEN_SECRET"));
  assert.equal(
    (await (await call(env, "/api/bootstrap", "GET", null, "different")).json())
      .account,
    null,
  );
});
test("expired rights leave the queue and failed retries return to authorization", async () => {
  const env = context();
  const { id } = await (
    await call(env, "/api/jobs", "POST", { ...input(), authorization: auth() })
  ).json();
  const stale = { ...auth(), expires_on: "2020-01-01" };
  await env.DB.prepare("UPDATE jobs SET authorization=? WHERE id=?")
    .bind(JSON.stringify(stale), id)
    .run();
  assert.equal(
    (
      await (
        await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
      ).json()
    ).job,
    null,
  );
  assert.equal(
    (await (await call(env, `/api/jobs/${id}`)).json()).job.state,
    "AWAITING_SOURCE_AUTHORIZATION",
  );
  await env.DB.prepare("UPDATE jobs SET state='FAILED',retryable=1 WHERE id=?")
    .bind(id)
    .run();
  const retry = await (
    await call(env, `/api/jobs/${id}/retry`, "POST", {})
  ).json();
  assert.equal(retry.state, "AWAITING_SOURCE_AUTHORIZATION");
  const j = (await (await call(env, `/api/jobs/${id}`)).json()).job;
  assert.equal(j.attempt, 2);
});
test("generation fails closed without verified account limits; private settings still work", async () => {
  const env = context();
  env.FREE_TIER_VERIFIED = "false";
  const waiting = await (await call(env, "/api/jobs", "POST", input())).json();
  assert.equal(waiting.state, "AWAITING_SOURCE_AUTHORIZATION");
  await assert.rejects(
    call(env, `/api/jobs/${waiting.id}/authorization`, "POST", auth()),
    (e) => e.status === 503,
  );
  await assert.rejects(
    call(env, "/api/worker/claim", "POST", {}, null, workerHeaders),
    (e) => e.status === 503,
  );
  const status = await (await call(env, "/api/bootstrap")).json();
  assert.equal(status.generation.enabled, false);
  assert.equal(status.jobs[0].state, "AWAITING_SOURCE_AUTHORIZATION");
});
test("production Actions backend requires provider authorization separately from free billing", async () => {
  const env = context();
  delete env.ACTIONS_APP_USE_AUTHORIZED;
  const waiting = await (await call(env, "/api/jobs", "POST", input())).json();
  await assert.rejects(
    call(env, `/api/jobs/${waiting.id}/authorization`, "POST", auth()),
    (e) => e.status === 503 && /provider authorization/i.test(e.message),
  );
  const status = await (await call(env, "/api/bootstrap")).json();
  assert.equal(status.generation.enabled, false);
  assert.equal(status.jobs[0].state, "AWAITING_SOURCE_AUTHORIZATION");
});
test("storage reservations are atomic and monthly operation budgets stop extra work", async () => {
  const env = context();
  const opts = { ...input().options, count: 10 };
  const results = await Promise.all(
    [0, 1].map(
      async (n) =>
        await (
          await call(env, "/api/jobs", "POST", {
            ...input(),
            url: `https://youtu.be/abcdefghij${n}`,
            options: opts,
            authorization: auth(),
          })
        ).json(),
    ),
  );
  assert.equal(results.filter((x) => x.state === "QUEUED").length, 1);
  assert.equal(results.filter((x) => x.state === "FAILED").length, 1);
  const used = await env.DB.prepare(
    "SELECT SUM(storage_reserved) total FROM jobs",
  )
    .bind()
    .first();
  assert(used.total <= 512 * 1024 * 1024);
  const { charge } = await import("../worker/generation.js");
  await charge(env.DB, "test", 1);
  await assert.rejects(charge(env.DB, "test", 1), (e) => e.status === 429);
});
test("private clip cleanup removes partial objects and preserves failure history", async () => {
  const env = context();
  const deleted = [];
  env.BUCKET.delete = async (keys) => deleted.push(...keys);
  const { id } = await (
    await call(env, "/api/jobs", "POST", { ...input(), authorization: auth() })
  ).json();
  const j = (
    await (
      await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders)
    ).json()
  ).job;
  for (const state of [
    "TRANSCRIBING",
    "SELECTING_HIGHLIGHTS",
    "RENDERING",
    "GENERATING_METADATA",
  ])
    await call(
      env,
      `/api/worker/jobs/${id}/stage`,
      "POST",
      { state },
      null,
      stageHeaders(j.lease_id),
    );
  const body = {
    position: 1,
    title: "Partial generated clip",
    description: "Partially stored",
    duration: 12,
  };
  const c = await (
    await call(
      env,
      `/api/worker/jobs/${id}/clips`,
      "POST",
      body,
      null,
      stageHeaders(j.lease_id),
    )
  ).json();
  const again = await (
    await call(
      env,
      `/api/worker/jobs/${id}/clips`,
      "POST",
      body,
      null,
      stageHeaders(j.lease_id),
    )
  ).json();
  assert.equal(c.id, again.id);
  await call(
    env,
    `/api/worker/jobs/${id}/fail`,
    "POST",
    { error: "Interrupted upload" },
    null,
    stageHeaders(j.lease_id),
  );
  assert(deleted.some((k) => k.endsWith("/short.mp4")));
  const row = await env.DB.prepare(
    "SELECT state,storage_reserved FROM jobs WHERE id=?",
  )
    .bind(id)
    .first();
  assert.equal(row.state, "FAILED");
  assert.equal(row.storage_reserved, 0);
  assert(
    (await (await call(env, `/api/jobs/${id}`)).json()).events.some(
      (x) => x.state === "FAILED",
    ),
  );
});
test("private connection can be verified before production generation is enabled", async () => {
  const env = context();
  env.FREE_TIER_VERIFIED = "false";
  delete env.GITHUB_DISPATCH_TOKEN;
  delete env.WORKER_CONNECTION_VERIFIED_AT;
  const response = await (
    await call(env, "/api/worker/health", "POST", {}, null, workerHeaders)
  ).json();
  assert(response.connected && response.storage_bound);
  assert(Number.isFinite(Date.parse(response.checked_at)));
  assert.equal(response.publishing_enabled, false);
  assert.equal(
    (await (await call(env, "/api/bootstrap")).json()).generation.enabled,
    false,
  );
});
test("an ambiguous dispatch never reports a regression after a real worker claim", async () => {
  const env = context();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, ...args) => {
    if (String(url).endsWith("/dispatches")) {
      await call(env, "/api/worker/claim", "POST", {}, null, workerHeaders);
      throw new Error("Dispatch response connection lost");
    }
    return original(url, ...args);
  };
  try {
    const result = await (
      await call(env, "/api/jobs", "POST", {
        ...input(),
        authorization: auth(),
      })
    ).json();
    assert.equal(result.state, "VALIDATING");
    assert.equal(result.dispatch_status, "UNCONFIRMED");
    const actual = await (await call(env, `/api/jobs/${result.id}`)).json();
    assert.equal(actual.job.state, "VALIDATING");
    assert.equal(actual.events.at(-1).state, "VALIDATING");
  } finally {
    globalThis.fetch = original;
  }
});

test("manual timestamps cannot replace a real private storage probe", async () => {
  const env = context();
  env.DB.db.exec("DELETE FROM worker_heartbeats");
  env.WORKER_CONNECTION_VERIFIED_AT = new Date().toISOString();
  const status = (await (await call(env, "/api/bootstrap")).json()).generation;
  assert.equal(status.enabled, false);
  assert.equal(status.connection.storage_verified, false);
});

test("storage probe proves write/read/delete and binds proof to current credentials", async () => {
  const env = context();
  env.DB.db.exec("DELETE FROM worker_heartbeats");
  delete env.WORKER_CONNECTION_VERIFIED_AT;
  const objects = new Map();
  env.BUCKET = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      return { body: objects.get(key) };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const proof = await (
    await call(
      env,
      "/api/worker/verify-storage",
      "POST",
      {},
      null,
      workerHeaders,
    )
  ).json();
  assert.equal(proof.storage_verified, true);
  assert.equal(objects.size, 0);
  let status = (await (await call(env, "/api/bootstrap")).json()).generation;
  assert.equal(status.enabled, true);
  assert.equal(status.connection.storage_verified_at, proof.checked_at);
  env.WORKER_TOKEN = "rotated-secret";
  status = (await (await call(env, "/api/bootstrap")).json()).generation;
  assert.equal(status.enabled, false);
  assert.equal(status.connection.storage_verified, false);
  assert(!JSON.stringify(status).includes("rotated-secret"));
});

test("storage probe requires free usage confirmation before any object operation", async () => {
  const env = context();
  env.FREE_TIER_VERIFIED = "false";
  let operations = 0;
  env.BUCKET = {
    async put() {
      operations++;
    },
  };
  await assert.rejects(
    call(env, "/api/worker/verify-storage", "POST", {}, null, workerHeaders),
    (e) => e.status === 503,
  );
  assert.equal(operations, 0);
  await assert.rejects(
    call(env, "/api/worker/verify-storage", "POST", {}, null, {}),
    (e) => e.status === 401,
  );
});

test("failed read-back invalidates old proof and cleans the temporary object", async () => {
  const env = context();
  const deleted = [];
  env.BUCKET = {
    async put() {},
    async get() {
      return { body: "corrupt" };
    },
    async delete(key) {
      deleted.push(key);
    },
  };
  await assert.rejects(
    call(env, "/api/worker/verify-storage", "POST", {}, null, workerHeaders),
    (e) => e.status === 503,
  );
  const status = (await (await call(env, "/api/bootstrap")).json()).generation;
  assert.equal(status.connection.storage_verified, false);
  assert.match(status.connection.last_check_error, /roundtrip failed/);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^_verification\//);
});

test("future and expired persisted storage proofs fail closed", async () => {
  const env = context();
  for (const delta of [86400000, -31 * 86400000]) {
    env.DB.db
      .prepare("UPDATE worker_heartbeats SET storage_verified_at=?")
      .run(new Date(Date.now() + delta).toISOString());
    assert.equal(
      (await (await call(env, "/api/bootstrap")).json()).generation.enabled,
      false,
    );
  }
});
