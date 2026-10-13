import { useEffect, useSyncExternalStore } from 'react'
import { TICK_MS, type Simulator } from './simulator'

export function useSimulator(simulator: Simulator) {
  return useSyncExternalStore(simulator.subscribe, simulator.getSnapshot)
}

/** Keeps most catch-up work bounded after the tab was in the background */
const MAX_TICKS_PER_FRAME = 50

/**
 * Runs the simulation in real time. Timers are throttled in background tabs, so each callback
 * runs as many ticks as the elapsed time requires (up to a limit) and the speed stays right.
 */
export function useSimulationClock(simulator: Simulator, running: boolean, speed: number) {
  useEffect(() => {
    if (!running) return

    let last = performance.now()
    let owed = 0
    const id = setInterval(() => {
      const now = performance.now()
      owed += ((now - last) * speed) / TICK_MS
      last = now
      const ticks = Math.min(MAX_TICKS_PER_FRAME, Math.floor(owed))
      owed -= ticks
      if (owed > MAX_TICKS_PER_FRAME) owed = 0 // drop the backlog instead of racing to catch up
      for (let i = 0; i < ticks; i++) simulator.tick()
    }, TICK_MS / 2)

    return () => clearInterval(id)
  }, [simulator, running, speed])
}
