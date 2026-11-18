# Cloud clipping audit and operating guide

Audit date: 18 November 2026. Base: `514fd2547227b98d951dfc1489fc8c7ce72f1b68`.
Repository: `Saisathwik045/purffle-shorts` (public, confirmed through GitHub).
All inspection, dependency installation, media generation and tests were performed in a Linux cloud workspace. No commands or processing ran on the user's Mac.

## Findings and implementation

Repository-wide inventory covers 34 Python modules, the web Studio, tests, packaging,
notebook, Docker files, dependency declarations and three existing workflows. Static
inspection covered imports, network integrations, subprocesses, credentials, persistence,
and entry points, with detailed review of the clipping/upload paths. This is an
engineering readiness audit, not a formal security audit of every dependency.

| Area | Existing behavior | Cloud preparation |
| --- | --- | --- |
| Clipping (`clipper.py`) | Downloads arbitrary yt-dlp sources; rights only in a docstring; LLM picks moments; can fall back to OpenAI transcription | Separate reviewed direct-media queue, checksum verification and resource bounds; no yt-dlp extraction or paid fallback in cloud path |
| Inference (`tts.py`, `llm.py`, `localai.py`) | CUDA autodetection; CPU int8 already available; provider auto-selection can use a paid key | Explicit CPU device and base Whisper; no LLM, local server or Mac app startup; deterministic sentence-based moment selection |
| Subtitles/render (`timing.py`, `overlays.py`, `render.py`, `ffmpeg.py`, `sfx.py`) | Word timings, caption overlays, SRT and CPU x264 already implemented | Reused existing render pipeline; cloud uses 720x1280, original audio, blurred framing, no external emoji, no music, no TTS |
| Upload (`youtube.py`, `pipeline.py`, `crosspost.py`) | Resumable OAuth upload, retries, scheduling, optional caption tracks and paid relay | Global upload default and `.env.example` now false. Cloud workflow receives no credentials and exposes no upload option. Separately authorized cloud CLI can upload privately; no crossposting |
| Automation (`autopilot.py`, `planner.py`, `history.py`) | Long-lived process and SQLite history assume persistent disk | Daily ephemeral Linux workflow; small best-effort completion cache; one clip per source; serial concurrency and 45-minute timeout |
| Studio/CLI/MCP/desktop | Multiple entry points support generating and publishing content | Existing interfaces retained. The new workflow invokes only `python -m purffle_shorts.cloud`, bypassing `.env`, settings files and auto-selected API providers |
| Topics/media/SEO/analytics/notifications/updates | Many network services unrelated to clipping | Excluded from cloud clipping or explicitly disabled; source media, model download and optional authorized Google OAuth/API calls are the required network interactions |
| Packaging/docs/notebook | CPU ffmpeg in Docker; clipping extras absent from default image; desktop workflows build macOS/Windows; upstream release targets hardcoded | Dedicated Linux workflow installs clipping dependencies; existing release/desktop workflows are not used. No changes to publication targets or release ownership |
| Dependencies | Broad lower bounds; optional heavy models; installed Anthropic SDK doesn't itself incur fees | `cloud/requirements.lock` pins this Linux/Python 3.12 tested environment, including transitive packages; workflow installs it before the package with `--no-deps`. Pins are not hash-verified or a vulnerability scan |

General CLI/Studio still support paid providers when deliberately configured. The
zero-paid-service boundary applies to the new cloud entry point. Changing the global
upload default is intentional; users who want the legacy autopilot to publish must
explicitly opt in.

## Service cost inventory

- CPU Whisper/faster-whisper, CTranslate2 and ffmpeg require no paid inference API.
  Whisper weights must be downloaded once; base has lower accuracy than larger models.
- OpenAI text/transcription/TTS/images, Anthropic, ElevenLabs, DeepSeek, Mistral,
  Together and xAI may incur usage fees. They are unreachable through this cloud path.
- Gemini/Groq/OpenRouter may offer limited free usage, but availability and billing
  settings vary; no dependency on their free tiers is introduced.
- Pexels/Pixabay need keys and license compliance. Edge TTS and Pollinations are
  external services without an uptime/free-usage guarantee. None are used here.
- Upload-Post is an external relay with account/plan limits. It is not used.
- YouTube Data API uses quotas rather than a purchased inference service; check
  the actual project's limits. Current official documentation describes a separate
  video-upload quota bucket; do not rely on older 1,600-unit upload estimates.
- Standard public-repository GitHub-hosted runners are free. This workflow skips
  private repositories and larger/self-hosted runners. Artifact storage can be
  billable, so artifact export is disabled until `PURFFLE_ARTIFACTS_ENABLED=true`.
  Cache storage is shared with other workflows in this repository; account billing
  and storage settings cannot be guaranteed by source code. Set a stop-spending
  budget and do not purchase cache overage. One-day retention reduces storage but
  does not by itself guarantee zero cost.

