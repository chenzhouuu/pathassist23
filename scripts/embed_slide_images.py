#!/usr/bin/env python3
"""
embed_slide_images.py

For each OME-TIFF in a scanner output folder:
  1. Appends label (barcodeImage.jpeg) and macro (whiteCorrectedInput.jpeg)
     as additional TIFF series — no full rewrite, just appends IFDs.
  2. Extracts key fields from metadata.json.
  3. Prints extracted metadata as JSON to stdout so the caller
     (upload_and_import.sh) can POST it to Girder after import.

Usage:
  python3 embed_slide_images.py <slide_folder> <ome_tiff_path>

Example:
  python3 scripts/embed_slide_images.py \
    /tmp/extract/C02N25TB190P-5683 \
    /tmp/extract/C02N25TB190P-5683.ome.tiff

Outputs JSON to stdout:
  { "slide_name": "...", "scanner": "...", ... }

Exit codes:
  0 — success (metadata JSON printed to stdout)
  1 — error
"""

import sys
import json
import shutil
from pathlib import Path

try:
    import tifffile
    import numpy as np
    from PIL import Image
except ImportError:
    print(json.dumps({"error": "Missing deps: pip install tifffile pillow numpy"}))
    sys.exit(1)


# ── Key fields to extract from metadata.json ─────────────────────────────────
def extract_metadata(meta_path: Path) -> dict:
    if not meta_path.exists():
        return {}

    with open(meta_path) as f:
        raw = json.load(f)

    data = raw.get("data", raw)  # Cubiq wraps everything under "data"

    result = {}

    # Basic slide info
    for key in ("slide_name", "biopsy_type", "activity_status", "number_of_z_stacks"):
        if key in data:
            result[key] = data[key]

    # Scanner info
    scanner = data.get("scanner_info") or data.get("scanner", {})
    if isinstance(scanner, dict):
        result["scanner_type"] = scanner.get("scanner_type") or scanner.get("type", "")
    elif "scanner_type" in data:
        result["scanner_type"] = data["scanner_type"]

    # QC metrics
    for key in ("focus_error_percentage", "dark_region_percentage",
                "faint_region_percentage", "debris_ratio"):
        if key in data:
            result[key] = data[key]

    # OCR output (slide label text)
    if "ocr_output" in data and data["ocr_output"]:
        result["ocr_text"] = " | ".join(str(x) for x in data["ocr_output"] if x)

    # Case info
    case = data.get("case_info", {})
    if isinstance(case, dict):
        for k in ("case_id", "block_id", "slide_num"):
            if case.get(k):
                result[k] = case[k]

    # Acquisition time
    acq_time = data.get("acquisition_completed_time")
    if acq_time:
        result["acquisition_time_ms"] = acq_time

    # File sizes
    for key in ("dicom_size", "dzi_size"):
        if key in data:
            result[key] = data[key]

    return result


# ── Embed label + macro as extra TIFF series ─────────────────────────────────
def embed_images(ome_tiff: Path, slide_folder: Path):
    loc = slide_folder / "loc_output_data"

    label_path = loc / "barcodeImage.jpeg"
    macro_path = loc / "whiteCorrectedInput.jpeg"

    if not label_path.exists() and not macro_path.exists():
        return False  # nothing to embed

    with tifffile.TiffWriter(str(ome_tiff), bigtiff=True, append=True) as tw:
        if label_path.exists():
            label = np.array(Image.open(label_path).convert("RGB"))
            tw.write(label, metadata={"Name": "label"},
                     compression="jpeg", photometric="rgb")

        if macro_path.exists():
            macro = np.array(Image.open(macro_path).convert("RGB"))
            tw.write(macro, metadata={"Name": "macro"},
                     compression="jpeg", photometric="rgb")

    return True


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: embed_slide_images.py <slide_folder> <ome_tiff>"}))
        sys.exit(1)

    slide_folder = Path(sys.argv[1])
    ome_tiff     = Path(sys.argv[2])

    if not ome_tiff.exists():
        print(json.dumps({"error": f"OME-TIFF not found: {ome_tiff}"}))
        sys.exit(1)

    # 1. Embed label + macro into OME-TIFF
    embedded = embed_images(ome_tiff, slide_folder)

    # 2. Extract metadata
    meta_path = slide_folder / "metadata.json"
    metadata  = extract_metadata(meta_path)
    metadata["associated_images_embedded"] = embedded

    # Print to stdout for caller to use
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
