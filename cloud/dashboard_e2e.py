"""Real cloud speech inference/render and HTTP dashboard integration using an isolated test store."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import requests
from PIL import Image

from purffle_shorts import ffmpeg
from purffle_shorts.dashboard_worker import DashboardClient, process

TEXT = ("This is a synthetic recording for a cloud video test. "
        "Every video should have readable captions and clear audio. "
        "Our small speech recognition model runs on a CPU in the cloud. "
        "The original pictures and spoken words are created only for this test. "
        "Nothing is uploaded to YouTube and no computer at home does the work.")


def main():
    with tempfile.TemporaryDirectory(prefix="purffle-e2e-") as folder:
        root = Path(folder)
        source = root / "synthetic.mp4"
        ffmpeg.run(["-f", "lavfi", "-i", "color=c=0x152333:s=640x360:r=30",
                    "-i", str(Path(__file__).parent / "fixtures" / "synthetic-speech.opus"), "-c:v", "libx264",
                    "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source)])
        env = dict(os.environ, PURFFLE_E2E_ROOT=str(root))
        backend = subprocess.Popen(["node", "scripts/e2e-server.mjs"], cwd="dashboard", env=env)
        try:
            for _ in range(100):
                if (root / "origin").exists():
                    break
                if backend.poll() is not None:
                    raise RuntimeError("Cloud integration API failed to start")
                time.sleep(0.1)
            origin = (root / "origin").read_text()
            owner = requests.Session()
            owner.headers.update({"x-test-owner": "synthetic-verification-owner", "Origin": origin})
            auth = {"approved": True, "license": "owned", "method": "direct_https",
                    "media_url": "https://fixtures.example.org/synthetic.mp4",
                    "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "evidence": "Original synthetic test pattern and flite speech generated on this authorized GitHub runner for verification only. No YouTube media is fetched.",
                    "attribution": "Synthetic cloud verification recording. Generated for this project; edited excerpt with subtitles.",
                    "all_components_cleared": True, "platform_download_permitted": True}
            payload = {"url": "https://www.youtube.com/watch?v=synthetic01", "source_kind": "video",
                       "options": {"count": 1, "duration": 15, "aspect": "9:16", "caption_style": "clean",
                                   "language": "en", "category": "Isolated synthetic verification; not a YouTube download"},
                       "authorization": auth}
            created = owner.post(origin + "/api/jobs", json=payload, timeout=30)
            assert created.status_code == 201, created.text
            jid = created.json()["id"]
            assert owner.post(origin + "/api/jobs", json=payload).status_code == 409
            client = DashboardClient.__new__(DashboardClient)
            client.origin = origin
            client.session = requests.Session()
            client.session.headers["Authorization"] = "Bearer synthetic-test-worker"
            assert client.claim()["id"] == jid
            os.environ["KEEP_WORK"] = "1"
            process(client, client.job, root, synthetic_fixture=source)
            data = owner.get(origin + "/api/bootstrap").json()
            assert data["jobs"][0]["state"] == "READY_FOR_REVIEW", data
            assert len(data["clips"]) == 1 and not data["publications"] and not data["publishing_enabled"]
            clip = data["clips"][0]
            media_path = f"/api/clips/{clip['id']}/video"
            assert requests.get(origin + media_path).status_code == 401
            assert requests.get(origin + media_path, headers={"x-test-owner": "different-owner"}).status_code == 404
            video = owner.get(origin + media_path)
            assert video.status_code == 200 and video.headers["Content-Type"] == "video/mp4"
            ranged = owner.get(origin + media_path, headers={"Range": "bytes=0-1023"})
            assert ranged.status_code == 206 and ranged.content == video.content[:1024]
            rendered = root / "verified-short.mp4"
            rendered.write_bytes(video.content)
            info = ffmpeg.probe(rendered)
            assert (info["width"], info["height"]) == (720, 1280) and info["has_audio"]
            ffmpeg.run(["-i", str(rendered), "-f", "null", "-"], label="decode private preview")
            subtitles = owner.get(origin + f"/api/clips/{clip['id']}/subtitles").text
            timestamps = re.findall(r"(\d\d):(\d\d):(\d\d),(\d\d\d)", subtitles)
            cues = [int(h)*3600+int(m)*60+int(s)+int(ms)/1000 for h, m, s, ms in timestamps]
            assert len(cues) >= 4 and all(0 <= x <= info["duration"] + 0.1 for x in cues)
            assert all(a < b for a, b in zip(cues[::2], cues[1::2]))
            assert any(word in subtitles.lower() for word in ("synthetic", "recording", "cloud", "video")), subtitles
            frame = root / "caption-proof.png"
            t = (cues[0] + cues[1]) / 2
            ffmpeg.run(["-ss", str(t), "-i", str(rendered), "-frames:v", "1", str(frame)])
            image = Image.open(frame).convert("RGB").crop((0, 200, 720, 1100))
            bright = sum(min(pixel) > 180 for pixel in image.getdata())
            assert bright > 200, f"No visible caption glyphs on the dark synthetic picture: {bright}"
            history = owner.get(origin + f"/api/jobs/{jid}").json()
            states = [e["state"] for e in history["events"]]
            for state in ["QUEUED", "VALIDATING", "TRANSCRIBING", "SELECTING_HIGHLIGHTS", "RENDERING", "GENERATING_METADATA", "READY_FOR_REVIEW"]:
                assert state in states
            assert owner.post(origin + f"/api/clips/{clip['id']}/publish", json={}).status_code == 403
            html = owner.get(origin + "/clips").text
            js = owner.get(origin + "/app.js").text
            assert "app.js" in html and "<video" in js and "/api/clips/" in js
            report = {"result": "PASS", "environment": "GitHub Linux CPU; isolated SQLite/filesystem API store, not production D1/R2",
                      "source": "original synthetic media; no YouTube download", "states": states,
                      "width": 720, "height": 1280, "audio": True, "duration": info["duration"],
                      "subtitle_cues": len(cues)//2, "visible_caption_pixels": bright,
                      "private_preview": True, "range_preview": True, "full_video_decode": True,
                      "sha256": hashlib.sha256(video.content).hexdigest(), "bytes": len(video.content),
                      "publishing": "disabled"}
            print("PURFFLE_E2E_REPORT " + json.dumps(report), flush=True)
            # Logs are free of Actions artifact-storage charges. Only original synthetic output is emitted.
            assert len(video.content) <= 2 * 1024 * 1024, "Verification sample too large for a bounded log export"
            print("PURFFLE_E2E_MEDIA_BEGIN", flush=True)
            encoded = base64.b64encode(video.content).decode()
            for start in range(0, len(encoded), 4096):
                print("PURFFLE_E2E_MEDIA " + encoded[start:start+4096], flush=True)
            print("PURFFLE_E2E_MEDIA_END", flush=True)
        finally:
            backend.terminate()
            backend.wait(timeout=10)


if __name__ == "__main__":
    main()
