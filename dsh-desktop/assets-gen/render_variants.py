#!/usr/bin/env python3
"""Render Liquid-Glass icon variants (macOS 26 style, full-bleed opaque)
and produce system-composited previews (NSWorkspace on tiny .app bundles).

Variants:
  A-flat   : flat white board + soft whale shadow (minimal)
  B-glass  : white glass (gradient, sheen, reflection, glass edge light)
  C-blue   : B-glass with a DeepSeek-blue tinted base

Run from repo root:  python3 assets-gen/render_variants.py
"""
import importlib.util
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets-gen"
PREVIEW = ASSETS / "preview"

spec = importlib.util.spec_from_file_location("gen_icons", ASSETS / "gen-icons.py")
gi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gi)

S = 1024
W_WIDTH = 620  # whale artwork width


def paste_whale(base: Image.Image, whale: Image.Image) -> Image.Image:
    """Whale with a soft cast shadow, floating on the glass base."""
    w = W_WIDTH
    h = round(whale.height * w / whale.width)
    whale_s = whale.resize((w, h), Image.LANCZOS)
    x0, y0 = (S - w) // 2, (S - h) // 2
    shadow = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(shadow)
    d.ellipse([x0 + 30, y0 + h - 70, x0 + w - 30, y0 + h + 80], fill=58)
    shadow = shadow.filter(ImageFilter.GaussianBlur(48))
    base = Image.composite(Image.new("RGB", (S, S), (22, 32, 62)), base, shadow)
    base.paste(whale_s, (x0, y0), whale_s)
    return base


def glass_base(tint_bottom, sheen=True):
    """Vertical white->tint gradient + top sheen + bottom reflection band + edge light."""
    top = (255, 255, 255)
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        a = y / S
        grad.putpixel((0, y), tuple(round(top[i] + (tint_bottom[i] - top[i]) * a) for i in range(3)))
    base = grad.resize((S, S))

    if sheen:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).ellipse([-560, -640, 1180, 660], fill=86)
        mask = mask.filter(ImageFilter.GaussianBlur(150))
        base = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), base, mask)

    band = Image.new("L", (S, S), 0)
    ImageDraw.Draw(band).ellipse([-120, 690, 1144, 1150], fill=62)
    band = band.filter(ImageFilter.GaussianBlur(80))
    base = Image.composite(Image.new("RGB", (S, S), (242, 248, 255)), base, band)

    # faint edge light aligned with the system shape (measured: ~100px margin /
    # ~80px corner radius on the 1024 grid)
    edge = Image.new("L", (S, S), 0)
    ImageDraw.Draw(edge).rounded_rectangle([103, 103, S - 103, S - 103], radius=82, outline=255, width=10)
    edge = edge.filter(ImageFilter.GaussianBlur(6))
    base = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), base, edge)
    return base


def build_master(style: str) -> Image.Image:
    whale = gi.load_black_whale()
    if style == "flat":
        base = Image.new("RGB", (S, S), (255, 255, 255))
    elif style == "glass":
        base = glass_base((231, 235, 243))
    else:  # blue tinted glass
        base = glass_base((208, 221, 255))
    return paste_whale(base, whale)


def system_preview(master: Image.Image, tag: str) -> Path:
    """Bundle the master into a tiny .app and have NSWorkspace composite it."""
    work = Path(f"/tmp/variants/{tag}")
    iconset = work / "icon.iconset"
    gi.write_iconset(master, iconset)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(work / "icon.icns")], check=True)
    app = work / f"V{tag}.app"
    for sub in ("Contents/MacOS", "Contents/Resources"):
        (app / sub).mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", str(work / "icon.icns"), str(app / "Contents/Resources/icon.icns")], check=True)
    exe = app / "Contents/MacOS" / f"V{tag}"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    (app / "Contents/Info.plist").write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>V{tag}</string>
<key>CFBundleIdentifier</key><string>local.iconvariant.{tag.lower()}</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleName</key><string>V{tag}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0</string>
</dict></plist>""")
    swift = f'''
import AppKit
let ws = NSWorkspace.shared
let img = ws.icon(forFile: "{app}")
let size = 256
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {{ exit(1) }}
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .sourceOver, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()
let data = rep.representation(using: .png, properties: [:])!
try! data.write(to: URL(fileURLWithPath: "{PREVIEW}/variant-{tag}-system.png"))
'''
    sf = work / "r.swift"
    sf.write_text(swift)
    subprocess.run(["swiftc", str(sf), "-o", str(work / "r")], check=True, capture_output=True)
    subprocess.run([str(work / "r")], check=True)
    return PREVIEW / f"variant-{tag}-system.png"


def main() -> None:
    PREVIEW.mkdir(parents=True, exist_ok=True)
    for tag, style in (("A-flat", "flat"), ("B-glass", "glass"), ("C-blue", "blue")):
        master = build_master(style)
        master.save(PREVIEW / f"variant-{tag}-1024.png")
        system_preview(master, tag)
        print(f"variant {tag} done")
    print("previews in", PREVIEW)


if __name__ == "__main__":
    main()