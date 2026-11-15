"""WiFi connection diagnosis: say which link of the chain is broken.

"Tunnel 啟動逾時" has many unrelated causes (firewall, VPN, router isolation,
wrong IP, no pairing) that all look the same to the user. /wifi/diagnose
checks each link separately and names the first broken one.

Every check is bounded and cheap: no LAN scan and no port scan (issue #49).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import subprocess
import sys

from fastapi import APIRouter, HTTPException

from api.device import (
    _browse_mdns_devices,
    _get_primary_local_ip,
    _probe_lockdownd,
)
from services import firewall

router = APIRouter(prefix="/api/device", tags=["device"])

_logger = logging.getLogger("wifi_tunnel")

# Adapter names / descriptions of VPNs and virtual switches. Matching one of
# these on the adapter that carries the default route means discovery and
# the tunnel are being sent somewhere the iPhone is not.
_VPN_KEYWORDS = (
    "vpn", "tap-", "tap windows", "wintun", "tunnel", "wireguard", "tailscale",
    "zerotier", "hamachi", "radmin", "openvpn", "clash", "mihomo", "sing-box",
    "hyper-v", "vethernet", "vmware", "virtualbox", "fortinet", "anyconnect",
    "nordlynx", "quickfox",
)

# Address ranges only VPNs hand out: CGNAT (Tailscale) and the benchmark
# range TUN-mode proxies use for fake-ip.
_VPN_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("198.18.0.0/15"),
)


def _local_interfaces() -> list[dict]:
    """Every interface that is up and has a usable IPv4.

    Returns:
        ``{"name", "ip", "network"}`` per address; link-local and loopback
        addresses are left out.
    """
    import psutil

    stats = psutil.net_if_stats()
    found: list[dict] = []
    for name, addrs in psutil.net_if_addrs().items():
        if name in stats and not stats[name].isup:
            continue
        for a in addrs:
            if getattr(a.family, "name", "") != "AF_INET" or not a.netmask:
                continue
            try:
                iface = ipaddress.ip_interface(f"{a.address}/{a.netmask}")
            except ValueError:
                continue
            if iface.ip.is_loopback or iface.ip.is_link_local:
                continue
            found.append({"name": name, "ip": str(iface.ip), "network": iface.network})
    return found


def _looks_like_vpn(name: str, desc: str, virtual: bool, ip: str) -> bool:
    text = f"{name} {desc}".lower()
    if virtual or any(k in text for k in _VPN_KEYWORDS):
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in _VPN_NETWORKS)


def _check_adapter(local_ip: str | None, interfaces: list[dict], adapters: list[dict]) -> dict:
    """Which adapter carries the default route, and is it a VPN."""
    if not local_ip:
        return {"id": "adapter", "status": "fail", "data": {}}
    by_name = {a.get("name"): a for a in adapters}

    def _describe(iface: dict) -> dict:
        info = by_name.get(iface["name"], {})
        desc = info.get("desc") or ""
        return {
            "name": iface["name"],
            "desc": desc,
            "ip": iface["ip"],
            "vpn": _looks_like_vpn(iface["name"], desc, bool(info.get("virtual")), iface["ip"]),
        }

    primary = next((i for i in interfaces if i["ip"] == local_ip), None)
    if primary is None:
        data = {"name": "", "desc": "", "ip": local_ip, "vpn": False, "others": []}
        return {"id": "adapter", "status": "ok", "data": data}
    data = _describe(primary)
    # Other VPN / virtual adapters that are up: they can swallow multicast
    # even when they do not carry the default route.
    data["others"] = [
        d["name"] for d in (_describe(i) for i in interfaces if i is not primary) if d["vpn"]
    ]
    status = "warn" if data["vpn"] or data["others"] else "ok"
    return {"id": "adapter", "status": status, "data": data}


def _check_subnet(ip: str | None, local_ip: str | None, interfaces: list[dict]) -> dict:
    """Is the phone's address on a network this PC is attached to."""
    if not ip or not local_ip:
        return {"id": "subnet", "status": "skip", "data": {}}
    addr = ipaddress.ip_address(ip)
    primary = next((i for i in interfaces if i["ip"] == local_ip), None)
    data = {"ip": ip, "local_ip": local_ip,
            "network": str(primary["network"]) if primary else ""}
    if primary and addr in primary["network"]:
        return {"id": "subnet", "status": "ok", "data": data}
    other = next((i for i in interfaces if addr in i["network"]), None)
    if other is not None:
        # Reachable, but through an adapter that is not the default route.
        data["via"] = other["name"]
        return {"id": "subnet", "status": "warn", "data": data}
    if primary is None:
        # Netmask unknown: fall back to comparing the first three octets.
        same = ip.split(".")[:3] == local_ip.split(".")[:3]
        return {"id": "subnet", "status": "ok" if same else "fail", "data": data}
    return {"id": "subnet", "status": "fail", "data": data}


