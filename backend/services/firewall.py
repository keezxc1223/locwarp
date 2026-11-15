"""Windows Firewall state for the backend's mDNS (Bonjour) discovery.

WiFi discovery listens for multicast replies on UDP 5353. Windows only lets
those in when an inbound Allow rule covers this exe on the profile (Public /
Private / Domain) of the network in use. The only rules LocWarp used to have
were the ones Windows creates from its first-run "allow access" prompt:

* Cancel on that prompt leaves a Block rule, and Block wins over Allow.
* Allowing only one profile leaves the other blocked, so discovery breaks
  when the network is later classified differently.

Either way discovery silently finds nothing. This module reads that state and
repairs it. Everything here blocks on PowerShell: call it via
asyncio.to_thread.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys

logger = logging.getLogger("locwarp")

MDNS_PORT = 5353
RULE_ID = "LocWarp-mDNS-In"
RULE_DISPLAY_NAME = "LocWarp WiFi Discovery (mDNS)"

_PS_TIMEOUT = 25.0

# NetworkCategory of a connection -> the firewall profile that applies to it.
_CATEGORY_TO_PROFILE = {
    "Public": "Public",
    "Private": "Private",
    "DomainAuthenticated": "Domain",
}

_PS_PRELUDE = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$exe = $env:LOCWARP_FW_EXE
function Get-OwnRules {
    foreach ($f in @(Get-NetFirewallApplicationFilter)) {
        if ($f.Program -and
            [Environment]::ExpandEnvironmentVariables($f.Program) -ieq $exe) {
            $f | Get-NetFirewallRule
        }
    }
}
"""

_PS_QUERY = _PS_PRELUDE + r"""
$out = @{}
$out.profiles = @(Get-NetFirewallProfile | ForEach-Object {
    @{ name = [string]$_.Name; enabled = ([string]$_.Enabled -eq 'True') }
})
$out.networks = @(Get-NetConnectionProfile | ForEach-Object {
    @{ alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory }
})
$out.adapters = @(Get-NetAdapter | ForEach-Object {
    @{ name = [string]$_.Name; desc = [string]$_.InterfaceDescription;
       virtual = [bool]$_.Virtual; status = [string]$_.Status }
})
$out.rules = @(Get-OwnRules | ForEach-Object {
    $p = $_ | Get-NetFirewallPortFilter
    @{ name = [string]$_.DisplayName; direction = [string]$_.Direction;
       action = [string]$_.Action; enabled = ([string]$_.Enabled -eq 'True');
       profile = [string]$_.Profile; protocol = [string]$p.Protocol;
       port = [string](@($p.LocalPort) -join ',') }
})
$out | ConvertTo-Json -Depth 4 -Compress
"""

_PS_REPAIR = _PS_PRELUDE + r"""
$removed = 0
foreach ($r in @(Get-OwnRules)) {
    if ([string]$r.Direction -eq 'Inbound' -and [string]$r.Action -eq 'Block') {
        $r | Remove-NetFirewallRule
        $removed++
    }
}
Get-NetFirewallRule -Name $env:LOCWARP_FW_RULE_ID -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule
New-NetFirewallRule -Name $env:LOCWARP_FW_RULE_ID `
    -DisplayName $env:LOCWARP_FW_RULE_NAME `
    -Direction Inbound -Action Allow -Program $exe `
    -Protocol UDP -LocalPort $env:LOCWARP_FW_PORT -Profile Any | Out-Null
@{ removed = $removed } | ConvertTo-Json -Compress
"""


def own_exe() -> str:
    """The executable Windows Firewall sees for this process."""
    return os.path.abspath(sys.executable)


def is_admin() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _run_ps(script: str, exe: str) -> dict:
    """Run a PowerShell script and parse the JSON object it prints.

    Raises:
        RuntimeError: PowerShell failed or printed no JSON.
    """
    env = dict(os.environ)
    env.update({
        "LOCWARP_FW_EXE": exe,
        "LOCWARP_FW_RULE_ID": RULE_ID,
        "LOCWARP_FW_RULE_NAME": RULE_DISPLAY_NAME,
        "LOCWARP_FW_PORT": str(MDNS_PORT),
    })
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=_PS_TIMEOUT, env=env,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    out = (proc.stdout or "").strip().lstrip("﻿")
    start = out.find("{")
    if proc.returncode != 0 or start < 0:
        err = (proc.stderr or out or f"exit code {proc.returncode}").strip()
        raise RuntimeError(err[:400])
    return json.loads(out[start:])


