"""Build the Chrome Web Store upload zip for extensions/pipi-cookie-sync.

Run from anywhere:  py -3.13 extensions/pack.py
Output:             dist-ext/locwarp-pipi-cookie-sync-<version>.zip

The zip has manifest.json at its root, which is what the store expects.
The README stays out: it documents loading the folder unpacked.
"""

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "pipi-cookie-sync"
OUT = ROOT.parent / "dist-ext"
SKIP = {"README.md"}


def main() -> None:
    version = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))["version"]
    OUT.mkdir(exist_ok=True)
    target = OUT / f"locwarp-pipi-cookie-sync-{version}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_file() and f.name not in SKIP:
                z.write(f, f.relative_to(SRC).as_posix())
    with zipfile.ZipFile(target) as z:
        names = z.namelist()
    print("wrote", target)
    for n in names:
        print("  ", n)


if __name__ == "__main__":
    main()
