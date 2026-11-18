# Pluggable cloud worker contract (production disabled by default)

The dashboard is the private control plane; the media pipeline runs only on an
independently authorized cloud CPU worker. Do not use a Mac, GitHub Actions app
backend, provider-limit workaround or paid automatic fallback.

## Private runtime configuration

- WORKER_PROVIDER=none (default). Set https only after a provider is independently verified.
- WORKER_BACKEND_AUTHORIZED=true: documented provider permission for this workload.
- WORKER_NO_CHARGE_VERIFIED=true: actual no-card/no-additional-charge account limits checked.
- WORKER_DISPATCH_URL: one public HTTPS endpoint with no credentials/query/fragment.
- WORKER_DISPATCH_HOST: exact hostname allowlist; no redirects, IP/private host or GitHub API.
- WORKER_DISPATCH_TOKEN: dedicated random server-side secret, minimum 32 characters.
- WORKER_TOKEN and the existing private Site service credential: stored separately
  on the authorized worker, never passed to browser or in dispatch payloads.
- FREE_TIER_VERIFIED: separate storage/hosting allowance check. Keep false until verified.

Flags record a verified decision; setting them cannot create provider permission
or prevent account-wide billing. Never add payment details as a shortcut.

## Submission

Dashboard POST to the configured URL:
- Authorization: Bearer <dedicated dispatch secret>
- Content-Type: application/json
- Idempotency-Key: <job_id>:<attempt>
- JSON: contract=purffle.worker.v1, job_id, attempt, idempotency_key.

The provider must validate authorization in constant time, reject unknown fields,
bound the body/concurrency/runtime/media sizes, persist deduplication by job+attempt,
and queue at most one processing attempt. Respond only after durable acceptance:
HTTP 202, application/json, contract=purffle.worker.v1, accepted=true,
matching job_id and attempt. A timeout is unconfirmed; wake the same job again.
Acknowledgement is not proof of processing or a completed clip.

Do not return a 202 for a discarded in-memory task or automatically create paid
instances after free limits. Stop at the quota and let the dashboard show blocked status.

## Processing and callbacks

Reuse purffle_shorts.dashboard_worker and the existing authenticated worker API:
health, verify-storage, claim, stage, clips/uploads and complete/fail. The provider
maintains private Site service access and worker credentials in its own secure
settings. Claims and uploads still require existing owner rights and valid leases.
Authenticated callbacks renew heartbeat liveness; heartbeat does not fabricate storage proof.

The adapter dispatches IDs only. A worker learns authorized source access through
the existing claim response. It never receives owner OAuth/publishing tokens.
No subscription, provider endpoint or background daemon is provisioned by this contract.

## Private storage and preview

Run the actual account-verified storage probe before processing. A good probe writes,
reads back and deletes an object; a binding/health flag or manual timestamp is not proof.
Preserve R2 reservation/operation budgets, same-origin owner checks, HEAD/range behavior,
seven-day retention and PR #3 playback fixes. Never publish the bucket or expose keys.

## Metadata and publishing preparation

Bootstrap returns metadata_hash for each real clip. Owner POST metadata and review
requests use expected_hash for optimistic concurrency. Metadata edits reset approval.
POST /api/clips/<id>/preparation exports a 10-minute diagnostic snapshot for review.
It never authorizes upload, performs OAuth, lists secrets/object keys, writes a publication
record or verifies that the media body can play. POST publish remains forbidden.

## Required cloud-only tests before rollout

Run existing Node tests/build and Python checks in the managed Codex Cloud environment.
Add real browser coverage for editing metadata, approval invalidation, stale decisions,
owner isolation and the non-executable preparation download. Keep isolated synthetic
CPU integration separate from production private R2/dashboard acceptance. No Mac execution.
