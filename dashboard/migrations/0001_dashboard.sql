CREATE TABLE jobs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL, source_url TEXT NOT NULL,
 source_kind TEXT NOT NULL, title TEXT NOT NULL, thumbnail TEXT, options TEXT NOT NULL,
 authorization TEXT, state TEXT NOT NULL, error TEXT, retryable INTEGER NOT NULL DEFAULT 0,
 attempt INTEGER NOT NULL DEFAULT 1, lease_id TEXT, lease_expires TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner, fingerprint)
);
CREATE INDEX jobs_owner_updated ON jobs(owner, updated_at);
CREATE INDEX jobs_queue ON jobs(state, created_at);
CREATE TABLE job_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
 state TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, attempt INTEGER NOT NULL
);
CREATE TABLE clips (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), owner TEXT NOT NULL,
 attempt INTEGER NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 duration REAL NOT NULL, video_key TEXT, subtitle_key TEXT, review_status TEXT NOT NULL DEFAULT 'PENDING',
 created_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE(job_id, attempt, position)
);
CREATE TABLE publications (
 id TEXT PRIMARY KEY, clip_id TEXT NOT NULL REFERENCES clips(id), owner TEXT NOT NULL,
 state TEXT NOT NULL, youtube_id TEXT, error TEXT, created_at TEXT NOT NULL, published_at TEXT
);
CREATE TABLE settings (owner TEXT PRIMARY KEY, preferences TEXT NOT NULL);
CREATE TABLE youtube_accounts (
 owner TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_title TEXT NOT NULL,
 encrypted_tokens TEXT NOT NULL, connected_at TEXT NOT NULL
);
CREATE TABLE oauth_states (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE worker_heartbeats (id TEXT PRIMARY KEY, last_seen TEXT NOT NULL);
