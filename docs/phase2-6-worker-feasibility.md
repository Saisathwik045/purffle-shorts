# Phase 2.6: worker feasibility and blocked-production status

Research checked 18 November 2026 against the primary sources linked below.
The working baseline is merged PR #2 plus the unmerged PR #3 head a0036b5.
This is a provider-neutral fallback, not a claim that production clipping works.

## Decision

No provider/account combination is currently verified to satisfy all of:
no Mac compute, no extra subscription, no paid API, no card trial, authorized
application-backend use, unattended processing, private storage, and tested playback.

This is not a claim that free CPU cannot exist. Lightning AI and HF ZeroGPU
have genuine conditional free offerings, but eligibility, restart/queue behavior,
production permission, credentials and private end-to-end operation are not verified
for this account. Do not provision or activate them based on pricing alone.
Do not automate restarts, account rotation or keep-alive traffic to evade limits.

## Required providers: technical feasibility

| Provider | CPU / RAM | FFmpeg / Whisper | Runtime | Temporary / persistent storage | Network / submission API |
| --- | --- | --- | --- | --- | --- |
| HF CPU Basic Space | 2 vCPU / 16 GB | Docker can install FFmpeg and CPU inference | Sleeping/restarted service; no durable-job guarantee | 50 GB ephemeral; durable storage separate | Limited outbound ports; HTTP/Gradio API |
| HF ZeroGPU exception | CPU host allocation is not a documented general-purpose CPU worker entitlement; shared GPU | Gradio/PyTorch GPU functions; existing CTranslate2 CPU pipeline is not validated on it | Default GPU function 60 s, custom duration supported; queue and daily quota apply | No private durable video storage established | Gradio API; private access and user quota require account verification |
| Google Cloud VM / Cloud Run | No eligible no-billing allocation verified | Containers/VMs technically support both | Product-specific, irrelevant without eligible billing | Ephemeral containers / separately billed disks and objects | HTTPS/SDK APIs; account billing prerequisite |
| Cloudflare Workers Free | 128 MB isolate; 10 ms CPU/request; not a Linux VM | Native FFmpeg subprocess and current Python inference worker cannot run as-is | HTTP wall time is not CPU time; long fetch waits do not grant compute | Virtual temporary memory; R2/D1 separate services | Excellent control-plane HTTP APIs; outbound fetch supported |
| GitHub-hosted public Linux CI | Standard x64 4 vCPU / 16 GB | Both work for software tests | 6 h/job ceiling; workflows may impose less | 14 GB ephemeral runner disk; artifacts separately limited | Workflow APIs exist, but are not selected for app job dispatch |

## Required providers: allowances, policy and eligibility

| Provider | Free allowance / payment requirement | Application use and unattended suitability | Outcome |
| --- | --- | --- | --- |
| HF CPU Basic | No hourly CPU charge, but new Gradio/Docker compute Spaces require PRO/Team/Enterprise; Static is free | ML demo/API hosting exists, but Static cannot execute this pipeline | Rejected under no-additional-subscription requirement |
| HF ZeroGPU | Up to 2 Spaces for verified-email personal accounts older than 30 days; free user GPU quota 5 min/day | Gradio-only, queued and quota-bound; no verified unattended production arrangement here | Conditional demo/inference candidate, not an activated production worker |
| Google Cloud | Free Tier requires an active Cloud Billing account | Backend compute is supported technically, but a no-billing account is required by this task | Rejected; no billing or trial enabled |
| Cloudflare Workers | 100,000 requests/day; free control-plane tier exists | Legitimate dashboard/API host, insufficient media/inference compute | Keep existing dashboard/control plane; not selected as renderer |
| GitHub Actions | Standard public CI runner availability does not grant backend permission | Terms restrict disproportionate/serverless application use and unrelated hosted-runner work | CI/CD only; application processing paths removed in this branch |

