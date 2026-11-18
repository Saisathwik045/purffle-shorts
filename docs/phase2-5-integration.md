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
