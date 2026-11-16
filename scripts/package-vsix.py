#!/usr/bin/env python3
"""
Zero-dependency offline VSIX packager for Binsight.
Generates a hacker-style 256x256 resources/icon.png and packages the extension into <name>-<version>.vsix.
"""

import json
import math
import os
import struct
import zipfile
import zlib
from xml.sax.saxutils import escape

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _dist_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def _alpha_blend(bg, fg, alpha):
    a = max(0.0, min(1.0, alpha))
    return (
        int(bg[0] * (1 - a) + fg[0] * a),
        int(bg[1] * (1 - a) + fg[1] * a),
        int(bg[2] * (1 - a) + fg[2] * a),
        255,
    )


def _dist_rounded_rect(px, py, x1, y1, x2, y2, r):
    cx = max(x1 + r, min(px, x2 - r))
    cy = max(y1 + r, min(py, y2 - r))
    return abs(math.hypot(px - cx, py - cy) - r)


def generate_icon_png(filepath, size=256):
    """Generate a clean, sharp 256x256 PNG icon matching the minimalist [0x] sidebar icon."""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    raw_rows = []
    s = size
    radius = s * 0.20

    # Crisp Midnight Slate + Mint-Emerald [ ] + Warm Amber dot + Crisp White 0x
    bg_top = (22, 27, 38)
    bg_bot = (13, 17, 24)
    bracket_col = (52, 211, 153)   # Mint Emerald (#34d399)
    dot_col = (251, 191, 36)       # Warm Amber (#fbbf24)
    symbol_col = (248, 250, 252)   # Crisp White (#f8fafc)
    border_col = (45, 58, 78)      # Subtle slate border

    # Crisp geometric strokes matching sidebar-icon.svg
    strokes = [
        # Left bracket '['
        (0.28, 0.22, 0.19, 0.22, 0.048, bracket_col),
        (0.19, 0.22, 0.19, 0.78, 0.048, bracket_col),
        (0.19, 0.78, 0.28, 0.78, 0.048, bracket_col),
        # Right bracket ']'
        (0.72, 0.22, 0.81, 0.22, 0.048, bracket_col),
        (0.81, 0.22, 0.81, 0.78, 0.048, bracket_col),
        (0.81, 0.78, 0.72, 0.78, 0.048, bracket_col),
        # 'x'
        (0.55, 0.40, 0.69, 0.62, 0.048, symbol_col),
        (0.69, 0.40, 0.55, 0.62, 0.048, symbol_col),
    ]

    aa = 1.4 / s  # Anti-aliasing feather

    for y in range(s):
        row = bytearray([0])
        ny = y / s
        for x in range(s):
            nx = x / s
            dx = max(0.0, radius - min(x, s - 1 - x))
            dy = max(0.0, radius - min(y, s - 1 - y))
            corner_dist = math.hypot(dx, dy)
            if corner_dist > radius + 1.0:
                row.extend((0, 0, 0, 0))
                continue

            # Smooth vertical slate gradient
            c = (
                int(bg_top[0] * (1 - ny) + bg_bot[0] * ny),
                int(bg_top[1] * (1 - ny) + bg_bot[1] * ny),
                int(bg_top[2] * (1 - ny) + bg_bot[2] * ny),
            )

            # Subtle crisp 1.5px border
            edge_dist = min(x, s - 1 - x, y, s - 1 - y)
            if corner_dist > radius - 1.8 or edge_dist < 1.8:
                c = _alpha_blend(c, border_col, 0.85)[:3]

            px_col = (c[0], c[1], c[2], 255)

            # Rounded '0' matching sidebar-icon.svg
            d_zero = _dist_rounded_rect(nx, ny, 0.31, 0.33, 0.47, 0.67, 0.055)
            half_z = 0.024
            if d_zero < half_z + aa:
                cov = 1.0 if d_zero <= half_z - aa else (half_z + aa - d_zero) / (2 * aa)
                px_col = _alpha_blend(px_col, symbol_col, cov)

            # Center dot inside '0'
            d_dot = math.hypot(nx - 0.39, ny - 0.50)
            if d_dot < 0.024 + aa:
                cov = 1.0 if d_dot <= 0.024 - aa else (0.024 + aa - d_dot) / (2 * aa)
                px_col = _alpha_blend(px_col, dot_col, cov)

            # Crisp line strokes
            for x1, y1, x2, y2, thick, col in strokes:
                d = _dist_segment(nx, ny, x1, y1, x2, y2)
                half_t = thick * 0.5
                if d < half_t + aa:
                    cov = 1.0 if d <= half_t - aa else (half_t + aa - d) / (2 * aa)
                    px_col = _alpha_blend(px_col, col, cov)

            alpha = 255
            if corner_dist > radius - 1.0:
                alpha = max(0, min(255, int(255 * (radius + 0.5 - corner_dist))))
            row.extend((px_col[0], px_col[1], px_col[2], alpha))
        raw_rows.append(bytes(row))

    raw_data = b"".join(raw_rows)

    def make_chunk(chunk_type, data):
        chunk = struct.pack(">I", len(data)) + chunk_type + data
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return chunk + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + make_chunk(b"IHDR", ihdr)
        + make_chunk(b"IDAT", zlib.compress(raw_data, 9))
        + make_chunk(b"IEND", b"")
    )
    with open(filepath, "wb") as f:
        f.write(png_bytes)


