#!/usr/bin/env python3
"""Require all three verified installers from the same source before releasing."""
import hashlib
import json
from pathlib import Path
import sys

EXPECTED = {"aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"}


def main():
    directory = Path(sys.argv[1])
    manifests = [json.loads(p.read_text()) for p in sorted(directory.glob("manifest-*.json"))]
    if len(manifests) != 3 or {m["target"] for m in manifests} != EXPECTED:
        raise ValueError("Release must contain exactly three platform manifests")
    if len({m["version"] for m in manifests}) != 1 or len({m["source_commit"] for m in manifests}) != 1:
        raise ValueError("Installers were built from different versions or commits")
    lines = []
    for m in manifests:
        if Path(m["file"]).name != m["file"]:
            raise ValueError("Invalid installer filename")
        file = directory / m["file"]
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if file.stat().st_size != m["bytes"] or digest != m["sha256"]:
            raise ValueError(f"Installer checksum mismatch: {file.name}")
        lines.append(f"{digest}  {file.name}")
    (directory / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n")
    (directory / "release-manifest.json").write_text(json.dumps({"version": manifests[0]["version"], "source_commit": manifests[0]["source_commit"], "platforms": manifests}, ensure_ascii=False, indent=2) + "\n")
    print("Verified three installers, one source commit, and all SHA-256 hashes.")


if __name__ == "__main__":
    main()
