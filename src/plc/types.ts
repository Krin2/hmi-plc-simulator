export type Mode = 'auto' | 'manual'

export type AlarmId =
  | 'levelHighHigh'
  | 'levelHigh'
  | 'levelLow'
  | 'levelLowLow'
  | 'pumpFailToStart'
  | 'sensorFault'
  | 'eStop'

export interface AlarmDefinition {
  id: AlarmId
  /** Tag-style description shown to the operator */
  label: string
  /** 1 = critical (needs immediate action), 2 = warning */
  priority: 1 | 2
}

export const ALARM_DEFINITIONS: AlarmDefinition[] = [
  { id: 'eStop', label: 'Emergency stop activated', priority: 1 },
  { id: 'sensorFault', label: 'Level sensor failure (signal lost)', priority: 1 },
  { id: 'pumpFailToStart', label: 'Pump P-101 failed to run', priority: 1 },
  { id: 'levelHighHigh', label: 'Tank T-101 level high-high', priority: 1 },
  { id: 'levelHigh', label: 'Tank T-101 level high', priority: 2 },
  { id: 'levelLow', label: 'Tank T-101 level low', priority: 2 },
  { id: 'levelLowLow', label: 'Tank T-101 level low-low', priority: 1 },
]

export interface PlcConfig {
  /** Auto mode starts the pump at or below this level (% of tank height) */
  startLevel: number
  /** Auto mode stops the pump at or above this level */
  stopLevel: number
  thresholds: { highHigh: number; high: number; low: number; lowLow: number }
  /**
   * Deadband of the level switches (% of tank height): a switch that has turned ON only turns
   * OFF once the level is this far back inside the limit, so noise at the limit does not make
   * the indication and the alarms flicker.
   */
  levelDeadbandPct: number
  /** The pump must report "running" within this time after being commanded */
  pumpFailDelayMs: number
  /** A level signal outside this range means a broken wire or a dead transmitter */
  sensorRange: { min: number; max: number }
}

export const DEFAULT_PLC_CONFIG: PlcConfig = {
  startLevel: 35,
  stopLevel: 75,
  thresholds: { highHigh: 95, high: 85, low: 15, lowLow: 5 },
  levelDeadbandPct: 1,
  pumpFailDelayMs: 3000,
  sensorRange: { min: -1, max: 101 },
}

/** Field signals read by the PLC at the start of every scan */
export interface PlcInputs {
  /** Level transmitter, 0-100 % */
  levelPct: number
  /** Pump running feedback (auxiliary contact) */
  pumpRunning: boolean
  /** Emergency stop circuit: true while healthy (normally-closed contact) */
  eStopHealthy: boolean
  autoSelected: boolean
  /** Manual mode: open the inlet (run pump P-101) / close it */
  startPb: boolean
  stopPb: boolean
  /** Manual mode: open / close the outlet valve XV-101 */
  openOutletPb: boolean
  closeOutletPb: boolean
  ackPb: boolean
  resetPb: boolean
}

/** Signals written by the PLC at the end of every scan */
export interface PlcOutputs {
  /** Inlet: pump P-101 running command */
  pumpCmd: boolean
  /** Outlet: valve XV-101 is allowed to open (false = shut) */
  outletOpen: boolean
  horn: boolean
}

/** What is holding a flow closed, in order of priority */
export type BlockReason = 'sensor-fault' | 'e-stop' | 'level-hh' | 'level-ll' | 'pump-lockout'

export interface Timer {
  elapsedMs: number
  /** "Done" bit: the preset time has been reached */
  done: boolean
}

export interface AlarmState {
  /** The abnormal condition is present right now */
  active: boolean
  /** The operator has seen the latest occurrence */
  acked: boolean
  /** Time of the latest activation, in ms of PLC time */
  since: number | null
}

export interface PlcState {
  /** Elapsed PLC time in ms */
  time: number
  /** Inputs of the previous scan, for rising-edge detection */
  prev: {
    startPb: boolean
    stopPb: boolean
    openOutletPb: boolean
    closeOutletPb: boolean
    ackPb: boolean
    resetPb: boolean
  }
  /** Mode and outputs of the previous scan (the pump feedback is compared against them) */
  auto: boolean
  pumpCmd: boolean
  outletOpen: boolean
  eStopLatched: boolean
  pumpLockout: boolean
  /** Level cut-offs with hysteresis: HH closes the inlet until the level is back below H,
   *  LL closes the outlet until the level is back above L */
  hhCutoff: boolean
  llCutoff: boolean
  /** Level switches with deadband (they drive the level alarms and the HMI marks) */
  switches: { highHigh: boolean; high: boolean; low: boolean; lowLow: boolean }
  autoDemand: boolean
  manualRun: boolean
  manualOutletOpen: boolean
  pumpFailTimer: Timer
  alarms: Record<AlarmId, AlarmState>
}

/** One line of the program with its current state, for the logic viewer */
export interface Rung {
  id: string
  label: string
  logic: string
  energized: boolean
  detail?: string
}

export interface ScanResult {
  state: PlcState
  outputs: PlcOutputs
  rungs: Rung[]
  /** Why the inlet and the outlet are being held closed (null = free to open) */
  blocks: { inlet: BlockReason | null; outlet: BlockReason | null }
  /** Level switches: lit while the level is beyond the limit */
  levelSwitches: { highHigh: boolean; high: boolean; low: boolean; lowLow: boolean }
}
