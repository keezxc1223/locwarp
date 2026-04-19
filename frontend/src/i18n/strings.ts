// Central string table for LocWarp.
// Keys are dotted paths by area; missing translations fall back to the other locale.

export type Lang = 'zh' | 'en';

export const STRINGS = {
  // ── Generic ──────────────────────────────────
  'generic.save': { zh: '儲存', en: 'Save' },
  'generic.cancel': { zh: '取消', en: 'Cancel' },
  'generic.delete': { zh: '刪除', en: 'Delete' },
  'generic.rename': { zh: '重新命名', en: 'Rename' },
  'generic.confirm': { zh: '確定', en: 'OK' },
  'generic.loading': { zh: '載入中…', en: 'Loading…' },
  'generic.retry': { zh: '重試', en: 'Retry' },
  'generic.stop': { zh: '停止', en: 'Stop' },
  'generic.start': { zh: '開始', en: 'Start' },
  'generic.pause': { zh: '暫停', en: 'Pause' },
  'generic.resume': { zh: '繼續', en: 'Resume' },
  'generic.clear': { zh: '清除', en: 'Clear' },
  'generic.add': { zh: '加入', en: 'Add' },
  'generic.km_h': { zh: 'km/h', en: 'km/h' },

  // ── Status bar ───────────────────────────────
  'status.connected': { zh: '已連線', en: 'Connected' },
  'status.disconnected': { zh: '未連線', en: 'Disconnected' },
  'status.cooldown_enabled': { zh: '冷卻啟用', en: 'Cooldown on' },
  'status.cooldown_disabled': { zh: '冷卻關閉', en: 'Cooldown off' },
  'status.cooldown_active': { zh: '冷卻中', en: 'Cooling down' },
  'status.cooldown_tooltip': { zh: '關閉後瞬移將不觸發冷卻', en: 'When off, teleports skip the cooldown' },
  'status.restore': { zh: '一鍵還原', en: 'Restore' },
  'status.restore_tooltip': { zh: '清除 iPhone 上的虛擬定位,恢復真實 GPS', en: 'Clear the virtual location and restore real GPS' },
  'status.restore_success': { zh: '已清除虛擬定位 · iPhone 需 10~30 秒取得真實 GPS', en: 'Virtual location cleared · iPhone needs 10-30s to reacquire real GPS' },
  'status.restore_failed': { zh: '清除失敗', en: 'Clear failed' },
  'status.copy_coord': { zh: '複製座標', en: 'Copy coordinates' },

  // ── Modes ────────────────────────────────────
  'mode.teleport': { zh: '瞬間移動', en: 'Teleport' },
  'mode.navigate': { zh: '導航移動', en: 'Navigate' },
  'mode.loop': { zh: '路線巡迴', en: 'Route Loop' },
  'mode.multi_stop': { zh: '多點導航', en: 'Multi-stop' },
  'mode.random_walk': { zh: '隨機漫步', en: 'Random Walk' },
  'mode.joystick': { zh: '搖桿操控', en: 'Joystick' },

  // ── Move mode (speed presets) ────────────────
  'move.walking': { zh: '走路', en: 'Walking' },
  'move.running': { zh: '跑步', en: 'Running' },
  'move.driving': { zh: '開車', en: 'Driving' },

  // ── Control panel ────────────────────────────
  'panel.speed': { zh: '速度', en: 'Speed' },
  'panel.custom_speed': { zh: '自訂速度', en: 'Custom speed' },
  'panel.custom_speed_active': { zh: '使用自訂速度', en: 'Using custom speed' },
  'panel.speed_variance': { zh: '上下浮動', en: 'Variance' },
  'panel.speed_variance_hint': { zh: '每趟隨機', en: 're-picked per leg' },
  'panel.actual_speed': { zh: '實際速度', en: 'Actual speed' },
  'panel.coords': { zh: '座標', en: 'Coordinates' },
  'panel.coord_lat': { zh: '緯度', en: 'Latitude' },
  'panel.coord_lng': { zh: '經度', en: 'Longitude' },
  'panel.coord_go': { zh: '前往', en: 'Go' },
  'panel.search': { zh: '搜尋', en: 'Search' },
  'panel.bookmarks': { zh: '書籤', en: 'Bookmarks' },
  'panel.routes': { zh: '路線', en: 'Routes' },
  'panel.waypoints': { zh: '路徑點', en: 'Waypoints' },
  'panel.waypoints_hint': { zh: '右鍵地圖添加', en: 'Right-click map to add' },
  'panel.waypoints_radius': { zh: '半徑', en: 'Radius' },
  'panel.waypoints_count': { zh: '數量', en: 'Count' },
  'panel.waypoints_generate': { zh: '隨機產生', en: 'Random' },
  'panel.waypoints_generate_all': { zh: '全隨機', en: 'All random' },
  'panel.waypoints_empty': { zh: '在地圖上右鍵點擊 → 「添加路徑點」,或使用上方隨機產生', en: 'Right-click the map to add waypoints, or use random generate above' },
  'panel.waypoints_start_loop': { zh: '開始巡迴', en: 'Start Loop' },
  'panel.waypoints_start_multi': { zh: '開始多點導航', en: 'Start Multi-stop' },
  'panel.waypoints_start_navigate': { zh: '開始導航', en: 'Start Navigate' },
  'panel.route_name': { zh: '路線名稱', en: 'Route name' },
  'panel.route_save_hint': { zh: '目前路徑點: {n} 個,輸入名稱後按儲存即可保存', en: 'Current waypoints: {n}, enter a name and click Save' },
  'panel.route_empty': { zh: '尚無儲存的路線', en: 'No saved routes' },
  'panel.route_gpx_import': { zh: '匯入 GPX', en: 'Import GPX' },
  'panel.route_gpx_export_tooltip': { zh: '匯出為 GPX', en: 'Export as GPX' },
  'panel.route_delete_confirm': { zh: '刪除路線「{name}」?', en: 'Delete route "{name}"?' },
  'panel.random_walk_radius': { zh: '隨機漫步半徑 (m)', en: 'Random walk radius (m)' },

  // ── Device status ────────────────────────────
  'device.no_device': { zh: '未偵測到裝置', en: 'No device detected' },
  'device.scan': { zh: 'USB', en: 'USB' },
  'device.scan_scanning': { zh: '掃描中', en: 'Scanning' },
  'device.scan_found': { zh: '找到 {n} 台', en: 'Found {n}' },
  'device.scan_none': { zh: '未偵測到', en: 'Not found' },
  'device.scan_tooltip': { zh: '掃描 USB 裝置', en: 'Scan USB devices' },
  'wifi.section_title': { zh: 'WiFi 無線連線', en: 'Wi-Fi Connection' },
  'wifi.section_hint': { zh: '(USB 模式不用連線)', en: '(USB mode: no connection needed)' },
  'wifi.warning_label': { zh: '注意事項', en: 'Notice' },
  'wifi.warning_title': { zh: '慎用:USB 拔除模式相容性說明', en: 'Caution: USB-free mode compatibility' },
  'wifi.warning_body': {
    zh: '本 WiFi Tunnel(USB 拔除)模式透過 pymobiledevice3 的 RemotePairing 協議與 iOS 裝置建立 TLS-PSK 加密通道,再於其上封裝 TCP tunnel 以存取 RemoteXPC / RSD 服務。需 Python 3.13+ 的原生 TLS-PSK 支援,且必須先經 USB 配對、取得 remote pair record 方可使用。\n\n由於各家網路卡驅動、VPN 客戶端、第三方防火牆、路由器 mDNS/Bonjour 支援與作業系統修補等級差異,此模式並非在所有 Windows 主機上皆能穩定建立 Tunnel,部分環境可能出現以下情況:\n\n• RemotePairing 握手失敗或 RSD 連線逾時\n• 裝置 IP/Port 無法被自動探索\n• 必須以系統管理員身分執行\n• iPhone 螢幕鎖定或 WiFi 瞬斷時 tunnel 斷線須重連\n\n若您的環境無法成功建立 Tunnel,建議改用 USB 連線;USB 模式透過 usbmuxd 相容性最佳且不需此側欄。',
    en: 'WiFi Tunnel (USB-free) mode uses pymobiledevice3\'s RemotePairing protocol to open a TLS-PSK encrypted channel with the iOS device, then layers a TCP tunnel on top for access to RemoteXPC / RSD services. Python 3.13+ is required (for native TLS-PSK) and the device must have been paired over USB first so that a remote pair record exists.\n\nBecause NIC drivers, VPN clients, third-party firewalls, router mDNS/Bonjour behavior and OS patch levels vary widely, this mode does not work reliably on every Windows host. In some environments you may see:\n\n• RemotePairing handshake failure or RSD connection timeout\n• Device IP/port cannot be auto-discovered\n• Requirement to run as Administrator\n• Tunnel drops and needs reconnection when the iPhone screen locks or Wi-Fi briefly fluctuates\n\nIf the tunnel cannot be established in your environment, please use a USB connection instead — USB mode goes through usbmuxd, has the best compatibility, and does not require this panel.',
  },
  'wifi.warning_ok': { zh: '我已了解', en: 'Got it' },
  'wifi.repair_button': { zh: '重新配對', en: 'Re-pair' },
  'wifi.repair_tooltip': { zh: '用 USB 重建 RemotePairing 記錄,修復 WiFi Tunnel 無法啟動的問題', en: 'Rebuild the RemotePairing record via USB to fix WiFi Tunnel startup failures' },
  'wifi.repair_confirm_title': { zh: '重新配對 iPhone', en: 'Re-pair iPhone' },
  'wifi.repair_confirm_body': { zh: '此動作會用 USB 重建 RemotePairing 記錄。過程中 iPhone 可能會跳「信任這台電腦」,請解鎖並按信任。LocWarp 必須以系統管理員身分執行。\n\n確定要繼續嗎?', en: 'This rebuilds the RemotePairing record via USB. Your iPhone may show "Trust This Computer" — unlock it and tap Trust. LocWarp must be running as Administrator.\n\nContinue?' },
  'wifi.repair_running': { zh: '配對中...請在 iPhone 上按「信任」', en: 'Pairing... tap Trust on the iPhone' },
  'wifi.repair_success': { zh: '配對成功!現在可以試 WiFi Tunnel 了', en: 'Paired! You can try WiFi Tunnel now' },
  'wifi.repair_failed': { zh: '配對失敗', en: 'Pairing failed' },
  'wifi.repair_cancel': { zh: '取消', en: 'Cancel' },
  'wifi.repair_ok': { zh: '開始配對', en: 'Start pairing' },
  'wifi.tab_ios17plus': { zh: 'iOS 17+', en: 'iOS 17+' },
  'wifi.tab_ios17minus': { zh: 'iOS 17 以下', en: 'iOS 17 and below' },
  'wifi.help_ip': { zh: '如何找 IP?', en: 'How to find IP?' },
  'wifi.detect': { zh: '自動偵測', en: 'Auto-detect' },
  'wifi.detect_scanning': { zh: '偵測中', en: 'Detecting' },
  'wifi.detect_tooltip': { zh: '自動偵測同網段 iPhone 的 IP 與 Port', en: "Auto-detect iPhone's IP and port on the local network" },
  'wifi.help_title': { zh: '如何找到 iPhone 的 IP?', en: "How to find your iPhone's IP?" },
  'wifi.help_steps': { zh: 'iPhone 上:設定 → Wi-Fi → 點目前連線網路旁的 (i) → 往下找「IP 位址」', en: 'On iPhone: Settings → Wi-Fi → tap (i) next to the current network → scroll down to "IP Address"' },
  'wifi.help_hint': { zh: 'iPhone 與電腦必須在同一個 WiFi 網段', en: 'iPhone and computer must be on the same Wi-Fi subnet' },
  'wifi.ip': { zh: 'IP', en: 'IP' },
  'wifi.port': { zh: 'Port', en: 'Port' },
  'wifi.ip_placeholder': { zh: 'iPhone IP(例如 192.168.0.205)', en: 'iPhone IP (e.g. 192.168.0.205)' },
  'wifi.tunnel_establishing': { zh: '建立 tunnel 中...', en: 'Establishing tunnel...' },
  'wifi.tunnel_start': { zh: 'Start WiFi Tunnel', en: 'Start Wi-Fi Tunnel' },
  'wifi.tunnel_stop': { zh: 'Stop Tunnel', en: 'Stop Tunnel' },
  'wifi.tunnel_active': { zh: 'Active', en: 'Active' },
  'wifi.tunnel_usb_can_disconnect': { zh: 'USB 可拔除', en: 'USB can be disconnected' },
  'wifi.tunnel_admin_hint': { zh: '請使用身分管理員開啟 LocWarp,必須先通過 USB 信任。', en: 'Run LocWarp as Administrator. Device must be paired via USB first.' },
  'wifi.legacy_connect': { zh: 'Connect', en: 'Connect' },
  'wifi.legacy_connecting': { zh: '連線中...', en: 'Connecting...' },
  'wifi.legacy_hint': { zh: 'iPhone 解鎖並已配對即可直接連線。', en: 'iPhone unlocked and paired — connect directly.' },
  'wifi.device_not_detected': { zh: '未偵測到裝置,請確認 iPhone 與電腦在同一 WiFi', en: 'Device not detected — ensure iPhone and computer are on the same Wi-Fi' },
  'wifi.detect_failed': { zh: '偵測失敗', en: 'Detection failed' },

  // ── Map ──────────────────────────────────────
  'map.recenter': { zh: '定位到目前位置', en: 'Recenter on current position' },
  'map.click_not_locate': { zh: '此功能非定位', en: 'This is NOT teleport' },
  'map.click_use_right': { zh: '請用右鍵「瞬移到這裡」', en: 'Right-click to "Teleport here"' },
  'map.device_disconnected': { zh: 'USB 已斷開,請重新插入', en: 'USB disconnected — please reconnect' },
  'map.teleport_here': { zh: '瞬移到這裡', en: 'Teleport here' },
  'map.navigate_here': { zh: '導航到這裡', en: 'Navigate here' },
  'map.add_waypoint': { zh: '添加路徑點', en: 'Add waypoint' },
  'map.add_bookmark': { zh: '加入書籤', en: 'Add bookmark' },

  // ── ETA / 進度 ──────────────────────────────
  'eta.remaining': { zh: '剩餘', en: 'Remaining' },
  'eta.eta': { zh: '預計到達', en: 'ETA' },
  'eta.traveled': { zh: '已行', en: 'Traveled' },
  'eta.pause_countdown': { zh: '到點暫停中 · 剩餘 {n}s', en: 'Paused at waypoint · {n}s left' },

  // ── Joystick ─────────────────────────────────
  'joy.drag_or_keys': { zh: '拖曳或按 WASD / 方向鍵', en: 'Drag or press WASD / arrow keys' },
  'joy.north': { zh: '北', en: 'N' },
  'joy.east': { zh: '東', en: 'E' },
  'joy.south': { zh: '南', en: 'S' },
  'joy.west': { zh: '西', en: 'W' },
  'joy.northeast': { zh: '東北', en: 'NE' },
  'joy.northwest': { zh: '西北', en: 'NW' },
  'joy.southeast': { zh: '東南', en: 'SE' },
  'joy.southwest': { zh: '西南', en: 'SW' },

  // ── Toast / errors ───────────────────────────
  'toast.route_saved': { zh: '已儲存路線「{name}」', en: 'Route "{name}" saved' },
  'toast.route_save_failed': { zh: '儲存失敗: {msg}', en: 'Save failed: {msg}' },
  'toast.route_need_waypoint': { zh: '請先加入至少一個路徑點', en: 'Add at least one waypoint first' },
  'toast.route_deleted': { zh: '已刪除路線', en: 'Route deleted' },
  'toast.route_delete_failed': { zh: '刪除失敗', en: 'Delete failed' },
  'toast.route_rename_failed': { zh: '重新命名失敗', en: 'Rename failed' },
  'toast.gpx_imported': { zh: '已匯入 {n} 個路徑點', en: 'Imported {n} waypoints' },
  'toast.gpx_import_failed': { zh: '匯入失敗: {msg}', en: 'Import failed: {msg}' },

  // ── Error codes (backend → i18n) ────────────
  'err.python313_missing': { zh: '需要 Python 3.13+ 才能啟動 WiFi Tunnel', en: 'Python 3.13+ is required to start the Wi-Fi tunnel' },
  'err.tunnel_script_missing': { zh: '找不到 wifi_tunnel.py 腳本', en: 'wifi_tunnel.py script not found' },
  'err.tunnel_spawn_failed': { zh: '無法啟動 Tunnel 進程', en: 'Failed to spawn tunnel process' },
  'err.tunnel_exited': { zh: 'Tunnel 進程異常結束', en: 'Tunnel process exited unexpectedly' },
  'err.tunnel_timeout': { zh: 'Tunnel 啟動逾時,請確認 iPhone 解鎖且與電腦同網段', en: 'Tunnel startup timed out — ensure iPhone is unlocked and on the same subnet' },
  'err.no_device': { zh: '尚未連接任何 iOS 裝置,請先透過 USB 連線', en: 'No iOS device connected — connect via USB first' },
  'err.no_position': { zh: '尚未取得目前位置,請先跳點到一個座標', en: 'No current position — teleport to a coordinate first' },
  'err.tunnel_lost': { zh: 'WiFi Tunnel 連線中斷,請重新建立', en: 'Wi-Fi tunnel dropped — please reconnect' },
  'err.cooldown_active': { zh: '冷卻中,請等待後再跳點', en: 'Cooldown active — wait before teleporting' },

  // ── Panel extras ────────────────────────────
  'panel.mode': { zh: '模式', en: 'Mode' },
  'panel.address_search': { zh: '地址搜尋', en: 'Address Search' },
  'panel.library': { zh: '收藏與路線', en: 'Library' },
  'panel.library_drag_hint': { zh: '收藏與路線 · 拖曳此處移動', en: 'Library · Drag to move' },
  'panel.bookmarks_count': { zh: '座標收藏', en: 'Bookmarks' },
  'panel.routes_count': { zh: '路線', en: 'Routes' },
  'panel.close': { zh: '關閉', en: 'Close' },
  'panel.route_load_tooltip': { zh: '點擊載入路線', en: 'Click to load route' },
  'panel.random_walk_range': { zh: '隨機漫步範圍', en: 'Random walk range' },
  'panel.meters_radius': { zh: '公尺 (半徑)', en: 'meters (radius)' },
  'panel.current_pos': { zh: '目前位置:', en: 'Current position:' },
  'panel.waypoints_pts': { zh: '個', en: '' },
  'panel.waypoints_remove': { zh: '移除', en: 'Remove' },
  'panel.waypoint_num': { zh: '路徑點 {n}', en: 'Waypoint {n}' },
  'panel.waypoints_gen_tooltip': { zh: '在當前位置周圍隨機產生路徑點', en: 'Random waypoints around current position' },
  'panel.waypoints_gen_all_tooltip': { zh: '半徑與數量全隨機', en: 'Fully randomize radius and count' },
  'panel.points': { zh: '點', en: 'pts' },
  'panel.start_prefix': { zh: '開始', en: 'Start ' },
  'panel.pts_short': { zh: 'pts', en: 'pts' },

  // ── Toasts extra ─────────────────────────────
  'toast.no_position_random': { zh: '尚未取得目前位置,無法產生隨機路徑點', en: 'No current position — cannot generate random waypoints' },
  'toast.no_waypoints': { zh: '尚未設定路徑點,請在地圖上右鍵添加或使用隨機產生', en: 'No waypoints set — right-click the map to add, or use Random generate' },
  'toast.pause_countdown': { zh: '到點暫停中 · 剩餘 {n}s', en: 'Paused at waypoint · {n}s left' },

  // ── Bookmarks ────────────────────────────────
  'bm.default': { zh: '預設', en: 'Default' },
  'bm.add_here': { zh: '在目前位置新增收藏', en: 'Add bookmark at current position' },
  'bm.add': { zh: '新增收藏', en: 'Add Bookmark' },
  'bm.manage_categories': { zh: '管理分類', en: 'Manage Categories' },
  'bm.name_placeholder': { zh: '收藏名稱', en: 'Bookmark name' },
  'bm.no_position': { zh: '目前無可用位置', en: 'No position available' },
  'bm.add_category': { zh: '新增分類', en: 'Add Category' },
  'bm.new_category': { zh: '新增', en: 'New' },
  'bm.blank': { zh: '空白', en: 'Empty' },
  'bm.empty': { zh: '尚無收藏', en: 'No bookmarks' },
  'bm.edit': { zh: '編輯', en: 'Edit' },
  'bm.move_to': { zh: '移動到:', en: 'Move to:' },

  // ── Address search ───────────────────────────
  'search.placeholder': { zh: '搜尋地址...', en: 'Search address...' },
  'search.searching': { zh: '搜尋中...', en: 'Searching...' },
  'search.no_results': { zh: '無搜尋結果', en: 'No results' },

  // ── Device status extra ──────────────────────
  'device.connect_failed': { zh: '連線失敗', en: 'Connection failed' },
  'wifi.tunnel_lost_banner': { zh: 'WiFi Tunnel 連線中斷,請重新建立', en: 'Wi-Fi tunnel dropped — please reconnect' },
  'wifi.legacy_unavailable': { zh: 'iOS 17 以下連線方式目前不可用。', en: 'iOS 17 and below connection mode is not available.' },

  // ── Map extras ──────────────────────────────
  'map.destination': { zh: '目的地', en: 'Destination' },

  // ── Pause settings ──────────────────────────
  'pause.multi_stop': { zh: '每站隨機暫停', en: 'Random pause at each stop' },
  'pause.loop': { zh: '每圈隨機暫停', en: 'Random pause between laps' },
  'pause.random_walk': { zh: '每段隨機暫停', en: 'Random pause between legs' },
  'pause.min': { zh: '最小', en: 'Min' },
  'pause.max': { zh: '最大', en: 'Max' },
  'pause.seconds': { zh: '秒', en: 's' },

  // ── DDI mount overlay ───────────────────────
  'ddi.mounting_title': { zh: '首次設定裝置中', en: 'Preparing device' },
  'ddi.mounting_hint': { zh: '正在下載並掛載 Developer Disk Image(約 20MB),請保持網路連線,約需 10~30 秒...', en: 'Downloading and mounting the Developer Disk Image (~20MB). Please keep your internet connected. This takes 10–30 seconds...' },

  // ── Activity rail (left navigation) ─────────
  'rail.control': { zh: '控制', en: 'Control' },
  'rail.device': { zh: '裝置', en: 'Device' },
  'rail.tools': { zh: '工具', en: 'Tools' },

  // ── History panel ───────────────────────────
  'history.title': { zh: '地點歷史', en: 'Location History' },
  'history.count_unit': { zh: '筆', en: '' },
  'history.empty': { zh: '尚無記錄', en: 'No history yet' },
  'history.jump': { zh: '跳', en: 'Go' },
  'history.jump_tooltip': { zh: '跳到此座標', en: 'Teleport to this point' },
  'history.export_gpx': { zh: '↓ 匯出 GPX', en: '↓ Export GPX' },
  'history.clear': { zh: '清除歷史', en: 'Clear history' },
} as const;

export type StringKey = keyof typeof STRINGS;
