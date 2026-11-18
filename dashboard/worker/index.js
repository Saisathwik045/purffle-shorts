import {
  generationStatus,
  requireGeneration,
  reserve,
  charge,
  dispatch,
  cleanup,
  MAX_VIDEO_BYTES,
  MAX_SUBTITLE_BYTES,
} from "./generation.js";
import {
  ACTIVE,
  STAGES,
  DEFAULTS,
  Problem,
  youtubeURL,
  options,
  authorization,
  currentAuthorization,
  parseJob,
  hash,
} from "./domain.js";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const one = (db, sql, ...args) =>
  db
    .prepare(sql)
    .bind(...args)
    .first();
const all = async (db, sql, ...args) =>
  (
    await db
      .prepare(sql)
      .bind(...args)
      .all()
  ).results;
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const event = (db, id, state, message, attempt = 1) =>
  statement(
    db,
    "INSERT INTO job_events(job_id,state,message,created_at,attempt) VALUES(?,?,?,?,?)",
    id,
    state,
    message,
    now(),
    attempt,
  );
const ownerJob = async (db, id, owner) => {
  const j = parseJob(
    await one(db, "SELECT * FROM jobs WHERE id=? AND owner=?", id, owner),
  );
  if (!j) throw new Problem("Job not found.", 404);
  return j;
};
async function body(request, max = 20000) {
  if (Number(request.headers.get("content-length") || 0) > max)
    throw new Problem("Request too large.", 413);
  const text = await request.text();
  if (text.length > max) throw new Problem("Request too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new Problem("Send valid JSON.");
  }
}
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin)
    throw new Problem("This action must originate from your dashboard.", 403);
}
async function workerAuth(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (
    !env.WORKER_TOKEN ||
    !token ||
    (await hash(token)) !== (await hash(env.WORKER_TOKEN))
  )
    throw new Problem("Cloud worker authorization required.", 401);
}
async function lease(db, id, token) {
  const j = await one(
    db,
    "SELECT * FROM jobs WHERE id=? AND lease_id=? AND lease_expires>?",
    id,
    token || "",
    now(),
  );
  if (!j || !ACTIVE.includes(j.state))
    throw new Problem(
      "Worker lease is invalid or expired; do not retry publishing.",
      409,
    );
  return parseJob(j);
}
async function metadata(url) {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(6000), redirect: "error" },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return {
      title: String(d.title || "").slice(0, 300),
      thumbnail: String(d.thumbnail_url || ""),
      author: String(d.author_name || "").slice(0, 120),
    };
  } catch {
    return null;
  }
}
async function secretKey(env) {
  if (!env.TOKEN_ENCRYPTION_KEY)
    throw new Problem(
      "YouTube connection needs an encryption key configured by the cloud administrator.",
      503,
    );
  let bytes;
  try {
    bytes = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new Problem(
      "YouTube token encryption is not configured correctly.",
      503,
    );
  }
  if (bytes.length !== 32)
    throw new Problem("YouTube token encryption requires a 32-byte key.", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptTokens(env, tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await secretKey(env),
    new TextEncoder().encode(JSON.stringify(tokens)),
  );
  return JSON.stringify({ iv: [...iv], data: [...new Uint8Array(encrypted)] });
}
async function launch(env, db, id, count, attempt = 1, reset = false) {
  try {
    requireGeneration(env);
    if (reset) await cleanup(env, db, { jobId: id, expectedAttempt: attempt });
    await reserve(db, id, count);
  } catch (error) {
    await db.batch([
      statement(
        db,
        "UPDATE jobs SET state='FAILED',error=?,retryable=1 WHERE id=?",
        error.message,
        id,
      ),
      event(db, id, "FAILED", error.message, attempt),
    ]);
    return { state: "FAILED", dispatch_status: "BLOCKED" };
  }
  await db.batch([
    statement(
      db,
      "UPDATE jobs SET state='QUEUED',updated_at=?,dispatch_status='PENDING' WHERE id=?",
      now(),
      id,
    ),
    event(
      db,
      id,
      "QUEUED",
      "Storage reserved. Requesting a standard public GitHub Linux worker.",
      attempt,
    ),
  ]);
  try {
    await dispatch(env, db, id);
  } catch (error) {
    // A dispatch timeout can be ambiguous. Keep one queued job and permit only another wake request.
    await statement(
      db,
      "UPDATE jobs SET dispatch_status='UNCONFIRMED',dispatch_error=? WHERE id=?",
      error.message,
      id,
    ).run();
    await event(
      db,
      id,
      "QUEUED",
      "Worker dispatch was not confirmed. Check connection settings and retry waking this same job.",
      attempt,
    ).run();
    return { state: "QUEUED", dispatch_status: "UNCONFIRMED" };
  }
  return { state: "QUEUED", dispatch_status: "ACCEPTED" };
}
export async function api(request, env) {
  const url = new URL(request.url),
    path = url.pathname,
    db = env.DB;
  if (!db)
    throw new Problem(
      "Persistent cloud database is not bound. No job has been accepted.",
      503,
    );
  if (path.startsWith("/api/worker/")) {
    await workerAuth(request, env);
    if (request.method === "POST" && path === "/api/worker/health") {
      await body(request);
      const checked_at = now();
      await statement(
        db,
        "INSERT INTO worker_heartbeats(id,last_seen) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen",
        "cpu",
        checked_at,
      ).run();
      return json({
        connected: true,
        checked_at,
        storage_bound: !!env.BUCKET,
        publishing_enabled: false,
      });
    }
    if (request.method === "POST" && path === "/api/worker/claim") {
      requireGeneration(env);
      const claimInput = await body(request);
      await cleanup(env, db);
      await statement(
        db,
        "INSERT INTO worker_heartbeats(id,last_seen) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen",
        "cpu",
        now(),
      ).run();
      // Expired leases fail visibly. Only a human can request a safe processing retry.
      const expired = await all(
        db,
        `SELECT id,attempt FROM jobs WHERE state IN ('VALIDATING','TRANSCRIBING','SELECTING_HIGHLIGHTS','RENDERING','GENERATING_METADATA') AND lease_expires<?`,
        now(),
      );
      for (const j of expired)
        await db.batch([
          statement(
            db,
            "UPDATE jobs SET state='FAILED',error='Cloud worker stopped reporting before completion. Review and retry processing.',retryable=1,lease_id=NULL,updated_at=? WHERE id=? AND lease_expires<?",
            now(),
            j.id,
            now(),
          ),
          event(
            db,
            j.id,
            "FAILED",
            "Worker lease expired; processing can be retried after review.",
            j.attempt,
          ),
        ]);
      const expiredRights = await all(
        db,
        "SELECT id,attempt FROM jobs WHERE state='QUEUED' AND json_extract(authorization,'$.expires_on')<?",
        now().slice(0, 10),
      );
      for (const j of expiredRights)
        await db.batch([
          statement(
            db,
            "UPDATE jobs SET state='AWAITING_SOURCE_AUTHORIZATION',storage_reserved=0,updated_at=? WHERE id=? AND state='QUEUED'",
            now(),
            j.id,
          ),
          event(
            db,
            j.id,
            "AWAITING_SOURCE_AUTHORIZATION",
            "Source permission expired before processing. Record current authorization to queue again.",
            j.attempt,
          ),
        ]);
      const claim = uuid();
      const row = await one(
        db,
        `UPDATE jobs SET state='VALIDATING',lease_id=?,lease_expires=?,updated_at=? WHERE id=(SELECT id FROM jobs WHERE state='QUEUED' AND storage_reserved>0 AND (?='' OR id=?) AND json_extract(authorization,'$.approved')=1 AND (json_extract(authorization,'$.expires_on') IS NULL OR json_extract(authorization,'$.expires_on')>=?) ORDER BY created_at LIMIT 1) AND state='QUEUED' RETURNING *`,
        claim,
        new Date(Date.now() + 45 * 60000).toISOString(),
        now(),
        String(claimInput.job_id || ""),
        String(claimInput.job_id || ""),
        now().slice(0, 10),
      );
      if (!row) return json({ job: null });
      await event(
        db,
        row.id,
        "VALIDATING",
        "CPU worker claimed this job. Validating the authorized media file before transcription.",
        row.attempt,
      ).run();
      if (
        claimInput.runner_url &&
        /^https:\/\/github\.com\/Saisathwik045\/purffle-shorts\/actions\/runs\/\d+$/.test(
          claimInput.runner_url,
        )
      )
        await statement(
          db,
          "UPDATE jobs SET runner_url=? WHERE id=?",
          claimInput.runner_url,
          row.id,
        ).run();
      return json({ job: { ...parseJob(row), lease_id: claim } });
    }
    const match = path.match(
      /^\/api\/worker\/jobs\/([\w-]+)\/(stage|clips|complete|fail)$/,
    );
    const upload = path.match(
      /^\/api\/worker\/jobs\/([\w-]+)\/clips\/([\w-]+)\/(video|subtitles)$/,
    );
    if (upload && request.method === "PUT") {
      requireGeneration(env);
      const j = await lease(db, upload[1], request.headers.get("x-job-lease"));
      if (j.state !== "GENERATING_METADATA")
        throw new Problem(
          "Files can be saved only during metadata finalization.",
          409,
        );
      const c = await one(
        db,
        "SELECT * FROM clips WHERE id=? AND job_id=? AND attempt=?",
        upload[2],
        j.id,
        j.attempt,
      );
      if (!c) throw new Problem("Clip not found.", 404);
      if (!env.BUCKET)
        throw new Problem("Private clip storage is not configured.", 503);
      const video = upload[3] === "video",
        limit = video ? MAX_VIDEO_BYTES : MAX_SUBTITLE_BYTES;
      const size = Number(request.headers.get("content-length"));
      if (!size || size > limit)
        throw new Problem("Clip file exceeds the permitted upload size.", 413);
      if (
        j.storage_reserved <
        j.options.count * (MAX_VIDEO_BYTES + MAX_SUBTITLE_BYTES)
      )
        throw new Problem("Clip storage was not reserved.", 409);
      await charge(db, "r2-write", 2000);
      const key = `${j.id}/${c.id}/${video ? "short.mp4" : "captions.srt"}`;
      await env.BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType: video ? "video/mp4" : "application/x-subrip",
        },
      });
      try {
        await lease(db, j.id, request.headers.get("x-job-lease"));
      } catch (error) {
        await env.BUCKET.delete(key);
        throw error;
      }
      await statement(
        db,
        `UPDATE clips SET ${video ? "video_key" : "subtitle_key"}=? WHERE id=?`,
        key,
        c.id,
      ).run();
      return json({ saved: true });
    }
    if (match && request.method === "POST") {
      if (match[2] === "complete") {
        const done = await one(
          db,
          "SELECT state FROM jobs WHERE id=?",
          match[1],
        );
        if (done?.state === "READY_FOR_REVIEW")
          return json({ state: done.state });
      }
      const j = await lease(db, match[1], request.headers.get("x-job-lease")),
        input = await body(request);
      if (match[2] === "stage") {
        if (input.state === j.state) return json({ state: j.state });
        if (
          !STAGES[j.state]?.includes(input.state) ||
          input.state === "FAILED" ||
          input.state === "READY_FOR_REVIEW"
        )
          throw new Problem("Invalid processing state transition.", 409);
        await db.batch([
          statement(
            db,
            "UPDATE jobs SET state=?,updated_at=? WHERE id=? AND lease_id=? AND state=?",
            input.state,
            now(),
            j.id,
            request.headers.get("x-job-lease"),
            j.state,
          ),
          event(
            db,
            j.id,
            input.state,
            String(input.message || "Cloud worker entered this stage.").slice(
              0,
              500,
            ),
            j.attempt,
          ),
        ]);
        return json({ state: input.state });
      }
      if (match[2] === "fail") {
        await db.batch([
          statement(
            db,
            "UPDATE jobs SET state='FAILED',error=?,retryable=1,lease_id=NULL,updated_at=? WHERE id=? AND lease_id=?",
            String(input.error || "Cloud processing failed.").slice(0, 1500),
            now(),
            j.id,
            request.headers.get("x-job-lease"),
          ),
          event(
            db,
            j.id,
            "FAILED",
            "Cloud processing failed. Review the error before retrying.",
            j.attempt,
          ),
        ]);
        await cleanup(env, db, { jobId: j.id, expectedAttempt: j.attempt });
        return json({ state: "FAILED" });
      }
      if (j.state !== "GENERATING_METADATA")
        throw new Problem(
          "Finish rendering before saving generated clips.",
          409,
        );
      if (match[2] === "clips") {
        if (
          !Number.isInteger(input.position) ||
          input.position < 1 ||
          input.position > j.options.count ||
          typeof input.title !== "string" ||
          !input.title.trim() ||
          !Number.isFinite(input.duration) ||
          input.duration <= 0 ||
          input.duration > 180
        )
          throw new Problem("Invalid generated clip metadata.");
        const previous = await one(
          db,
          "SELECT id FROM clips WHERE job_id=? AND attempt=? AND position=?",
          j.id,
          j.attempt,
          input.position,
        );
        if (previous) return json({ id: previous.id });
        const id = uuid();
        await statement(
          db,
          "INSERT INTO clips(id,job_id,owner,attempt,position,title,description,duration,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          j.id,
          j.owner,
          j.attempt,
          input.position,
          input.title.slice(0, 100),
          String(input.description || "").slice(0, 3500) +
            "\n\n" +
            j.authorization.attribution,
          input.duration,
          now(),
        ).run();
        return json({ id }, 201);
      }
      const clips = await all(
        db,
        "SELECT * FROM clips WHERE job_id=? AND attempt=?",
        j.id,
        j.attempt,
      );
      if (!clips.length || clips.some((c) => !c.video_key || !c.subtitle_key))
        throw new Problem(
          "All generated clips need video and subtitle files before review.",
          409,
        );
      await db.batch([
        statement(
          db,
          "UPDATE jobs SET state='READY_FOR_REVIEW',lease_id=NULL,updated_at=? WHERE id=? AND lease_id=?",
          now(),
          j.id,
          request.headers.get("x-job-lease"),
        ),
        event(
          db,
          j.id,
          "READY_FOR_REVIEW",
          `${clips.length} clip(s) saved to private cloud storage. Publishing is disabled.`,
          j.attempt,
        ),
      ]);
      return json({ state: "READY_FOR_REVIEW" });
    }
    throw new Problem("Worker endpoint not found.", 404);
  }
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner)
    throw new Problem("Sign in to access your private dashboard.", 401);
  if (!["GET", "HEAD"].includes(request.method)) sameOrigin(request);
  if (path === "/api/bootstrap" && request.method === "GET") {
    const jobs = (
      await all(
        db,
        "SELECT * FROM jobs WHERE owner=? ORDER BY updated_at DESC LIMIT 200",
        owner,
      )
    ).map(parseJob);
    const clips = await all(
      db,
      "SELECT c.* FROM clips c JOIN jobs j ON j.id=c.job_id AND j.attempt=c.attempt WHERE c.owner=? AND j.state IN ('READY_FOR_REVIEW','APPROVED','PUBLISHING','PUBLISHED') ORDER BY c.created_at DESC LIMIT 500",
      owner,
    );
    const publications = await all(
      db,
      "SELECT p.*,c.title FROM publications p JOIN clips c ON c.id=p.clip_id WHERE p.owner=? ORDER BY p.created_at DESC LIMIT 200",
      owner,
    );
    const account = await one(
      db,
      "SELECT channel_id,channel_title,connected_at FROM youtube_accounts WHERE owner=?",
      owner,
    );
    const preferences = await one(
      db,
      "SELECT preferences FROM settings WHERE owner=?",
      owner,
    );
    const heartbeat = await one(
      db,
      "SELECT last_seen FROM worker_heartbeats WHERE id=?",
      "cpu",
    );
    return json({
      jobs,
      clips,
      publications,
      account,
      preferences: preferences ? JSON.parse(preferences.preferences) : DEFAULTS,
      worker: heartbeat || null,
      publishing_enabled: false,
      generation: generationStatus(env),
      oauth_configured: !!(
        env.GOOGLE_CLIENT_ID &&
        env.GOOGLE_CLIENT_SECRET &&
        env.TOKEN_ENCRYPTION_KEY
      ),
      user: {
        name:
          request.headers.get("oai-authenticated-user-email") ||
          "Workspace owner",
      },
    });
  }
  if (path === "/api/metadata" && request.method === "GET") {
    const source = youtubeURL(url.searchParams.get("url"));
    return json({
      source,
      ...(await metadata(source.url)),
      permission_granted: false,
    });
  }
  if (path === "/api/jobs" && request.method === "POST") {
    const input = await body(request),
      source = youtubeURL(input.url),
      opts = options(input.options);
    if (!["video", "livestream"].includes(input.source_kind))
      throw new Problem("Choose video or livestream.");
    const auth = authorization(input.authorization, owner);
    if (auth) requireGeneration(env);
    const fingerprint = await hash(JSON.stringify([source.url, opts]));
    const existing = await one(
      db,
      "SELECT id,state FROM jobs WHERE owner=? AND fingerprint=?",
      owner,
      fingerprint,
    );
    if (existing)
      return json(
        {
          error:
            "This source and these clip settings already have a job. Open it to review progress or retry a safe failure.",
          existing_job: existing.id,
        },
        409,
      );
    const id = uuid(),
      stamp = now(),
      meta = await metadata(source.url),
      state = auth ? "CREATED" : "AWAITING_SOURCE_AUTHORIZATION";
    try {
      await db.batch([
        statement(
          db,
          "INSERT INTO jobs(id,owner,fingerprint,source_url,source_kind,title,thumbnail,options,authorization,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          owner,
          fingerprint,
          source.url,
          input.source_kind,
          meta?.title || `YouTube ${input.source_kind} · ${source.id}`,
          `https://i.ytimg.com/vi/${source.id}/hqdefault.jpg`,
          JSON.stringify(opts),
          auth ? JSON.stringify(auth) : null,
          state,
          stamp,
          stamp,
        ),
        event(db, id, "CREATED", "Job created."),
        event(
          db,
          id,
          "VALIDATING",
          "YouTube URL and clipping settings validated. Metadata is not proof of permission.",
        ),
        event(
          db,
          id,
          state,
          auth
            ? "Rights evidence and permitted media-access method recorded. Waiting for a CPU worker."
            : "Add source authorization evidence and an authorized media-file URL before this job can enter the queue.",
        ),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        return json(
          {
            error:
              "A duplicate job was created by another request. Refresh to open it.",
          },
          409,
        );
      throw error;
    }
    const result = auth ? await launch(env, db, id, opts.count) : { state };
    return json({ id, ...result }, 201);
  }
  const jobRoute = path.match(
    /^\/api\/jobs\/([\w-]+)(?:\/(authorization|retry|dispatch|cleanup))?$/,
  );
  if (jobRoute) {
    const j = await ownerJob(db, jobRoute[1], owner);
    if (request.method === "GET" && !jobRoute[2])
      return json({
        job: j,
        events: await all(
          db,
          "SELECT * FROM job_events WHERE job_id=? ORDER BY id",
          j.id,
        ),
      });
    if (request.method === "POST" && jobRoute[2] === "dispatch") {
      if (j.state !== "QUEUED")
        throw new Problem(
          "Only a queued job can request another worker wake. Active work is not duplicated.",
          409,
        );
      requireGeneration(env);
      if (!j.storage_reserved) await reserve(db, j.id, j.options.count);
      await dispatch(env, db, j.id);
      return json({ state: j.state, dispatch_status: "ACCEPTED" });
    }
    if (request.method === "POST" && jobRoute[2] === "cleanup") {
      if (!["FAILED", "READY_FOR_REVIEW", "APPROVED"].includes(j.state))
        throw new Problem("Only inactive jobs can be cleaned up.", 409);
      const locked = await one(
        db,
        "UPDATE jobs SET state='CREATED' WHERE id=? AND owner=? AND state=? AND attempt=? RETURNING id",
        j.id,
        owner,
        j.state,
        j.attempt,
      );
      if (!locked)
        throw new Problem(
          "This job changed. Refresh before removing its files.",
          409,
        );
      try {
        await cleanup(env, db, { jobId: j.id, expectedAttempt: j.attempt });
      } catch (error) {
        await statement(
          db,
          "UPDATE jobs SET state='FAILED',retryable=1,error='Private file cleanup was interrupted. Retry cleanup before processing.' WHERE id=? AND attempt=? AND state='CREATED'",
          j.id,
          j.attempt,
        ).run();
        throw error;
      }
      await db.batch([
        statement(
          db,
          "UPDATE jobs SET state='FAILED',retryable=1,error='Generated files removed by owner. Processing can be retried with current authorization.',updated_at=? WHERE id=? AND attempt=? AND state='CREATED'",
          now(),
          j.id,
          j.attempt,
        ),
        event(
          db,
          j.id,
          "FAILED",
          "Generated files removed by the owner; job history is retained.",
          j.attempt,
        ),
      ]);
      return json({ deleted: true });
    }
    if (request.method === "POST" && jobRoute[2] === "authorization") {
      requireGeneration(env);
      if (j.state !== "AWAITING_SOURCE_AUTHORIZATION")
        throw new Problem(
          "Only jobs awaiting authorization can be authorized.",
          409,
        );
      const auth = authorization(await body(request), owner);
      if (!auth)
        throw new Problem("Explicit source authorization is required.");
      const updated = await one(
        db,
        "UPDATE jobs SET authorization=?,state='CREATED',updated_at=? WHERE id=? AND owner=? AND state='AWAITING_SOURCE_AUTHORIZATION' RETURNING id",
        JSON.stringify(auth),
        now(),
        j.id,
        owner,
      );
      if (!updated)
        throw new Problem(
          "Source authorization was already updated. Refresh this job.",
          409,
        );
      await event(
        db,
        j.id,
        "VALIDATING",
        "Source rights and permitted media access recorded. Reserving cloud capacity.",
        j.attempt,
      ).run();
      return json(
        await launch(env, db, j.id, j.options.count, j.attempt, true),
      );
    }
    if (request.method === "POST" && jobRoute[2] === "retry") {
      if (j.state !== "FAILED" || j.retryable !== 1)
        throw new Problem(
          "Only safe failed processing can be retried. Publishing is never retried automatically.",
          409,
        );
      if (!currentAuthorization(j.authorization)) {
        const waiting = await one(
          db,
          "UPDATE jobs SET state='AWAITING_SOURCE_AUTHORIZATION',attempt=attempt+1,error=NULL,retryable=0,lease_id=NULL,lease_expires=NULL,updated_at=? WHERE id=? AND owner=? AND state='FAILED' AND attempt=? RETURNING id",
          now(),
          j.id,
          owner,
          j.attempt,
        );
        if (!waiting)
          throw new Problem(
            "This job was already updated. Refresh its status.",
            409,
          );
        await event(
          db,
          j.id,
          "AWAITING_SOURCE_AUTHORIZATION",
          "Source permission expired. Record current authorization before retrying processing.",
          j.attempt + 1,
        ).run();
        return json({ state: "AWAITING_SOURCE_AUTHORIZATION" });
      }
      requireGeneration(env);
      // Claim retry atomically before cleanup. Previous attempt files remain private and are not presented as generated clips.
      const retried = await one(
        db,
        "UPDATE jobs SET state='CREATED',attempt=attempt+1,error=NULL,retryable=0,lease_id=NULL,lease_expires=NULL,updated_at=? WHERE id=? AND owner=? AND state='FAILED' AND attempt=? RETURNING id",
        now(),
        j.id,
        owner,
        j.attempt,
      );
      if (!retried)
        throw new Problem(
          "This job was already retried. Refresh its status.",
          409,
        );
      await event(
        db,
        j.id,
        "QUEUED",
        "Processing retry requested by the workspace owner.",
        j.attempt + 1,
      ).run();
      return json(
        await launch(env, db, j.id, j.options.count, j.attempt + 1, true),
      );
    }
  }
  const clipRoute = path.match(
    /^\/api\/clips\/([\w-]+)\/(review|video|subtitles|publish)$/,
  );
  if (clipRoute) {
    const c = await one(
      db,
      "SELECT c.*,j.state AS job_state,j.attempt AS current_attempt FROM clips c JOIN jobs j ON j.id=c.job_id WHERE c.id=? AND c.owner=?",
      clipRoute[1],
      owner,
    );
    if (
      !c ||
      c.attempt !== c.current_attempt ||
      !["READY_FOR_REVIEW", "APPROVED", "PUBLISHING", "PUBLISHED"].includes(
        c.job_state,
      )
    )
      throw new Problem("Generated clip not found.", 404);
    if (clipRoute[2] === "publish")
      throw new Problem(
        "Publishing remains disabled. Connection and review do not authorize uploads.",
        403,
      );
    if (clipRoute[2] === "review" && request.method === "POST") {
      const input = await body(request);
      if (
        !["APPROVED", "REJECTED"].includes(input.decision) ||
        !["READY_FOR_REVIEW", "APPROVED"].includes(c.job_state)
      )
        throw new Problem(
          "This clip cannot be reviewed in its current state.",
          409,
        );
      await statement(
        db,
        "UPDATE clips SET review_status=?,reviewed_at=? WHERE id=? AND owner=?",
        input.decision,
        now(),
        c.id,
        owner,
      ).run();
      const counts = await one(
        db,
        "SELECT SUM(review_status='PENDING') pending,SUM(review_status='APPROVED') approved FROM clips WHERE job_id=? AND attempt=?",
        c.job_id,
        c.attempt,
      );
      const next =
        !counts.pending && counts.approved ? "APPROVED" : "READY_FOR_REVIEW";
      await db.batch([
        statement(
          db,
          "UPDATE jobs SET state=?,updated_at=? WHERE id=?",
          next,
          now(),
          c.job_id,
        ),
        event(
          db,
          c.job_id,
          next,
          `Clip ${c.position} ${input.decision.toLowerCase()} by the workspace owner. Uploads remain disabled.`,
          c.attempt,
        ),
      ]);
      return json({ state: next });
    }
    if (
      request.method === "GET" &&
      ["video", "subtitles"].includes(clipRoute[2])
    ) {
      if (env.FREE_TIER_VERIFIED !== "true")
        throw new Problem(
          "Private media serving is paused until free storage and operation allowances are verified.",
          503,
        );
      await charge(db, "r2-read", 10000);
      const key = clipRoute[2] === "video" ? c.video_key : c.subtitle_key;
      const object =
        key && env.BUCKET
          ? await env.BUCKET.get(key, { range: request.headers })
          : null;
      if (!object)
        throw new Problem(
          "Clip file is unavailable in private cloud storage.",
          404,
        );
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      object.writeHttpMetadata(headers);
      headers.set("Accept-Ranges", "bytes");
      if (clipRoute[2] === "subtitles")
        headers.set(
          "Content-Disposition",
          `attachment; filename="${c.id}.srt"`,
        );
      if (object.range) {
        headers.set(
          "Content-Range",
          `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
        );
        headers.set("Content-Length", String(object.range.length));
      } else headers.set("Content-Length", String(object.size));
      return new Response(object.body, {
        status: object.range ? 206 : 200,
        headers,
      });
    }
  }
  if (path === "/api/settings" && request.method === "POST") {
    const prefs = options(await body(request));
    await statement(
      db,
      "INSERT INTO settings(owner,preferences) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET preferences=excluded.preferences",
      owner,
      JSON.stringify(prefs),
    ).run();
    return json({ preferences: prefs, publishing_enabled: false });
  }
  if (path === "/api/youtube/disconnect" && request.method === "POST") {
    await statement(
      db,
      "DELETE FROM youtube_accounts WHERE owner=?",
      owner,
    ).run();
    return json({ disconnected: true, publishing_enabled: false });
  }
  if (path === "/api/youtube/connect" && request.method === "GET") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      throw new Problem(
        "Set up a Google OAuth Web application and its cloud secrets first. No account has been connected.",
        503,
      );
    await secretKey(env);
    const state = uuid() + uuid();
    await statement(
      db,
      "INSERT INTO oauth_states(hash,owner,expires_at) VALUES(?,?,?)",
      await hash(state),
      owner,
      new Date(Date.now() + 10 * 60000).toISOString(),
    ).run();
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: url.origin + "/api/youtube/callback",
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return Response.redirect(target.href, 302);
  }
  if (path === "/api/youtube/callback" && request.method === "GET") {
    const state = url.searchParams.get("state");
    if (!state) throw new Problem("Missing YouTube OAuth state.", 403);
    const consumed = await one(
      db,
      "DELETE FROM oauth_states WHERE hash=? AND owner=? AND expires_at>? RETURNING owner",
      await hash(state),
      owner,
      now(),
    );
    if (!consumed)
      throw new Problem(
        "Connection request expired or was already used. Start again from YouTube Connection.",
        403,
      );
    if (url.searchParams.get("error"))
      return Response.redirect(
        url.origin + "/youtube?connection=cancelled",
        302,
      );
    const code = url.searchParams.get("code");
    if (!code) throw new Problem("Google did not return a connection code.");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + "/api/youtube/callback",
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok)
      throw new Problem(
        "Google could not complete authorization. Start the connection again.",
        502,
      );
    const tokens = await response.json();
    if (!tokens.refresh_token)
      throw new Problem(
        "Google did not supply offline access. Reconnect with consent to allow cloud use.",
        409,
      );
    const channels = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!channels.ok)
      throw new Problem(
        "Cannot read the authorized channel. Enable YouTube Data API and retry.",
        502,
      );
    const channel = (await channels.json()).items?.[0];
    if (!channel)
      throw new Problem(
        "This Google account has no accessible YouTube channel.",
      );
    const encrypted = await encryptTokens(env, {
      ...tokens,
      obtained_at: now(),
    });
    await statement(
      db,
      "INSERT INTO youtube_accounts(owner,channel_id,channel_title,encrypted_tokens,connected_at) VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET channel_id=excluded.channel_id,channel_title=excluded.channel_title,encrypted_tokens=excluded.encrypted_tokens,connected_at=excluded.connected_at",
      owner,
      channel.id,
      channel.snippet.title,
      encrypted,
      now(),
    ).run();
    return Response.redirect(url.origin + "/youtube?connection=success", 302);
  }
  throw new Problem("Endpoint not found.", 404);
}
export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) return await api(request, env);
      if (request.method !== "GET")
        return json({ error: "Method not allowed." }, 405);
      const headers = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.ytimg.com; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
      };
      if (path === "/app.css")
        return new Response(__CSS__, {
          headers: { ...headers, "Content-Type": "text/css" },
        });
      if (path === "/app.js")
        return new Response(__JS__, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      return new Response(__HTML__, {
        headers: { ...headers, "Content-Type": "text/html;charset=utf-8" },
      });
    } catch (error) {
      if (!(error instanceof Problem))
        console.error("Dashboard request failed:", String(error).slice(0, 300));
      return json(
        {
          error:
            error instanceof Problem
              ? error.message
              : "The cloud service could not complete this operation. Refresh and try again.",
        },
        error.status || 500,
      );
    }
  },
};
