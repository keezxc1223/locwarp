from setuptools import setup

APP = ['locwarp_menubar.py']
OPTIONS = {
    'argv_emulation': False,
    'packages': ['rumps'],
    'iconfile': 'frontend/public/icon-512.png',
    'plist': {
        'CFBundleName': 'LocWarp',
        'CFBundleDisplayName': 'LocWarp',
        'CFBundleIdentifier': 'com.locwarp.app',
        'CFBundleVersion': '1.0',
        'LSUIElement': True,
        'NSHighResolutionCapable': True,
    },
}

setup(
    app=APP,
    name='LocWarp',
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
