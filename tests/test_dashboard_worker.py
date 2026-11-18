import json
from types import SimpleNamespace

import pytest

from purffle_shorts import dashboard_worker as W


def job():
    return {"id": "owned-talk", "authorization": {
        "approved": True, "method": "direct_https", "media_url": "https://example.org/video.mp4",
        "sha256": "a" * 64, "license": "owned", "evidence": "Owner record: original recording and audio",
        "reviewed_by": "owner", "reviewed_on": "2026-01-01", "attribution": "Owner recording; edited excerpt.",
        "all_components_cleared": True, "platform_download_permitted": True},
        "options": {"count": 3, "duration": 40, "caption_style": "bold", "language": "en", "aspect": "9:16"}}


def test_worker_needs_both_private_cloud_credentials(monkeypatch):
    monkeypatch.setenv("PURFFLE_DASHBOARD_URL", "https://dashboard.example.org")
    monkeypatch.delenv("PURFFLE_DASHBOARD_WORKER_TOKEN", raising=False)
    monkeypatch.delenv("PURFFLE_DASHBOARD_SITE_TOKEN", raising=False)
    with pytest.raises(ValueError, match="both"):
        W.DashboardClient()


def test_uncleared_job_never_fetches_media(tmp_path, monkeypatch):
    j = job()
    j["authorization"]["all_components_cleared"] = False
    monkeypatch.setattr(W, "fetch", lambda *args: pytest.fail("Unauthorized download"))
    with pytest.raises(ValueError):
        W.process(None, j, tmp_path)


def test_bridge_reuses_clipper_and_reports_only_actual_stages(tmp_path, monkeypatch):
    monkeypatch.setenv("PURFFLE_WHISPER_MODEL_PATH", str(tmp_path / "test-model"))
    updates, files = [], []
    client = SimpleNamespace(update=lambda operation, data: updates.append((operation, data)) or {"id": "clip-id"},
                             file=lambda *args: files.append(args))
    monkeypatch.setattr(W, "fetch", lambda record, dest: dest)
    observed = {}

    def make(studio, source, **kwargs):
        observed.update(kwargs)
        assert studio.s.whisper_device == "cpu" and studio.s.offline and not studio.s.upload
        assert studio.s.resolution == (720, 1280)
        studio.progress("voice", 23, "Transcribing")
        studio.progress("script", 61, "Selecting")
        studio.progress("render", 80, "Rendering")
        studio.progress("render", 82, "Rendering another clip")
        folder = tmp_path / "clip"
        folder.mkdir()
        (folder / "metadata.json").write_text(json.dumps({"title": "Generated clip", "description": "Clip", "duration": 30}))
        (folder / "short.mp4").write_bytes(b"generated-video")
        (folder / "captions.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nSpeech\n")
        return [SimpleNamespace(ok=True, folder=folder, video=folder / "short.mp4")]

    monkeypatch.setattr(W.clipper, "make_clips", make)
    W.process(client, job(), tmp_path)
    assert observed["upload"] is False and observed["count"] == 3
    assert [data["state"] for operation, data in updates if operation == "stage"] == [
        "TRANSCRIBING", "SELECTING_HIGHLIGHTS", "RENDERING", "GENERATING_METADATA"]
    assert all("progress" not in data and "percentage" not in data for _, data in updates)
    assert updates[-1] == ("complete", {}) and len(files) == 2


def test_claim_connection_failure_is_never_retried(monkeypatch):
    import requests
    calls = []
    client = W.DashboardClient.__new__(W.DashboardClient)
    client.origin = "https://dashboard.example.org"
    def timeout(*args, **kwargs):
        calls.append(args)
        raise requests.Timeout()
    client.session = SimpleNamespace(request=timeout)
    with pytest.raises(RuntimeError, match="claim"):
        client.request("POST", "/api/worker/claim", json={})
    assert len(calls) == 1


def test_transient_upload_retry_rewinds_same_file(monkeypatch):
    import io

    import requests
    bodies = []
    client = W.DashboardClient.__new__(W.DashboardClient)
    client.origin = "https://dashboard.example.org"
    def request(*args, **kwargs):
        bodies.append(kwargs["data"].read())
        if len(bodies) == 1:
            raise requests.Timeout()
        return SimpleNamespace(status_code=200, json=lambda: {"saved": True})
    client.session = SimpleNamespace(request=request)
    monkeypatch.setattr(W.time, "sleep", lambda _: None)
    assert client.request("PUT", "/api/worker/jobs/id/clips/id/video", data=io.BytesIO(b"actual-bytes")) == {"saved": True}
    assert bodies == [b"actual-bytes", b"actual-bytes"]
