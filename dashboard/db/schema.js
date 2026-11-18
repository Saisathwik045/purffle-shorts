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
});
export const oauthStates = sqliteTable("oauth_states", {
  hash: text().primaryKey(),
  owner: text().notNull(),
  expires_at: text().notNull(),
});
export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: text().primaryKey(),
  last_seen: text().notNull(),
});
