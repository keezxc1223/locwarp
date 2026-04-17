import { useState, useCallback, useEffect } from 'react'
import {
  listDevices, connectDevice, disconnectDevice,
  wifiConnect, wifiScan,
  wifiTunnelStartAndConnect, wifiTunnelStatus, wifiTunnelStop,
} from '../services/api'
import type { WsMessage } from './useWebSocket'

export interface DeviceInfo {
  udid: string
  name: string
  ios_version: string
  connection_type: string
  is_connected: boolean
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
        } else {
          setDevices((prev) => prev.map((d) => udids.includes(d.udid) ? { ...d, is_connected: false } : d))
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
        setConnectedDevice(null)
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

  const [tunnelStatus, setTunnelStatus] = useState<{ running: boolean; rsd_address?: string; rsd_port?: number }>({ running: false })

  const startWifiTunnel = useCallback(
    async (ip: string, port = 49152) => {
      try {
        const res = await wifiTunnelStartAndConnect(ip, port)
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
        setTunnelStatus({ running: true, rsd_address: res.rsd_address, rsd_port: res.rsd_port })
        return info
      } catch (err) {
        console.error('WiFi tunnel failed:', err)
        throw err
      }
    },
    [],
  )

  const checkTunnelStatus = useCallback(async () => {
    try {
      const res = await wifiTunnelStatus()
      setTunnelStatus(res)
      return res
    } catch {
      setTunnelStatus({ running: false })
      return { running: false }
    }
  }, [])

  const stopTunnel = useCallback(async () => {
    try {
      await wifiTunnelStop()
      setTunnelStatus({ running: false })
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
    startWifiTunnel, checkTunnelStatus, stopTunnel, tunnelStatus,
    connectedDevices, primaryDevice,
  }
}
