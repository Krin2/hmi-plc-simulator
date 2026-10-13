/**
 * Physical model of the process: a tank filled by a pump and drained through a valve by the
 * consumer. It knows nothing about the PLC; it only reacts to the pump command and the valve.
 */

export interface ProcessState {
  /** Real liquid level, 0-100 % of the tank height */
  levelPct: number
  /** Pump speed, 0 (stopped) to 1 (full speed). It ramps instead of jumping. */
  pumpSpeed: number
}

export interface ProcessInputs {
  pumpCmd: boolean
  /** Injected fault: the pump cannot run even if commanded */
  pumpFault: boolean
  /** Outlet valve opening set by the operator, 0-100 % */
  outletOpenPct: number
}

/** Level rise per second with the pump at full speed (%/s) */
export const INFLOW_PCT_PER_S = 3.2
/** Level drop per second through a fully open valve at 100 % level (%/s) */
export const OUTFLOW_PCT_PER_S = 3.0
/** The pump reaches ~63 % of its speed after this many seconds */
export const PUMP_TIME_CONSTANT_S = 1
/** Above this speed the pump auxiliary contact reports "running" */
export const PUMP_RUNNING_SPEED = 0.9

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const initialProcess = (levelPct = 50): ProcessState => ({ levelPct, pumpSpeed: 0 })

export const isPumpRunning = (state: ProcessState) => state.pumpSpeed >= PUMP_RUNNING_SPEED

export function stepProcess(
  state: ProcessState,
  input: ProcessInputs,
  dtSec: number,
): ProcessState {
  const target = input.pumpCmd && !input.pumpFault ? 1 : 0
  const pumpSpeed =
    state.pumpSpeed + (target - state.pumpSpeed) * (1 - Math.exp(-dtSec / PUMP_TIME_CONSTANT_S))

  const inflow = pumpSpeed * INFLOW_PCT_PER_S
  // Torricelli: the outflow grows with the square root of the liquid height
  const outflow =
    (clamp(input.outletOpenPct, 0, 100) / 100) *
    OUTFLOW_PCT_PER_S *
    Math.sqrt(Math.max(state.levelPct, 0) / 100)

  return {
    pumpSpeed,
    levelPct: clamp(state.levelPct + (inflow - outflow) * dtSec, 0, 100),
  }
}

/** Value the PLC sees from the level transmitter: a little noise, or a broken wire (< 4 mA). */
export function measureLevel(levelPct: number, sensorFault: boolean, tick: number): number {
  if (sensorFault) return -5
  // Deterministic pseudo-noise (about +/- 0.15 %), so runs are reproducible
  const noise = Math.sin(tick * 12.9898) * 43758.5453
  return levelPct + (noise - Math.floor(noise) - 0.5) * 0.3
}
