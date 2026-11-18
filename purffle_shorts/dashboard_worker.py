"""Pull authorized jobs from the private dashboard and reuse the existing clipper on Linux CPU."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests

from . import clipper, ffmpeg
from .cloud import cloud_settings, fetch
from .pipeline import Studio
from .whisper_assets import prepare


class DashboardClient:
    def __init__(self):
        self.origin = os.environ.get("PURFFLE_DASHBOARD_URL", "").rstrip("/")
        url = urlsplit(self.origin)
        if url.scheme != "https" or not url.hostname or url.path or url.query or url.fragment or url.username:
            raise ValueError("PURFFLE_DASHBOARD_URL must be the exact HTTPS dashboard origin")
        self.session = requests.Session()
        worker_token = os.environ.get("PURFFLE_DASHBOARD_WORKER_TOKEN", "")
        site_token = os.environ.get("PURFFLE_DASHBOARD_SITE_TOKEN", "")
        if not worker_token or not site_token:
            raise ValueError("Configure both private Site service access and the separate dashboard worker token")
        self.session.headers.update({"Authorization": f"Bearer {worker_token}",
                                     "OAI-Sites-Authorization": f"Bearer {site_token}"})
        self.job: dict | None = None

    def request(self, method: str, path: str, **kwargs):
        # Claim has ambiguous side effects; it must never be retried automatically.
        attempts = 1 if path.endswith("/claim") else 3
        for attempt in range(attempts):
            try:
                response = self.session.request(method, self.origin + path, timeout=(15, 120),
                                                allow_redirects=False, **kwargs)
            except (requests.ConnectionError, requests.Timeout):
                if attempt + 1 == attempts:
                    raise RuntimeError(f"Cloud API connection failed during {path.rsplit('/', 1)[-1]}; no YouTube upload was attempted") from None
            else:
                if 200 <= response.status_code < 300:
                    return response.json()
                if response.status_code not in (408, 429, 500, 502, 503, 504) or attempt + 1 == attempts:
                    raise RuntimeError(f"Cloud API {path.rsplit('/', 1)[-1]} returned HTTP {response.status_code}; review connection, free-tier limits and lease status")
            if method == "PUT" and hasattr(kwargs.get("data"), "seek"):
                kwargs["data"].seek(0)
            time.sleep(2 ** attempt)
        raise RuntimeError("Cloud API request did not complete")

    def claim(self):
        self.job = self.request("POST", "/api/worker/claim", json={"job_id": os.environ.get("PURFFLE_DASHBOARD_JOB_ID", ""),
                                                                    "runner_url": os.environ.get("PURFFLE_RUNNER_URL", "")})["job"]
        if self.job:
            self.session.headers["X-Job-Lease"] = self.job["lease_id"]
        return self.job

    def update(self, operation: str, data: dict):
        return self.request("POST", f"/api/worker/jobs/{self.job['id']}/{operation}", json=data)

    def file(self, clip_id: str, kind: str, path: Path):
        with path.open("rb") as handle:
            return self.request("PUT", f"/api/worker/jobs/{self.job['id']}/clips/{clip_id}/{kind}",
                                data=handle, headers={"Content-Length": str(path.stat().st_size),
                                                      "Content-Type": "video/mp4" if kind == "video" else "application/x-subrip"})


def source_record(job: dict) -> dict:
    auth = job.get("authorization") or {}
    if auth.get("approved") is not True or auth.get("method") != "direct_https":
        raise ValueError("Dashboard job lacks approved source authorization")
    return {"id": job["id"], "url": auth["media_url"], "sha256": auth["sha256"], "license": auth["license"],
            "rights_evidence": auth["evidence"], "reviewed_by": auth["reviewed_by"],
            "reviewed_on": auth["reviewed_on"], "attribution": auth["attribution"],
            "approved": True, "all_components_cleared": auth.get("all_components_cleared"),
            "platform_download_permitted": auth.get("platform_download_permitted"),
            **({"expires_on": auth["expires_on"]} if auth.get("expires_on") else {})}


def process(client: DashboardClient, job: dict, root: Path, *, synthetic_fixture: Path | None = None):
    from .cloud import validate_queue

    record = source_record(job)
    manifest = root / "source.json"
    manifest.write_text(json.dumps({"sources": [record]}))
    validate_queue(manifest)  # independent worker-side rights and expiry validation before downloading
    if synthetic_fixture is None:
        source = fetch(record, root / "source.mp4")
    else:
        # Internal CI injection only: no public API/CLI can select a local file or skip rights validation.
        source = synthetic_fixture
        if source.stat().st_size > 500 * 1024 * 1024 or hashlib.sha256(source.read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError("Synthetic verification source checksum mismatch")
        info = ffmpeg.probe(source)
        if not info["has_audio"] or not info["has_video"] or not 5 <= info["duration"] <= 1800:
            raise ValueError("Synthetic verification source must meet the same media limits")
    client.update("stage", {"state": "TRANSCRIBING", "message": "Authorized media checksum and duration verified. Beginning CPU speech transcription."})
    opts = job["options"]
    resolution = {"9:16": (720, 1280), "1:1": (720, 720), "16:9": (1280, 720)}[opts["aspect"]]
    if not 1 <= int(opts["count"]) <= 10 or not 15 <= int(opts["duration"]) <= 60:
        raise ValueError("Invalid dashboard clipping limits")
    settings = cloud_settings(root / "render").with_overrides(
        resolution=resolution, caption_style=opts["caption_style"], language=opts["language"],
        whisper_model=os.environ.get("PURFFLE_WHISPER_MODEL_PATH") or prepare())
    stage = "TRANSCRIBING"

    def progress(name, _legacy_percentage, message):
        nonlocal stage
        # Ignore the original Studio's estimated percentage. Report only real stage boundaries.
        target = {"script": "SELECTING_HIGHLIGHTS", "render": "RENDERING"}.get(name)
        if target and target != stage:
            client.update("stage", {"state": target, "message": message or target.replace("_", " ").lower()})
            stage = target

    results = clipper.make_clips(Studio(settings, progress=progress), str(source), count=int(opts["count"]),
                                min_seconds=max(5, int(opts["duration"]) - 5),
                                max_seconds=int(opts["duration"]), crop="blur", upload=False)
    if not results or any(not r.ok for r in results):
        raise RuntimeError("One or more clips could not be rendered. Review the worker logs and retry processing.")
    client.update("stage", {"state": "GENERATING_METADATA", "message": "Saving generated clip metadata, video and subtitles to private cloud storage."})
    for index, result in enumerate(results, 1):
        meta = json.loads((result.folder / "metadata.json").read_text())
        clip = client.update("clips", {"position": index, "title": meta["title"],
                                        "description": meta["description"], "duration": meta["duration"]})
        if result.video.stat().st_size > 25 * 1024 * 1024:
            raise ValueError("Rendered clip exceeds the dashboard's 25 MiB storage limit")
        client.file(clip["id"], "video", result.video)
        client.file(clip["id"], "subtitles", result.folder / "captions.srt")
    client.update("complete", {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-connection", action="store_true")
    parser.add_argument("--verify-storage", action="store_true", help="Verify private PUT/GET/delete only after account free-tier confirmation")
    args = parser.parse_args()
    if platform.system() != "Linux":
        raise RuntimeError("Dashboard processing requires a remote Linux cloud runner")
    client = DashboardClient()
    if args.verify_storage:
        result = client.request("POST", "/api/worker/verify-storage", json={})
        if not result.get("storage_verified"):
            raise RuntimeError("Private storage roundtrip did not verify")
        print(f"Private storage roundtrip verified at {result['checked_at']}; proof persisted by the dashboard; no job claimed or video processed")
        return
    if args.check_connection:
        result = client.request("POST", "/api/worker/health", json={})
        if not result.get("connected") or not result.get("storage_bound"):
            raise RuntimeError("Private dashboard connection or storage binding is incomplete")
        print(f"Private dashboard connection verified at {result['checked_at']}; no job was claimed and no media operation or YouTube upload was attempted")
        return
    job = client.claim()
    if not job:
        print("No authorized queued jobs. Worker heartbeat recorded.")
        return
    try:
        with tempfile.TemporaryDirectory(prefix="purffle-dashboard-job-") as folder:
            process(client, job, Path(folder))
        print(f"Job {job['id']}: clips saved for review. Nothing was published.")
    except Exception as error:
        detail = str(error).lower()
        if "checksum" in detail:
            message = "The authorized source checksum changed. Review the source evidence and exact media file before retrying."
        elif "403" in detail or "proxy" in detail:
            message = "Cloud access was denied. Check private Site credentials, source access and public Whisper download connectivity. No restriction was bypassed."
        elif isinstance(error, ImportError):
            message = "CPU inference dependencies are missing. Reinstall the pinned cloud requirements."
        elif "cloud api" in detail:
            message = str(error)
        else:
            message = f"{type(error).__name__}: cloud generation failed. Check the GitHub worker run for model, source or FFmpeg errors."
        try:
            client.update("fail", {"error": message})
        except Exception:
            print("Could not report failure. The lease will expire visibly; review before retrying.")
        raise RuntimeError(f"Job {job['id']} failed; no upload was attempted") from None


if __name__ == "__main__":
    main()
