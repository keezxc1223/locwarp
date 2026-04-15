import { DeviceChip } from './DeviceChip'
import { useT } from '../i18n'
import type { DeviceInfo } from '../hooks/useDevice'
import type { RuntimesMap } from '../hooks/useSimulation'

interface Props {
  devices: DeviceInfo[]           // connected devices in order (max 2)
  runtimes: RuntimesMap
  onAdd: () => void               // opens add-device picker
  onDisconnect: (udid: string) => void
  onRestoreOne: (udid: string) => void
  onEnableDev?: (udid: string) => void
}

export function DeviceChipRow({ devices, runtimes, onAdd, onDisconnect, onRestoreOne, onEnableDev }: Props) {
  const t = useT()
  const atMax = devices.length >= 2

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 10px 8px',
      flexWrap: 'wrap',
    }}>
      {devices.slice(0, 2).map((d, i) => {
        const letter = (i === 0 ? 'A' : 'B') as 'A' | 'B'
        return (
          <DeviceChip
            key={d.udid}
            letter={letter}
            device={d}
            runtime={runtimes[d.udid]}
            onDisconnect={() => onDisconnect(d.udid)}
            onRestoreOne={() => onRestoreOne(d.udid)}
            onEnableDev={onEnableDev ? () => onEnableDev(d.udid) : undefined}
          />
        )
      })}
      {!atMax && (
        <button
          onClick={onAdd}
          title={devices.length === 0 ? t('device.add_device') : t('device.add_device')}
          style={{
            height: 24, minWidth: 24, padding: '0 8px',
            borderRadius: 12,
            border: '1px dashed rgba(255,255,255,0.25)',
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.75)',
            fontSize: 11, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
          {devices.length === 0 && <span>{t('device.add_device')}</span>}
        </button>
      )}
    </div>
  )
}
