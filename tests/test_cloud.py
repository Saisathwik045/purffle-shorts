import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from purffle_shorts import cloud
from purffle_shorts.config import Settings


def source():
    return dict(id="owned-talk", url="https://example.org/talk.mp4", sha256="a" * 64,
                license="owned", rights_evidence="Owner archive record 12", reviewed_by="Owner",
                reviewed_on="2026-01-01", attribution="Original talk by the channel owner; edited excerpt.",
                approved=True, all_components_cleared=True, platform_download_permitted=True)


def manifest(tmp_path, items):
    p = tmp_path / "sources.json"
    p.write_text(json.dumps({"sources": items}))
    return p


@pytest.mark.parametrize("change", [
    {"approved": False}, {"license": "CC-BY-NC"}, {"license": "Standard YouTube"},
    {"license": "CC-BY-ND-4.0"}, {"rights_evidence": ""}, {"sha256": "unknown"},
    {"all_components_cleared": False}, {"platform_download_permitted": False},
    {"expires_on": "2020-01-01"}, {"reviewed_on": "2099-01-01"}, {"id": "../escape"},
    {"url": "http://example.org/talk.mp4"}, {"url": "https://example.org/talk.mp4?token=secret"},
])
def test_rejects_uncleared_sources(tmp_path, change):
    with pytest.raises(ValueError):
        cloud.validate_queue(manifest(tmp_path, [source() | change]))


def test_duplicate_and_empty_queue(tmp_path):
    assert cloud.validate_queue(manifest(tmp_path, [])) == []
    with pytest.raises(ValueError):
        cloud.validate_queue(manifest(tmp_path, [source(), source()]))


def test_no_environment_can_enable_paid_services_or_uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "paid")
    monkeypatch.setenv("UPLOAD", "true")
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    s = cloud.cloud_settings(tmp_path)
    assert s.offline and not s.upload and not s.openai_api_key and not s.llm_api_key
    assert s.whisper_device == "cpu" and s.align == "faster-whisper"
    assert s.privacy == "private" and not s.caption_emoji
    assert not Settings().upload


def test_upload_denied_before_processing(tmp_path, monkeypatch):
    monkeypatch.delenv("PURFFLE_YOUTUBE_UPLOAD_AUTHORIZED", raising=False)
    with pytest.raises(PermissionError):
        cloud.run(Path("missing.json"), tmp_path, upload=True)


def test_no_paid_transcription_fallback(settings, tmp_path, monkeypatch):
    from purffle_shorts import clipper, tts
    from purffle_shorts.utils import PermanentError
    monkeypatch.setattr(clipper.ffmpeg, "run", lambda *a, **k: None)
    def missing(*args, **kwargs):
        raise ImportError("no whisper")
    monkeypatch.setattr(tts, "_align_faster_whisper", missing)
    monkeypatch.setattr(tts, "_align_openai", lambda *a: pytest.fail("Paid API called"))
    with pytest.raises(PermanentError, match="paid fallback"):
        clipper.transcribe(tmp_path / "source.mp4", tmp_path, settings.with_overrides(
            align="faster-whisper", openai_api_key="paid"))


def test_cpu_is_forced_even_with_cuda(tmp_path, monkeypatch):
    import sys

    from purffle_shorts import tts
    calls = []
    class Model:
        def __init__(self, *args, **kwargs):
            calls.append(kwargs)
        def transcribe(self, *args, **kwargs):
            return [], None
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model))
    monkeypatch.setattr(tts, "_cuda", lambda: True)
    monkeypatch.setattr(tts, "_pcm16k", lambda p: [])
    monkeypatch.setattr(tts, "_model_cache", {})
    assert tts._align_faster_whisper(tmp_path / "audio", "en", device="cpu") == []
    assert calls[0]["device"] == "cpu" and calls[0]["compute_type"] == "int8"


def test_fetch_checksum_limits_and_private_hosts(tmp_path, monkeypatch):
    monkeypatch.setattr(cloud.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", ("127.0.0.1", 443))])
    monkeypatch.setattr(cloud.requests, "get", lambda *a, **k: pytest.fail("Private request"))
    with pytest.raises(ValueError, match="public"):
        cloud.fetch(source(), tmp_path / "src")
    monkeypatch.setattr(cloud.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", ("93.184.216.34", 443))])
    class Response:
        status_code = 200
        def __enter__(self):
            return self
        def __exit__(self, *a):
            pass
        def iter_content(self, n):
            yield b"test"
    monkeypatch.setattr(cloud.requests, "get", lambda *a, **k: Response())
    with pytest.raises(ValueError, match="checksum"):
        cloud.fetch(source(), tmp_path / "src")
    monkeypatch.setattr(cloud, "MAX_BYTES", 2)
    with pytest.raises(ValueError, match="500 MiB"):
        cloud.fetch(source(), tmp_path / "src")


def test_render_records_rights_and_skips_completed(tmp_path, monkeypatch):
    from purffle_shorts.pipeline import Result
    item = source()
    path = manifest(tmp_path, [item])
    folder = tmp_path / "clip"
    folder.mkdir()
    (folder / "metadata.json").write_text(json.dumps({"description": "An excerpt"}))
    result = Result(True, "clip", folder=folder, record_id=1)
    history = SimpleNamespace(update_video=lambda *a, **k: None)
    monkeypatch.setattr(cloud, "Studio", lambda settings: SimpleNamespace(history=history))
    monkeypatch.setattr(cloud, "fetch", lambda item, dest: dest)
    calls = []
    monkeypatch.setattr(cloud.clipper, "make_clips", lambda *a, **k: calls.append(k) or [result])
    root = tmp_path / "out"
    cloud.run(path, root)
    cloud.run(path, root)
    assert len(calls) == 1 and calls[0]["upload"] is False
    meta = json.loads((folder / "metadata.json").read_text())
    assert meta["rights"] == item and item["attribution"] in meta["description"]
    key = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
    assert key in json.loads((root / "completed.json").read_text())
