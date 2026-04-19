# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the standalone wifi_tunnel helper.
# Windows:  py -3.13   -m PyInstaller wifi-tunnel.spec --noconfirm
# macOS:    python3    -m PyInstaller wifi-tunnel.spec --noconfirm

import sys
import os
from PyInstaller.utils.hooks import collect_all

IS_MACOS = sys.platform == 'darwin'
IS_WIN   = sys.platform == 'win32'

pmd_datas, pmd_binaries, pmd_hiddenimports = collect_all('pymobiledevice3')
pytun_datas, pytun_binaries, pytun_hidden = collect_all('pytun_pmd3')

a = Analysis(
    ['wifi_tunnel.py'],
    pathex=['.'],
    binaries=[*pmd_binaries, *pytun_binaries],
    datas=[*pmd_datas, *pytun_datas],
    hiddenimports=[*pmd_hiddenimports, *pytun_hidden],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'numpy', 'scipy', 'pandas'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

_entitlements = os.path.join(
    os.path.dirname(os.path.abspath(SPEC)),  # noqa: F821
    'frontend', 'build', 'entitlements.mac.plist',
) if IS_MACOS else None

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='wifi-tunnel',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    # uac_admin=True is Windows-only — skip on macOS (use sudo/osascript instead)
    **({"uac_admin": True} if IS_WIN else {}),
    target_arch=None,
    codesign_identity=None,
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
    name='wifi-tunnel',
)
