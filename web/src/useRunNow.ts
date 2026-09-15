import { useCallback, useEffect, useRef, useState } from 'react'
import { apiPost } from './api'
import type { RunStartedResponse } from '@shared/apiTypes'

export interface RunNowState {
  run: () => void
  busy: boolean
  toast: { msg: string; err: boolean } | null
}

/**
 * Shared "Run now" action (Status page's Scheduler card, and the Dashboard's
 * empty state for a configuration nothing has been fetched for yet). Guards
 * against a double-click firing two POSTs, and clears its toast timeout on
 * unmount so nothing writes state into an unmounted component.
 */
export function useRunNow(onSettled?: () => void): RunNowState {
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  useEffect(
    () => () => {
      aliveRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const run = useCallback(() => {
    if (busy) return
    setBusy(true)
    apiPost<RunStartedResponse>('/api/run')
      .then(() => {
        if (aliveRef.current) setToast({ msg: 'cycle started', err: false })
      })
      .catch((e: unknown) => {
        const err = e as { status?: number; message: string }
        if (aliveRef.current) {
          setToast({ msg: err.status === 409 ? 'a cycle is already running' : `failed: ${err.message}`, err: true })
        }
      })
      .finally(() => {
        if (!aliveRef.current) return
        setBusy(false)
        onSettled?.()
        timerRef.current = setTimeout(() => {
          if (aliveRef.current) setToast(null)
        }, 3500)
      })
  }, [busy, onSettled])

  return { run, busy, toast }
}
