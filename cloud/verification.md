# Verification record — 18 November 2026

Environment: managed Linux x86_64 cloud workspace, Python 3.12. No Mac processing.

- Original suite: **265 passed** in 348.60 seconds.
- Focused clipping/rights/CPU/upload/config suite: **46 passed** in 24.91 seconds.
- New cloud safety tests, including authorized private upload and ambiguous-failure handling: **22 passed** in 0.59 seconds. Upload transport is mocked; no channel was contacted.
- Repository Ruff checks, Studio JavaScript syntax, workflow YAML parsing and empty
  manifest validation passed. YAML parsing does not prove GitHub expression semantics.
- Clipping dependencies installed successfully: faster-whisper 1.2.1, CTranslate2
  4.9.0, PyAV 19.0.2, yt-dlp 2026.10.26. Complete pins are in `requirements.lock`.
- An original speech/video source was synthesized with ffmpeg's flite filter in
  `/tmp/purffle-smoke` for actual CPU-model inference and captioned rendering.
  Model download was rejected by the environment proxy with HTTP 403. This is an
  unverified real-inference smoke, not a passing test. No paid fallback was used.
- `cloud/smoke.py` reproduces the real-inference test in public Linux GitHub CI.
  It requires free access to the Whisper base weights on Hugging Face; no secrets,
  paid APIs, source downloads or uploads are involved. It asserts recognizable
  spoken words in SRT and checks the rendered video's dimensions/audio.
- The existing render tests use synthetic fixtures and verify actual ffmpeg output,
  including caption composition, sound/picture sync and clip framing. The cloud
  unit tests stub model initialization to verify CPU/int8 selection, not accuracy.
- Live YouTube upload, OAuth consent/token refresh against a real channel, API
  quota and account billing were not exercised. Uploads remain disabled.

Full changed-suite run: **285 passed in 278.55 seconds**. Two additional upload-safety
cases added afterward passed with the complete 22-test cloud file; production code
was unchanged. `pip check` also reports no broken requirements.

An intermediate run had one failure caused by an incorrect import in the new
CPU-selection test; it was corrected before the successful full run.

GitHub Actions on commit `c35192b`: cloud-manifest validation, Docker build/smoke,
package build/check, and Python 3.10 tests passed. Other jobs were still running at
this snapshot. The render job correctly skipped because rendering was not enabled.
See the PR checks for subsequent results.
