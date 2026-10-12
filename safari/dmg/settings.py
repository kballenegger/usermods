# dmgbuild settings for dist/usermods.dmg. Read by `node scripts/safari-xcode.mjs dmg`, never by
# hand.
#
# dmgbuild executes this file and reads the module-level names out of it, so plain assignments are
# the whole interface. The three paths it needs arrive as -D defines: `app` (the exported,
# Developer ID signed usermods.app), `background_source` (safari/dmg/background.png) and `scratch`
# (a directory the script creates and removes, where the two background sizes are derived).
#
# The artwork carries the wordmark, the instruction, the arrow and the two hairline landing boxes;
# the only things placed here are the two real Finder items the person drags between. Same shape
# as the images Caret and Feke ship.

import os.path

from PIL import Image

application = defines["app"]
background_source = defines["background_source"]
scratch = defines["scratch"]

app_name = os.path.basename(application)

# The artwork is the owner's, 1536 x 1024 pixels, kept byte for byte (docs/branding.md). Finder
# sizes the window in points, so the window is the artwork halved, and both sizes ship: dmgbuild
# finds the sibling named `<name>@2x.<ext>` and hands Finder one multi-representation TIFF, which
# keeps Retina crisp while the window stays 768 x 512 points.
WINDOW_WIDTH = 768
WINDOW_HEIGHT = 512

_background_1x = os.path.join(scratch, "background.png")
_background_2x = os.path.join(scratch, "background@2x.png")

with Image.open(background_source) as _art:
    _art = _art.convert("RGB")
    if _art.size != (WINDOW_WIDTH * 2, WINDOW_HEIGHT * 2):
        raise SystemExit(
            f"background is {_art.size}, expected {(WINDOW_WIDTH * 2, WINDOW_HEIGHT * 2)}: "
            "the icon positions below are measured against that artwork"
        )
    _art.resize((WINDOW_WIDTH, WINDOW_HEIGHT), Image.LANCZOS).save(_background_1x)
    _art.save(_background_2x)

background = _background_1x

# Icon centres, in window points, measured against the artwork: the arrow sits at x 683-845,
# y 495-632 (pixels), so the two icons go either side of it on its centre line (y 282 points),
# below the instruction (which ends at y 330 pixels) and above the goblin, whose hat starts at
# y 700 pixels under the left icon's filename label.
icon_size = 104
icon_locations = {
    app_name: (215, 282),
    "Applications": (553, 282),
}

# No hide_extensions for the app: dmgbuild hides an extension by writing com.apple.FinderInfo onto
# the bundle, which `codesign --verify --strict` rejects as detritus on signed code. Finder hides
# ".app" by default anyway.
files = [application]
symlinks = {"Applications": "/Applications"}

format = "UDZO"
compression_level = 9
filesystem = "HFS+"

# Finder chrome off: the window is a canvas here, not a file browser.
default_view = "icon-view"
show_icon_preview = False
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
arrange_by = None
grid_offset = (0, 0)
label_pos = "bottom"
text_size = 12
include_icon_view_settings = True
include_list_view_settings = False

# Where the window opens. The top-left is arbitrary; the size is not. Finder's window rect is the
# whole frame, title bar included, so the height adds the title bar back or the bottom of the
# artwork is cropped by it. 28 points is the smallest title bar in use (32 on macOS 27): a taller
# one crops a few points of blank ground, where a larger allowance would leave a strip under the
# artwork on the shorter one.
TITLE_BAR_HEIGHT = 28
window_rect = ((200, 200), (WINDOW_WIDTH, WINDOW_HEIGHT + TITLE_BAR_HEIGHT))
