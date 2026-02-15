#!/usr/bin/env python3
"""Crop an image by removing its single-color background border."""

import argparse
import sys
from pathlib import Path

from PIL import Image
import numpy as np


def detect_bg_color(img_array):
    """Detect background color from the image corners."""
    h, w = img_array.shape[:2]
    corners = [
        img_array[0, 0],
        img_array[0, w - 1],
        img_array[h - 1, 0],
        img_array[h - 1, w - 1],
    ]
    # Use the most common corner color
    corners = [tuple(c) for c in corners]
    return max(set(corners), key=corners.count)


def autocrop(image, tolerance=10):
    """Crop away single-color background border.

    Args:
        image: PIL Image
        tolerance: Max per-channel difference from background color to still
                   count as background (0 = exact match).

    Returns:
        Cropped PIL Image.
    """
    arr = np.array(image.convert("RGB"))
    bg = np.array(detect_bg_color(arr), dtype=np.int16)

    # Boolean mask: True where pixel differs from background
    diff = np.abs(arr.astype(np.int16) - bg)
    mask = np.any(diff > tolerance, axis=2)

    coords = np.argwhere(mask)
    if coords.size == 0:
        print("Warning: entire image matches background color, returning original", file=sys.stderr)
        return image

    y0, x0 = coords.min(axis=0)
    y1, x1 = coords.max(axis=0)

    return image.crop((x0, y0, x1 + 1, y1 + 1))


def main():
    parser = argparse.ArgumentParser(description="Crop single-color background from an image.")
    parser.add_argument("input", help="Input image path")
    parser.add_argument("-o", "--output", help="Output image path (default: auto-generate with resolution suffix)")
    parser.add_argument("-t", "--tolerance", type=int, default=10,
                        help="Color tolerance 0-255 (default: 10)")
    args = parser.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"Error: {src} not found", file=sys.stderr)
        sys.exit(1)

    img = Image.open(src)
    cropped = autocrop(img, tolerance=args.tolerance)

    if args.output:
        dst = Path(args.output)
    else:
        dst = src.with_stem(f"{src.stem}-{cropped.width}x{cropped.height}")
    cropped.save(dst)

    orig = f"{img.width}x{img.height}"
    result = f"{cropped.width}x{cropped.height}"
    print(f"{orig} -> {result}  saved to {dst}")


if __name__ == "__main__":
    main()