def _check_firewall(state: dict) -> dict:
    data = {
        "state": state["status"],
        "networks": state["networks"],
        "admin": state["admin"],
    }
    if not state["supported"] or state["status"] == "unknown":
        return {"id": "firewall", "status": "skip", "data": data}
    ok = state["status"] in ("ok", "off")
    return {"id": "firewall", "status": "ok" if ok else "fail", "data": data}


async def _check_mdns_send() -> dict:
    """Can an mDNS query leave this PC at all."""
    try:
        from pymobiledevice3.bonjour import is_multicast_blocked, probe_multicast
        sent, errors = await probe_multicast()
    except Exception as e:
        return {"id": "mdns_send", "status": "fail", "data": {"sent": 0, "error": str(e)[:200]}}
    # Some interfaces always refuse (disconnected adapters, tunnels); only
    # every one of them refusing means multicast is blocked.
    blocked = sent == 0 or is_multicast_blocked(sent, errors)
    return {
        "id": "mdns_send",
        "status": "fail" if blocked else "ok",
        "data": {"sent": sent, "refused": len(errors)},
    }


async def _browse() -> tuple[list[dict], str | None]:
    try:
        return await _browse_mdns_devices(), None
    except Exception as e:
        return [], str(e)[:200]


def _check_mdns_browse(devices: list[dict], error: str | None, ip: str | None) -> dict:
    """Did an iPhone answer the mDNS query (and was it the one asked about)."""
    found = [{"ip": d["ip"], "port": d["port"], "host": d.get("host") or ""} for d in devices]
    data: dict = {"devices": found}
    if error:
        data["error"] = error
    if not found:
        return {"id": "mdns_browse", "status": "fail", "data": data}
    if ip and all(d["ip"] != ip for d in found):
        return {"id": "mdns_browse", "status": "warn", "data": data}
    return {"id": "mdns_browse", "status": "ok", "data": data}


def _ping(ip: str) -> bool:
    """One ICMP echo. Blocking; run it in a thread."""
    count_flag = "-n" if sys.platform == "win32" else "-c"
    wait = ["-w", "1000"] if sys.platform == "win32" else ["-W", "1"]
    try:
        proc = subprocess.run(
            ["ping", count_flag, "1", *wait, ip],
            capture_output=True, text=True, errors="replace", timeout=4.0,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
        )
    except Exception:
        return False
    # Windows exits 0 for "destination host unreachable" too; only a real
    # echo reply carries a TTL.
    return proc.returncode == 0 and "ttl=" in (proc.stdout or "").lower()


async def _check_reach(ip: str | None) -> dict:
    """Can this PC open a connection to the phone.

    Every iPhone on WiFi runs lockdownd on 62078 and answers QueryType
    without pairing, so this separates "the network does not let us through"
    from "the network is fine, the problem is the port or the pairing".
    """
    if not ip:
        return {"id": "reach", "status": "skip", "data": {}}
    state = await _probe_lockdownd(ip)
    data: dict = {"ip": ip, "state": state}
    if state == "lockdown":
        return {"id": "reach", "status": "ok", "data": data}
    if state == "open":
        # Something accepted the connection but is not an iPhone: a VPN or
        # proxy answering for every address, or another device's IP.
        return {"id": "reach", "status": "fail", "data": data}
    data["ping"] = await asyncio.to_thread(_ping, ip)
    return {"id": "reach", "status": "fail", "data": data}


def _check_pair_records() -> dict:
    """Has any iPhone been paired for WiFi (done once over USB)."""
    try:
        from pymobiledevice3.pair_records import iter_remote_pair_records
        count = sum(1 for _ in iter_remote_pair_records())
    except Exception as e:
        return {"id": "pair", "status": "skip", "data": {"error": str(e)[:200]}}
    return {"id": "pair", "status": "ok" if count else "fail", "data": {"count": count}}


