import { Problem } from "./domain.js";
import { charge, RETENTION_DAYS } from "./generation.js";

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  const a = match[1] ? Number(match[1]) : null;
  const b = match[2] ? Number(match[2]) : null;
  if (
    (a !== null && !Number.isSafeInteger(a)) ||
    (b !== null && !Number.isSafeInteger(b))
  )
    return null;
  const start = a === null ? Math.max(0, size - b) : a;
  const end = a === null || b === null ? size - 1 : Math.min(b, size - 1);
  if (start >= size || start > end) return null;
  return { offset: start, length: end - start + 1 };
}

export async function serveMedia(request, env, db, clip, kind) {
  if (env.FREE_TIER_VERIFIED !== "true")
    throw new Problem(
      "Private media serving is paused until free storage and operation allowances are verified.",
      503,
    );
  if (Date.now() - Date.parse(clip.created_at) >= RETENTION_DAYS * 86400000)
    throw new Problem(
      "Clip media retention has ended. Open Source & history to remove old files and regenerate with current source authorization.",
      410,
    );
  const key = kind === "video" ? clip.video_key : clip.subtitle_key;
  if (!key || !env.BUCKET)
    throw new Problem(
      "Clip file is unavailable in private cloud storage. Open Source & history to review cleanup and retry options.",
      410,
    );
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type":
      kind === "video" ? "video/mp4" : "application/x-subrip; charset=utf-8",
    "Accept-Ranges": "bytes",
  });
  if (kind === "subtitles")
    headers.set("Content-Disposition", `attachment; filename="${clip.id}.srt"`);
  const read = async (method, ...args) => {
    await charge(db, "r2-read", 10000);
    return env.BUCKET[method](key, ...args);
  };
  const missing = () =>
    new Problem(
      "Clip file is missing from private storage. Open Source & history to review cleanup and retry options.",
      410,
    );
  // HEAD is metadata-only. Range requests are normalized before touching the body.
  if (request.method === "HEAD") {
    const object = await read("head");
    if (!object) throw missing();
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers });
  }
  let range;
  const requested = request.headers.has("If-Range")
    ? null
    : request.headers.get("Range");
  if (requested !== null) {
    const object = await read("head");
    if (!object) throw missing();
    range = byteRange(requested, object.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${object.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(range.length));
  }
  const object = await read("get", range ? { range } : undefined);
  if (!object) throw missing();
  if (!range) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
