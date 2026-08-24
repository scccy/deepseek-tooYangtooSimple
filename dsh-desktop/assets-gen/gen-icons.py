#!/usr/bin/env python3
"""Regenerate the macOS 26 style icon set for DeepSeek Harness desktop.

Spec (macOS 26, user-approved):
- Full-bleed artwork + baked standard shape: the glass board bleeds to the
  canvas edges, then the standard icon shape is baked into the alpha channel
  (macOS 26 / Tahoe squircle: ~100px margin / ~186px corner radius on the 1024
  grid — the standard ~18% radius). Running Dock tiles get the system mask
  (which coincides with the baked shape), while contexts that render the
  artwork raw — persistent Dock tiles being the live example — still show the
  exact same rounded icon.
- Official whale glyph taken from deepseek.com's favicon (whale-official-blue.png,
  225x225, official blue #4060F0) -> recolored to official black, cropped to the
  glyph bounding box (224x165). The whale artwork itself is never redrawn.
- Board (底板): macOS 26 "Liquid Glass" white glass — vertical white->near-
  neutral soft-gray gradient, restrained top sheen, NO bottom reflection band
  (the old (242,248,255) band was what made the white read as blue), faint glass
  edge light aligned with the system squircle (~100px margin / ~186px corner
  radius), whale floating on a soft cast shadow. (Variant "B-glass", tuned.)
- Notification icon == Dock icon automatically (no separate asset needed).
- tray.png: black template silhouette (menu bar), same official glyph.

Run from the repo root:  python3 assets-gen/gen-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-gen" / "whale-official-blue.png"
ICONS = ROOT / "src-tauri" / "icons"
OUT = ROOT / "assets-gen" / "icon-1024.png"

GLYPH_BBOX = (0, 31, 224, 196)  # x0,y0,x1,y1 inclusive -> 224x165
CANVAS = 1024
GLYPH_WIDTH = 620  # dock icon artwork width inside the 1024 canvas


def load_black_whale() -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    glyph = im.crop(GLYPH_BBOX)  # 224x165
    # recolor the official blue to official black, keep antialiased alpha
    px = glyph.load()
    for y in range(glyph.height):
        for x in range(glyph.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (0, 0, 0, a)
    return glyph


def glass_base() -> Image.Image:
    """White liquid-glass board: gradient + sheen + glass edge (no cold tint).

    macOS 26 / Tahoe look: the white is near-neutral (a faint warm->cool
    gradient that ends on a soft light gray, not a blue), the top sheen is
    restrained, and the old bottom (242,248,255) reflection band is gone — that
    band was what made the white read as "blue" in the Dock.
    """
    S = CANVAS
    top = (255, 255, 255)
    bottom = (243, 245, 249)  # near-neutral soft light gray, no blue cast
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        a = y / S
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * a) for i in range(3)))
    base = grad.resize((S, S))

    sheen = Image.new("L", (S, S), 0)
    ImageDraw.Draw(sheen).ellipse([-560, -640, 1180, 660], fill=58)
    sheen = sheen.filter(ImageFilter.GaussianBlur(120))
    base = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), base, sheen)

    # faint edge light aligned with the system shape (macOS 26 squircle:
    # ~100px margin / ~186px corner radius on the 1024 grid)
    edge = Image.new("L", (S, S), 0)
    ImageDraw.Draw(edge).rounded_rectangle([103, 103, S - 103, S - 103], radius=188, outline=255, width=10)
    edge = edge.filter(ImageFilter.GaussianBlur(6))
    base = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), base, edge)
    return base


def apply_standard_shape(img: Image.Image) -> Image.Image:
    """Bake the standard icon shape (rounded rect) into the alpha channel.

    Geometry aligned with the macOS 26 / Tahoe squircle mask (100px margin /
    ~186px corner radius on the 1024 grid — the standard ~18% radius), so
    system-masked and raw renderers agree and the Dock tile is a true squircle,
    not the old gentle ~8% rounding.
    """
    S = CANVAS
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([100, 100, S - 100, S - 100], radius=186, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))  # antialias the edge
    rgba = img.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def make_master() -> Image.Image:
    whale = load_black_whale()
    base = glass_base()
    w = GLYPH_WIDTH
    h = round(whale.height * w / whale.width)
    whale_s = whale.resize((w, h), Image.LANCZOS)
    x0, y0 = (CANVAS - w) // 2, (CANVAS - h) // 2
    # Soft, light cool-gray shadow under the whale. The old (22,32,62) dark
    # navy + fill=58 was fine when the (242,248,255) bottom band partially
    # cancelled it; once that band is gone, the dark navy takes over the whole
    # bottom and the white reads as gray. Keep the depth cue but with a
    # near-white cool gray so the base stays clean.
    shadow = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(shadow).ellipse([x0 + 30, y0 + h - 70, x0 + w - 30, y0 + h + 80], fill=38)
    shadow = shadow.filter(ImageFilter.GaussianBlur(42))
    base = Image.composite(Image.new("RGB", (CANVAS, CANVAS), (185, 192, 208)), base, shadow)
    base.paste(whale_s, (x0, y0), whale_s)
    return apply_standard_shape(base)


def make_tray() -> Image.Image:
    whale = load_black_whale()
    # match the previous silhouette box (~500px wide on 512) so the menu-bar
    # icon keeps its apparent size
    scale = 500 / whale.width
    w = 500
    h = round(whale.height * scale)
    whale_s = whale.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    canvas.paste(whale_s, ((512 - w) // 2, (512 - h) // 2), whale_s)
    return canvas


def write_iconset(master: Image.Image, iconset: Path) -> None:
    iconset.mkdir(parents=True, exist_ok=True)
    spec = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    for name, size in spec.items():
        master.resize((size, size), Image.LANCZOS).save(iconset / name)


def main() -> None:
    master = make_master()
    master.save(OUT)                          # 1024 master (RGBA, baked shape)
    # Tauri's generate_context! requires the bundle PNGs to be RGBA — master
    # already is; baked-shape alpha is exactly what we want everywhere.
    master.save(ICONS / "icon.png")           # bundle fallback master
    for name, size in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)):
        master.resize((size, size), Image.LANCZOS).save(ICONS / name)

    make_tray().save(ICONS / "tray.png")

    # Windows .ico (PNG-compressed entries)
    master.save(ICONS / "icon.ico", format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    iconset = ROOT / "assets-gen" / "icon.iconset"
    write_iconset(master, iconset)
    print("iconset written:", iconset)


if __name__ == "__main__":
    main()