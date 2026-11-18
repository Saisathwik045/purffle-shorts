"""Pinned public Whisper base weights for free CPU cloud inference."""
import os
from pathlib import Path


def prepare():
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
    from huggingface_hub import snapshot_download
    try:
        path = snapshot_download("Systran/faster-whisper-base", revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66", allow_patterns=[
            "config.json", "model.bin", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"])
    except Exception:
        raise RuntimeError("Public Whisper weights could not be downloaded. Run on the standard GitHub cloud runner with HTTPS access to huggingface.co and its download hosts; no paid API fallback is permitted.") from None
    if not (Path(path) / "model.bin").is_file():
        raise RuntimeError("The downloaded Whisper snapshot is incomplete")
    os.environ["PURFFLE_WHISPER_MODEL_PATH"] = path
    return path

