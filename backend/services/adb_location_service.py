"""
ADB Location Service
透過 Android Debug Bridge 對 BlueStacks / Android 模擬器注入假 GPS。
使用 Android 內建的 test provider 機制，不需要在模擬器裡安裝任何 App。
"""

from __future__ import annotations

import asyncio
import logging

from services.location_service import LocationService

logger = logging.getLogger(__name__)

ADB_SERIAL = "127.0.0.1:5555"   # 預設 BlueStacks ADB 位址


async def _adb(serial: str, *args: str) -> tuple[int, str, str]:
    """Run `adb -s <serial> <args>` and return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "adb", "-s", serial, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out.decode().strip(), err.decode().strip()


class AdbLocationService(LocationService):
    """
    GPS 模擬服務 — 透過 ADB test provider 注入座標。

    流程：
    1. connect() — 授予 mock location 權限、建立 test provider
    2. set(lat, lng) — 設定 test provider 座標（每次移動都呼叫）
    3. clear() — 停用並移除 test provider，恢復正常 GPS
    """

    PROVIDER = "gps"

    def __init__(self, serial: str = ADB_SERIAL) -> None:
        self._serial = serial
        self._active = False
        self._provider_added = False

    async def connect(self) -> None:
        """建立 ADB 連線並初始化 test provider。"""
        # 確保 ADB 連上
        rc, out, _ = await _adb(self._serial, "get-state")
        if rc != 0 or "device" not in out:
            # 嘗試連線
            proc = await asyncio.create_subprocess_exec(
                "adb", "connect", self._serial,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"ADB connect failed: {err.decode().strip()}")

        # 授予 mock location 權限
        await _adb(self._serial, "shell",
                   "appops set com.android.shell android:mock_location allow")

        # 建立 test provider（若已存在先移除）
        await _adb(self._serial, "shell",
                   f"cmd location providers remove-test-provider {self.PROVIDER}")
        rc, _, err = await _adb(self._serial, "shell",
                                f"cmd location providers add-test-provider {self.PROVIDER}")
        if rc != 0:
            logger.warning("add-test-provider warning: %s", err)

        # 啟用 provider
        await _adb(self._serial, "shell",
                   f"cmd location providers set-test-provider-enabled {self.PROVIDER} true")

        self._provider_added = True
        logger.info("ADB location service connected to %s", self._serial)

    async def set(self, lat: float, lng: float) -> None:
        """注入指定座標。"""
        if not self._provider_added:
            await self.connect()

        rc, _, err = await _adb(
            self._serial, "shell",
            f"cmd location providers set-test-provider-location {self.PROVIDER} "
            f"--location {lat},{lng} --accuracy 1",
        )
        if rc != 0:
            logger.error("ADB set location failed: %s", err)
            raise RuntimeError(f"ADB set location failed: {err}")

        self._active = True
        logger.debug("ADB location set to (%.6f, %.6f)", lat, lng)

    async def clear(self) -> None:
        """停用並移除 test provider，恢復真實 GPS。"""
        if not self._provider_added:
            return

        await _adb(self._serial, "shell",
                   f"cmd location providers set-test-provider-enabled {self.PROVIDER} false")
        await _adb(self._serial, "shell",
                   f"cmd location providers remove-test-provider {self.PROVIDER}")

        self._active = False
        self._provider_added = False
        logger.info("ADB location cleared on %s", self._serial)
