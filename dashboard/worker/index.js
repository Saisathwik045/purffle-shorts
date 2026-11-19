import { metadataHash, approvalValid, publishingPreparation } from "./review.js";
import { generateMetadata, clipFields } from "./metadata.js";
import { clipReviewRoute, appendReviewHistory } from "./review-store.js";
import { publicIntent, invalidateIntents } from "./publishing.js";
import { startOAuth, finishOAuth, disconnectOAuth, oauthConfigured, YOUTUBE_SCOPES } from "./oauth.js";
import { serveMedia } from "./media.js";
import {
  generationStatus,
  credentialHash,
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
async function launch(env, db, id, count, attempt = 1, reset = false) {
  try {
    await requireGeneration(env, db);
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
    const actual = await one(db, "SELECT state FROM jobs WHERE id=?", id);
    await event(
      db,
      id,
      actual?.state || "QUEUED",
      "Worker dispatch was not confirmed. Check connection settings and retry waking this same job.",
      attempt,
    ).run();
    return { state: actual?.state || "QUEUED", dispatch_status: "UNCONFIRMED" };
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
    // Authenticated callbacks renew liveness; they never create a storage proof.
    await statement(db, "INSERT INTO worker_heartbeats(id,last_seen) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen", "cpu", now()).run();
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
    if (request.method === "POST" && path === "/api/worker/verify-storage") {
      await body(request);
      if (env.FREE_TIER_VERIFIED !== "true")
        throw new Problem(
          "Verify account free allowances before any storage probe.",
          503,
        );
      if (!env.BUCKET) throw new Problem("Private storage is not bound.", 503);
      await charge(db, "verification", 20);
      // Invalidate old proof first. A failed probe must never leave generation enabled.
      const checked_at = now();
      await statement(
        db,
        "INSERT INTO worker_heartbeats(id,last_seen) VALUES('cpu',?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen",
        checked_at,
      ).run();
      await statement(
        db,
        "UPDATE worker_heartbeats SET storage_verified_at=NULL,credential_hash=NULL,last_check_error=NULL WHERE id='cpu'",
      ).run();
      const key = `_verification/${uuid()}.txt`;
      const value = uuid();
      let wrote = false;
      try {
        await charge(db, "r2-write", 2000);
        // Reserve the delete operation before creating the temporary object.
        await charge(db, "r2-write", 2000);
        await charge(db, "r2-read", 10000);
        wrote = true; // PUT may succeed even if its acknowledgement is lost.
        await env.BUCKET.put(key, value);
        const saved = await env.BUCKET.get(key);
        if (!saved || (await new Response(saved.body).text()) !== value)
          throw new Error("Private object read-back mismatch");
        await env.BUCKET.delete(key);
        wrote = false;
        await statement(
          db,
          "UPDATE worker_heartbeats SET credential_hash=?,storage_verified_at=?,last_check_error=NULL WHERE id='cpu'",
          await credentialHash(env),
          checked_at,
        ).run();
        return json({
          connected: true,
          storage_verified: true,
          checked_at,
          publishing_enabled: false,
        });
      } catch {
        await statement(
          db,
          "UPDATE worker_heartbeats SET last_check_error='Private storage roundtrip failed. Check bindings and provider limits.' WHERE id='cpu'",
        ).run();
        throw new Problem(
          "Private storage verification failed. No generation was enabled.",
          503,
        );
      } finally {
        if (wrote) {
          try {
            await env.BUCKET.delete(key);
          } catch {
            /* Proof stays invalid; report the probe failure. */
          }
        }
      }
    }
    if (request.method === "POST" && path === "/api/worker/claim") {
      await requireGeneration(env, db);
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
      await requireGeneration(env, db);
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
      const digest=request.headers.get("x-content-sha256");
      if(digest&&!/^[a-f0-9]{64}$/.test(digest))throw new Problem("Invalid media fingerprint.");
      const savedObject=await env.BUCKET.put(key,request.body,{
        httpMetadata:{contentType:video?"video/mp4":"application/x-subrip"},
        ...(video&&digest?{customMetadata:{sha256:digest}}:{})
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
      await db.prepare("UPDATE clips SET media_revision=media_revision+1,review_status='PENDING',reviewed_at=NULL,approval_hash=NULL"+
        (video?",content_sha256=?,media_etag=?":"")+" WHERE id=?")
        .bind(...(video?[digest||null,savedObject?.etag||savedObject?.httpEtag||null,c.id]:[c.id])).run();
      await invalidateIntents(db,c.id,"Media content changed; a new approval is required.");
      await appendReviewHistory(db,await one(db,"SELECT * FROM clips WHERE id=?",c.id),"MEDIA_CHANGED");
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
        const id=uuid();
        const generated=generateMetadata({transcript:input.transcript_excerpt||"",sourceTitle:input.title||j.title,attribution:j.authorization.attribution,position:input.position});
        await statement(db,
          "INSERT INTO clips(id,job_id,owner,attempt,position,title,description,duration,created_at,hashtags,opening_hook,source_attribution,commentary_suggestions,transcript_excerpt,metadata_method) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,j.id,j.owner,j.attempt,input.position,generated.title,generated.description,input.duration,now(),
          JSON.stringify(generated.hashtags),generated.opening_hook,generated.source_attribution,JSON.stringify(generated.commentary_suggestions),
          generated.transcript_excerpt,generated.metadata_method).run();
        await appendReviewHistory(db,await one(db,"SELECT * FROM clips WHERE id=?",id),"GENERATED");
        return json({id,metadata:generated},201);
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
      "SELECT channel_id,channel_title,connected_at,connection_id,status,scopes FROM youtube_accounts WHERE owner=?",
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
      clips: await Promise.all(clips.map(async (clip) => {
        const view=clipFields(clip);
        for(const key of ["video_key","subtitle_key","media_etag","approval_hash","transcript_excerpt","mutation_id"]) delete view[key];
        return {...view,metadata_hash:await metadataHash(clip),approval_valid:await approvalValid(clip)};
      })),
      upload_intents: (await all(db,"SELECT * FROM upload_intents WHERE owner=? ORDER BY updated_at DESC LIMIT 200",owner)).map(publicIntent),
      publications,
      account,
      preferences: preferences ? JSON.parse(preferences.preferences) : DEFAULTS,
      worker: heartbeat || null,
      publishing_enabled: false,
      generation: await generationStatus(env, db),
      oauth_configured: oauthConfigured(env),
      user: {
        name:
          request.headers.get("oai-authenticated-user-email") ||
          "Workspace owner",
      },
    });
  }
  const intentRoute=path.match(/^\/api\/upload-intents\/([\w-]+)(?:\/(cancel|history))?$/);
  if(intentRoute) {
    const intent=await one(db,"SELECT * FROM upload_intents WHERE id=? AND owner=?",intentRoute[1],owner);
    if(!intent)throw new Problem("Upload intent not found.",404);
    if(request.method==="GET"&&intentRoute[2]==="history")
      return json({events:await all(db,"SELECT state,message,created_at FROM upload_events WHERE intent_id=? AND owner=? ORDER BY created_at,rowid",intent.id,owner)});
    if(request.method==="GET"&&!intentRoute[2])return json({intent:publicIntent(intent),publishing_enabled:false});
    if(request.method==="POST"&&intentRoute[2]==="cancel") {
      await body(request);
      if(!["PREPARED","INVALIDATED","CANCELLED"].includes(intent.state)||intent.session_blob)
        throw new Problem("An initiated or ambiguous upload requires reconciliation; it cannot be discarded.",409);
      await statement(db,"UPDATE upload_intents SET state='CANCELLED',updated_at=? WHERE id=? AND owner=? AND state IN ('PREPARED','INVALIDATED','CANCELLED') AND session_blob IS NULL",now(),intent.id,owner).run();
      return json({cancelled:true,publishing_enabled:false});
    }
    throw new Problem("Live upload execution is disabled.",403);
  }
  if(path==="/api/youtube/readiness"&&request.method==="GET") {
    const account=await one(db,"SELECT channel_id,status,connection_id,scopes FROM youtube_accounts WHERE owner=?",owner);
    let scopes=[];try{scopes=JSON.parse(account?.scopes||"[]");}catch{}
    return json({oauth_configured:oauthConfigured(env),channel_connected:!!account?.connection_id&&account.status==="CONNECTED",
      scopes_ready:YOUTUBE_SCOPES.every(s=>scopes.includes(s)),publishing_enabled:false,execution_authorized:false,
      blockers:["Uploads require separate explicit authorization and remain disabled.",...(!oauthConfigured(env)?["Configure Google OAuth in secure server settings."]:[])]});
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
    if (auth) await requireGeneration(env, db);
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
      state = auth ? "VALIDATING" : "AWAITING_SOURCE_AUTHORIZATION";
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
      await requireGeneration(env, db);
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
      await requireGeneration(env, db);
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
      await requireGeneration(env, db);
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
    /^\/api\/clips\/([\w-]+)\/(review|metadata|regenerate|history|readiness|upload-intent|preparation|video|subtitles|publish)$/,
  );
  if (clipRoute) {
    const c = await one(
      db,
      "SELECT c.*,j.state AS job_state,j.attempt AS current_attempt,j.authorization AS source_authorization FROM clips c JOIN jobs j ON j.id=c.job_id WHERE c.id=? AND c.owner=?",
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
    if(clipRoute[2]==="preparation"&&request.method==="POST") {
      const input=await body(request);
      const {expectedMetadata}=await import("./review.js");await expectedMetadata(input,c);
      const channel=await one(db,"SELECT channel_id FROM youtube_accounts WHERE owner=?",owner);
      return json(await publishingPreparation(c,c.source_authorization?JSON.parse(c.source_authorization):null,channel));
    }
    const reviewed=await clipReviewRoute(request,env,db,c,owner,clipRoute[2],request.method==="POST"?await body(request):null);
    if(reviewed)return json(reviewed);
    if (
      ["GET", "HEAD"].includes(request.method) &&
      ["video", "subtitles"].includes(clipRoute[2])
    )
      return serveMedia(request, env, db, c, clipRoute[2]);
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
  if(path==="/api/youtube/disconnect"&&request.method==="POST") {
    await body(request);return json(await disconnectOAuth(env,db,owner));
  }
  if(path==="/api/youtube/connect"&&request.method==="GET")return startOAuth(env,db,owner,url.origin);
  if(path==="/api/youtube/callback"&&request.method==="GET")return finishOAuth(env,db,owner,url);
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
