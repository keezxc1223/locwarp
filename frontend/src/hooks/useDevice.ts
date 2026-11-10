import { useState, useCallback, useEffect, useRef } from 'react'
import {
  listDevices, connectDevice, disconnectDevice,
  wifiConnect, wifiScan,
  wifiTunnelStartAndConnect, wifiTunnelStatus, wifiTunnelStop, wifiTunnelDiscover,
  type TunnelInfo,
} from '../services/api'
import {
  wifiCandidates, fillFreeSlots, tallyWifiResults, needsDiscovery,
  type ConnectMode, type DiscoveredInput, type CandidateSource, type CandidateOutcome,
} from '../wifiCandidates'
import type { WsMessage } from './useWebSocket'
import {
  readSavedIps, savedIpsForPrefix, upsertSavedIp,
  type SavedTunnelIp,
} from '../utils/savedTunnelIps'
import { getHostPrefix } from '../utils/hostNetwork'

export interface DeviceInfo {
  udid: string
  name: string
  ios_version: string
  connection_type: string
  is_connected: boolean
  // iOS 16+ Developer Mode toggle state. null = unknown (iOS <16, query
  // failed, or device not yet connected). Used to decide whether to show
  // the "Reveal Developer Mode option" button.
  developer_mode_enabled?: boolean | null
  // WiFi only: the RemotePairing port the tunnel actually handshook on,
  // which can differ from the requested one when the backend re-scans.
  port?: number
}

export interface WifiScanResult {
  ip: string
  name: string
  udid: string
  ios_version: string
}

export type WsSubscribe = (fn: (m: WsMessage) => void) => () => void

