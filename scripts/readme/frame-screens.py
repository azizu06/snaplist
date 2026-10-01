#!/usr/bin/env python3
"""Frame exact screen crops with an original enclosure; requires ImageMagick 7.

Single: frame-screens.py source.png output.webp [--crop WIDTHxHEIGHT+X+Y]
Batch:  frame-screens.py --manifest sources.json --output-dir docs/readme
Manifest: {"screens": [{"source": "...", "output": "phone-to-list.webp",
                       "crop": "1179x2556+0+0"}]}
Source paths are relative to the manifest. Omit crop only for bare native screens.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

FRAME = Path(__file__).with_name("iphone-frame.svg")


def run(*args):
    return subprocess.check_output(["magick", *map(str, args)], text=True).strip()


def frame(source, output, crop=None):
    source, output = Path(source).resolve(), Path(output)
    if source == output.resolve():
        raise ValueError("Output must not overwrite the raw capture")
    if output.suffix.lower() != ".webp":
        raise ValueError("Output must be .webp (transparent, compressed README asset)")
    width, height = map(int, run("identify", "-format", "%w %h", source).split())
    if crop:
        match = re.fullmatch(r"([1-9]\d*)x([1-9]\d*)\+(\d+)\+(\d+)", crop)
        if not match:
            raise ValueError("Crop must be WIDTHxHEIGHT+X+Y in source pixels")
        cw, ch, x, y = map(int, match.groups())
        if x + cw > width or y + ch > height:
            raise ValueError("Screen crop exceeds capture bounds")
    else:
        cw, ch = width, height
    # Never distort or silently center-crop a desktop/Mirroring window.
    if abs(cw / ch / (1179 / 2556) - 1) > .005:
        raise ValueError("Expected a 1179:2556 screen; supply the exact --crop rectangle")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="readme-frame-") as tmp:
        tmp = Path(tmp)
        screen, mask, device = [tmp / f"{name}.png" for name in ("screen", "mask", "device")]
        args = [source]
        if crop:
            args += ["-crop", crop, "+repage"]
        run(*args, "-auto-orient", "-resize", "1179x2556", "-background", "#090a0b",
            "-gravity", "center", "-extent", "1179x2556", screen)
        run("-size", "1179x2556", "xc:black", "-fill", "white", "-draw",
            "roundrectangle 0,0 1178,2555 190,190", mask)
        run(screen, mask, "-alpha", "off", "-compose", "CopyOpacity", "-composite", screen)
        run("-background", "none", FRAME, device)
        run(device, screen, "-geometry", "+50+50", "-compose", "Over", "-composite",
            "-fill", "#030405", "-draw", "roundrectangle 460,83 819,178 48,48",
            "-fill", "#131923", "-draw", "circle 773,130 786,130",
            "-fill", "#263247", "-draw", "circle 770,127 774,127",
            "-filter", "Lanczos", "-resize", "480x996!", "-strip",
            "-quality", "88", "-define", "webp:alpha-quality=100", output)
    if output.stat().st_size > 250_000:
        raise ValueError(f"{output}: exceeds 250 KB; inspect before choosing lower quality")
    return {"source": source.name, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "crop": crop, "output": output.name, "bytes": output.stat().st_size,
            "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--crop")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if not shutil.which("magick"):
        parser.error("Install ImageMagick 7 (macOS: brew install imagemagick)")
    try:
        if args.manifest:
            if not args.output_dir or args.source or args.output or args.crop:
                parser.error("Batch usage requires only --manifest and --output-dir")
            screens = json.loads(args.manifest.read_text())["screens"]
            receipts = []
            for entry in screens:
                name = entry["output"]
                if Path(name).name != name:
                    raise ValueError("Manifest output must be a filename")
                receipts.append(frame(args.manifest.parent / entry["source"],
                                      args.output_dir / name, entry.get("crop")))
            receipt = {"frame_sha256": hashlib.sha256(FRAME.read_bytes()).hexdigest(),
                       "imagemagick": run("-version").splitlines()[0],
                       "dimensions": [480, 996], "screens": receipts}
            (args.output_dir / "frame-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(json.dumps(receipt, indent=2))
        else:
            if not args.source or not args.output or args.output_dir:
                parser.error("Supply source and output, or --manifest with --output-dir")
            print(json.dumps(frame(args.source, args.output, args.crop), indent=2))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"frame-screens: {error}\n")


if __name__ == "__main__":
    main()
