"""Bounded, CPU-only clipping of a reviewed source queue. Never loads .env."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import platform
import re
import socket
import tempfile
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import requests

from . import clipper, ffmpeg
from .config import Settings
from .pipeline import Studio

MAX_BYTES = 500 * 1024 * 1024
LICENSES = {"owned", "written-permission", "CC0-1.0", "CC-BY-4.0"}


def validate_queue(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("sources"), list):
        raise ValueError("Manifest must contain a sources array")
    seen = set()
    for item in data["sources"]:
        if not isinstance(item, dict):
            raise ValueError("Source must be an object")
        for key in ("id", "url", "sha256", "license", "rights_evidence", "reviewed_by", "reviewed_on", "attribution"):
            if not isinstance(item.get(key), str) or not item[key].strip():
                raise ValueError(f"Source requires {key}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", item["id"]) or item["id"] in seen:
            raise ValueError("Source IDs must be unique safe slugs")
        seen.add(item["id"])
        if item["license"] not in LICENSES or item.get("approved") is not True:
            raise ValueError("Source requires explicit rights approval and an allowed license")
        if item.get("platform_download_permitted") is not True or item.get("all_components_cleared") is not True:
            raise ValueError("Clear platform download terms, music, guests and all source components first")
        if len(item["attribution"]) > 1200:
            raise ValueError("Attribution must fit in 1200 characters without truncation")
        reviewed = date.fromisoformat(item["reviewed_on"])
        if reviewed > date.today():
            raise ValueError("Rights review cannot be in the future")
        if item.get("expires_on") and date.fromisoformat(item["expires_on"]) < date.today():
            raise ValueError("Source permission expired")
        if not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
            raise ValueError("Source requires a pinned SHA-256")
        url = urlsplit(item["url"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("Use a public direct HTTPS media URL without credentials or signed query strings")
    return data["sources"]


def fetch(item: dict, dest: Path) -> Path:
    url = item["url"]
    host = urlsplit(url).hostname
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("Source must resolve to public addresses")
    digest, size = hashlib.sha256(), 0
    # Redirects are deliberately rejected: approve the final direct media URL instead.
    with requests.get(url, stream=True, timeout=(15, 60), allow_redirects=False) as response:
        if response.status_code != 200:
            raise ValueError(f"Direct source returned HTTP {response.status_code}")
        with dest.open("wb") as out:
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("Source exceeds 500 MiB")
                digest.update(chunk)
                out.write(chunk)
    if size == 0 or digest.hexdigest() != item["sha256"]:
        dest.unlink(missing_ok=True)
        raise ValueError("Source checksum mismatch")
    info = ffmpeg.probe(dest)
    if not info["has_audio"] or not info["has_video"] or not math.isfinite(info["duration"]) or not 5 <= info["duration"] <= 1800:
        raise ValueError("Source must have audio/video and last 5–1800 seconds")
    return dest


def cloud_settings(root: Path) -> Settings:
    # Construct directly: environment API keys, providers, webhooks and .env cannot enable paid calls.
    return Settings(offline=True, upload=False, privacy="private", keep_videos=True,
                    align="faster-whisper", whisper_model="base", whisper_device="cpu",
                    resolution=(720, 1280), video_encoder="libx264", workers=1,
                    seo_keywords=False, caption_emoji=False, check_updates=False,
                    sound_effects=False, clip_zoom=False, watermark="none", end_cta="",
                    output_dir=str(root / "videos"), data_dir=str(root / "data"))


def run(manifest: Path, root: Path, *, upload: bool = False) -> int:
    if platform.system() != "Linux":
        raise RuntimeError("Cloud pipeline requires a Linux cloud runner")
    if upload and os.environ.get("PURFFLE_YOUTUBE_UPLOAD_AUTHORIZED") != "true":
        raise PermissionError("Upload requires explicit authorization and PURFFLE_YOUTUBE_UPLOAD_AUTHORIZED=true")
    sources = validate_queue(manifest)  # validate the entire queue before any network or inference
    root.mkdir(parents=True, exist_ok=True)
    settings = cloud_settings(root)
    if upload:
        token = Path(os.environ.get("YOUTUBE_TOKEN_FILE", "token.json"))
        if not token.is_file():
            raise ValueError("Provide an authorized OAuth JSON token; interactive/legacy auth is disabled here")
        settings = settings.with_overrides(token_file=str(token))
    studio = Studio(settings)
    done_file = root / "completed.json"
    done = json.loads(done_file.read_text()) if done_file.exists() else {}
    for item in sources:
        key = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
        if key in done:
            continue
        if upload and (root / f"upload-intent-{key}.json").exists():
            raise RuntimeError("Existing upload intent: reconcile with YouTube before retrying")
        with tempfile.TemporaryDirectory(prefix="purffle-source-") as scratch:
            src = fetch(item, Path(scratch) / "source.mp4")
            results = clipper.make_clips(studio, str(src), count=1, crop="blur", upload=False)
        if not results or any(not r.ok for r in results):
            raise RuntimeError(f"Clipping failed for {item['id']}")
        for result in results:
            meta_path = result.folder / "metadata.json"
            meta = json.loads(meta_path.read_text())
            meta.update(rights=item, clip_of=item["url"])
            meta["description"] = (meta["description"][:3500] + "\n\n" + item["attribution"][:1200])
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            studio.history.update_video(result.record_id, description=meta["description"])
            # Persist intent BEFORE contacting YouTube. An ambiguous failure needs manual reconciliation.
            if upload:
                intent = root / f"upload-intent-{key}.json"
                with intent.open("x", encoding="utf-8") as handle:
                    json.dump({"source": item["id"], "folder": str(result.folder)}, handle)
                status = studio.upload_record(result.record_id, result)
                if status != "uploaded":
                    raise RuntimeError("Upload incomplete; reconcile the intent with YouTube before retrying")
        done[key] = {"source": item["id"], "folders": [str(r.folder) for r in results]}
        tmp = done_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(done, indent=2), encoding="utf-8")
        tmp.replace(done_file)
    return len(sources)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("cloud/sources.json"))
    parser.add_argument("--output", type=Path, default=Path("cloud-output"))
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--upload", action="store_true", help="Explicitly authorized private uploads only")
    args = parser.parse_args()
    count = len(validate_queue(args.manifest)) if args.validate_only else run(args.manifest, args.output, upload=args.upload)
    print(f"Validated {count} source(s)" if args.validate_only else f"Queue complete: {count} source(s)")


if __name__ == "__main__":
    main()
