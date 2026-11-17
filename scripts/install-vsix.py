#!/usr/bin/env python3
"""Cross-platform (Windows / Linux / macOS) offline VSIX packager & installer."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_vscode_cli() -> str | None:
    """Locate the VS Code CLI executable across Windows, Linux, and macOS."""
    candidates = ["code", "code.cmd", "code-insiders", "code-insiders.cmd"]
    for cmd in candidates:
        found = shutil.which(cmd)
        if found:
            return found

    if sys.platform == "win32":
        env_dirs = [
            os.environ.get("LOCALAPPDATA"),
            os.environ.get("ProgramFiles"),
            os.environ.get("ProgramFiles(x86)"),
        ]
        rel_paths = [
            Path("Programs/Microsoft VS Code/bin/code.cmd"),
            Path("Microsoft VS Code/bin/code.cmd"),
            Path("Programs/Microsoft VS Code Insiders/bin/code-insiders.cmd"),
        ]
        for base in env_dirs:
            if not base:
                continue
            for rel in rel_paths:
                p = Path(base) / rel
                if p.is_file():
                    return str(p)
    return None


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Package and install Binsight VSIX offline.")
    parser.add_argument("--no-package", action="store_true", help="Skip running package-vsix.py and install existing VSIX.")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    root_dir = script_dir.parent
    pkg_json = json.loads((root_dir / "package.json").read_text(encoding="utf-8"))
    name = pkg_json.get("name", "binsight")
    version = pkg_json.get("version", "0.1.0")
    vsix_file = root_dir / f"{name}-{version}.vsix"

    if not args.no_package:
        pkg_script = script_dir / "package-vsix.py"
        subprocess.run([sys.executable, str(pkg_script)], check=True, cwd=str(root_dir))

    if not vsix_file.is_file():
        print(f"Error: VSIX file not found: {vsix_file}", file=sys.stderr)
        return 1

    code_cli = find_vscode_cli()
    if not code_cli:
        print("Error: VS Code CLI ('code') was not found in PATH.", file=sys.stderr)
        print(f"You can still install manually in VS Code: Extensions -> '...' -> Install from VSIX -> {vsix_file}", file=sys.stderr)
        return 1

    env = os.environ.copy()
    env["NODE_OPTIONS"] = "--no-deprecation"

    subprocess.run([code_cli, "--install-extension", str(vsix_file), "--force"], check=True, env=env)

    print("-" * 64)
    print(f"Installed {vsix_file}")
    print("In VS Code, press Ctrl+Shift+P -> 'Developer: Reload Window'")
    print("-" * 64)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
