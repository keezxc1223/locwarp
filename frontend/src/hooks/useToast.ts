/**
 * useToast — single-slot transient message with auto-dismiss.
 *
 * Model: at most one toast on screen at a time. A new `show()` call
 * replaces the current message (and resets its timer), matching how a
 * user expects feedback to work — they just triggered something, they
 * want to see *that* result, not the previous one.
 *
 * The timer is tracked via ref (not state) so re-renders don't reset it,
 * and is cleared on unmount to avoid the "setState on unmounted component"
 * warning from a stale setTimeout.
 *
 * Extracted from App.tsx where 10+ call sites inline-called the same
 * `setToastMsg + setTimeout` dance.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_DURATION_MS = 2000

interface UseToastReturn {
  message: string | null
  show: (msg: string, ms?: number) => void
  clear: () => void
}

export function useToast(): UseToastReturn {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setMessage(null)
  }, [])

  const show = useCallback((msg: string, ms: number = DEFAULT_DURATION_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setMessage(msg)
    timerRef.current = setTimeout(() => {
      setMessage(null)
      timerRef.current = null
    }, ms)
  }, [])

  // Unmount safety — prevents the setTimeout callback from firing setState
  // after the component is gone (React dev-mode warning).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { message, show, clear }
}
