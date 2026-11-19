import {
  sqliteTable,
  text,
  integer,
  real,
  unique,
  index,
} from "drizzle-orm/sqlite-core";
export const jobs = sqliteTable(
  "jobs",
  {
    id: text().primaryKey(),
    owner: text().notNull(),
    fingerprint: text().notNull(),
    source_url: text().notNull(),
    source_kind: text().notNull(),
    title: text().notNull(),
    thumbnail: text(),
    options: text().notNull(),
    authorization: text(),
    state: text().notNull(),
    error: text(),
    retryable: integer().notNull().default(0),
    attempt: integer().notNull().default(1),
    storage_reserved: integer().notNull().default(0),
    dispatch_status: text(),
    dispatch_error: text(),
    runner_url: text(),
    lease_id: text(),
    lease_expires: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    unique().on(t.owner, t.fingerprint),
    index("jobs_owner_updated").on(t.owner, t.updated_at),
    index("jobs_queue").on(t.state, t.created_at),
  ],
);
export const events = sqliteTable("job_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  job_id: text()
    .notNull()
    .references(() => jobs.id),
  state: text().notNull(),
  message: text().notNull(),
  created_at: text().notNull(),
  attempt: integer().notNull(),
});
export const clips = sqliteTable(
  "clips",
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id),
    owner: text().notNull(),
    attempt: integer().notNull(),
    position: integer().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    duration: real().notNull(),
    video_key: text(),
    subtitle_key: text(),
    review_status: text().notNull().default("PENDING"),
    created_at: text().notNull(),
    reviewed_at: text(),
    hashtags: text().notNull().default("[]"), opening_hook: text().notNull().default(""),
    source_attribution: text().notNull().default(""), commentary_suggestions: text().notNull().default("[]"),
    transcript_excerpt: text().notNull().default(""), metadata_version: integer().notNull().default(1),
    metadata_method: text().notNull().default("legacy"), media_revision: integer().notNull().default(0),
    content_sha256: text(), media_etag: text(), approval_hash: text(), mutation_id: text(),
  },
  (t) => [unique().on(t.job_id, t.attempt, t.position)],
);
export const publications = sqliteTable("publications", {
  id: text().primaryKey(),
  clip_id: text()
    .notNull()
    .references(() => clips.id),
  owner: text().notNull(),
  state: text().notNull(),
  youtube_id: text(),
  error: text(),
  created_at: text().notNull(),
  published_at: text(),
  upload_intent_id: text().unique(), channel_id: text(),
});
export const settings = sqliteTable("settings", {
  owner: text().primaryKey(),
  preferences: text().notNull(),
});
export const youtubeAccounts = sqliteTable("youtube_accounts", {
  owner: text().primaryKey(),
  channel_id: text().notNull(),
  channel_title: text().notNull(),
  encrypted_tokens: text().notNull(),
  connected_at: text().notNull(),
  connection_id: text(), status: text().notNull().default("CONNECTED"), scopes: text().notNull().default("[]"),
});
export const oauthStates = sqliteTable("oauth_states", {
  hash: text().primaryKey(),
  owner: text().notNull(),
  expires_at: text().notNull(),
  verifier_blob: text(), redirect_uri: text(), epoch: integer().notNull().default(0),
});
export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: text().primaryKey(),
  last_seen: text().notNull(),
  credential_hash: text(),
  storage_verified_at: text(),
  last_check_error: text(),
});

export const operationBudgets = sqliteTable(
  "operation_budgets",
  {
    period: text().notNull(),
    kind: text().notNull(),
    used: integer().notNull().default(0),
  },
  (t) => [unique().on(t.period, t.kind)],
);

export const clipReviewHistory=sqliteTable("clip_review_history",{
 id:text().primaryKey(),clip_id:text().notNull(),job_id:text().notNull(),owner:text().notNull(),
 attempt:integer().notNull(),action:text().notNull(),metadata_hash:text().notNull(),snapshot:text().notNull(),created_at:text().notNull()
},t=>[index("review_history_owner_clip").on(t.owner,t.clip_id,t.created_at)]);
export const uploadIntents=sqliteTable("upload_intents",{
 id:text().primaryKey(),owner:text().notNull(),clip_id:text().notNull(),job_id:text().notNull(),
 channel_id:text().notNull(),connection_id:text().notNull(),metadata_hash:text().notNull(),media_revision:integer().notNull(),
 content_sha256:text().notNull(),metadata:text().notNull(),state:text().notNull().default("PREPARED"),total_bytes:integer().notNull(),
 acknowledged_bytes:integer().notNull().default(0),session_blob:text(),remote_video_id:text(),lease_id:text(),lease_expires:text(),
 attempts:integer().notNull().default(0),invalidated_at:text(),error:text(),retry_at:text(),created_at:text().notNull(),updated_at:text().notNull()
},t=>[unique().on(t.owner,t.clip_id,t.channel_id,t.media_revision),index("upload_intents_owner_updated").on(t.owner,t.updated_at)]);
export const uploadEvents=sqliteTable("upload_events",{
 id:text().primaryKey(),intent_id:text().notNull(),owner:text().notNull(),state:text().notNull(),message:text().notNull(),created_at:text().notNull()
},t=>[index("upload_events_intent").on(t.owner,t.intent_id,t.created_at)]);
export const oauthConnectionEpochs=sqliteTable("oauth_connection_epochs",{
 owner:text().primaryKey(),epoch:integer().notNull().default(0)
});
