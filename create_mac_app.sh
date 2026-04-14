#!/bin/bash
# 建立 LocWarp.app — 雙擊啟動，不需終端機

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="LocWarp"
APP_PATH="$SCRIPT_DIR/$APP_NAME.app"
MACOS_DIR="$APP_PATH/Contents/MacOS"
RES_DIR="$APP_PATH/Contents/Resources"

# 找 Python
VENV_PY="$SCRIPT_DIR/.venv/bin/python3"
if [ -f "$VENV_PY" ]; then
    PYTHON="$VENV_PY"
else
    PYTHON="$(which python3)"
fi

# 安裝 rumps
echo "安裝 rumps..."
"$PYTHON" -m pip install rumps -q

# 建立目錄結構
rm -rf "$APP_PATH"
mkdir -p "$MACOS_DIR" "$RES_DIR"

# 複製圖示
ICON_SRC="$SCRIPT_DIR/frontend/public/icon-512.png"
if [ -f "$ICON_SRC" ]; then
    # 用 sips 轉成 icns
    ICONSET="$SCRIPT_DIR/LocWarp.iconset"
    mkdir -p "$ICONSET"
    sips -z 16   16   "$ICON_SRC" --out "$ICONSET/icon_16x16.png"    2>/dev/null
    sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_16x16@2x.png" 2>/dev/null
    sips -z 32   32   "$ICON_SRC" --out "$ICONSET/icon_32x32.png"    2>/dev/null
    sips -z 64   64   "$ICON_SRC" --out "$ICONSET/icon_32x32@2x.png" 2>/dev/null
    sips -z 128  128  "$ICON_SRC" --out "$ICONSET/icon_128x128.png"  2>/dev/null
    sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_128x128@2x.png" 2>/dev/null
    sips -z 256  256  "$ICON_SRC" --out "$ICONSET/icon_256x256.png"  2>/dev/null
    sips -z 512  512  "$ICON_SRC" --out "$ICONSET/icon_256x256@2x.png" 2>/dev/null
    cp "$ICON_SRC"                     "$ICONSET/icon_512x512.png"
    iconutil -c icns "$ICONSET" -o "$RES_DIR/AppIcon.icns" 2>/dev/null && \
        echo "圖示已建立" || echo "圖示建立失敗（略過）"
    rm -rf "$ICONSET"
fi

# 建立啟動腳本
cat > "$MACOS_DIR/$APP_NAME" << LAUNCHER
#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"
SCRIPT_DIR="$SCRIPT_DIR"
PYTHON="$PYTHON"
exec "\$PYTHON" "\$SCRIPT_DIR/locwarp_menubar.py"
LAUNCHER

chmod +x "$MACOS_DIR/$APP_NAME"

# 建立 Info.plist
cat > "$APP_PATH/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>LocWarp</string>
    <key>CFBundleDisplayName</key>
    <string>LocWarp</string>
    <key>CFBundleIdentifier</key>
    <string>com.locwarp.app</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo ""
echo "✅ LocWarp.app 已建立！"
echo ""
echo "   路徑: $APP_PATH"
echo ""
echo "   使用方式："
echo "   1. 雙擊 LocWarp.app"
echo "   2. 狀態列出現圖示後點擊 → 啟動 LocWarp"
echo "   3. 變綠色表示已就緒"
echo ""
echo "   （可拖到 /Applications 或 Dock 加入快速啟動）"
