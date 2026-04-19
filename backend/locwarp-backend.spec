# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for LocWarp backend — cross-platform (Windows / macOS / Linux).
# Windows:  py -3.12 -m PyInstaller backend/locwarp-backend.spec --noconfirm
# macOS:    python3  -m PyInstaller backend/locwarp-backend.spec --noconfirm
#           For Universal 2: add --target-arch universal2

import sys
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

IS_MACOS = sys.platform == 'darwin'
IS_WIN   = sys.platform == 'win32'

# pymobiledevice3 has a LOT of dynamic imports — collect everything
pmd_datas, pmd_binaries, pmd_hiddenimports = collect_all('pymobiledevice3')

# pytun_pmd3 ships wintun.dll (Windows) or a macOS .dylib as a data file
pytun_datas, pytun_binaries, pytun_hidden = collect_all('pytun_pmd3')

# uvicorn/fastapi also need their sub-modules collected
uvicorn_hidden = collect_submodules('uvicorn')
fastapi_hidden = collect_submodules('fastapi')

hidden = [
    *pmd_hiddenimports,
    *pytun_hidden,
    *uvicorn_hidden,
    *fastapi_hidden,
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'websockets',
    'websockets.legacy',
    'websockets.legacy.client',
    'websockets.legacy.server',
    'gpxpy',
    'httpx',
    'multipart',
]

# macOS: uvloop provides better timer precision
if IS_MACOS:
    hidden.append('uvloop')

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[*pmd_binaries, *pytun_binaries],
    datas=[*pmd_datas, *pytun_datas],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'numpy', 'scipy', 'pandas'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

# macOS entitlements path (relative to spec file location)
_entitlements = os.path.join(
    os.path.dirname(os.path.abspath(SPEC)),  # noqa: F821  (PyInstaller global)
    '..', 'frontend', 'build', 'entitlements.mac.plist',
) if IS_MACOS else None

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='locwarp-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    # target_arch: None = native arch; pass --target-arch universal2 for fat binary
    target_arch=None,
    # macOS: sign with Hardened Runtime + our entitlements
    codesign_identity=None,           # None = ad-hoc sign; set to "Developer ID Application: ..." for dist
    entitlements_file=_entitlements,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='locwarp-backend',
)
