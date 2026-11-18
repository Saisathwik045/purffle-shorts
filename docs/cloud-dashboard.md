> Phase 1 historical guide. The current dispatch, cost guards, cleanup, account setup and verified real cloud generation are documented in [Phase 2](phase2-cloud-generation.md).

# Purffle Cloud Dashboard — Phase 1

Open the private hosted dashboard:
https://purffle-shorts-cloud.turfylamb4.chatgpt.site

No local server, Docker, Python or ML model is required on a Mac. The browser
renders the interface and plays generated videos; all transcription and rendering
runs on a remote Linux CPU worker. Existing clipping modules are retained.

## Pages and real data

Overview, New Clipping Job, Processing Jobs (including job detail/history),
Generated Clips, Review & Approval, Publishing History, YouTube Connection and
Settings are backed by an authenticated Worker API and persistent D1 records.
Generated video/SRT files use private R2 storage; they are served only to the job
owner through authenticated same-origin endpoints. No sample jobs, fake progress,
simulated clips or synthetic publication records are inserted.

The dashboard records actual stage transitions, timestamps, attempts and errors.
It intentionally has no percentage or time-to-completion estimate. Queued means
waiting for a connected worker; it does not mean processing has begun.

Job states: CREATED, VALIDATING, AWAITING_SOURCE_AUTHORIZATION, QUEUED,
TRANSCRIBING, SELECTING_HIGHLIGHTS, RENDERING, GENERATING_METADATA,
READY_FOR_REVIEW, APPROVED, PUBLISHING, PUBLISHED, FAILED. Phase 1 implements
creation through approval. PUBLISHING/PUBLISHED are reserved for a later,
explicitly authorized publishing integration and cannot be reached by the UI or
processing worker. Publishing history remains empty until real publication records
exist. The publish endpoint rejects requests, including for approved clips.

## Source authorization

YouTube video, Shorts and specific livestream links are canonicalized to a video
ID. Channels, playlists, insecure or lookalike links are rejected. Public oEmbed
metadata is best effort and does not imply reuse permission. A completed media
recording is required for livestreams; live capture is not supported.

An unauthorized job can be saved, but cannot be claimed by a worker. Authorization
requires a reviewed rights basis (owned, written permission, CC0 or CC BY 4.0),
specific evidence, complete attribution, a rights-holder supplied direct HTTPS
media URL, the exact file SHA-256, and explicit clearance of all components and
media-access terms. Expired permission cannot be claimed or retried. The Python
worker independently revalidates rights and verifies public DNS, source size,
checksum and duration before processing. There is no YouTube downloader in this
path. Human attestations are evidence records, not independent legal verification.

## Cloud worker activation

The dashboard is usable for creating jobs, authorization, history and preferences
without a worker, but generation cannot finish until a remote worker is connected.

The additive `purffle_shorts/dashboard_worker.py` bridge calls the existing
`clipper.make_clips`. It uses CPU/int8 Whisper base, no LLM or paid inference API,
and honors clip count, preferred duration, aspect ratio, caption style and spoken
language. Preferred duration is approximate; fewer clips can result when speech
is short. Category is stored with the job. Translation is not included.

The `.github/workflows/dashboard-worker.yml` workflow processes one queued job
per invocation and records a heartbeat, with a 45-minute lease and timeout.
Schedules run only after the workflow reaches the default branch and the following
configuration exists in the repository account:

- Variable `PURFFLE_DASHBOARD_WORKER_ENABLED=true` (keep unset until configured).
- Variable `PURFFLE_DASHBOARD_URL` set to the exact hosted HTTPS origin above.
- Secret `PURFFLE_DASHBOARD_WORKER_TOKEN`, matching the Site's private `WORKER_TOKEN`.
- Secret `PURFFLE_DASHBOARD_SITE_TOKEN`, the private Site service-access bearer
  credential. This platform credential and the app worker secret are separate.

