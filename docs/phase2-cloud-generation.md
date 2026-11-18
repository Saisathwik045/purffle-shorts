# Phase 2: real cloud generation

Private dashboard: https://purffle-shorts-cloud.turfylamb4.chatgpt.site

The existing interface, owner authentication, records, preferences, OAuth and
clipping modules are retained. `Generate clips` now calls the hosted API which
reserves storage, checks the public GitHub repository, and sends a real Actions
workflow dispatch to the fixed `dashboard-worker.yml` workflow on the repository's
default branch. The CPU worker claims only the requested authorized job. A schedule
provides recovery for an unconfirmed dispatch; additional wakes cannot duplicate
an active claim. No local server or processing on a Mac is required.

## Activation is blocked until the account prerequisites are met

This is a real integration, but production execution is deliberately fail-closed.
Neither this task's GitHub connector nor the invalid terminal GitHub token can
manage Actions secrets, billing, variables or runtime dispatch credentials. The
cloud browser also fails to initialize. The following account actions cannot be
completed through the available access:

0. **Provider authorization is a prerequisite, not a billing switch.** GitHub's
   [Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions)
   restrict application-backend/serverless use. The free public-runner allowance
   does not authorize this production workload. Obtain documented GitHub permission
   for this use before setting Site `ACTIONS_APP_USE_AUTHORIZED=true` and repository
   variable `PURFFLE_ACTIONS_APP_USE_AUTHORIZED=true`. Do not set them merely to
   dismiss the warning. Otherwise keep production off and provision a separately
   authorized free worker; none is connected or claimed verified in this task.
   CI generation tests and the non-processing private-connection check remain
   available independently.
1. Review and merge PR #2 so `dashboard-worker.yml` exists on the default branch.
2. Configure repository variables `PURFFLE_DASHBOARD_URL` with the exact origin
   above and `PURFFLE_DASHBOARD_WORKER_ENABLED=true`.
3. Configure repository secrets `PURFFLE_DASHBOARD_WORKER_TOKEN` (matching the
   Site's private `WORKER_TOKEN`) and `PURFFLE_DASHBOARD_SITE_TOKEN` (the private
   Site service-access bearer for this Site). Use secure provider settings, never
   repository files, chat messages, form fields, logs or artifacts. Native Sites
   tools can retrieve supported service access. If the existing app worker secret
   cannot be recovered, reprovision it on both sides through secure settings.
4. Configure a repository-scoped token or GitHub App installation token with
   **Actions: write** and repository metadata access as the Site runtime secret
   `GITHUB_DISPATCH_TOKEN`. No code-writing or YouTube permission is needed.
5. Manually run the worker workflow with `verify_connection=true`. This checks
   private access and database/binding presence without object operations.
6. Check actual provider plan/account-wide usage, R2 Standard storage and hard
   spending controls. Only when the app has a guaranteed no-charge allowance,
   set Site `FREE_TIER_VERIFIED=true`. Leave it unset otherwise.
7. Run the worker workflow with `verify_storage=true`. This private check performs
   one tiny PUT/GET/delete and persists its real proof in D1. No job is claimed.
   It can run independently of production Actions application-backend permission
   because it only tests this repository's integration.
8. Confirm Settings shows a verified storage connection. Proof expires after
   30 days and on worker-token rotation. `WORKER_CONNECTION_VERIFIED_AT` is now
   ignored: manually entered timestamps cannot enable processing. Generation
   remains blocked until provider permission and all other prerequisites hold.

Unauthorized jobs can still be saved outside the processing queue. A heartbeat
or a configured binding is not evidence of a successful storage roundtrip.

No Google OAuth credentials are required to **generate** clips. YouTube uploads
remain disabled in the UI, API and worker, even after clip approval.

## Actual pipeline

The additive Python worker uses the existing clipping code with faster-whisper
CPU/int8 and free sentence-based highlight selection. It verifies the permitted
media-file URL, source checksum, all-component rights and source duration before
transcription. It renders H.264/AAC MP4 at 720x1280 by default, burns word-timed
captions, saves SRT and metadata, uploads through the private API into R2, and
marks `READY_FOR_REVIEW` only after all files have been acknowledged.

A YouTube URL is a reference, never a download license. No restriction bypass,
YouTube downloader, live capture, paid model API, or paid fallback is introduced.
The authorized media must be supplied independently by the rights holder.

