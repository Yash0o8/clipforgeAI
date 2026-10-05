"""Caption styling, ported from ``CAPTION_PRESETS`` in the frontend.

The browser renders captions as absolutely-positioned DOM. The renderer burns
them in with libass via an ASS subtitle file. Both have to agree, so the preset
table lives here once and the frontend keeps its copy; any change needs to be
made in both places, and this file says so.

ASS colour is ``&HAABBGGRR`` — alpha first, then *reversed* RGB. That ordering is
the single most common source of wrong-coloured burned captions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

PositionId = Literal["top", "center", "lower"]

# Colours as #RRGGBB or #RGB, matching the CSS values in constants.js.
PRESETS: dict[str, dict[str, Any]] = {
    "clean": {
        "label": "Clean",
        "position": "lower",
        "size": 0.052,
        "weight": 600,
        "uppercase": False,
        "color": "#ffffff",
        "highlight": "#c4b5fd",
        "background": "rgba(9, 9, 16, 0.62)",
        "outline": 0,
        "shadow": 0,
        "margin_v": 220,
        "margin_h": 90,
    },
    "bold": {
        "label": "Bold",
        "position": "center",
        "size": 0.062,
        "weight": 800,
        "uppercase": True,
        "color": "#ffffff",
        "highlight": "#fde68a",
        "background": "transparent",
        "outline": 3.0,
        "shadow": 3,
        "margin_v": 0,
        "margin_h": 70,
    },
    "karaoke": {
        "label": "Karaoke",
        "position": "lower",
        "size": 0.056,
        "weight": 700,
        "uppercase": False,
        "color": "rgba(255,255,255,0.55)",
        "highlight": "#ffffff",
        "background": "transparent",
        "outline": 0,
        "shadow": 2,
        "margin_v": 260,
        "margin_h": 80,
    },
    "minimal": {
        "label": "Minimal",
        "position": "lower",
        "size": 0.038,
        "weight": 500,
        "uppercase": False,
        "color": "#ffffff",
        "highlight": "#ffffff",
        "background": "transparent",
        "outline": 0,
        "shadow": 1,
        "margin_v": 120,
        "margin_h": 70,
    },
    "creator": {
        "label": "Creator Style",
        "position": "center",
        "size": 0.058,
        "weight": 700,
        "uppercase": False,
        "color": "#ffffff",
        "highlight": "#fde68a",
        # Gradient pill: approximated by an opaque fill plus a border, since
        # libass has no gradient. The violet tint is the dominant stop.
        "background": "#7c3aed",
        "outline": 0,
        "shadow": 4,
        "margin_v": 0,
        "margin_h": 80,
    },
}

DEFAULT_PRESET = "clean"

# Arial is metric-compatible with Liberation Sans and is present on every
# Windows install; libass substitutes when it is not.
FONT_NAME = "Arial"

# PlayResX/Y for each supported aspect, so margins and font sizes are computed
# against the real output frame rather than an assumed 1080p.
RESOLUTION_MAP: dict[str, tuple[int, int]] = {
    "1080x1920": (1080, 1920),
    "1080x1080": (1080, 1080),
    "1920x1080": (1920, 1080),
}


# --- Colour conversion ------------------------------------------------------

_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# A real ASS override block: an opening brace, an inline-tag sequence that
# starts with a backslash, then a closing brace. Anchoring on the backslash is
# what stops legitimate caption text like "{world}" from being treated as markup
# and silently deleted.
_ASS_OVERRIDE = re.compile(r"\{\\[^}]*\}")
_HTML_TAG = re.compile(r"</?[a-zA-Z][^>]*>")


def parse_color(value: str) -> tuple[int, int, int]:
    """``#rgb``/``#rrggbb`` -> (r, g, b). Raises on anything else."""
    match = _HEX.match(value or "")
    if not match:
        raise ValueError(f"unsupported colour: {value!r}")
    digits = match.group(1)
    if len(digits) == 3:
        digits = "".join(char * 2 for char in digits)
    return tuple(int(digits[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def to_ass_color(value: str, alpha: int | None = None) -> str:
    """CSS colour -> ``&HAABBGGRR``, the format libass expects.

    ``alpha`` is 0 (opaque) to 255 (transparent), overriding any alpha encoded in
    an ``rgba()`` string.
    """
    raw = (value or "").strip()

    rgba_match = re.match(r"^rgba?\(([^)]+)\)$", raw, re.IGNORECASE)
    if rgba_match:
        parts = [part.strip() for part in rgba_match.group(1).split(",")]
        channels = []
        for part in parts[:3]:
            channels.append(int(float(part)))
        # CSS alpha is 0..1 transparent..opaque; ASS is the inverse.
        if alpha is None:
            css_alpha = float(parts[3]) if len(parts) > 3 else 1.0
            alpha = int(round((1.0 - max(0.0, min(1.0, css_alpha))) * 255))
        red, green, blue = channels
    else:
        red, green, blue = parse_color(raw)
        if alpha is None:
            alpha = 0

    red, green, blue = (max(0, min(255, channel)) for channel in (red, green, blue))
    return f"&H{max(0, min(255, alpha)):02X}{blue:02X}{green:02X}{red:02X}"


def is_transparent(value: str) -> bool:
    """True for ``transparent`` or a fully transparent ``rgba()``."""
    raw = (value or "").strip().lower()
    if raw in ("transparent", "none", ""):
        return True
    match = re.match(r"^rgba?\(([^)]+)\)$", raw)
    if match:
        parts = [part.strip() for part in match.group(1).split(",")]
        if len(parts) > 3:
            return float(parts[3]) <= 0.01
    return False


# --- Layout -----------------------------------------------------------------


def resolve_position(preset_id: str | None, override: str | None) -> str:
    """Resolve the effective vertical anchor.

    A null position means "inherit the preset's own", matching the frontend's
    ``position: null -> preset default`` behaviour.
    """
    if override in ("top", "center", "lower"):
        return override
    preset = PRESETS.get(preset_id or DEFAULT_PRESET, PRESETS[DEFAULT_PRESET])
    return preset["position"]


def font_size(style: dict[str, Any], frame_width: int) -> int:
    """Preset size is a fraction of frame width, so scale to the output."""
    fraction = float(style.get("size", 0.052))
    # ASS sizes in script resolution units, which we set to the frame size, so
    # the pixel value is the fraction directly.
    return max(12, int(round(frame_width * fraction)))


def alignment(position: str) -> int:
    """ASS alignment: bottom-centre / middle-centre / top-centre."""
    return {"lower": 2, "center": 5, "top": 8}.get(position, 2)


@dataclass(frozen=True)
class CaptionStyle:
    """Resolved, ASS-ready styling for one render."""

    font_name: str
    font_size: int
    # Spoken / already-highlighted colour.
    primary: str
    # Unspoken remainder. For karaoke this is the dim colour.
    secondary: str
    outline: str
    alignment: int
    bold: bool
    uppercase: bool
    outline_width: float
    shadow: float
    margin_v: int
    margin_h: int
    # ASS BorderStyle: 1 = outline+shadow, 3 = opaque box behind the text.
    # 3 is how the CSS `background` + `radius` presets are reproduced.
    border_style: int
    box_padding: int

    def style_line(self, name: str) -> str:
        bold_flag = -1 if self.bold else 0
        return (
            f"Style: {name},{self.font_name},{self.font_size},"
            f"{self.primary},{self.secondary},{self.outline},&H80000000,"
            f"{bold_flag},0,0,0,100,100,0,0,"
            f"{self.border_style},{self.outline_width},{self.shadow},"
            f"{self.alignment},{self.margin_h},{self.margin_h},{self.margin_v},1"
        )


def build_style(
    preset_id: str | None,
    position_override: str | None,
    resolution: str,
    width: int,
    height: int,
) -> CaptionStyle:
    """Resolve a preset + position + resolution into concrete ASS styling."""
    preset = PRESETS.get(preset_id or DEFAULT_PRESET, PRESETS[DEFAULT_PRESET])
    position = resolve_position(preset_id, position_override)

    size = font_size(preset, width)

    # libass margins are in the same units as PlayRes, so scale the preset's
    # 1080-based margins to the actual frame.
    scale_x = width / 1080
    scale_y = height / 1920

    bg_value = preset.get("background", "transparent")
    has_box = not is_transparent(bg_value)
    # `padding` in the CSS presets becomes the ASS Outline value, which is
    # exactly what BorderStyle=3 uses as box padding.
    box_padding = 6 if has_box else 0

    return CaptionStyle(
        font_name=FONT_NAME,
        font_size=size,
        primary=to_ass_color(preset["color"]),
        secondary=to_ass_color(preset["highlight"]),
        outline=to_ass_color("#000000", alpha=0x80),
        alignment=alignment(position),
        bold=bool(preset.get("weight", 600) >= 700),
        uppercase=bool(preset.get("uppercase")),
        # A heavy shadow reads better than an outline for the "bold" preset,
        # which is why shadow comes from the preset's own css `shadow` string.
        outline_width=float(preset.get("outline", 0)),
        shadow=float(preset.get("shadow", 0)),
        margin_v=int(round(preset["margin_v"] * scale_y)),
        margin_h=int(round(preset["margin_h"] * scale_x)),
        border_style=3 if has_box else 1,
        box_padding=box_padding,
    )


def strip_ass_formatting(text: str) -> str:
    """Remove ASS override blocks and stray HTML tags from caption text.

    Only blocks that look like real overrides are removed. Deleting every
    brace-delimited span would eat legitimate caption text such as
    ``"the {best} way to edit"``.
    """
    cleaned = _ASS_OVERRIDE.sub("", text or "")
    return _HTML_TAG.sub("", cleaned).strip()


def escape_text(text: str) -> str:
    """Escape the characters libass treats as markup.

    A backslash is doubled first so later replacements do not re-escape their
    own output.
    """
    cleaned = strip_ass_formatting(text or "")
    cleaned = cleaned.replace("\\", "\\\\")
    cleaned = cleaned.replace("{", "\\{").replace("}", "\\}")
    # Commas separate style fields; a comma inside a Dialogue line would shift
    # every later column.
    cleaned = cleaned.replace("\n", " ").replace(",", "\\,")
    return cleaned.strip()


def resolve_dimensions(resolution: str) -> tuple[int, int]:
    """Parse ``"1080x1920"`` into a tuple, falling back to vertical."""
    try:
        width, height = resolution.lower().split("x", 1)
        return int(width), int(height)
    except (ValueError, AttributeError):
        return RESOLUTION_MAP["1080x1920"]


def preset_label(preset_id: str | None) -> str:
    return PRESETS.get(preset_id or DEFAULT_PRESET, PRESETS[DEFAULT_PRESET])["label"]