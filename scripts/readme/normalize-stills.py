#!/usr/bin/env python3
"""Extract native recording stills and replace only their 180px status-bar band.

Requires ffmpeg and ImageMagick 7. The input receipt supplies source timestamps.
App pixels below the band are preserved; the shared PNGs are presentation edits.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--font', type=Path,
                        default=Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf'))
    args = parser.parse_args()
    if not args.font.is_file():
        parser.error('Supply --font with a bold sans-serif TrueType font')
    receipt = json.loads(args.receipt.read_text())
    if digest(args.video) != receipt['video_sha256']:
        parser.error('Source video hash does not match receipt')
    overlay = Path(__file__).with_name('standard-status-bar.svg')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-stills-') as tmp:
        raw = Path(tmp) / 'raw.png'
        for entry in receipt['stills']:
            name = entry['png']
            if Path(name).name != name or not name.endswith('.png'):
                parser.error('Receipt PNG must be a .png filename')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(entry['source_seconds']),
                            '-i', str(args.video), '-map', '0:v:0', '-frames:v', '1',
                            '-threads', '1', str(raw)], check=True)
            dimensions = subprocess.check_output(
                ['magick', 'identify', '-format', '%w %h', str(raw)], text=True).strip()
            if dimensions != '1206 2622':
                parser.error('This measured status band requires 1206x2622 input')
            # Match the safe-area background at the band's lower left edge.
            background = subprocess.check_output(
                ['magick', str(raw), '-format', '%[pixel:p{10,179}]', 'info:'], text=True).strip()
            output = args.output_dir / name
            subprocess.run(['magick', str(raw), '-fill', background, '-draw',
                            'rectangle 0,0 1205,179', '(', '-background', 'none', str(overlay), ')',
                            '-geometry', '+0+0', '-compose', 'Over', '-composite',
                            '-font', str(args.font), '-pointsize', '52', '-fill', '#111111',
                            '-gravity', 'NorthWest', '-annotate', '+94+61', '9:41',
                            '-strip', str(output)], check=True)
            entry['source_png_sha256'] = digest(raw)
            entry['sha256'] = digest(output)
            entry['status_bar_crop'] = None
            entry['status_bar_replacement'] = {
                'band': [0, 0, 1206, 180], 'time': '9:41',
                'island': 'standard', 'signal_wifi_battery': 'full',
                'recording_indicator': False, 'background': background}
    receipt['status_bar_svg_sha256'] = digest(overlay)
    receipt['status_bar_font_sha256'] = digest(args.font)
    receipt['presentation_edit'] = 'Only the top 180px status band is replaced; app pixels below it are unchanged.'
    (args.output_dir / args.receipt.name).write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
