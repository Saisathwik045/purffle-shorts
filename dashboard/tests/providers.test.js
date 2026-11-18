import test from "node:test";
import assert from "node:assert/strict";
import { providerConfiguration, freshHeartbeat, dispatchToProvider } from "../worker/providers.js";
import { reviewedMetadata, metadataHash, expectedMetadata, publishingPreparation } from "../worker/review.js";
const configured = () => ({
  WORKER_PROVIDER: "https", WORKER_BACKEND_AUTHORIZED: "true", WORKER_NO_CHARGE_VERIFIED: "true",
  WORKER_DISPATCH_URL: "https://worker.example.org/jobs", WORKER_DISPATCH_HOST: "worker.example.org",
  WORKER_DISPATCH_TOKEN: "isolated-test-only-token-at-least-32-characters",
});
test("default and old Actions credentials cannot activate a backend", () => {
  assert(providerConfiguration({}).blockers.length);
  assert(providerConfiguration({ ACTIONS_APP_USE_AUTHORIZED: "true", GITHUB_DISPATCH_TOKEN: "old" }).blockers.length);
  assert.deepEqual(providerConfiguration(configured()).blockers, []);
});
test("unsafe or unapproved endpoints fail closed", () => {
  for (const url of ["http://worker.example.org/jobs", "https://api.github.com/jobs", "https://127.0.0.1/jobs",
    "https://[::1]/jobs", "https://worker.internal/jobs", "https://user:pass@worker.example.org/jobs",
    "https://worker.example.org/jobs?token=x", "https://other.example.org/jobs"]) {
    assert(providerConfiguration({ ...configured(), WORKER_DISPATCH_URL: url }).blockers.length, url);
  }
  assert(providerConfiguration({ ...configured(), WORKER_NO_CHARGE_VERIFIED: "false" }).blockers.length);
});
test("heartbeat must be recent and never in the future", () => {
  const time = Date.now();
  assert(freshHeartbeat(new Date(time).toISOString(), time));
  for (const value of ["invalid", new Date(time + 1).toISOString(), new Date(time - 900001).toISOString()])
    assert.equal(freshHeartbeat(value, time), false);
});
test("dispatch uses a bounded private contract and idempotent job attempt", async () => {
  const env = configured();
  await dispatchToProvider(env, { id: "job-1", attempt: 2 }, async (url, init) => {
    assert.equal(url, env.WORKER_DISPATCH_URL);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["Idempotency-Key"], "job-1:2");
    assert.equal(init.headers.Authorization, "Bearer " + env.WORKER_DISPATCH_TOKEN);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["attempt", "contract", "idempotency_key", "job_id"]);
    return Response.json({ ...body, accepted: true }, { status: 202 });
  });
  await assert.rejects(dispatchToProvider(env, { id: "job-1", attempt: 2 }, async () =>
    Response.json({ accepted: true, contract: "purffle.worker.v1", job_id: "other", attempt: 2 }, { status: 202 })));
  await assert.rejects(dispatchToProvider(env, { id: "job-1", attempt: 2 }, async () => new Response("", { status: 200 })));
});
test("metadata validation is bounded and stale decisions fail closed", async () => {
  assert.deepEqual(reviewedMetadata({ title: "  Title ", description: " Text " }), { title: "Title", description: "Text" });
  for (const title of ["", "x".repeat(101), "<script>", "two\nlines"])
    assert.throws(() => reviewedMetadata({ title, description: "" }));
  const clip = { id: "clip", attempt: 1, title: "Title", description: "Text", review_status: "PENDING" };
  const hash = await metadataHash(clip);
  await expectedMetadata({ expected_hash: hash }, clip);
  await assert.rejects(expectedMetadata({ expected_hash: hash }, { ...clip, title: "Changed" }));
});
test("publishing preparation cannot authorize uploads or expose object keys", async () => {
  const clip = { id: "clip", job_id: "job", attempt: 1, title: "Title", description: "Text",
    review_status: "APPROVED", video_key: "private-secret-object", subtitle_key: "private-secret-subtitle",
    created_at: new Date().toISOString() };
  const plan = await publishingPreparation(clip, { approved: true, attribution: "Owned recording" }, { channel_id: "channel" });
  assert.equal(plan.upload_enabled, false); assert.equal(plan.execution_authorized, false);
  assert.equal(plan.proposed_privacy, "private"); assert(plan.blockers.length);
  assert(!JSON.stringify(plan).includes("private-secret"));
  const pending = await publishingPreparation({ ...clip, review_status: "PENDING" }, null);
  assert(pending.blockers.some((x) => x.includes("approved")));
});
