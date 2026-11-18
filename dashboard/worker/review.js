import { Problem, hash, currentAuthorization } from "./domain.js";
import { completeMetadata, clipFields } from "./metadata.js";
export async function contentHash(clip) {
  const c = clipFields(clip);
  return hash(JSON.stringify([c.id,c.attempt,c.title,c.description,c.hashtags,c.opening_hook || "",c.source_attribution || "",
    c.commentary_suggestions,c.metadata_version || 1,c.media_revision || 0,c.content_sha256 || "",c.media_etag || ""]));
}
export async function metadataHash(clip) {
  return hash(JSON.stringify([await contentHash(clip),clip.review_status,clip.reviewed_at || null]));
}
export function reviewedMetadata(input) {
  const value = completeMetadata(input); return { title:value.title,description:value.description };
}
export async function expectedMetadata(input, clip) {
  if (typeof input.expected_hash !== "string" || input.expected_hash !== await metadataHash(clip))
    throw new Problem("Clip metadata or review state changed. Refresh before continuing.",409);
}
export async function approvalValid(clip) {
  return clip.review_status === "APPROVED" && !!clip.approval_hash && clip.approval_hash === await contentHash(clip);
}
export async function publishingPreparation(clip, sourceAuthorization, channel = null, time = Date.now()) {
  const metadata = completeMetadata(clipFields(clip),clip);
  const blockers = ["YouTube publishing is disabled. This document cannot authorize or execute an upload."];
  if (!await approvalValid(clip)) blockers.push("The current metadata and video must be approved by the owner.");
  if (!currentAuthorization(sourceAuthorization)) blockers.push("Current source rights have not been recorded.");
  const created=Date.parse(clip.created_at || "");
  if (!Number.isFinite(created)||created>time||time-created>=7*86400000) blockers.push("Clip retention evidence is missing or expired.");
  if (!clip.video_key||!clip.subtitle_key) blockers.push("Private video and subtitle objects must be recorded.");
  if (!channel) blockers.push("No channel is connected.");
  return { schema:"purffle.publish-preparation.v1",upload_enabled:false,execution_authorized:false,
    generated_at:new Date(time).toISOString(),expires_at:new Date(time+600000).toISOString(),
    clip_id:clip.id,job_id:clip.job_id,attempt:clip.attempt,metadata_hash:await metadataHash(clip),
    ...metadata,attribution:sourceAuthorization?.attribution || "",review_status:clip.review_status,
    channel_id:channel?.channel_id || null,proposed_privacy:"private",storage_roundtrip_verified:false,blockers };
}