def _verdict(checks: dict[str, dict], ip: str | None) -> str:
    """Name the first broken link, most fundamental first."""
    adapter, reach = checks["adapter"], checks["reach"]
    if adapter["status"] == "fail":
        return "no_network"
    if reach["status"] == "fail":
        if reach["data"].get("state") == "open":
            return "not_iphone"
        if reach["data"].get("ping"):
            # Answers ping but has no lockdownd: some other device's address.
            return "wrong_device"
        if adapter["data"].get("vpn"):
            return "vpn_suspected"
        if checks["subnet"]["status"] == "fail":
            return "different_subnet"
        return "phone_unreachable"
    if checks["pair"]["status"] == "fail":
        return "no_pair_record"
    browse = checks["mdns_browse"]["status"]
    if browse == "warn":
        # Other iPhones answered, this one did not.
        return "phone_not_advertising"
    if browse == "fail":
        if checks["firewall"]["status"] == "fail":
            return "firewall_blocked"
        if checks["mdns_send"]["status"] == "fail":
            return "mdns_send_blocked"
        if not ip:
            return "no_device_found"
        # The phone is reachable but silent on multicast: the router does
        # not pass multicast between the two, or a VPN adapter takes it.
        return "mdns_no_reply"
    return "all_ok"


@router.get("/wifi/diagnose")
async def wifi_diagnose(ip: str = ""):
    """Check each link of the WiFi connection and name the broken one.

    Args:
        ip: the iPhone's IPv4 when the user knows it. Without it, the
            address of an iPhone found over mDNS is used; with neither, the
            checks that need an address are skipped.

    Returns:
        ``ip`` / ``ip_source`` (``input`` or ``mdns``): the address checked;
        ``checks``: ``{"id", "status", "data"}`` per check, status being
        ``ok`` / ``warn`` / ``fail`` / ``skip``; ``verdict``: the code of the
        conclusion; ``admin``: whether the firewall can be repaired from here.

    Raises:
        HTTPException: 400 ``bad_ip`` when ip is not an IPv4 address.
    """
    target: str | None = (ip or "").strip() or None
    if target:
        try:
            ipaddress.IPv4Address(target)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail={"code": "bad_ip", "message": "IP 格式不正確"},
            )
    source = "input" if target else None

    local_ip = _get_primary_local_ip()
    try:
        interfaces = await asyncio.to_thread(_local_interfaces)
    except Exception:
        _logger.debug("Could not list network interfaces", exc_info=True)
        interfaces = []

    fw_state, send_check, (devices, browse_error), reach_check = await asyncio.gather(
        asyncio.to_thread(firewall.query_state),
        _check_mdns_send(),
        _browse(),
        _check_reach(target),
    )
    if target is None and devices:
        target, source = devices[0]["ip"], "mdns"
        reach_check = await _check_reach(target)

    ordered = [
        _check_adapter(local_ip, interfaces, fw_state["adapters"]),
        _check_subnet(target, local_ip, interfaces),
        reach_check,
        _check_pair_records(),
        _check_firewall(fw_state),
        send_check,
        _check_mdns_browse(devices, browse_error, target if source == "input" else None),
    ]
    verdict = _verdict({c["id"]: c for c in ordered}, target)
    _logger.info(
        "WiFi diagnose ip=%s (%s) local=%s -> %s | %s",
        target, source, local_ip, verdict,
        ", ".join(f"{c['id']}={c['status']}" for c in ordered),
    )
    for c in ordered:
        if c["status"] in ("warn", "fail"):
            _logger.info("WiFi diagnose detail %s: %s", c["id"], c["data"])
    return {
        "ip": target,
        "ip_source": source,
        "local_ip": local_ip,
        "checks": ordered,
        "verdict": verdict,
        "admin": fw_state["admin"],
    }


@router.post("/wifi/firewall/repair")
async def wifi_firewall_repair():
    """Let mDNS replies through Windows Firewall for this exe.

    Returns:
        ``{"status": "repaired"}``.

    Raises:
        HTTPException: 403 ``firewall_need_admin`` when not elevated, 500
            ``firewall_repair_failed`` otherwise.
    """
    ok, code = await asyncio.to_thread(firewall.repair)
    if ok:
        return {"status": "repaired"}
    if code == "need_admin":
        raise HTTPException(
            status_code=403,
            detail={"code": "firewall_need_admin", "message": "需以系統管理員身分執行 LocWarp"},
        )
    raise HTTPException(
        status_code=500,
        detail={"code": "firewall_repair_failed", "message": f"防火牆修復失敗:{code}"},
    )
