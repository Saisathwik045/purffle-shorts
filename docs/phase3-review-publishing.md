# Phase 3: review and publishing preparation

Live YouTube uploads remain disabled. No production route invokes the resumable upload engine. OAuth consent, clip approval and preparing an intent do not authorize execution.

## Implemented flow
Worker output → deterministic extractive metadata → private preview → persistent edits → approval bound to metadata and media fingerprint → durable upload intent → future explicitly authorized upload runner → confirmed publication history.

Metadata includes title, description, hashtags, opening hook, source attribution and commentary suggestions. Suggestions are not narration added to the video. Regeneration uses the stored transcript excerpt, with an explicit source-title fallback when no transcript exists. No paid inference is used.

Edits, regeneration and media replacement invalidate approval and pending intents. History is owner scoped. Existing clips must be reviewed again and must receive a verified media fingerprint before preparing an intent.

## Google setup (account actions, not performed automatically)
Create or use a Google Cloud project with YouTube Data API v3 enabled. Configure the OAuth consent screen, test users as needed and a Web application OAuth client. Register the exact deployed callback URL, /api/youtube/callback. These API/OAuth configuration steps do not require enabling paid billing for this application.

Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY as private server configuration. The callback URI is derived from the request origin and is pinned in each pending OAuth transaction; register that exact HTTPS URI with Google. TOKEN_ENCRYPTION_KEY is a random 32-byte base64 key; never put it or tokens in public assets, logs or Git. Preserve this key to retain existing encrypted connections. The dashboard reports missing configuration without exposing values.

The owner connects through Google's consent page. Authorization uses one-use, expiring, owner-bound state, PKCE, encrypted refresh/access tokens and the official channel API. Disconnect deletes the local connection and invalidates intents; Google revocation is attempted and reported separately if unavailable. The scopes are youtube.upload and youtube.readonly.

## Storage and migrations
Apply the next migration using the deployment's existing migration process. Do not apply both dashboard/drizzle/0003_clip_review_publishing.sql and dashboard/migrations/0004_clip_review_publishing.sql: they are equivalent for the two supported migration paths. New Drizzle snapshot/journal entries accompany the migration.

Private storage readiness checks require both video/subtitle objects, an unexpired retention period, source authorization, approval, OAuth configuration and the current video's SHA-256 and object ETag. Production worker/storage verification remains separate. No fixture is inserted into the deployed database.

## Durable publishing engine
Prepared intents are idempotent for owner, clip, channel and media revision. Metadata and media identity are frozen. Session URLs are encrypted. The isolated engine uses leases, 256 KiB chunks, acknowledged offsets and status probes before resuming. A lost initiation response requires manual reconciliation; it never starts a second session automatically. Confirmed remote video IDs are recorded once. Changed approval/account/media blocks new chunks while permitting status-only reconciliation.

The engine has no default HTTP client, no public execution route and no production scheduler. A future rollout requires explicit user authorization, review of OAuth/API requirements and a compliant runner. All live /publish requests stay forbidden even if an environment flag is set.

## Verification and deployment boundary
Run Node API/database tests and the synthetic Chromium review flow in remote software CI. OAuth and upload requests are mocked; no real Google account or upload is exercised. The browser fixture uses isolated SQLite/storage and loopback only. Existing CPU Whisper/FFmpeg CI remains an isolated synthetic regression test, not an application backend.

Deployment and production storage/OAuth are not established by these tests. No active production processing worker is supplied by Phase 3. Production clips remain zero until verified separately.
