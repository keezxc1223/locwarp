export interface LocatePcResult {
  ok: boolean
  lat?: number
  lng?: number
  accuracy?: number
  via?: 'windows' | 'ipwho.is' | 'ipapi.co' | 'freeipapi.com'
  code?: 'DENIED' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'SPAWN_FAILED' | 'NODATA' | 'ALL_FAILED'
  message?: string
}

export type RenderMode = 'hardware' | 'software'

export interface RenderModeInfo {
  mode: RenderMode
  saved: RenderMode | null
  isWin10: boolean
}

export type UpdateStatusEvent =
  | { phase: 'downloading'; percent: number; transferred: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

declare global {
  interface Window {
    electronAPI?: {
      locatePc(): Promise<LocatePcResult>
      getRenderMode(): Promise<RenderModeInfo>
      setRenderMode(mode: RenderMode): Promise<{ ok: boolean }>
      relaunchApp(): Promise<void>
      updateSupported?(): Promise<boolean>
      updateDownload?(): Promise<{ ok: boolean; version?: string; code?: 'UNSUPPORTED' | 'NO_UPDATE' | 'ERROR'; message?: string }>
      updateInstall?(): Promise<{ ok: boolean }>
      onUpdateStatus?(cb: (s: UpdateStatusEvent) => void): () => void
    }
  }
}

export {}
