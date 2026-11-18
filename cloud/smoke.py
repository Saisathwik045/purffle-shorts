"""Real CPU inference + render smoke using original synthesized speech, never uploaded."""
from pathlib import Path
from tempfile import TemporaryDirectory

from purffle_shorts import ffmpeg
from purffle_shorts.clipper import make_clips
from purffle_shorts.cloud import cloud_settings
from purffle_shorts.pipeline import Studio

TEXT = (
    "This is an original recording for our cloud video pipeline. "
    "We are testing automatic subtitles using a small speech recognition model on a CPU. "
    "The software keeps the original audio and creates a vertical video with captions. "
    "No paid service is needed to edit this recording. "
    "Each sentence is spoken for the cloud integration test."
)

with TemporaryDirectory(prefix="purffle-smoke-") as folder:
    root = Path(folder)
    source = root / "source.mp4"
    ffmpeg.run(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
                "-f", "lavfi", "-i", f"flite=text='{TEXT}':voice=slt", "-c:v", "libx264",
                "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source)])
    settings = cloud_settings(root / "output").with_overrides(resolution=(360, 640))
    results = make_clips(Studio(settings), str(source), count=1, crop="blur", upload=False, min_seconds=5)
    assert results and all(r.ok for r in results), results
    result = results[0]
    captions = (result.folder / "captions.srt").read_text()
    assert "-->" in captions and any(w in captions.lower() for w in ("cloud", "video", "recording")), captions
    info = ffmpeg.probe(result.video)
    assert info["has_audio"] and (info["width"], info["height"]) == (360, 640), info
    print("PASS: real Whisper base CPU int8 inference, burned captions, SRT and vertical H.264/AAC")
