"""Download the public base model on the authorized cloud runner, then use that local snapshot."""
import argparse
import os
from pathlib import Path


def prepare():
    from huggingface_hub import snapshot_download
    try:
        path = snapshot_download("Systran/faster-whisper-base", allow_patterns=[
            "config.json", "model.bin", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"])
    except Exception:
        raise RuntimeError("Public Whisper weights could not be downloaded. Run on the standard GitHub cloud runner with HTTPS access to huggingface.co and its download hosts; no paid API fallback is permitted.") from None
    if not (Path(path) / "model.bin").is_file():
        raise RuntimeError("The downloaded Whisper snapshot is incomplete")
    os.environ["PURFFLE_WHISPER_MODEL_PATH"] = path
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github-env", type=Path)
    args = parser.parse_args()
    model = prepare()
    if args.github_env:
        with args.github_env.open("a") as file:
            file.write(f"PURFFLE_WHISPER_MODEL_PATH={model}\n")
    print(f"Public Whisper base snapshot ready: {Path(model).name}; CPU/int8 only")
