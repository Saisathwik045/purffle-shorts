import test from "node:test";
import assert from "node:assert/strict";
import { D1 } from "./support/d1.js";
import { serveMedia } from "../worker/media.js";
const bytes = new TextEncoder().encode("0123456789");
function setup() {
  const calls = [];
  const env = {
    FREE_TIER_VERIFIED: "true",
    BUCKET: {
      async head() {
        calls.push("head");
        return { size: bytes.length };
      },
      async get(_key, options) {
        calls.push("get");
        const r = options?.range;
        return {
          size: bytes.length,
          body: r ? bytes.slice(r.offset, r.offset + r.length) : bytes,
        };
      },
    },
  };
  const db = new D1();
  const clip = {
    id: "private-clip",
    video_key: "private/key.mp4",
    subtitle_key: "private/key.srt",
    created_at: new Date().toISOString(),
  };
  return {
    calls,
    env,
    db,
    clip,
    serve(method = "GET", headers = {}) {
      return serveMedia(
        new Request("https://private.test/api/clips/private-clip/video", {
          method,
          headers,
        }),
        env,
        db,
        clip,
        "video",
      );
    },
  };
}
test("full and HEAD previews have stable private metadata without HEAD body reads", async () => {
  const t = setup();
  const head = await t.serve("HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.deepEqual(t.calls, ["head"]);
  const full = await t.serve();
  assert.equal(await full.text(), "0123456789");
  assert.equal(full.headers.get("Content-Type"), "video/mp4");
  assert.equal(full.headers.get("Cache-Control"), "private, no-store");
  assert.equal(full.headers.get("Access-Control-Allow-Origin"), null);
});
test("bounded, open-ended, suffix and clamped ranges return exact bytes", async () => {
  for (const [range, body, contentRange] of [
    ["bytes=0-0", "0", "bytes 0-0/10"],
    ["bytes=4-", "456789", "bytes 4-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-30", "0123456789", "bytes 0-9/10"],
    ["bytes=7-30", "789", "bytes 7-9/10"],
  ]) {
    const t = setup();
    const response = await t.serve("GET", { Range: range });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
  }
});
test("invalid and unsatisfiable ranges return 416 without reading object bodies", async () => {
  for (const range of [
    "bytes=10-",
    "bytes=-0",
    "bytes=9-3",
    "bytes=",
    "bytes=0-1,4-5",
    "items=0-1",
    "bytes=999999999999999999999-",
    "bytes=-",
  ]) {
    const t = setup();
    const response = await t.serve("GET", { Range: range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("Content-Range"), "bytes */10");
    assert.deepEqual(t.calls, ["head"]);
  }
});
test("If-Range safely falls back to full private response without a matching validator", async () => {
  const response = await setup().serve("GET", {
    Range: "bytes=0-1",
    "If-Range": "old-etag",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "0123456789");
});
test("expired, missing and unverified media fail before unsafe playback", async () => {
  const t = setup();
  t.clip.created_at = new Date(Date.now() - 8 * 86400000).toISOString();
  await assert.rejects(t.serve(), (e) => e.status === 410);
  assert.deepEqual(t.calls, []);
  t.clip.created_at = new Date().toISOString();
  t.env.BUCKET.head = async () => null;
  await assert.rejects(t.serve("HEAD"), (e) => e.status === 410);
  t.env.FREE_TIER_VERIFIED = "false";
  await assert.rejects(t.serve(), (e) => e.status === 503);
});
test("metadata and body fetches both consume the shared persisted read budget", async () => {
  const t = setup();
  t.db.db
    .prepare("INSERT INTO operation_budgets(period,kind,used) VALUES(?,?,9999)")
    .run(new Date().toISOString().slice(0, 7), "r2-read");
  await assert.rejects(
    t.serve("GET", { Range: "bytes=0-1" }),
    (e) => e.status === 429,
  );
  assert.deepEqual(t.calls, ["head"]);
});
