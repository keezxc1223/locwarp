// Group-mode device slots. Every place that caps the device count or labels
// a device by letter / colour reads from here, so raising the cap is a
// one-line change. The backend enforces the same cap (api/device.py
// MAX_DEVICES).

export const MAX_DEVICES = 5

export const DEVICE_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const

export type DeviceLetter = typeof DEVICE_LETTERS[number]

export const DEVICE_COLORS: Record<DeviceLetter, string> = {
  A: '#4285f4',
  B: '#ff9800',
  C: '#9c6ade',
  D: '#2bb673',
  E: '#e8578a',
}

/** Letter for the device at `slot` (its index in connection order). */
export function deviceLetter(slot: number): DeviceLetter | undefined {
  return DEVICE_LETTERS[slot]
}
