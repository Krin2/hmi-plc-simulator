import type { Timer } from './types'

export const newTimer = (): Timer => ({ elapsedMs: 0, done: false })

/**
 * TON (on-delay timer): accumulates time while `enable` is true and sets `done` when the
 * preset is reached. Any scan with `enable` false resets it, like the IEC 61131-3 function block.
 */
export function ton(timer: Timer, enable: boolean, presetMs: number, dtMs: number): Timer {
  if (!enable) return newTimer()
  const elapsedMs = Math.min(presetMs, timer.elapsedMs + dtMs)
  return { elapsedMs, done: elapsedMs >= presetMs }
}
