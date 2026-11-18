# Phase 2.5 integration status

Checked 18 November 2026. This phase preserves the existing UI, jobs and clipper.

## Implemented improvement

The previous manual connection timestamp was insufficient evidence. The dashboard
now requires an authenticated worker's persisted storage proof: a temporary object
is written, read back exactly and deleted before D1 records success. The probe
requires `FREE_TIER_VERIFIED=true` before object access, has a 20-check monthly
budget, and reserves its write/read operation costs before creating the object.
No job is claimed and publishing stays disabled. Failed probes invalidate old
proof and attempt cleanup; a failed cleanup leaves only a tiny randomly named
verification object and must be reviewed in provider storage settings.

The proof is bound to the SHA-256 of the current worker secret, expires in 30 days
and rejects future timestamps. Raw secrets and hashes never appear in owner API
responses. Settings shows actual storage verification separately from heartbeat.
`WORKER_CONNECTION_VERIFIED_AT` no longer enables generation. Standalone health
checks only verify private access/database and binding presence.

Use workflow input `verify_storage=true`, or run the existing worker CLI with
`--verify-storage` **on an authorized remote cloud worker**, after billing checks.
No Mac process is required. The isolated real-generation CI now performs this
same storage probe before generating its synthetic clip.

## Live observations and unavoidable blockers

Native Sites tools verified the active private deployment and the real D1 binding
and tables. The worker heartbeat table was empty. Runtime environment revision 1
contained only a redacted worker secret. There was no dispatch credential, no
provider authorization flag and no verified no-charge allowance. These are actual
account observations, not simulated connection results. Existing job/media records
were not modified and the worker secret was not rotated.

The managed cloud environment's enforced network policy excludes the deployed
Site and Hugging Face. A normal HTTPS request to the Site failed at the proxy with
CONNECT 403. No policy, authentication or TLS restriction was bypassed. To test
from this environment, its owner must allow the exact Site hostname, Hugging Face
and the model downloader's documented transfer hosts. That alone does not satisfy
provider authorization, credentials or billing requirements.

GitHub Actions remains suitable for repository CI, which already proved real
CPU inference/rendering. Its [current terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions)
restrict application-backend use. Do not switch on production without documented
provider permission or a separately authorized no-cost worker.

A proposed Hugging Face CPU Basic alternative was rejected after checking
[current Spaces documentation](https://huggingface.co/docs/hub/spaces-overview):
creating Docker/Gradio compute Spaces requires a paid plan, despite CPU Basic
having no hourly charge. No subscription, Space, paid service or fallback was
created. An existing grandfathered/granted worker would require account-specific
proof; none is connected or claimed verified here.

Exact activation steps remain in [the Phase 2 guide](phase2-cloud-generation.md).
The private Site-to-worker-to-R2 generation roundtrip is **BLOCKED**, not passed.
The isolated CI generation and its private filesystem preview are separate proof.

## Follow-up after PR #2 merged

PR #2 was merged on 18 November 2026 (merge `d6b56e6`). Subsequent playback fixes
are on `codex/phase2-5-playback`, with a linked follow-up PR rather than altering
merged history. The existing clipping, transcription and captioning modules remain
unchanged.

The private media route now handles HEAD without reading the video body, normalizes
bounded/open/suffix byte ranges, returns 416 with the real object length for invalid
or unsatisfiable requests, and falls back to a complete response for If-Range when
no matching validator is available. Retention-ended and missing files report 410.
Authentication and owner lookup precede every media/HEAD request. Media stays on
same-origin private API paths with no public bucket, signed-link workaround, CORS
relaxation or client-side credentials. The UI gives playback errors for expired
sessions, missing/expired media, storage quotas and paused serving, with an explicit
preview retry when the file remains accessible. Automatic retries do not recreate
jobs. Probe and preview requests now consume the same persisted R2 budget counters.

The isolated real-generation CI additionally checks authenticated HEAD, anonymous
and cross-owner HEAD denial, suffix preview bytes and out-of-bounds 416. Its
SQLite/filesystem storage and stub dispatch still mean it is not a deployed end-to-end
acceptance test. The 25 dashboard checks passed in the managed Linux workspace;
production build, syntax and Ruff passed. Updated real inference results are linked
from the follow-up PR.

The latest live audit found only the worker secret at Site environment revision 1,
an empty heartbeat table, and no configured outbound cloud identity or environment
secrets. The network policy is enforced and excludes the exact Site host; a normal
HTTPS probe failed with proxy CONNECT 403. Recent Site error-filtered logs showed
canceled bootstrap requests, not a worker callback or a completed generation job.
Those observations do not establish successful browser authentication or playback.
The merged default-branch workflow removes that former prerequisite; provider
permission, private credentials, verified no-charge allowances and real storage
proof are still absent. Production generation and YouTube publishing remain off.

### Required account actions

1. Establish an authorized no-additional-charge worker: documented GitHub permission
   for this backend use, or an existing free/granted provider account with suitable
   terms and verified quotas. No new paid service is authorized or provisioned.
2. For the GitHub option, configure repository variables `PURFFLE_DASHBOARD_URL`,
   `PURFFLE_DASHBOARD_WORKER_ENABLED`, `PURFFLE_ACTIONS_APP_USE_AUTHORIZED` only after
   permission; secrets `PURFFLE_DASHBOARD_WORKER_TOKEN` and
   `PURFFLE_DASHBOARD_SITE_TOKEN`. Configure private Site `GITHUB_DISPATCH_TOKEN`
   (repository-scoped Actions write/metadata), and `ACTIONS_APP_USE_AUTHORIZED`
   only with the same provider authorization.
3. Confirm actual shared-account storage/hosting/operation allowances and hard
   no-overage controls before setting Site `FREE_TIER_VERIFIED=true`. Code caps
   cannot prove account-wide costs. Do not purchase a plan to dismiss this gate.
4. Run the private connection and storage-verification workflows. The storage
   proof is persisted automatically; no manual timestamp can substitute for it.
5. To test from this managed environment, allow its exact Site origin and approved
   model-download hosts through the environment settings, and supply credentials
   through secure settings. The current tools cannot modify that policy or GitHub
   Actions secrets. Never paste keys in chat, source code or logs.
6. Perform the exact deployed Generate Clips sequence after these prerequisites.
   Until the deployed dashboard serves and plays that resulting MP4, report the
   production end-to-end acceptance test as BLOCKED.