def _as_list(value) -> list:
    """ConvertTo-Json turns a one-element array into a bare object."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _covers_profile(rule_profile: str, profile: str) -> bool:
    names = {p.strip() for p in (rule_profile or "").split(",")}
    return "Any" in names or profile in names


def _covers_mdns(rule: dict) -> bool:
    if (rule.get("protocol") or "Any") not in ("UDP", "Any", "17"):
        return False
    port = (rule.get("port") or "Any").strip()
    if port in ("", "Any"):
        return True
    return str(MDNS_PORT) in {p.strip() for p in port.split(",")}


def evaluate(raw: dict) -> dict:
    """Decide whether mDNS replies can reach this exe.

    Args:
        raw: what _PS_QUERY printed (profiles, networks, rules).

    Returns:
        ``status``: ``ok``, ``blocked`` (a Block rule covers this exe),
        ``missing`` (no Allow rule), ``off`` (the firewall is disabled on
        every network in use) or ``unknown`` (no network to judge by);
        ``networks``: one ``{alias, profile, status}`` per network in use.
    """
    enabled = {p["name"]: bool(p.get("enabled")) for p in _as_list(raw.get("profiles"))}
    rules = [
        r for r in _as_list(raw.get("rules"))
        if r.get("enabled") and r.get("direction") == "Inbound" and _covers_mdns(r)
    ]
    networks: list[dict] = []
    for net in _as_list(raw.get("networks")):
        profile = _CATEGORY_TO_PROFILE.get(net.get("category") or "")
        if profile is None:
            continue
        mine = [r for r in rules if _covers_profile(r.get("profile") or "", profile)]
        if not enabled.get(profile, True):
            status = "off"
        elif any(r.get("action") == "Block" for r in mine):
            status = "blocked"
        elif any(r.get("action") == "Allow" for r in mine):
            status = "ok"
        else:
            status = "missing"
        networks.append({"alias": net.get("alias") or "", "profile": profile, "status": status})

    statuses = {n["status"] for n in networks}
    if not networks:
        overall = "unknown"
    elif "blocked" in statuses:
        overall = "blocked"
    elif "missing" in statuses:
        overall = "missing"
    elif statuses == {"off"}:
        overall = "off"
    else:
        overall = "ok"
    return {"status": overall, "networks": networks}


def query_state(exe: str | None = None) -> dict:
    """Read the firewall state for mDNS discovery. Never raises.

    Returns:
        ``supported`` (False off Windows), ``status`` and ``networks`` as in
        :func:`evaluate`, ``admin``, ``adapters`` (``{name, desc, virtual,
        status}`` per network adapter) and ``error`` when the query failed.
    """
    state: dict = {
        "supported": sys.platform == "win32",
        "status": "unknown",
        "networks": [],
        "adapters": [],
        "admin": is_admin(),
        "error": None,
    }
    if not state["supported"]:
        return state
    try:
        raw = _run_ps(_PS_QUERY, exe or own_exe())
    except Exception as e:
        logger.warning("Firewall state query failed: %s", e)
        state["error"] = str(e)
        return state
    state.update(evaluate(raw))
    state["adapters"] = _as_list(raw.get("adapters"))
    return state


def repair(exe: str | None = None) -> tuple[bool, str]:
    """Let mDNS replies reach this exe: delete the inbound Block rules bound
    to it and add an Allow rule for UDP 5353 on every profile.

    Returns:
        ``(ok, code)`` where code is ``repaired``, ``unsupported``,
        ``need_admin`` or the PowerShell error text.
    """
    if sys.platform != "win32":
        return False, "unsupported"
    if not is_admin():
        return False, "need_admin"
    try:
        result = _run_ps(_PS_REPAIR, exe or own_exe())
    except Exception as e:
        logger.warning("Firewall repair failed: %s", e)
        return False, str(e)
    logger.info(
        "Firewall: added %r for %s, removed %s block rule(s)",
        RULE_DISPLAY_NAME, exe or own_exe(), result.get("removed", 0),
    )
    return True, "repaired"


def ensure_mdns_allowed() -> str:
    """Startup check: repair the rules when mDNS replies are blocked.

    Returns:
        The resulting status: ``ok`` / ``off`` / ``unknown`` when nothing
        was needed, ``repaired``, or ``blocked`` / ``missing`` when the
        repair could not be done (not elevated, or PowerShell failed).
    """
    state = query_state()
    status = state["status"]
    if status not in ("blocked", "missing"):
        return status
    ok, code = repair()
    if ok:
        return "repaired"
    logger.warning(
        "Firewall blocks mDNS replies (%s) and could not be repaired: %s", status, code,
    )
    return status
