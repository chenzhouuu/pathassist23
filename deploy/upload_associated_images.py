#!/usr/bin/env python3
"""
Upload label, macro, thumbnail JPEGs to a Girder item as associated image metadata.
Supports both local and S3 assetsores.

Usage:
  python3 upload_associated_images.py <item_id> <slide_folder>

Example:
  python3 deploy/upload_associated_images.py 699e3bfb268bc8b1c9173854 \
    /mnt/c/Users/tkantheti/Downloads/other
"""

import sys
import json
import requests
from pathlib import Path

BASE    = "http://54.224.61.23/api/v1"
TOKEN   = "raBQqmo1mCZcwXgssI1V9KNexf76PIBYhOkDYNmX7eSmF5ejHe9FSzS8WepnRHtg"
HEADERS = {"Girder-Token": TOKEN}


def upload_file(item_id, file_path, name):
    path = Path(file_path)
    size = path.stat().st_size
    print(f"  Uploading {name} ({size // 1024}KB)...")

    # Step 1 — init upload
    r = requests.post(f"{BASE}/file", headers=HEADERS, data={
        "parentType": "item",
        "parentId": item_id,
        "name": name,
        "mimeType": "image/jpeg",
        "size": size,
    })
    r.raise_for_status()
    upload_info = r.json()
    upload_id = upload_info["_id"]

    with open(path, "rb") as f:
        data = f.read()

    # Step 2 — S3 assetstore: upload directly to S3 presigned URL
    if upload_info.get("behavior") == "s3":
        s3 = upload_info["s3"]
        s3_url     = s3["request"]["url"]
        s3_headers = s3["request"]["headers"]
        s3_headers["Content-Length"] = str(size)

        r2 = requests.put(s3_url, headers=s3_headers, data=data)
        r2.raise_for_status()

        # Step 3 — notify Girder upload is complete
        r3 = requests.post(f"{BASE}/file/completion", headers=HEADERS,
                           data={"uploadId": upload_id})
        r3.raise_for_status()
        file_id = r3.json()["_id"]

    else:
        # Local assetstore: send data as chunk
        r2 = requests.post(f"{BASE}/file/chunk", headers=HEADERS,
                           params={"uploadId": upload_id, "offset": 0},
                           data=data)
        r2.raise_for_status()
        file_id = r2.json()["_id"]

    print(f"  -> file_id: {file_id}")
    return file_id


def set_metadata(item_id, meta):
    r = requests.put(f"{BASE}/item/{item_id}/metadata",
                     headers={**HEADERS, "Content-Type": "application/json"},
                     data=json.dumps(meta))
    r.raise_for_status()
    print("  -> metadata saved")


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 upload_associated_images.py <item_id> <slide_folder>")
        sys.exit(1)

    item_id    = sys.argv[1]
    slide_dir  = Path(sys.argv[2])

    # Resolve image paths
    label_path     = slide_dir / "loc_output_data" / "barcodeImage.jpeg"
    macro_path     = slide_dir / "loc_output_data" / "whiteCorrectedInput.jpeg"
    thumbnail_path = next(
        (slide_dir / "loc_output_data" / f for f in
         (slide_dir / "loc_output_data").iterdir()
         if f.suffix == ".jpeg" and not any(x in f.name for x in
            ["barcode", "whiteCorrected", "label", "mask", "region", "heatMap",
             "output", "input", "debug", "filtered", "contour"])),
        slide_dir / "loc_output_data" / "whiteCorrectedInput.jpeg"  # fallback
    )

    # Use the full slide JPEG if available at root level
    root_jpegs = list(slide_dir.glob("*.jpeg"))
    if root_jpegs:
        thumbnail_path = root_jpegs[0]

    print(f"\nItem ID  : {item_id}")
    print(f"Label    : {label_path}")
    print(f"Macro    : {macro_path}")
    print(f"Thumbnail: {thumbnail_path}\n")

    for p, label in [(label_path, "label"), (macro_path, "macro"), (thumbnail_path, "thumbnail")]:
        if not p.exists():
            print(f"  WARNING: {p} not found, skipping {label}")

    print("Uploading files to Girder...")
    label_id     = upload_file(item_id, label_path,     "label.jpeg")
    macro_id      = upload_file(item_id, macro_path,     "macro.jpeg")
    thumbnail_id  = upload_file(item_id, thumbnail_path, "thumbnail.jpeg")

    print("\nSaving file IDs to item metadata...")
    set_metadata(item_id, {
        "associated_images": {
            "label":     label_id,
            "macro":     macro_id,
            "thumbnail": thumbnail_id,
        }
    })

    print(f"""
Done!
  label_id     = {label_id}
  macro_id      = {macro_id}
  thumbnail_id  = {thumbnail_id}

Fetch in your UI:
  GET /api/v1/file/{label_id}/download     <- label
  GET /api/v1/file/{macro_id}/download     <- macro
  GET /api/v1/file/{thumbnail_id}/download <- thumbnail
""")


if __name__ == "__main__":
    main()
