"""In-process WiFi tunnel runner.

Backend now runs on Python 3.13 (native TLS-PSK support), so the tunnel
lives inside the backend event loop instead of a separate helper exe.
The tunnel context (`service.start_tcp_tunnel()`) must stay open for the
RSD link to remain usable, so we hold it inside a long-running task and
release it via a stop event.
"""

import asyncio
import logging

logger = logging.getLogger("wifi_tunnel")


class TunnelRunner:
    """Owns the tunnel asyncio task and its RSD info."""

    def __init__(self) -> None:
        self.info: dict | None = None
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self._stop: asyncio.Event = asyncio.Event()
        self._ready: asyncio.Event = asyncio.Event()
        self._error: BaseException | None = None

    def is_running(self) -> bool:
        return self.task is not None and not self.task.done()

    async def _run(self, udid: str, ip: str, port: int) -> None:
        from pymobiledevice3.remote.tunnel_service import (
            create_core_device_tunnel_service_using_remotepairing,
        )
        try:
            logger.info("Connecting to RemotePairing service at %s:%d", ip, port)
            service = await create_core_device_tunnel_service_using_remotepairing(
                udid, ip, port,
            )
            logger.info("RemotePairing connected (identifier=%s)", service.remote_identifier)

            async with service.start_tcp_tunnel() as tunnel:
                self.info = {
                    "rsd_address": tunnel.address,
                    "rsd_port": tunnel.port,
                    "interface": tunnel.interface,
                    "protocol": str(tunnel.protocol),
                }
                logger.info(
                    "WiFi tunnel established: %s:%d iface=%s",
                    tunnel.address, tunnel.port, tunnel.interface,
                )
                self._ready.set()
                await self._stop.wait()
                logger.info("Tunnel stop signal received; closing context")
        except BaseException as exc:
            self._error = exc
            self._ready.set()
            raise
        finally:
            self.info = None

    async def start(self, udid: str, ip: str, port: int, timeout: float = 20.0) -> dict:
        """Start the tunnel and wait until RSD info is ready.

        Raises asyncio.TimeoutError on timeout or the underlying exception
        if the tunnel setup failed before becoming ready.
        """
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()
        self._error = None
        self.info = None
        self.task = asyncio.create_task(self._run(udid, ip, port))
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._stop.set()
            try:
                await asyncio.wait_for(self.task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
            self.task = None
            raise
        if self._error is not None:
            exc = self._error
            self.task = None
            raise exc
        return dict(self.info or {})

    async def stop(self) -> None:
        if not self.is_running():
            self.task = None
            self.info = None
            return
        self._stop.set()
        try:
            await asyncio.wait_for(self.task, timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Tunnel task did not exit in 5s; cancelling")
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        except (asyncio.CancelledError, Exception):
            pass
        self.task = None
        self.info = None
