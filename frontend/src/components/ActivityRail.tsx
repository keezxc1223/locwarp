/**
 * ActivityRail — 52px icon-based left navigation rail
 *
 * Three panel toggles: control / device / tools.
 * Clicking the active panel closes it (toggle behavior).
 * A green indicator dot on the device icon when a device is connected.
 */
import React from 'react'
import { useT, type StringKey } from '../i18n'

export type PanelId = 'control' | 'device' | 'tools'

interface RailItem {
  id: PanelId
  icon: string
  labelKey: StringKey
}

// Labels go through i18n so English users see "Control / Device / Tools"
// instead of the original hard-coded Chinese.
const ITEMS: RailItem[] = [
  { id: 'control', icon: '🕹️', labelKey: 'rail.control' },
  { id: 'device',  icon: '📱', labelKey: 'rail.device' },
  { id: 'tools',   icon: '🛠️', labelKey: 'rail.tools' },
]

interface ActivityRailProps {
  activePanel: PanelId | null
  onToggle: (panel: PanelId) => void
  deviceConnected: boolean
}

const ActivityRail: React.FC<ActivityRailProps> = ({
  activePanel,
  onToggle,
  deviceConnected,
}) => {
  const t = useT()
  return (
    <div className="activity-rail">
      {ITEMS.map(item => {
        const label = t(item.labelKey)
        return (
          <button
            key={item.id}
            className={`rail-btn${activePanel === item.id ? ' rail-btn--active' : ''}`}
            onClick={() => onToggle(item.id)}
            title={label}
            aria-pressed={activePanel === item.id}
          >
            <span className="rail-btn-icon">{item.icon}</span>
            <span className="rail-btn-label">{label}</span>
            {item.id === 'device' && deviceConnected && (
              <span className="rail-btn-dot" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}

export default ActivityRail
