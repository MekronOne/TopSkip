#!/usr/bin/env python3
"""Собирает ZIP и XPI для текущей версии из manifest.json."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

FILES = [
    "manifest.json",
    "content.js",
    "popup.html",
    "popup.css",
    "popup.js",
]


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]

    icon_files = sorted(
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "icons").glob("*.png")
    )

    archive_files = FILES + icon_files
    missing = [name for name in archive_files if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit(f"Не найдены файлы: {', '.join(missing)}")

    DIST.mkdir(exist_ok=True)
    for suffix in ("zip", "xpi"):
        archive_path = DIST / f"TopSkip-{version}.{suffix}"
        with zipfile.ZipFile(
            archive_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for name in archive_files:
                archive.write(ROOT / name, arcname=name)

        print(f"{archive_path.relative_to(ROOT)} — {archive_path.stat().st_size} байт")


if __name__ == "__main__":
    main()