The first real GitHub inference test completed successfully on Ubuntu 24.04:
[cloud-inference job](https://github.com/Saisathwik045/purffle-shorts/actions/runs/44240514753/job/134586993601).
Its log records public Whisper download and `PASS: real Whisper base CPU int8
inference, burned captions, SRT and vertical H.264/AAC`. This resolves the earlier
HTTP 403 **on a GitHub runner**. The managed authoring workspace still has an
allowlist that excludes Hugging Face and the deployed Site origin; we do not
bypass that restriction. The explicit public snapshot preparation in the new
integration test uses no Hugging Face token or paid API.

## Charges, limits and cleanup

Official limits checked 18 November 2026:

| Provider | Published free allowance | Application guard |
| --- | --- | --- |
| Standard public GitHub Actions runner | Runner compute is free | Fixed Ubuntu standard runner; private repositories rejected; no larger/GPU runner |
| R2 Standard | 10 GB-month; 1 million Class A and 10 million Class B requests/month; free egress | 512 MiB total reservations; 25 MiB/video, 1 MiB/SRT; 2,000 writes and 10,000 reads/month |
| D1 on Workers Free | 5 million rows read/day; 100,000 written/day; 5 GB storage | Indexed job lookups, bounded results, persisted budget counters; provider free-plan hard limits still required |
| Workers Free | 100,000 requests/day; 10 ms CPU/invocation | HTTP orchestration/storage only; no video inference or rendering in a Worker |

Sources: [GitHub billing](https://docs.github.com/en/actions/concepts/billing-and-usage),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

These are account-wide provider limits, not proof that this account has remaining
quota. Paid plans, shared consumption, pre-existing objects or overage settings
cannot be inferred from source code. Production is blocked until verified. R2
Infrequent Access is not eligible and must not be selected. No new paid plan,
Cloudflare account, paid API or storage overage was enabled by this task.

There are at most 200 dispatches/month. Storage is reserved atomically before
queue admission, including all jobs' reservations. Upload and preview operations
stop at conservative monthly caps. Seven-day retention deletes inactive private
media in bounded batches when a worker polls, releases reservations, and retains
job history. The owner can delete generated files without deleting history.
Failed partial outputs are removed before retry and on failure; predetermined keys
also cover an upload whose acknowledgement was lost. If a worker never polls,
automatic retention is delayed, so existing reservations remain held rather than
allowing more uploads. Provider account usage must still be monitored.

Retries are bounded. Claims are never retried blindly; file writes replace the same
key; clip metadata, stage updates and completion acknowledgements are idempotent.
A failed/unconfirmed GitHub dispatch remains visibly queued and can request another
wake for the same job. Publication is never retried or attempted.

## Cloud integration verification

`cloud/dashboard_e2e.py` runs in the PR's standard public Linux GitHub runner using the existing bundled CPU FFmpeg, without system-package installation.
It creates an original synthetic picture with the project’s original offline speech fixture, submits an authorized job
through the same dashboard API, runs real Whisper, real highlight selection and
FFmpeg, uploads the output to an isolated filesystem object store, and fetches the
private preview through the same authenticated media route. It verifies:

- No access for anonymous or different-owner callers.
- Duplicate prevention and real persisted stage events.
- A decodable 720x1280 MP4 with audio, valid bounded SRT cues and recognizable speech.
- Visible caption pixels on the otherwise dark synthetic picture.
- Byte-range preview matches the generated file and video elements reference the
  private route; publishing returns 403 and publication history remains empty.

Only the GitHub dispatch boundary is stubbed in this **isolated integration test**:
the actual worker is the already-running GitHub CI job. SQLite/filesystem adapters
stand in for production D1/R2. There is no mocked transcript, clip, progress or
video renderer. The fixture and test-only loopback identity transport are not
bundled into or enabled on the deployed Site. A successful test is evidence for
the cloud pipeline and API integration, **not** a production Site/R2 roundtrip.

A bounded original synthetic MP4 may be exported in the free workflow log, avoiding
Actions artifact storage and publishing no user media. No live production jobs,
rights evidence or credentials are copied to that log. Exact test results and
recovered output are recorded below.

## Verified result from the real cloud run

[Cloud generation CI passed](https://github.com/Saisathwik045/purffle-shorts/actions/runs/44245901913/job/134604660379).
The original synthetic output was recovered from the bounded workflow log and its
SHA-256 verified independently in the managed cloud workspace:

- H.264/AAC MP4, 720 × 1280 (9:16), 10.57 seconds, 371,643 bytes.
- 13 subtitle cues, all within clip bounds; 4,750 visible bright caption pixels
  on the dark synthetic picture. A decoded frame was also visually inspected.
- Anonymous preview returned 401; another owner returned 404; the owner received
  the actual MP4 bytes. Range 0–1023 returned 206 and matched those bytes.
- Full video decoding passed; actual stage history reached READY_FOR_REVIEW;
  no publication records appeared and publishing returned 403.
- SHA-256: `e6556c21e8eb98721437392dcaf9f2abb3e81480e0eb6d9bee8d22acd95f4c37`.
- Model revision: `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`.

Machine-readable evidence: [phase2-verification.json](phase2-verification.json).
The returned media artifact is `/workspace/onboarding-artifacts/phase2/short.mp4`
in this cloud chat workspace; it is not user media or a YouTube upload.

Cloud test development encountered and fixed three concrete failures: an unneeded
system-package step stalled, a 10-second model-download timeout interrupted the
HTTP fallback, and a custom snapshot file filter omitted vocabulary assets. The
pipeline now uses bundled FFmpeg and original fixture speech, tolerates normal
public-weight transfer times, and reuses faster-whisper's complete downloader
with a pinned revision. A log-export backpressure failure after a passing pipeline
was also corrected; the final CI job, including export, is green.

Current available checks passed: 14 Node API/state/security tests, 42 focused Python
worker/cloud/clipping tests, production build, JavaScript syntax, Ruff, Python
compilation, and workflow YAML parsing. The successful cloud integration uses the
same real inference, clipping and rendering modules; SQLite/filesystem substitute
only for production D1/R2, and the dispatch response is stubbed in the isolated
runner harness. Live Site-to-GitHub dispatch and Site-to-R2 preview are not claimed
as tested: account credentials, provider usage verification, and the authoring
network policy remain blockers. No paid API, storage artifact, or Mac processing
was used.
