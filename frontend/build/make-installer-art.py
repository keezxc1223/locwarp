"""Generate the NSIS installer artwork from the app icon.

NSIS only accepts BMP for these, at fixed sizes it does not scale:
  installerSidebar / uninstallerSidebar  164 x 314   (welcome + finish page)
  installerHeader                        150 x 57    (interior page header)

Run from anywhere:  py -3.13 frontend/build/make-installer-art.py
Outputs land next to this script and are committed, so a normal build does
not need Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ICON = HERE / "icon.png"

# Sampled from icon.png: deep navy at the edges, brighter blue in the middle.
TOP = (10, 20, 48)
MID = (23, 48, 96)
BOTTOM = (8, 16, 38)
ACCENT = (108, 168, 255)
MUTED = (143, 168, 220)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"


def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def _gradient(w: int, h: int) -> Image.Image:
    """Vertical three-stop gradient, dark at both ends."""
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        if t < 0.5:
            k = t / 0.5
            a, b = TOP, MID
        else:
            k = (t - 0.5) / 0.5
            a, b = MID, BOTTOM
        px[0, y] = tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3))
    return img.resize((w, h), Image.BILINEAR)


def _arcs(size: tuple[int, int], center: tuple[int, int]) -> Image.Image:
    """Faint concentric rings echoing the signal waves in the icon."""
    w, h = size
    layer = Image.new("L", (w * 2, h * 2), 0)
    d = ImageDraw.Draw(layer)
    cx, cy = center[0] * 2, center[1] * 2
    for i, r in enumerate((78, 128, 182, 240)):
        r *= 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=34 - i * 6, width=3)
    layer = layer.resize((w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    return layer


def _rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1],
                                           radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def _glow(img: Image.Image, spread: int, strength: float) -> Image.Image:
    """Soft colored halo behind the icon so it lifts off the gradient."""
    w, h = img.size
    pad = spread * 2
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    halo = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle(
        [pad, pad, pad + w - 1, pad + h - 1], radius=w // 4,
        fill=ACCENT + (int(255 * strength),),
    )
    halo = halo.filter(ImageFilter.GaussianBlur(spread))
    canvas.alpha_composite(halo)
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def _pools(img: Image.Image) -> Image.Image:
    """Two soft pools of light, the same ambient glow the app's sidebar has
    behind its glass panels, so the installer and the app read as one piece."""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([-70, -60, 110, 120], fill=(108, 140, 255, 120))
    d.ellipse([w - 90, h - 150, w + 70, h + 10], fill=(150, 120, 255, 105))
    layer = layer.filter(ImageFilter.GaussianBlur(38))
    out = img.convert("RGBA")
    out.alpha_composite(layer)
    return out.convert("RGB")


def _glass_card(canvas: Image.Image, box: tuple[int, int, int, int], radius: int) -> None:
    """Translucent panel with a bright top edge: the app's liquid-glass card."""
    x0, y0, x1, y1 = box
    card = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle(box, radius=radius, fill=(255, 255, 255, 20), outline=(255, 255, 255, 46), width=1)
    d.line([(x0 + radius, y0 + 1), (x1 - radius, y0 + 1)], fill=(255, 255, 255, 90), width=1)
    canvas.alpha_composite(card)


def build_sidebar(path: Path, w: int = 164, h: int = 314) -> None:
    bg = _pools(_gradient(w, h))
    rings = _arcs((w, h), (w // 2, 104))
    bg.paste(Image.new("RGB", (w, h), (150, 190, 255)), (0, 0), rings)

    canvas = bg.convert("RGBA")

    icon = Image.open(ICON).convert("RGBA").resize((84, 84), Image.LANCZOS)
    icon = _rounded(icon, 20)
    glowed = _glow(icon, 14, 0.34)
    canvas.alpha_composite(glowed, ((w - glowed.width) // 2, 104 - glowed.height // 2))

    _glass_card(canvas, (14, 156, w - 14, 246), 16)

    d = ImageDraw.Draw(canvas)
    title = _font(FONT_BOLD, 25)
    sub = _font(FONT_REG, 11)

    d.text((w / 2, 176), "LocWarp", font=title, fill=(255, 255, 255), anchor="mm")
    d.line([(w / 2 - 26, 197), (w / 2 + 26, 197)], fill=ACCENT + (0,), width=1)
    d.line([(w / 2 - 26, 197), (w / 2 + 26, 197)], fill=(70, 110, 180), width=1)
    d.text((w / 2, 214), "GPS Location Simulator", font=sub, fill=MUTED, anchor="mm")
    d.text((w / 2, 231), "for iOS", font=sub, fill=MUTED, anchor="mm")

    canvas.convert("RGB").save(path, "BMP")
    print("wrote", path)


def build_header(path: Path, w: int = 150, h: int = 57) -> None:
    # The interior pages have a white header strip, so this bitmap has to sit
    # on white rather than carry its own background.
    canvas = Image.new("RGBA", (w, h), (255, 255, 255, 255))

    icon = Image.open(ICON).convert("RGBA").resize((40, 40), Image.LANCZOS)
    icon = _rounded(icon, 10)
    canvas.alpha_composite(icon, (12, (h - 40) // 2))

    # No tagline here: at 150px wide anything longer than the wordmark gets
    # clipped, and NSIS will not scale the bitmap to fit.
    d = ImageDraw.Draw(canvas)
    d.text((60, h / 2), "LocWarp", font=_font(FONT_BOLD, 18),
           fill=(20, 42, 88), anchor="lm")

    canvas.convert("RGB").save(path, "BMP")
    print("wrote", path)


if __name__ == "__main__":
    build_sidebar(HERE / "installerSidebar.bmp")
    build_sidebar(HERE / "uninstallerSidebar.bmp")
    build_header(HERE / "installerHeader.bmp")
