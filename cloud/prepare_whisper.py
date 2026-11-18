"""Download the public base model on the authorized cloud runner, then use that local snapshot."""
import argparse
from pathlib import Path

from purffle_shorts.whisper_assets import prepare

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github-env", type=Path)
    args = parser.parse_args()
    model = prepare()
    if args.github_env:
        with args.github_env.open("a") as file:
            file.write(f"PURFFLE_WHISPER_MODEL_PATH={model}\n")
    print(f"Public Whisper base snapshot ready: {Path(model).name}; CPU/int8 only")
