import { Problem } from "./domain.js";
import { providerConfiguration, freshHeartbeat, dispatchToProvider } from "./providers.js";
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_SUBTITLE_BYTES = 1024 * 1024;
export const STORAGE_BUDGET = 512 * 1024 * 1024;
export const RETENTION_DAYS = 7;
export async function credentialHash(env) {
  const bytes = new TextEncoder().encode(JSON.stringify([env.WORKER_TOKEN || "", env.WORKER_PROVIDER || "none", env.WORKER_DISPATCH_URL || "", env.WORKER_DISPATCH_HOST || ""]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export async function generationStatus(env, db) {
  const config = providerConfiguration(env);
  const blockers = [...config.blockers];
  if (env.FREE_TIER_VERIFIED !== "true")
    blockers.push("Account storage/hosting free allowances and stop-spending settings have not been verified. Cloud processing is paused.");
  const proof = db
    ? await db
        .prepare(
          "SELECT last_seen,credential_hash,storage_verified_at,last_check_error FROM worker_heartbeats WHERE id=?",
        )
        .bind("cpu")
        .first()
    : null;
  const worker_active = freshHeartbeat(proof?.last_seen);
  if (!worker_active)
    blockers.push("No authenticated worker heartbeat within the last 15 minutes. Generation remains paused.");
  const checked = Date.parse(proof?.storage_verified_at || "");
  const storage_verified =
    !!env.WORKER_TOKEN &&
    proof?.credential_hash === (await credentialHash(env)) &&
    Number.isFinite(checked) &&
    checked <= Date.now() &&
    Date.now() - checked <= 30 * 86400000;
  if (!storage_verified)
    blockers.push(
      "Run the private worker storage verification after confirming free account allowances. A manually supplied timestamp does not verify connectivity or storage.",
    );
  return {
    enabled: !blockers.length,
    blockers,
    provider: config.provider,
    worker_active,
    connection: {
      last_seen: proof?.last_seen || null,
      storage_verified,
      storage_verified_at: storage_verified ? proof.storage_verified_at : null,
      last_check_error: proof?.last_check_error || null,
    },
    storage_budget_bytes: STORAGE_BUDGET,
    max_video_bytes: MAX_VIDEO_BYTES,
    retention_days: RETENTION_DAYS,
  };
}
export async function requireGeneration(env, db) {
  const status = await generationStatus(env, db);
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
  await requireGeneration(env, db);
  await charge(db, "dispatch", 200);
  const job = await db.prepare("SELECT id,attempt FROM jobs WHERE id=? AND state='QUEUED'").bind(jobId).first();
  if (!job) throw new Problem("Only an existing queued job can wake a cloud worker.", 409);
  await dispatchToProvider(env, job);
  await db
    .prepare("UPDATE jobs SET dispatch_status=?,dispatch_error=NULL WHERE id=?")
    .bind("ACCEPTED", jobId)
    .run();
}
export async function cleanup(
  env,
  db,
  { jobId = null, expectedAttempt = null } = {},
) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const targets = jobId
    ? [{ id: jobId }]
    : (
        await db
          .prepare(
            "SELECT DISTINCT j.id FROM jobs j JOIN clips c ON c.job_id=j.id WHERE c.created_at<? AND j.state IN ('FAILED','READY_FOR_REVIEW','APPROVED') AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.clip_id=c.id) LIMIT 10",
          )
          .bind(cutoff)
          .all()
      ).results;
  let removed = 0;
  for (const target of targets) {
    const job = await db
      .prepare("SELECT id,state,attempt FROM jobs WHERE id=?")
      .bind(target.id)
      .first();
    if (!job || (expectedAttempt !== null && job.attempt !== expectedAttempt))
      continue;
    let ownsLock = false;
    if (job.state !== "CREATED") {
      if (!["FAILED", "READY_FOR_REVIEW", "APPROVED"].includes(job.state))
        continue;
      const locked = await db
        .prepare(
          "UPDATE jobs SET state='CREATED' WHERE id=? AND state=? AND attempt=? RETURNING id",
        )
        .bind(job.id, job.state, job.attempt)
        .first();
      if (!locked) continue;
      ownsLock = true;
    } else if (!jobId) continue;
    try {
      const clips = await db
        .prepare(
          "SELECT c.* FROM clips c WHERE c.job_id=? AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.clip_id=c.id)" +
            (jobId ? "" : " AND c.created_at<?"),
        )
        .bind(...(jobId ? [job.id] : [job.id, cutoff]))
        .all();
      for (const clip of clips.results) {
        const keys = [
          clip.video_key,
          clip.subtitle_key,
          `${clip.job_id}/${clip.id}/short.mp4`,
          `${clip.job_id}/${clip.id}/captions.srt`,
        ];
        if (env.BUCKET)
          await env.BUCKET.delete([...new Set(keys.filter(Boolean))]);
        await db.prepare("DELETE FROM clips WHERE id=?").bind(clip.id).run();
        removed++;
      }
      const left = await db
        .prepare("SELECT COUNT(*) n FROM clips WHERE job_id=?")
        .bind(job.id)
        .first();
      if (!left.n)
        await db
          .prepare(
            "UPDATE jobs SET storage_reserved=0 WHERE id=? AND attempt=? AND state='CREATED'",
          )
          .bind(job.id, job.attempt)
          .run();
      if (ownsLock) {
        const expired = !left.n && job.state !== "FAILED";
        await db
          .prepare(
            "UPDATE jobs SET state=?,retryable=CASE WHEN ? THEN 1 ELSE retryable END,error=CASE WHEN ? THEN 'Seven-day media retention ended. Processing can be retried with current source rights.' ELSE error END,updated_at=? WHERE id=? AND attempt=? AND state='CREATED'",
          )
          .bind(
            expired ? "FAILED" : job.state,
            expired ? 1 : 0,
            expired ? 1 : 0,
            new Date().toISOString(),
            job.id,
            job.attempt,
          )
          .run();
        if (expired)
          await db
            .prepare(
              "INSERT INTO job_events(job_id,state,message,created_at,attempt) VALUES(?,'FAILED','Generated files removed by seven-day retention. Job history is retained.',?,?)",
            )
            .bind(job.id, new Date().toISOString(), job.attempt)
            .run();
      }
    } catch (error) {
      if (ownsLock)
        await db
          .prepare(
            "UPDATE jobs SET state='FAILED',retryable=1,error='Private storage cleanup was interrupted. Retry cleanup before processing more media.' WHERE id=? AND attempt=? AND state='CREATED'",
          )
          .bind(job.id, job.attempt)
          .run();
      throw error;
    }
  }
  return removed;
}