def build_content_types_xml():
    return """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".txt" ContentType="text/plain"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""


def build_vsix_manifest(pkg):
    publisher = escape(pkg.get("publisher", "local-dev"))
    name = escape(pkg["name"])
    version = escape(pkg["version"])
    display_name = escape(pkg.get("displayName", name))
    description = escape(pkg.get("description", ""))
    vscode_engine = escape(pkg.get("engines", {}).get("vscode", "^1.75.0"))
    categories = ",".join(pkg.get("categories", ["Other"]))
    tags = ",".join(pkg.get("keywords", []))
    icon_path = pkg.get("icon", "")

    icon_asset = (
        f'\n    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{escape(icon_path)}" Addressable="true" />'
        if icon_path
        else ""
    )
    icon_prop = (
        f'\n      <Property Id="Microsoft.VisualStudio.Services.Icons.Default" Value="extension/{escape(icon_path)}" />'
        if icon_path
        else ""
    )

    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Tags>{escape(tags)}</Tags>
    <Categories>{escape(categories)}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{vscode_engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />{icon_prop}
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/{escape(icon_path)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />{icon_asset}
  </Assets>
</PackageManifest>
"""


def main():
    pkg_path = os.path.join(ROOT_DIR, "package.json")
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)

    icon_rel = pkg.get("icon", "resources/icon.png")
    icon_abs = os.path.join(ROOT_DIR, icon_rel)
    # Always regenerate hacker-style icon
    generate_icon_png(icon_abs)

    vsix_filename = f"{pkg['name']}-{pkg['version']}.vsix"
    vsix_path = os.path.join(ROOT_DIR, vsix_filename)

    include_files = [
        ("package.json", "extension/package.json"),
        ("README.md", "extension/README.md"),
        ("LICENSE", "extension/LICENSE.txt"),
    ]
    for folder in ("resources", "src", "schemas", "media"):
        base = os.path.join(ROOT_DIR, folder)
        if not os.path.isdir(base):
            continue
        for root, _, files in os.walk(base):
            for fname in sorted(files):
                full_path = os.path.join(root, fname)
                rel = os.path.relpath(full_path, ROOT_DIR).replace(os.sep, "/")
                include_files.append((rel, f"extension/{rel}"))

    with zipfile.ZipFile(vsix_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", build_content_types_xml())
        zf.writestr("extension.vsixmanifest", build_vsix_manifest(pkg))
        for local_rel, arcname in include_files:
            full_path = os.path.join(ROOT_DIR, local_rel)
            if os.path.exists(full_path):
                zf.write(full_path, arcname)

    print(f"Successfully packaged offline VSIX: {vsix_path}")


if __name__ == "__main__":
    main()
