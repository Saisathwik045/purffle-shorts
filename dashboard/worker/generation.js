import { Problem } from "./domain.js";
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_SUBTITLE_BYTES = 1024 * 1024;
export const STORAGE_BUDGET = 512 * 1024 * 1024;
export const RETENTION_DAYS = 7;
const REPO = "Saisathwik045/purffle-shorts";
export function generationStatus(env) {
  const blockers = [];
  if (env.FREE_TIER_VERIFIED !== "true")
    blockers.push(
      "Account free allowances and stop-spending settings have not been verified. Cloud processing is paused.",
    );
  if (!env.GITHUB_DISPATCH_TOKEN)
    blockers.push(
      "Configure a repository-scoped GitHub token with Actions write permission in the private Site runtime.",
    );
  if (
    !env.WORKER_CONNECTION_VERIFIED_AT ||
    !Number.isFinite(Date.parse(env.WORKER_CONNECTION_VERIFIED_AT)) ||
    Date.now() - Date.parse(env.WORKER_CONNECTION_VERIFIED_AT) > 30 * 86400000
  )
    blockers.push(
      "Verify the private GitHub worker connection and refresh its 30-day verification timestamp.",
    );
  return {
    enabled: !blockers.length,
    blockers,
    storage_budget_bytes: STORAGE_BUDGET,
    max_video_bytes: MAX_VIDEO_BYTES,
    retention_days: RETENTION_DAYS,
  };
}
export function requireGeneration(env) {
  const status = generationStatus(env);
  if (!status.enabled) throw new Problem(status.blockers.join(" "), 503);
}
export async function reserve(db, jobId, count) {
  const bytes = count * (MAX_VIDEO_BYTES + MAX_SUBTITLE_BYTES);
  const row = await db
    .prepare(
      "UPDATE jobs SET storage_reserved=? WHERE id=? AND storage_reserved=0 AND (SELECT COALESCE(SUM(storage_reserved),0) FROM jobs)+?<=? RETURNING id",
    )
    .bind(bytes, jobId, bytes, STORAGE_BUDGET)
    .first();
  if (!row)
    throw new Problem(
      "Private clip storage capacity is reserved. Delete old clips or wait for retention cleanup before retrying.",
      409,
    );
}
export async function charge(db, kind, limit) {
  const month = new Date().toISOString().slice(0, 7);
  const result = await db
    .prepare(
      "INSERT INTO operation_budgets(period,kind,used) VALUES(?,?,1) ON CONFLICT(period,kind) DO UPDATE SET used=used+1 WHERE used<? RETURNING used",
    )
    .bind(month, kind, limit)
    .first();
  if (!result)
    throw new Problem(
      "The conservative cloud operation budget is exhausted. Processing is paused before more storage operations.",
      429,
    );
}
export async function dispatch(env, db, jobId) {
  requireGeneration(env);
  await charge(db, "dispatch", 200);
  const headers = {
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Purffle-Cloud-Dashboard",
  };
  const repo = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!repo.ok)
    throw new Problem(
      "GitHub repository access failed. Check the Actions token; no dispatch was confirmed.",
      502,
    );
  const info = await repo.json();
  if (
    info.private !== false ||
    info.full_name?.toLowerCase() !== REPO.toLowerCase()
  )
    throw new Problem(
      "Cloud generation requires this public repository and a standard free GitHub runner.",
      403,
    );
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/dashboard-worker.yml/dispatches`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: info.default_branch,
        inputs: { job_id: jobId },
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    },
  );
  if (response.status !== 204)
    throw new Problem(
      "GitHub did not confirm the cloud job. Ensure the workflow is merged and Actions permissions/secrets are configured; use safe retry after correcting setup.",
      502,
    );
  await db
    .prepare("UPDATE jobs SET dispatch_status=?,dispatch_error=NULL WHERE id=?")
    .bind("ACCEPTED", jobId)
    .run();
}
export async function cleanup(env, db, { jobId = null } = {}) {
  const date = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const rows = await db
    .prepare(
      jobId
        ? "SELECT c.* FROM clips c WHERE c.job_id=?"
        : "SELECT c.* FROM clips c JOIN jobs j ON j.id=c.job_id WHERE c.created_at<? AND j.state NOT IN ('VALIDATING','TRANSCRIBING','SELECTING_HIGHLIGHTS','RENDERING','GENERATING_METADATA','PUBLISHING') LIMIT 50",
    )
    .bind(jobId || date)
    .all();
  const affected = new Set();
  for (const clip of rows.results) {
    const publication = await db
      .prepare("SELECT id FROM publications WHERE clip_id=?")
      .bind(clip.id)
      .first();
    if (publication) continue;
    affected.add(clip.job_id);
    const keys = [
      clip.video_key,
      clip.subtitle_key,
      `${clip.job_id}/${clip.id}/short.mp4`,
      `${clip.job_id}/${clip.id}/captions.srt`,
    ];
    if (env.BUCKET) await env.BUCKET.delete([...new Set(keys.filter(Boolean))]);
    await db.prepare("DELETE FROM clips WHERE id=?").bind(clip.id).run();
  }
  if (!jobId)
    for (const id of affected) {
      const empty = await db
        .prepare(
          "SELECT id,state,attempt FROM jobs WHERE id=? AND NOT EXISTS(SELECT 1 FROM clips WHERE job_id=?)",
        )
        .bind(id, id)
        .first();
      if (empty && ["READY_FOR_REVIEW", "APPROVED"].includes(empty.state))
        await db.batch([
          db
            .prepare(
              "UPDATE jobs SET state='FAILED',retryable=1,error='Seven-day media retention ended. Processing can be retried with current source rights.',updated_at=? WHERE id=?",
            )
            .bind(new Date().toISOString(), id),
          db
            .prepare(
              "INSERT INTO job_events(job_id,state,message,created_at,attempt) VALUES(?,'FAILED','Generated files removed by seven-day retention. Job history is retained.',?,?)",
            )
            .bind(id, new Date().toISOString(), empty.attempt),
        ]);
    }
  if (jobId)
    await db
      .prepare(
        "UPDATE jobs SET storage_reserved=0 WHERE id=? AND NOT EXISTS(SELECT 1 FROM clips WHERE job_id=?)",
      )
      .bind(jobId, jobId)
      .run();
  else
    await db
      .prepare(
        "UPDATE jobs SET storage_reserved=0 WHERE state NOT IN ('QUEUED','VALIDATING','TRANSCRIBING','SELECTING_HIGHLIGHTS','RENDERING','GENERATING_METADATA','PUBLISHING') AND NOT EXISTS(SELECT 1 FROM clips WHERE clips.job_id=jobs.id)",
      )
      .bind()
      .run();
  return rows.results.length;
}
