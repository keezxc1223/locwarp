# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for LocWarp backend (Python 3.13).
# Build: py -3.13 -m PyInstaller backend/locwarp-backend.spec --noconfirm

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

# pymobiledevice3 has a LOT of dynamic imports — collect everything
pmd_datas, pmd_binaries, pmd_hiddenimports = collect_all('pymobiledevice3')

# pytun_pmd3 ships wintun.dll as a data file that ctypes loads at runtime
pytun_datas, pytun_binaries, pytun_hidden = collect_all('pytun_pmd3')

# pmd_pytcp is the userspace TCP/IP stack pymobiledevice3 11.x uses for the
# RemotePairing WiFi tunnel (remote/userspace_tunnel.py). It resolves its
# protocol handlers dynamically, so collect_all is needed or the frozen exe
# fails to build a WiFi tunnel while the dev checkout works fine.
pytcp_datas, pytcp_binaries, pytcp_hidden = collect_all('pmd_pytcp')

# developer_disk_image is an indirect dependency of pymobiledevice3 (imported
# at the top of services/mobile_image_mounter.py). PyInstaller doesn't pick
# it up via collect_all('pymobiledevice3'), so previously the bundled exe
# would fail to import mobile_image_mounter and silently skip DDI mount.
# That broke iOS <17 users (e.g. iPhone 8 Plus / iOS 16.7) — DtSimulateLocation
# accepts the call but iOS rejects it without DDI.
ddi_datas, ddi_binaries, ddi_hidden = collect_all('developer_disk_image')

# pyimg4 is an indirect dep of mobile_image_mounter's Personalized DDI path.
# pymobiledevice3 calls importlib.metadata.distribution('pyimg4') at import
# time. collect_all('pymobiledevice3') pulls pyimg4's .py files in as
# transitive imports, but NOT its .dist-info metadata directory, so the
# metadata lookup raises PackageNotFoundError and the whole
# mobile_image_mounter import fails. That cascades into "No such service:
# com.apple.instruments.dtservicehub" on iOS 17+ devices whose DDI was never
# pre-mounted by another tool. copy_metadata pulls the dist-info dir into
# the bundle so importlib.metadata finds it. Also collect_all for the
# python files and any companion binaries.
pyimg4_datas, pyimg4_binaries, pyimg4_hidden = collect_all('pyimg4')
pyimg4_meta = copy_metadata('pyimg4')

# uvicorn/fastapi also need their sub-modules collected
uvicorn_hidden = collect_submodules('uvicorn')
fastapi_hidden = collect_submodules('fastapi')

# websockets: uvicorn 0.51's default `auto` now selects the websockets-sansio
# implementation, which imports the sansio core modules (websockets.frames,
# websockets.http11, websockets.server, ...). Those are NOT covered by the old
# manual list below, so collect every submodule to be safe across the
# 13.x -> 16.x upgrade (legacy + asyncio + sync + sansio core).
websockets_hidden = collect_submodules('websockets')

# psutil has a Windows-specific extension module that must be bundled
# for NIC enumeration to work in the frozen exe.
ps_datas, ps_binaries, ps_hidden = collect_all('psutil')

# collect_all() also returns every package's .py source as a data file.
# The frozen importer loads modules from the PYZ archive, never from those
# copies, and nothing in these packages opens its own source (they only
# read real data: json / txt / js / png / wintun.dll). The loose sources
# were 465 of the ~830 installed files, so dropping them roughly halves
# the file count the installer has to write and the antivirus has to scan.
def _no_py(datas):
    return [d for d in datas if not d[0].lower().endswith(('.py', '.pyi'))]

pmd_datas = _no_py(pmd_datas)
pytun_datas = _no_py(pytun_datas)
pytcp_datas = _no_py(pytcp_datas)
ddi_datas = _no_py(ddi_datas)
pyimg4_datas = _no_py(pyimg4_datas)
ps_datas = _no_py(ps_datas)

hidden = [
    *pmd_hiddenimports,
    *pytun_hidden,
    *pytcp_hidden,
    *ddi_hidden,
    *pyimg4_hidden,
    *uvicorn_hidden,
    *fastapi_hidden,
    *websockets_hidden,
    *ps_hidden,
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

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[*pmd_binaries, *pytun_binaries, *pytcp_binaries, *ddi_binaries, *pyimg4_binaries,
              *ps_binaries],
    datas=[*pmd_datas, *pytun_datas, *pytcp_datas, *ddi_datas, *pyimg4_datas, *pyimg4_meta,
           *ps_datas,
           ('static/phone.html', 'static'),
           ('static/phone-icon.png', 'static')],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Size / install-time trims. All of these are only reached through
    # pymobiledevice3 features LocWarp never calls, and each import is lazy:
    #   av (PyAV + ffmpeg DLLs, ~68 MB): remote/core_device/hevc_av.py, the
    #       screen-mirroring transcoder.
    #   IPython / jedi / parso (~25 MB, ~5500 files): utils.start_ipython_shell,
    #       the CLI's interactive shell. jedi alone was 78% of the installed
    #       file count, which is what made the installer slow.
    #   tzdata (~600 files): only zoneinfo.ZoneInfo(key) lookups need it and
    #       nothing in the backend does one.
    excludes=['tkinter', 'matplotlib', 'PIL', 'numpy', 'scipy', 'pandas',
              'av', 'IPython', 'jedi', 'parso', 'tzdata'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

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
    console=True,   # keep console for logs; change to False for prod if desired
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
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
