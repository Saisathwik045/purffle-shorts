ALTER TABLE clips ADD COLUMN hashtags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE clips ADD COLUMN opening_hook TEXT NOT NULL DEFAULT '';
ALTER TABLE clips ADD COLUMN source_attribution TEXT NOT NULL DEFAULT '';
ALTER TABLE clips ADD COLUMN commentary_suggestions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE clips ADD COLUMN transcript_excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE clips ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE clips ADD COLUMN metadata_method TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE clips ADD COLUMN media_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN content_sha256 TEXT;
ALTER TABLE clips ADD COLUMN media_etag TEXT;
ALTER TABLE clips ADD COLUMN approval_hash TEXT;
ALTER TABLE youtube_accounts ADD COLUMN connection_id TEXT;
ALTER TABLE youtube_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'CONNECTED';
ALTER TABLE youtube_accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE oauth_states ADD COLUMN verifier_blob TEXT;
ALTER TABLE oauth_states ADD COLUMN redirect_uri TEXT;
CREATE TABLE clip_review_history (
 id TEXT PRIMARY KEY, clip_id TEXT NOT NULL, job_id TEXT NOT NULL, owner TEXT NOT NULL,
 attempt INTEGER NOT NULL, action TEXT NOT NULL, metadata_hash TEXT NOT NULL,
 snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX review_history_owner_clip ON clip_review_history(owner,clip_id,created_at);
CREATE TABLE upload_intents (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, clip_id TEXT NOT NULL, job_id TEXT NOT NULL,
 channel_id TEXT NOT NULL, connection_id TEXT NOT NULL, metadata_hash TEXT NOT NULL,
 media_revision INTEGER NOT NULL, content_sha256 TEXT NOT NULL, metadata TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PREPARED', total_bytes INTEGER NOT NULL,
 acknowledged_bytes INTEGER NOT NULL DEFAULT 0, session_blob TEXT, remote_video_id TEXT,
 lease_id TEXT, lease_expires TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 invalidated_at TEXT, error TEXT, retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner,clip_id,channel_id,media_revision)
);
CREATE INDEX upload_intents_owner_updated ON upload_intents(owner,updated_at);
CREATE TABLE upload_events (
 id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, owner TEXT NOT NULL,
 state TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX upload_events_intent ON upload_events(owner,intent_id,created_at);
ALTER TABLE publications ADD COLUMN upload_intent_id TEXT;
ALTER TABLE publications ADD COLUMN channel_id TEXT;
CREATE UNIQUE INDEX publications_one_intent ON publications(upload_intent_id);
CREATE TABLE oauth_connection_epochs(owner TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
ALTER TABLE oauth_states ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clips ADD COLUMN mutation_id TEXT;