A private app worker secret has been provisioned in the Site runtime. GitHub
secrets still require account-side configuration; the available GitHub connector
has no secrets-management capability. Never paste tokens into the dashboard,
repository, source authorization evidence, build logs, caches or artifacts.
If credentials must be reprovisioned, replace both sides through their secure
account settings. Native Sites tools can retrieve supported private service access.

Worker requests require both the platform's private Site access boundary and the
app worker bearer. Each claimed job also has an expiring lease token. Invalid,
stale and out-of-order transitions are rejected. Expired leases become visible
failures at the next worker poll, not fabricated progress. A human can retry safe
failed processing; failed attempts remain recorded and partial output is not shown
as a completed clip. Publishing is never retried by this worker.

Duplicate jobs are prevented by a unique owner/source/options fingerprint. The
same YouTube source with tracking parameters maps to the existing job. Retry uses
the same job ID and increments its attempt, rather than creating a duplicate.

## Google OAuth account connection

OAuth is implemented but not configured with a real Google project. In hosted
runtime secrets configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a base64
32-byte `TOKEN_ENCRYPTION_KEY`. Create a Google OAuth **Web application** client,
enable YouTube Data API, and register this redirect URI:

`https://purffle-shorts-cloud.turfylamb4.chatgpt.site/api/youtube/callback`

The flow uses server-stored, owner-bound, expiring single-use state. It obtains
offline OAuth access, reads the selected channel and encrypts tokens using AES-GCM
before storage. Tokens never appear in bootstrap/API browser responses. Removing
the saved connection deletes the app's tokens; it does not revoke the Google
account's consent. Google consent/test-user setup, testing-mode token expiry,
project quota and restrictions are account-level requirements. Connecting a
channel does not enable or authorize publishing.

## Hosting and costs

Auth is provided by the owner-private Sites access policy. Source lives in
`dashboard/` on the existing Codex branch/PR. A synchronized deployment checkout
contains the same dashboard source for the hosting provider; its managed source
commit is separate from the primary GitHub repository commit.

The Site uses D1 (`DB`) and R2 (`BUCKET`), with generated Drizzle schema migrations. The original SQL bootstrap is retained for standalone Wrangler development; the first Drizzle migration is idempotent against that bootstrap.
SQLite-backed Node tests exercise the same API queries and transition rules.
The hosting manifest stores resource bindings and Site identity only, never keys.

No paid APIs or inference services are used. The standard public GitHub runner
is free, but provider hosting/database/object-storage allowances are finite and
account-specific. Do not enable paid overages. Media uploads are capped at 100 MiB
per clip; each source is capped at 500 MiB/30 minutes and requests at 10 clips.
Phase 1 has no automatic storage retention/deletion policy; old/partial attempts
can retain private objects. Check usage and implement retention before high-volume
unattended operation. A 15-minute worker schedule is best effort and handles only
one job per run; it is not a latency guarantee.

## Verification limits

- Eight Node API tests passed: authentication/CSRF, ownership isolation, canonical duplicate
  protection, source rights, claims/state machine, safe retry, saved preferences,
  token non-disclosure and approval/publishing separation.
- Python focused suite: 39 passed (dashboard bridge plus existing cloud/clipping tests); the three bridge tests also passed independently.
- Production Worker builds, Node/browser-JS syntax, Ruff and Python compilation.
- Native Sites deployment reports successful private publication.
- Cloud browser automation failed at initialization with a sandbox error; managed
  preview also failed because its relay could not open port 4173. No substitute
  preview server was launched.
- This managed environment's outbound proxy rejects the deployed Site origin
  with HTTP 403 before reaching the app. Live browser/API interactions, actual
  production D1 writes and a complete real-media worker-to-R2 roundtrip therefore
  remain unverified here. Do not interpret deployment success as proof of these.
- Live OAuth and YouTube upload are not tested. No live upload was attempted.

Cloud-only development checks (for maintainers, never needed on the user's Mac):

```sh
npm --prefix dashboard ci
npm --prefix dashboard test
npm --prefix dashboard run build
.venv/bin/pytest tests/test_dashboard_worker.py tests/test_cloud.py tests/test_clip_editing.py tests/test_clip_framing.py -q
```
