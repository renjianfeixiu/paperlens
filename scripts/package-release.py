#!/usr/bin/env python3
"""Validate a native build and collect a reproducible PaperLens installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/desktop"
TARGETS = {
    "aarch64-apple-darwin": ("macOS-AppleSilicon", ".dmg", "arm64"),
    "x86_64-apple-darwin": ("macOS-Intel", ".dmg", "x86_64"),
    "x86_64-pc-windows-msvc": ("Windows-x64", "-setup.exe", "AMD64"),
}


def checked(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--output", type=Path, default=ROOT / "release-assets")
    args = parser.parse_args()
    package = json.loads((DESKTOP / "package.json").read_text())
    config = json.loads((DESKTOP / "src-tauri/tauri.conf.json").read_text())
    cargo = tomllib.loads((DESKTOP / "src-tauri/Cargo.toml").read_text())
    version = package["version"]
    if config["version"] != version or cargo["package"]["version"] != version:
        raise ValueError("Frontend, native and bundle versions differ")
    ref = os.environ.get("GITHUB_REF", "")
    if ref.startswith("refs/tags/") and ref.removeprefix("refs/tags/") not in (f"v{version}", f"v{version}-github"):
        raise ValueError("Release tag does not match application version")
    directory = DESKTOP / "src-tauri/target" / args.target / "release"
    label, extension, architecture = TARGETS[args.target]
    checks = ["source-version-consistency"]
    if extension == ".dmg":
        app = directory / "bundle/macos/PaperLens.app"
        metadata = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if metadata["CFBundleShortVersionString"] != version or metadata["CFBundleIdentifier"] != config["identifier"]:
            raise ValueError("Application metadata differs from source")
        executable = app / "Contents/MacOS" / metadata["CFBundleExecutable"]
        if checked(["lipo", "-archs", str(executable)]).split() != [architecture]:
            raise ValueError("Unexpected Mach-O architecture")
        checked(["codesign", "--verify", "--deep", "--strict", str(app)])
        candidates = list((directory / "bundle/dmg").glob("*.dmg"))
        if len(candidates) != 1:
            raise ValueError(f"Expected one DMG, found {len(candidates)}")
        source = candidates[0]
        checked(["hdiutil", "verify", str(source)])
        checks += ["app-version-and-identifier", "mach-o-architecture", "codesign-verification", "dmg-integrity"]
    else:
        binary = directory / "paperlens.exe"
        data = binary.read_bytes()
        if data[:2] != b"MZ":
            raise ValueError("Main program is not a PE executable")
        offset = struct.unpack_from("<I", data, 0x3C)[0]
        if data[offset:offset + 4] != b"PE\x00\x00" or struct.unpack_from("<H", data, offset + 4)[0] != 0x8664:
            raise ValueError("Main program is not Windows AMD64")
        escaped = str(binary).replace("'", "''")
        resource_version = checked(["powershell", "-NoProfile", "-Command", f"(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductVersion"])
        if resource_version != version and not re.fullmatch(re.escape(version) + r"\.0", resource_version):
            raise ValueError(f"Unexpected Windows product version: {resource_version}")
        candidates = list((directory / "bundle/nsis").glob("*-setup.exe"))
        if len(candidates) != 1 or candidates[0].read_bytes()[:2] != b"MZ":
            raise ValueError("Expected one valid NSIS executable installer")
        source = candidates[0]
        checks += ["pe-amd64-architecture", "windows-product-version", "nsis-executable-header"]
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / f"PaperLens-{version}-{label}{extension}"
    shutil.copy2(source, output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    manifest = {
        "version": version, "target": args.target, "architecture": architecture,
        "source_commit": os.environ.get("GITHUB_SHA", "local"),
        "file": output.name, "bytes": output.stat().st_size, "sha256": digest,
        "checks": checks, "gui_runtime_verified": False,
        "publisher_signing": "ad-hoc-not-notarized" if extension == ".dmg" else "unsigned",
    }
    (args.output / f"manifest-{args.target}.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Installer validation failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