export function useDevice(subscribe?: WsSubscribe) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connectedDevice, setConnectedDevice] = useState<DeviceInfo | null>(null)

  // React to real-time device state broadcasts via the subscribe callback.
  // See useWebSocket.ts for the rationale vs the old useState pattern.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'device_disconnected') {
        // Group mode: only mark the specific udid disconnected when provided;
        // fall back to clearing all for legacy single-device disconnect events.
        const udid = msg.data?.udid
        const udids: string[] = Array.isArray(msg.data?.udids) ? msg.data.udids : (udid ? [udid] : [])
        if (udids.length === 0) {
          setConnectedDevice(null)
          setDevices((prev) => prev.map((d) => ({ ...d, is_connected: false })))
          // Also clear the WiFi tunnel list so the 連線 page doesn't keep
          // showing a device that was just disconnected (issue: right-click
          // disconnect left the tunnel chip showing "still connected").
          setTunnels([])
        } else {
          setDevices((prev) => prev.map((d) => udids.includes(d.udid) ? { ...d, is_connected: false } : d))
          setTunnels((prev) => prev.filter((tn) => !udids.includes(tn.udid)))
          // DON'T null out connectedDevice here. The authoritative refresh
          // below (listDevices) will pick a surviving device to promote
          // so downstream UI (MapView / StatusBar) doesn't flash
          // 'No device' in dual-device mode when only one was unplugged.
        }
        // Re-fetch so the sidebar list and metadata stay in sync with the
        // backend, AND promote a surviving connected device as the new
        // active one when the old primary was the one unplugged. This
        // fixes the bug where unplugging A (primary) in dual-device mode
        // made the UI think no device was connected even though B was
        // still alive.
        listDevices().then((list) => {
          setDevices(list)
          setConnectedDevice((prev) => {
            // Keep the current one if it's still connected.
            if (prev && list.some((d) => d.udid === prev.udid && d.is_connected)) return prev
            // Otherwise promote the first surviving connected device.
            return list.find((d) => d.is_connected) ?? null
          })
        }).catch(() => {})
      } else if (msg.type === 'device_connected') {
        // Re-fetch list so the newly-connected device appears with correct metadata.
        listDevices().then((list) => {
          setDevices(list)
          // If nothing is currently set as the active device, promote the
          // newly-connected one so the bottom panel switches off NODEVICE
          // without the user having to press the USB button.
          const udid = msg.data?.udid
          const match = udid ? list.find((d) => d.udid === udid && d.is_connected) : null
          setConnectedDevice((prev) => prev ?? match ?? list.find((d) => d.is_connected) ?? null)
        }).catch(() => {})
      } else if (msg.type === 'device_reconnected') {
        listDevices().then((list) => {
          setDevices(list)
          const udid = msg.data?.udid
          const match = udid ? list.find((d) => d.udid === udid) : null
          setConnectedDevice(match ?? list.find((d) => d.is_connected) ?? null)
        }).catch(() => {})
      }
    })
  }, [subscribe])
  const [scanning, setScanning] = useState(false)
  const [wifiScanning, setWifiScanning] = useState(false)
  const [wifiDevices, setWifiDevices] = useState<WifiScanResult[]>([])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const result = await listDevices()
      const list: DeviceInfo[] = Array.isArray(result) ? result : []
      setDevices(list)
      const active = list.find((d) => d.is_connected) ?? null
      if (active) {
        setConnectedDevice(active)
      } else if (list.length === 1) {
        // Auto-connect when exactly one device is found
        try {
          await connectDevice(list[0].udid)
          const refreshed = await listDevices()
          const rList: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
          setDevices(rList)
          setConnectedDevice(rList.find((d) => d.udid === list[0].udid) ?? list[0])
        } catch {
          setConnectedDevice(null)
        }
      } else {
        setConnectedDevice(null)
      }
      return list
    } catch (err) {
      console.error('Failed to scan devices:', err)
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const connect = useCallback(
    async (udid: string) => {
      try {
        await connectDevice(udid)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        const active = list.find((d) => d.udid === udid) ?? null
        setConnectedDevice(active)
        return active
      } catch (err) {
        console.error('Failed to connect device:', err)
        throw err
      }
    },
    [],
  )

  const disconnect = useCallback(
    async (udid: string) => {
      try {
        await disconnectDevice(udid)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        // Only the named device was disconnected — DON'T blanket-null the
        // active device. In dual/triple mode that made the whole UI flip to
        // "NO device" even though the other iPhones were still connected.
        // Keep the current active device if it survived; otherwise promote
        // any remaining connected one; null only when nothing is left.
        setConnectedDevice((prev) => {
          if (prev && prev.udid !== udid && list.some((d) => d.udid === prev.udid && d.is_connected)) return prev
          return list.find((d) => d.is_connected) ?? null
        })
        setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
      } catch (err) {
        console.error('Failed to disconnect device:', err)
        throw err
      }
    },
    [],
  )

  const connectWifi = useCallback(
    async (ip: string) => {
      try {
        const res = await wifiConnect(ip)
        const info: DeviceInfo = {
          udid: res.udid,
          name: res.name,
          ios_version: res.ios_version,
          connection_type: 'Network',
          is_connected: true,
        }
        setConnectedDevice(info)
        setDevices((prev) => {
          const filtered = prev.filter((d) => d.udid !== info.udid)
          return [...filtered, info]
        })
        return info
      } catch (err) {
        console.error('WiFi connect failed:', err)
        throw err
      }
    },
    [],
  )

  const scanWifi = useCallback(async () => {
    setWifiScanning(true)
    try {
      const results = await wifiScan()
      const list: WifiScanResult[] = Array.isArray(results) ? results : []
      setWifiDevices(list)
      return list
    } catch (err) {
      console.error('WiFi scan failed:', err)
      return []
    } finally {
      setWifiScanning(false)
    }
  }, [])

  // v0.2.83: WiFi tunnel state went from a singleton to a per-device list.
  // Each connected iOS 17+ WiFi device gets its own runner on the backend;
  // `tunnels` mirrors that list. `tunnelStatus` is kept as a derived
  // singleton (mirrors first tunnel) for any leftover single-tunnel callers
  // until they migrate.
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const tunnelStatus = tunnels.length > 0
    ? { running: true, rsd_address: tunnels[0].rsd_address, rsd_port: tunnels[0].rsd_port }
    : { running: false }

  // ── Pin & auto-reconnect (issue #33) ──────────────────────────────
  // A pinned device keeps trying to reconnect on its own after the
  // backend watchdog gives up (tunnel_lost). The backend already retries
  // 3x with backoff for transient blips; this covers the longer outages
  // (phone opened late, left the WiFi for a while) the user has to fix by
  // hand today. State is persisted so a pin survives an app restart.
  const PIN_KEY = 'locwarp.tunnel.pinned'
  const readPinned = (): string[] => {
    try {
      const arr = JSON.parse(localStorage.getItem(PIN_KEY) || '[]')
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
    } catch { return [] }
  }
  const [pinnedUdids, setPinnedUdids] = useState<string[]>(readPinned)
  const pinnedRef = useRef<string[]>(pinnedUdids)
  pinnedRef.current = pinnedUdids
  const tunnelsRef = useRef<TunnelInfo[]>(tunnels)
  tunnelsRef.current = tunnels
  const pinRetryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // Set after startWifiTunnel is defined below; the retry loop calls
  // through the ref so we avoid a definition-order cycle.
  const startWifiTunnelRef = useRef<((ip: string, port?: number, udidHint?: string) => Promise<any>) | null>(null)

  const clearPinRetry = useCallback((udid: string) => {
    const tmr = pinRetryTimers.current[udid]
    if (tmr) { clearTimeout(tmr); delete pinRetryTimers.current[udid] }
  }, [])

  // Newest saved address for a device, without waiting on the host-prefix
  // probe. Used by togglePin, which runs inside a setState updater.
  const readSavedEntryFor = (udid: string): { ip: string; port: number } | null => {
    const hit = readSavedIps()
      .filter((e) => e.udid === udid)
      .sort((a, b) => b.lastUsed - a.lastUsed)[0]
    return hit ? { ip: hit.ip, port: hit.port } : null
  }

  // Addresses to retry a pinned device on, best first. A phone can be saved
  // under several LANs (home / office / hotspot), so we keep only the ones
  // whose prefix matches the network this PC is on right now, newest first
  // (issue #48). Unknown host prefix leaves every saved address in play.
  const readSavedEntriesFor = async (udid: string): Promise<SavedTunnelIp[]> => {
    const mine = readSavedIps().filter((e) => e.udid === udid)
    if (mine.length === 0) return []
    const prefix = await getHostPrefix()
    return savedIpsForPrefix(mine, prefix)
  }

  const schedulePinReconnect = useCallback((udid: string, delayMs = 5000) => {
    if (pinRetryTimers.current[udid]) return // already scheduled
    const attempt = async () => {
      delete pinRetryTimers.current[udid]
      // Stop if the user unpinned, or the tunnel already came back.
      if (!pinnedRef.current.includes(udid)) return
      if (tunnelsRef.current.some((tn) => tn.udid === udid)) return
      const entries = await readSavedEntriesFor(udid)
      for (const entry of entries) {
        if (!startWifiTunnelRef.current) break
        // Re-check between attempts: the user may have unpinned, or an
        // earlier candidate's tunnel may have come up meanwhile.
        if (!pinnedRef.current.includes(udid)) return
        if (tunnelsRef.current.some((tn) => tn.udid === udid)) return
        try {
          await startWifiTunnelRef.current(entry.ip, entry.port, udid)
          return // success path clears the timer via startWifiTunnel
        } catch { /* try the next saved address, then reschedule */ }
      }
      if (pinnedRef.current.includes(udid) && !tunnelsRef.current.some((tn) => tn.udid === udid)) {
        pinRetryTimers.current[udid] = setTimeout(attempt, 15000)
      }
    }
    pinRetryTimers.current[udid] = setTimeout(attempt, delayMs)
  }, [])

  const PIN_IP_MAP_KEY = 'locwarp.tunnel.pin_ip_map'

  const togglePin = useCallback((udid: string) => {
    setPinnedUdids((prev) => {
      const next = prev.includes(udid) ? prev.filter((u) => u !== udid) : [...prev, udid]
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      if (!next.includes(udid)) {
        clearPinRetry(udid)
        // Remove IP mapping when unpinning so the device is no longer
        // auto-connected on next startup (issue #35).
        try {
          const map = JSON.parse(localStorage.getItem(PIN_IP_MAP_KEY) || '{}')
          delete map[udid]
          localStorage.setItem(PIN_IP_MAP_KEY, JSON.stringify(map))
        } catch { /* ignore */ }
      } else {
        // Save last known IP when pinning so startup auto-connect can
        // filter to pinned devices only (issue #35).
        const entry = readSavedEntryFor(udid)
        if (entry) {
          try {
            const map = JSON.parse(localStorage.getItem(PIN_IP_MAP_KEY) || '{}')
            map[udid] = `${entry.ip}:${entry.port}`
            localStorage.setItem(PIN_IP_MAP_KEY, JSON.stringify(map))
          } catch { /* ignore */ }
        }
      }
      return next
    })
  }, [clearPinRetry])

  // Drive pin retries off the tunnel lifecycle events. Kept separate from
  // the panel-state handler above so ordering / deps stay simple.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'tunnel_lost') {
        const udid = msg.data?.udid
        if (udid && pinnedRef.current.includes(udid)) schedulePinReconnect(udid)
      } else if (msg.type === 'tunnel_recovered' || msg.type === 'device_connected') {
        const udid = msg.data?.udid
        if (udid) clearPinRetry(udid)
      }
    })
  }, [subscribe, schedulePinReconnect, clearPinRetry])

  // React to backend tunnel lifecycle events so the DeviceStatus panel
  // doesn't keep showing a dead tunnel as connected when the iPhone
  // leaves the WiFi network. Without this, the `tunnels` list is only
  // mutated by explicit Start / Stop button clicks — issue #29.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'tunnel_lost') {
        const udid = msg.data?.udid
        if (udid) {
          setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
          setDevices((prev) => prev.map((d) =>
            d.udid === udid && d.connection_type === 'Network'
              ? { ...d, is_connected: false }
              : d,
          ))
        } else {
          // No udid in the payload — fall back to a full re-query so
          // we never leave a phantom tunnel chip in the panel.
          wifiTunnelStatus().then((res) => {
            setTunnels(Array.isArray(res?.tunnels) ? res.tunnels : [])
          }).catch(() => setTunnels([]))
        }
      } else if (msg.type === 'tunnel_recovered') {
        const udid = msg.data?.udid
        const rsd_address = msg.data?.rsd_address
        const rsd_port = msg.data?.rsd_port
        if (udid && rsd_address && typeof rsd_port === 'number') {
          setTunnels((prev) => {
            const filtered = prev.filter((tn) => tn.udid !== udid)
            return [...filtered, { udid, rsd_address, rsd_port }]
          })
        }
      }
    })
  }, [subscribe])

  const startWifiTunnel = useCallback(
    async (ip: string, port = 49152, udidHint?: string, portHints?: number[], skipConnected = false) => {
      try {
        const res = await wifiTunnelStartAndConnect(ip, port, udidHint, portHints, skipConnected)
        // The backend left an already-connected phone as it was, so there
        // is nothing to record: marking it Network, adding a tunnel chip
        // or saving the IP would all misdescribe a USB phone.
        if (res?.status === 'already_connected') {
          return { status: 'already_connected' as const, udid: String(res.udid) }
        }
        // The backend re-scans and may land on a different port than the one
        // we asked for (iOS re-picks RemotePairing on every boot). Remember
        // what actually worked, not what we guessed.
        const usedPort = Number(res.port) > 0 ? Number(res.port) : port
        const info: DeviceInfo = {
          udid: res.udid,
          name: res.name,
          ios_version: res.ios_version,
          connection_type: 'Network',
          is_connected: true,
        }
        setConnectedDevice(info)
        setDevices((prev) => {
          const filtered = prev.filter((d) => d.udid !== info.udid)
          return [...filtered, info]
        })
        setTunnels((prev) => {
          const filtered = prev.filter((tn) => tn.udid !== res.udid)
          return [...filtered, {
            udid: res.udid,
            rsd_address: res.rsd_address,
            rsd_port: res.rsd_port,
          }]
        })
        // Persist every successful tunnel into savedips, regardless of
        // who initiated it (manual button, launch auto-connect, mDNS
        // discover-and-connect). Without this, an iPhone that was
        // connected via auto-discovery never gets remembered, and the
        // next launch only auto-connects whichever iPhone the user once
        // manually clicked through. v0.2.110 bug surfaced when a user
        // with two iPhones only had one of them in savedips.
        // Dedup is by (ip, port) and by (udid, LAN prefix): a phone that
        // got a new DHCP address on the same WiFi replaces its old entry,
        // while the same phone on another WiFi is kept alongside it so
        // switching networks doesn't erase the other one (issue #48).
        // The device name rides along so the panel can keep showing the
        // real phone name after a drop instead of a raw UDID (issue #33).
        upsertSavedIp({ ip, port: usedPort, udid: res.udid, name: res.name })
        // A successful connect clears any pending pin-retry for this device.
        clearPinRetry(res.udid)
        return { ...info, port: usedPort, status: 'connected' as const }
      } catch (err) {
        console.error('WiFi tunnel failed:', err)
        throw err
      }
    },
    [],
  )
  // Expose the latest startWifiTunnel to the pin-retry loop without making
  // it a hook dependency (the callback is stable, deps: []).
  startWifiTunnelRef.current = startWifiTunnel

  const devicesRef = useRef(devices)
  devicesRef.current = devices

  /**
   * Launch auto-connect ('auto') or the 掃描 WiFi 裝置 button ('scan'): find
   * iPhones on this LAN and open a WiFi tunnel to each one that is not
   * connected yet, as many at once as the device cap still allows. Phones
   * that are already connected are never touched.
   *
   * 'auto' honours pins (issue #35) and looks with mDNS only: a pass the
   * user did not ask for must never scan the LAN (issue #49). 'scan'
   * ignores pins and may fall back to the LAN scan, because the user
   * pressed a button for it.
   */
  const findAndConnectWifi = useCallback(async (mode: ConnectMode) => {
    const pinned = pinnedRef.current
    const [status, hostPrefix, discovered] = await Promise.all([
      wifiTunnelStatus().catch(() => null),
      getHostPrefix(),
      needsDiscovery(mode, pinned)
        ? wifiTunnelDiscover({ scan: mode === 'scan' })
          .then((r): DiscoveredInput[] => r?.devices || [])
          // Saved addresses still get tried.
          .catch((): DiscoveredInput[] => [])
        : Promise.resolve<DiscoveredInput[]>([]),
    ])
    // Saved addresses, plus the single-IP keys from builds that predate
    // the saved list.
    let saved = readSavedIps()
    if (saved.length === 0) {
      try {
        const ip = (localStorage.getItem('locwarp.tunnel.ip') || '').trim()
        if (ip) saved = [{ ip, port: parseInt(localStorage.getItem('locwarp.tunnel.port') || '49152', 10) || 49152, lastUsed: 0 }]
      } catch { /* ignore */ }
    }
    const connectedOf = () => devicesRef.current.filter((d) => d.is_connected).map((d) => d.udid)
    const connectedUdids = connectedOf()
    const candidates = wifiCandidates({
      mode,
      savedIps: savedIpsForPrefix(saved, hostPrefix),
      discovered,
      connectedUdids,
      tunnelIps: (status?.tunnels || []).map((tn) => tn.target_ip).filter((x): x is string => !!x),
      pinnedUdids: pinned,
    })
    type Result = { sources: CandidateSource[]; outcome: CandidateOutcome; udid?: string }
    const results = await fillFreeSlots(candidates, connectedUdids.length, async (c): Promise<Result> => {
      try {
        const r = await startWifiTunnel(c.ip, c.ports[0], c.udid, c.ports.slice(1), true)
        return { sources: c.sources, outcome: r.status, udid: r.udid }
      } catch {
        return { sources: c.sources, outcome: 'failed' }
      }
    })
    // Counted at the end rather than "before + new": a USB phone may have
    // been plugged in meanwhile, and this pass's own connections may not
    // have rendered into devicesRef yet.
    const after = new Set(connectedOf())
    for (const r of results) if (r.outcome === 'connected' && r.udid) after.add(r.udid)
    return { ...tallyWifiResults(results), connectedAfter: after.size, tried: results.length }
  }, [startWifiTunnel])

  const checkTunnelStatus = useCallback(async () => {
    try {
      const res = await wifiTunnelStatus()
      setTunnels(Array.isArray(res?.tunnels) ? res.tunnels : [])
      return res
    } catch {
      setTunnels([])
      return { tunnels: [], running: false }
    }
  }, [])

  // udid: stop one specific tunnel; omit to stop all.
  const stopTunnel = useCallback(async (udid?: string) => {
    try {
      await wifiTunnelStop(udid)
      if (udid) {
        setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
      } else {
        setTunnels([])
      }
    } catch (err) {
      console.error('Failed to stop tunnel:', err)
    }
  }, [])

  // Group-mode derived state: every device in `devices` marked is_connected.
  // `primaryDevice` sticks to whichever device we picked first; we only
  // promote a new one when the current sticky primary is no longer in the
  // connected slice. Without stickiness, listDevices()'s order on a
  // mid-session reconnect can swap primary back to the just-rejoined
  // device, which then receives the auto-sync replay (a fresh sim from
  // its current position) and the frontend lets that REPLAY's events
  // through the udid filter, overwriting the surviving device's polyline
  // and "瞬移回起點 / 慢慢走回起點" on screen. Sticky primary keeps the
  // surviving device in charge so the rejoining one's replay stays
  // filtered out and invisible until the user explicitly chooses to
  // switch.
  const connectedDevices: DeviceInfo[] = devices.filter((d) => d.is_connected)
  const [stickyPrimaryUdid, setStickyPrimaryUdid] = useState<string | null>(null)
  useEffect(() => {
    if (connectedDevices.length === 0) {
      if (stickyPrimaryUdid !== null) setStickyPrimaryUdid(null)
      return
    }
    if (stickyPrimaryUdid && connectedDevices.some((d) => d.udid === stickyPrimaryUdid)) {
      return
    }
    setStickyPrimaryUdid(connectedDevices[0].udid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])
  const primaryDevice: DeviceInfo | null =
    devices.find((d) => d.udid === stickyPrimaryUdid && d.is_connected) ?? null

  return {
    devices, connectedDevice, scanning, scan, connect, disconnect,
    connectWifi, scanWifi, wifiScanning, wifiDevices,
    startWifiTunnel, findAndConnectWifi, checkTunnelStatus, stopTunnel, tunnelStatus, tunnels,
    connectedDevices, primaryDevice,
    pinnedUdids, togglePin,
  }
}