Official references checked during this audit:
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[YouTube upload reference](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert),
[quota calculator](https://developers.google.com/youtube/data/determine_quota_cost),
[OAuth token expiry](https://developers.google.com/identity/protocols/oauth2#expiration),
[YouTube license types](https://support.google.com/youtube/answer/2797468),
[YouTube monetization policies](https://support.google.com/youtube/answer/1311392).

## Source rights gate

`cloud/sources.json` starts empty deliberately: no supplied source had a verified reuse
license. Each source needs a unique slug, direct public HTTPS media URL, exact file
SHA-256, license, rights evidence, human reviewer/date, attribution, and explicit
approval of all components and platform download terms. Signed URLs and redirects
are rejected. Private addresses are rejected at DNS preflight (this is not a hardened
network sandbox; only trusted maintainers should edit the manifest).

Allowed labels: `owned`, `written-permission`, `CC0-1.0`, `CC-BY-4.0`.
NC, ND, unknown and Standard YouTube licenses fail closed. This conservative subset
doesn't imply other licenses can never be used; they need separate review and code
support. A license label cannot verify ownership, release rights, music rights or the
scope of written permission. Check guests, embedded footage and audio, trademark and
privacy/publicity rights, commercial use, derivative works, territorial restrictions
and revocation. A downloadable video or a podcast appearance is not permission.
CC BY needs proper credit including the license link and an indication of edits.
Attribution is appended before any optional upload and preserved with the complete
rights record in metadata. Keep evidence independently if its URL can change.

Example (replace all placeholders, calculate SHA-256 in a cloud shell):

```json
{
  "sources": [{
    "id": "owned-interview-001",
    "url": "https://your-public-origin.example/interview.mp4",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
    "license": "owned",
    "rights_evidence": "Owner record or written permission reference",
    "reviewed_by": "Channel owner",
    "reviewed_on": "2026-11-18",
    "attribution": "Original interview by Owner. Edited excerpt, subtitles added.",
    "approved": true,
    "all_components_cleared": true,
    "platform_download_permitted": true
  }]
}
```

An optional `expires_on` date rejects expired permission. Metadata alone cannot
establish legality. Reuse permission also does not ensure YouTube monetization;
automatically selected excerpts with subtitles may lack sufficient original value.

## Cloud operation and remaining blockers

1. Review/merge the branch. Keep the repository public. Check Actions permissions,
   third-party action availability, included storage and stop-spending settings.
2. Add reviewed source records in a PR. Validation checks every record before any
   download or inference. Limit each source to 500 MiB and 5–1800 seconds. A large
   queue may exceed the 45-minute job budget; start with a single short source.
3. Set repository variable `PURFFLE_CLOUD_ENABLED=true` to enable rendering on the
   default branch. Schedule is 03:17 UTC daily (08:47 India time). GitHub schedules
   are best effort, may be delayed, and inactive public repositories may have them
   disabled. The workflow never invokes a Mac or self-hosted runner.
4. Leave `PURFFLE_ARTIFACTS_ENABLED` unset for no artifact storage. For downloadable
   MP4/SRT/rights metadata, enable it only after confirming free storage and a
   stop-spending budget. Exports expire after one day. Public repository artifacts
   and rights metadata should contain no private evidence, names or URLs that
   should not be disclosed. Without export, rendered media is discarded at job end.
5. The completed cache prevents ordinary repeated rendering, but can be evicted;
   re-rendering is possible after eviction. Cache completion is not a durable
   publication ledger and must never be used as upload deduplication.

No YouTube upload is enabled or attempted by the workflow. The integration exists
for a future explicitly authorized Linux cloud session:

```sh
# Only after channel-owner authorization; persistent cloud disk required.
# Obtain OAuth credentials/refresh token through a browser in that cloud environment.
PURFFLE_YOUTUBE_UPLOAD_AUTHORIZED=true YOUTUBE_TOKEN_FILE=/secure/token.json \
  python -m purffle_shorts.cloud --manifest cloud/sources.json \
  --output /persistent/purffle --upload
```

This uploads privately only. Provide an already-authorized JSON token using the
`youtube.upload` scope; `youtube.py` refreshes it noninteractively. Do not store OAuth
secrets, refresh tokens or the persistent output directory in Git/artifacts/caches.
OAuth consent, correct channel selection, enabling YouTube Data API and any required
verification are account-owner actions. External OAuth apps in Testing can have
seven-day refresh-token expiry. Actual API quota, channel upload limits, account
restrictions and permission status require account access to verify. Older private-only
upload restrictions have changed in current documentation; verify the current
project's behavior instead of assuming an audit is always required.

Upload intent files are exclusively created before upload to stop blind automatic
retry after ambiguous failures, but only while the persistent disk is preserved.
The current integration intentionally does not wire uploads into ephemeral scheduled
Actions. Durable publication state, reconciliation of ambiguous responses, token
rotation, and explicit publication authorization are prerequisites for doing so.
Rendered completion state should not be reused as an upload queue; use a new persistent
output directory for an initially authorized upload run. Never change directories to
retry an ambiguous upload: check YouTube and reconcile the existing intent first.

## Verification

See `cloud/verification.md` for exact results and limitations. Network restrictions
in this managed cloud session returned HTTP 403 for Hugging Face model downloads;
therefore actual downloaded-weight inference must be verified on a cloud runner with
Hugging Face access. No fallback to a paid API was attempted.