Sources: [HF overview](https://huggingface.co/docs/hub/spaces-overview),
[HF Docker](https://huggingface.co/docs/hub/spaces-sdks-docker),
[HF ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu),
[Google Free Tier](https://docs.cloud.google.com/free/docs/free-cloud-features),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[GitHub terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions),
[runner resources](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Actions runtime ceiling](https://docs.github.com/en/actions/reference/limits).

## Other CPU environments investigated

| Provider | Compute / runtime | Storage / network / API | Payment and backend suitability |
| --- | --- | --- | --- |
| Render Free | 0.1 CPU, 512 MB; idle sleep after 15 min, restart possible at any time; 750 instance-hours/workspace/month | Ephemeral filesystem, no free persistent disk or one-off jobs; HTTPS APIs; outbound traffic/build limits | Docs say not for production; no-card overage suspends services, not unlimited compute. No validated Whisper memory/runtime fit. Not selected |
| Koyeb Free | 0.1 vCPU, 512 MB; one instance, idle sleep after 1 h | 2 GB SSD, no volumes; web service API, not Worker Services | Credit card verification and plan charge described by provider; docs exclude production. Rejected |
| Google Colab | Dynamic non-guaranteed CPU/RAM; free notebook may run up to 12 h | Session filesystem, separate Drive; outbound access; not a production submission service | No-card notebook use exists, but unrelated media/web service offerings are disallowed. Interactive research/testing only |
| Google Cloud Shell | Shared development VM; 50 h/week; interactive sessions | 5 GB persistent home, network and development preview | No-billing development option, explicitly not unattended application hosting |
| PythonAnywhere Free | 100 CPU seconds/day allowance; process RAM capped at 3 GB; web request timeout 5 min | 512 MiB disk, one web worker, outbound allowlist; app expires after one month | No-card web hosting exists; free accounts lack always-on worker capability. Model/dependency/media disk needs and outbound/private-service access unverified. Not suitable for this unattended pipeline |
| Modal Starter | Configurable Linux CPU/RAM; runtime configurable by product | HTTPS job submission, outbound networking, ephemeral disk/Volumes; 30 USD/month compute credit | Payment method required; usage beyond credits is billable. Reject under no-card/no-paid activation constraints |
| Lightning AI Free Studio | Advertised 4 CPU / 16 GB, one free Studio, mandatory 4 h session restarts | Advertised persistent storage up to 200 GB; SDK/public-port demos; no private production roundtrip verified | Advertises no card and background execution, but free session restarts and 10 min auto-sleep remain. More credits or removing limits may be paid. Account and compliant unattended lifecycle unverified; do not automate forced restarts |

Sources: [Render free policy](https://render.com/docs/free),
[Render resource plans](https://render.com/docs/compute-plans),
[Koyeb resources](https://www.koyeb.com/docs/reference/instances),
[Koyeb billing](https://www.koyeb.com/docs/faqs/pricing),
[Colab FAQ](https://research.google.com/colaboratory/faq.html),
[Cloud Shell limits](https://docs.cloud.google.com/shell/docs/quotas-limits),
[PythonAnywhere free features](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/),
[PythonAnywhere RAM](https://help.pythonanywhere.com/pages/RAMLimit/),
[PythonAnywhere request timeout](https://help.pythonanywhere.com/pages/AsyncInWebApps),
[Modal pricing](https://modal.com/pricing),
[Modal billing](https://modal.com/docs/guide/billing),
[Lightning pricing](https://studio.lightning.ai/pricing/),
[Lightning getting started](https://code.lightning.ai/docs/platform/overview/getting-started/),
[Lightning auto-sleep](https://assets.lightning.ai/docs/platform/build/ai-studio/auto-sleep/).
Some Lightning documentation requires authentication; search-indexed primary pricing
is not proof of actual entitlement in this user's account.

## Implemented fallback architecture

The existing private dashboard, D1 records, R2 media routes and Python clipping
modules remain. WORKER_PROVIDER defaults to none. An HTTPS adapter is an interface
for a later authorized provider; it is not a deployed resource.

- No production GitHub repository/workflow dispatch remains in generation.js.
- No application-worker schedule remains in dashboard-worker.yml.
- cloud-clips.yml retains software validation only, not source-queue rendering.
- Software tests/builds may still use Actions as CI. They are not a backend and
  do not establish production storage or playback.
- New provider configuration, explicit host allowlisting, private dispatch secret,
  no redirects, timeout and exact acknowledgement checks fail closed.
- Dispatch carries a job ID/attempt/idempotency key, not media URLs, source rights,
  owner identity, callback credentials or publishing secrets.
- Existing authenticated claim, lease, stage, upload and reconciliation routes remain.
- A recent authenticated heartbeat and a genuine, current private storage proof
  are both required. Storage proof is bound to the current worker credential and
  dispatch configuration.
- Title/description edits are owner-only, bounded and use optimistic metadata
  hashes. Changed metadata clears approval. Stale edits/reviews fail with 409.
- Publishing preparation exports a non-executable JSON review document. It is
  always marked upload_enabled=false and execution_authorized=false. It contains
  neither credentials nor object keys and creates no publication records.
- YouTube publishing stays forbidden; no upload endpoint was enabled.

Protocol and secure setup are described in [worker-provider-contract.md](worker-provider-contract.md).

## Actual deployment and verification status

Native Sites read-only inspection in this phase confirmed:
- Existing Site appgprj_6afd2846709481918878ee21703805c9 is active, version 8.
- Access remains custom/private; no audience changes were made.
- D1 has one source-authorization-waiting job, zero clips, and zero worker heartbeats.
- No production worker callback, storage write/read/delete roundtrip, clip or playback
  was observed. Storage binding presence alone does not verify storage use.
- No provider, paid resource, subscription, API credit purchase, billing account,
  public bucket, publishing action or real-source processing was created here.

This phase's draft changes are not yet deployed or merged. Repository software CI
at code commit 944e024 passed 33 Node tests, JavaScript syntax and the production
dashboard build. Its isolated synthetic integration also passed real Whisper/FFmpeg
generation: 10.57 seconds, 720×1280, 13 subtitle cues, private range preview and
full video decoding. This used SQLite/filesystem test storage, not production D1/R2.
Evidence: https://github.com/Saisathwik045/purffle-shorts/actions/runs/44357274725

The user separately requires Codex Cloud verification. The current chat is attached
to the user's Mac; no application tests, dependency installs, rendering or transcription
have run there. An existing runnable purffle-shorts Codex Cloud environment was
discovered. The user explicitly authorized a new Cloud task; the creation request
has not returned a task ID yet. Codex Cloud verification is still pending, not passed.
Do not substitute the CI result for that requirement or use the Mac.

## Remaining account actions

1. Complete the already-authorized Codex Cloud task setup and run Cloud verification.
   The creation tool request is pending; do not create duplicate Cloud tasks or use
   the Mac as a fallback. No additional purchase or authorization is requested.
2. Establish a provider account with actual no-card/no-additional-charge eligibility
   and documented permission for this exact workload. For Lightning/ZeroGPU, verify
   the account-specific restart/queue/private-API behavior first. Neither is silently selected.
3. Supply secrets through secure provider/Sites settings only; never paste them in
   chat or commit them. Confirm the exact cloud-to-Site origin is permitted by the
   managed environment network policy; do not bypass that policy.
4. Verify the shared account's storage/hosting allowances and hard no-overage behavior.
   Application caps do not prove account-wide billing safety.
5. Run one authorized synthetic deployed job, private storage roundtrip, authenticated
   HEAD/range preview, cross-owner denial and actual dashboard playback. Keep this
   production check distinct from isolated CPU unit/integration tests.
6. Keep production generation off until those checks actually pass.

## Optional paid reference only — not activated or requested

For comparison, Render lists a 0.5 CPU/512 MB Starter service at 7 USD/month and
Hugging Face lists PRO at 9 USD/month (CPU Basic itself has no hourly fee).
Neither is selected, purchased or recommended for purchase in this task; 512 MB
is not an established fit for this pipeline. A general-purpose authorized CPU
container with enough measured RAM and explicit account spending controls would
be needed if no existing grant/free account qualifies. The exact cheapest viable
option depends on measured workload, storage and account eligibility, not the
headline entry price. Sources: [Render compute](https://render.com/docs/compute-plans),
[HF pricing](https://huggingface.co/pricing).
