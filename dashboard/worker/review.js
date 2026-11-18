import { Problem, hash, currentAuthorization } from "./domain.js";
export async function metadataHash(clip) {
  return hash(JSON.stringify([clip.id, clip.attempt, clip.title, clip.description, clip.review_status, clip.reviewed_at || null]));
}
export function reviewedMetadata(input) {
  if (!input || typeof input.title !== "string" || typeof input.description !== "string")
    throw new Problem("Title and description must be text.");
  const title = input.title.trim(), description = input.description.trim();
  if (!title || [...title].length > 100 || /[<>\r\n\u0000-\u001f]/.test(title))
    throw new Problem("Use a title of 1–100 characters without angle brackets or control characters.");
  if ([...description].length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description))
    throw new Problem("Use a description of at most 5,000 characters without control characters.");
  return { title, description };
}
export async function expectedMetadata(input, clip) {
  if (typeof input.expected_hash !== "string" || input.expected_hash !== await metadataHash(clip))
    throw new Problem("Clip metadata or review state changed. Refresh before continuing.", 409);
}
export async function publishingPreparation(clip, sourceAuthorization, channel = null, time = Date.now()) {
  const metadata = reviewedMetadata(clip);
  const blockers = ["YouTube publishing is disabled. This document cannot authorize or execute an upload."];
  if (clip.review_status !== "APPROVED") blockers.push("The current metadata must be approved by the owner.");
  if (!currentAuthorization(sourceAuthorization)) blockers.push("Current source rights have not been recorded.");
  const created = Date.parse(clip.created_at || "");
  if (!Number.isFinite(created) || created > time || time - created >= 7 * 86400000)
    blockers.push("The clip is missing valid, unexpired media retention evidence.");
  if (!clip.video_key || !clip.subtitle_key) blockers.push("Both private video and subtitle objects must be recorded.");
  if (!channel) blockers.push("No channel is connected. Do not add credentials to this document.");
  return {
    schema: "purffle.publish-preparation.v1",
    upload_enabled: false,
    execution_authorized: false,
    generated_at: new Date(time).toISOString(),
    expires_at: new Date(time + 10 * 60000).toISOString(),
    clip_id: clip.id,
    job_id: clip.job_id,
    attempt: clip.attempt,
    metadata_hash: await metadataHash(clip),
    ...metadata,
    attribution: sourceAuthorization?.attribution || "",
    review_status: clip.review_status,
    channel_id: channel?.channel_id || null,
    proposed_privacy: "private",
    storage_roundtrip_verified: false,
    blockers,
  };
}
