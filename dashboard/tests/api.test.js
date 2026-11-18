import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { api } from "../worker/index.js";
import { youtubeURL, options, authorization } from "../worker/domain.js";
class D1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      readFileSync(
        new URL("../drizzle/0000_dashboard.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  prepare(sql) {
    const db = this.db;
    return {
      bind(...args) {
        return {
          async first() {
            return db.prepare(sql).get(...args) || null;
          },
          async all() {
            return { results: db.prepare(sql).all(...args) };
          },
          async run() {
            return db.prepare(sql).run(...args);
          },
          _run() {
            return db.prepare(sql).all(...args);
          },
        };
      },
    };
  }
  async batch(items) {
    this.db.exec("BEGIN");
    try {
      const out = items.map((x) => x._run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
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
  return {
    DB: new D1(),
    WORKER_TOKEN: "worker-test-secret",
    BUCKET: {
      async put() {},
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
globalThis.fetch = async () => {
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
