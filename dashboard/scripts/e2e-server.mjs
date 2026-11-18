// Isolated integration harness on a GitHub Linux runner. Never deployed or exposed publicly.
import http from "node:http";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { D1 } from "../tests/support/d1.js";
import worker from "../dist/server/index.js";
const root = resolve(process.env.PURFFLE_E2E_ROOT);
await mkdir(root, { recursive: true });
const db = new D1();
const bucket = {
  async put(key, body) {
    const path = resolve(root, "objects", key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await new Response(body).arrayBuffer()));
  },
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys])
      await rm(resolve(root, "objects", key), { force: true });
  },
  async get(key, opts) {
    let bytes;
    try {
      bytes = await readFile(resolve(root, "objects", key));
    } catch {
      return null;
    }
    const size = bytes.length;
    const range = opts?.range?.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
    let info;
    if (range) {
      const offset = Number(range[1]);
      const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      bytes = bytes.subarray(offset, end + 1);
      info = { offset, length: bytes.length };
    }
    return {
      body: bytes,
      size,
      range: info,
      writeHttpMetadata(headers) {
        headers.set(
          "Content-Type",
          key.endsWith(".mp4") ? "video/mp4" : "application/x-subrip",
        );
      },
    };
  },
};
const env = {
  DB: db,
  BUCKET: bucket,
  WORKER_TOKEN: "synthetic-test-worker",
  // Isolated development/test harness, not provider authorization for production.
    ACTIONS_APP_USE_AUTHORIZED: "true",
    FREE_TIER_VERIFIED: "true",
  GITHUB_DISPATCH_TOKEN: "isolated-test-token",
  WORKER_CONNECTION_VERIFIED_AT: new Date().toISOString(),
};
// Only the GitHub dispatch boundary is stubbed: the actual cloud worker is this CI job.
// No production credentials, Site, YouTube content, transcript, renderer or media are mocked.
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/repos/Saisathwik045/purffle-shorts"))
    return Response.json({
      private: false,
      full_name: "Saisathwik045/purffle-shorts",
      default_branch: "main",
    });
  if (String(url).endsWith("/dispatches"))
    return new Response(null, { status: 204 });
  throw new Error(
    "This isolated fixture does not fetch external source metadata",
  );
};
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    // Test-only identity transport, accepted only by this loopback harness, absent from deployed source.
    if (headers["x-test-owner"])
      headers["oai-authenticated-user-id"] = headers["x-test-owner"];
    const request = new Request(
      `http://127.0.0.1:${server.address().port}${req.url}`,
      {
        method: req.method,
        headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      },
    );
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(0, "127.0.0.1", async () => {
  await writeFile(
    resolve(root, "origin"),
    `http://127.0.0.1:${server.address().port}`,
  );
  console.log("Isolated cloud API and private filesystem object store ready");
});
