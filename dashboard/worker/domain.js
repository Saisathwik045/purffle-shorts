export const STATES = [
  "CREATED",
  "VALIDATING",
  "AWAITING_SOURCE_AUTHORIZATION",
  "QUEUED",
  "TRANSCRIBING",
  "SELECTING_HIGHLIGHTS",
  "RENDERING",
  "GENERATING_METADATA",
  "READY_FOR_REVIEW",
  "APPROVED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
];
export const ACTIVE = [
  "VALIDATING",
  "TRANSCRIBING",
  "SELECTING_HIGHLIGHTS",
  "RENDERING",
  "GENERATING_METADATA",
];
export const STAGES = {
  VALIDATING: ["TRANSCRIBING", "FAILED"],
  TRANSCRIBING: ["SELECTING_HIGHLIGHTS", "FAILED"],
  SELECTING_HIGHLIGHTS: ["RENDERING", "FAILED"],
  RENDERING: ["GENERATING_METADATA", "FAILED"],
  GENERATING_METADATA: ["READY_FOR_REVIEW", "FAILED"],
};
export const DEFAULTS = {
  caption_style: "bold",
  language: "en",
  count: 3,
  duration: 40,
  aspect: "9:16",
};
export class Problem extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function youtubeURL(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Problem("Enter a complete YouTube video or livestream URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    throw new Problem(
      "Use an HTTPS YouTube URL without credentials or a custom port.",
    );
  let id;
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else
      id = u.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})\/?$/)?.[1];
  }
  if (!/^[\w-]{11}$/.test(id || ""))
    throw new Problem(
      "Use a specific YouTube video, Shorts or /live/ URL. Channel, playlist and shortened redirect links are not supported.",
    );
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}
export function options(value = {}) {
  const o = { ...DEFAULTS, ...value };
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > 10)
    throw new Problem("Choose between 1 and 10 clips.");
  if (!Number.isInteger(o.duration) || o.duration < 15 || o.duration > 60)
    throw new Problem("Choose a preferred duration from 15 to 60 seconds.");
  if (!["9:16", "1:1", "16:9"].includes(o.aspect))
    throw new Problem("Choose a supported aspect ratio.");
  if (
    !["bold", "boxed", "neon", "clean", "karaoke", "minimal"].includes(
      o.caption_style,
    )
  )
    throw new Problem("Choose a supported caption style.");
  if (
    ![
      "en",
      "hi",
      "es",
      "fr",
      "de",
      "pt",
      "ja",
      "ko",
      "ar",
      "it",
      "te",
      "ta",
    ].includes(o.language)
  )
    throw new Problem(
      "Choose a supported spoken subtitle language. Subtitles transcribe speech; translation is not included.",
    );
  return {
    count: o.count,
    duration: o.duration,
    aspect: o.aspect,
    caption_style: o.caption_style,
    language: o.language,
    category: String(o.category || "").slice(0, 80),
  };
}
export function authorization(input, reviewer, now = new Date()) {
  if (!input || input.approved !== true) return null;
  if (
    !["owned", "written-permission", "CC0-1.0", "CC-BY-4.0"].includes(
      input.license,
    )
  )
    throw new Problem(
      "Choose ownership, written permission, CC0 or CC BY 4.0 and provide evidence.",
    );
  if (input.method !== "direct_https")
    throw new Problem(
      "Use an authorized direct HTTPS media file. A YouTube watch page is not a permitted download method.",
    );
  let u;
  try {
    u = new URL(input.media_url);
  } catch {
    throw new Problem("Provide the authorized direct media-file URL.");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !u.hostname.includes(".") ||
    /[\[\]:]/.test(u.hostname) ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname)
  )
    throw new Problem(
      "Use a public HTTPS media URL without redirects, credentials, query strings, IP addresses or private hostnames.",
    );
  if (
    ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(
      u.hostname,
    )
  )
    throw new Problem(
      "Provide a media file supplied by the rights holder, not a YouTube watch link.",
    );
  if (!/^[a-f0-9]{64}$/.test(input.sha256 || ""))
    throw new Problem(
      "Provide the media file’s 64-character lowercase SHA-256 checksum.",
    );
  if (
    typeof input.evidence !== "string" ||
    input.evidence.trim().length < 10 ||
    input.evidence.length > 4000
  )
    throw new Problem(
      "Add specific rights evidence (10–4000 characters), including the scope of permission.",
    );
  if (
    typeof input.attribution !== "string" ||
    !input.attribution.trim() ||
    input.attribution.length > 1200
  )
    throw new Problem(
      "Add complete attribution (up to 1200 characters), including license and edits where required.",
    );
  if (
    input.all_components_cleared !== true ||
    input.platform_download_permitted !== true
  )
    throw new Problem(
      "Confirm rights for all footage, guests and audio, and permission for this media access method.",
    );
  if (
    input.expires_on &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(input.expires_on) ||
      !Number.isFinite(Date.parse(input.expires_on)) ||
      input.expires_on < now.toISOString().slice(0, 10))
  )
    throw new Problem(
      "Permission must have a valid current or future expiry date.",
    );
  return {
    approved: true,
    license: input.license,
    method: "direct_https",
    media_url: u.href,
    sha256: input.sha256,
    evidence: input.evidence.trim(),
    attribution: input.attribution.trim(),
    all_components_cleared: true,
    platform_download_permitted: true,
    reviewed_by: reviewer,
    reviewed_on: now.toISOString().slice(0, 10),
    expires_on: input.expires_on || null,
  };
}
export function currentAuthorization(auth) {
  return (
    !!auth?.approved &&
    (!auth.expires_on ||
      auth.expires_on >= new Date().toISOString().slice(0, 10))
  );
}
export function canRetry(job) {
  return (
    job.state === "FAILED" &&
    job.retryable === 1 &&
    currentAuthorization(job.authorization)
  );
}
export function parseJob(row) {
  if (!row) return null;
  return {
    ...row,
    options: JSON.parse(row.options),
    authorization: row.authorization ? JSON.parse(row.authorization) : null,
    lease_id: undefined,
    fingerprint: undefined,
  };
}
export async function hash(text) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
