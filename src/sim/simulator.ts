import { initialPlcState, scan } from '../plc/program'
import {
  ALARM_DEFINITIONS,
  DEFAULT_PLC_CONFIG,
  type AlarmDefinition,
  type AlarmState,
  type Mode,
  type PlcConfig,
  type PlcState,
  type Rung,
} from '../plc/types'
import {
  initialProcess,
  isPumpRunning,
  measureLevel,
  stepProcess,
  type ProcessState,
} from '../process/tank'

/** PLC scan time and simulation step, in ms */
export const TICK_MS = 100
/** The trend keeps one sample every 500 ms, for the last two minutes */
const SAMPLE_EVERY_TICKS = 5
const MAX_SAMPLES = 240

export const MIN_SETPOINT_GAP = 10

export type Fault = 'pump' | 'sensor'

export type Command =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'ack' }
  | { type: 'reset' }
  | { type: 'setMode'; mode: Mode }
  | { type: 'setOutlet'; pct: number }
  | { type: 'setSetpoints'; startLevel: number; stopLevel: number }
  | { type: 'eStop'; pressed: boolean }
  | { type: 'fault'; fault: Fault; on: boolean }

export type CommandResult = { ok: true } | { ok: false; error: string }

export interface TrendSample {
  /** Simulation time in seconds */
  t: number
  level: number
  pumpRunning: boolean
}

export interface VisibleAlarm extends AlarmDefinition, AlarmState {}

export interface SimSnapshot {
  /** Simulation time in seconds */
  time: number
  mode: Mode
  /** Real level in the tank (what the process "is") */
  levelPct: number
  /** Level as the PLC reads it (noise, or a bad signal when the sensor has failed) */
  measuredLevel: number
  sensorFault: boolean
  pumpCmd: boolean
  pumpRunning: boolean
  pumpFaultInjected: boolean
  outletOpenPct: number
  eStopPressed: boolean
  horn: boolean
  config: PlcConfig
  /** Alarms that are active or still waiting for acknowledgement, most urgent first */
  alarms: VisibleAlarm[]
  rungs: Rung[]
  trend: TrendSample[]
}

/**
 * Connects the PLC program to the process model and the operator: every tick it builds the
 * PLC inputs from the field, runs one scan and applies the outputs to the process.
 */
export class Simulator {
  private plc: PlcState = initialPlcState()
  private process: ProcessState = initialProcess(50)
  private config: PlcConfig = structuredClone(DEFAULT_PLC_CONFIG)
  private ticks = 0
  private rungs: Rung[] = []
  private horn = false
  private measured = 50
  private trend: TrendSample[] = []

  private mode: Mode = 'auto'
  private outletOpenPct = 60
  private eStopPressed = false
  private pumpFault = false
  private sensorFault = false
  /** Push buttons are momentary: they stay "pressed" for exactly one scan */
  private pulses = { start: false, stop: false, ack: false, reset: false }

  private listeners = new Set<() => void>()
  private snapshot: SimSnapshot

  constructor() {
    this.measured = measureLevel(this.process.levelPct, false, 0)
    this.snapshot = this.buildSnapshot()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Stable between changes, as `useSyncExternalStore` requires */
  getSnapshot = (): SimSnapshot => this.snapshot

  command(command: Command): CommandResult {
    switch (command.type) {
      case 'start':
      case 'stop':
      case 'ack':
      case 'reset':
        this.pulses[command.type] = true
        break
      case 'setMode':
        this.mode = command.mode
        break
      case 'setOutlet':
        this.outletOpenPct = Math.min(100, Math.max(0, command.pct))
        break
      case 'setSetpoints': {
        const error = this.validateSetpoints(command.startLevel, command.stopLevel)
        if (error) return { ok: false, error }
        this.config = {
          ...this.config,
          startLevel: command.startLevel,
          stopLevel: command.stopLevel,
        }
        break
      }
      case 'eStop':
        this.eStopPressed = command.pressed
        break
      case 'fault':
        if (command.fault === 'pump') this.pumpFault = command.on
        else this.sensorFault = command.on
        break
    }
    this.publish()
    return { ok: true }
  }

  /** Advances the simulation by one scan (TICK_MS). */
  tick(): void {
    const { pulses } = this

    const result = scan(
      this.plc,
      {
        levelPct: this.measured,
        pumpRunning: isPumpRunning(this.process),
        eStopHealthy: !this.eStopPressed,
        autoSelected: this.mode === 'auto',
        startPb: pulses.start,
        stopPb: pulses.stop,
        ackPb: pulses.ack,
        resetPb: pulses.reset,
      },
      this.config,
      TICK_MS,
    )
    this.plc = result.state
    this.rungs = result.rungs
    this.horn = result.outputs.horn
    this.pulses = { start: false, stop: false, ack: false, reset: false }

    this.process = stepProcess(
      this.process,
      {
        pumpCmd: result.outputs.pumpCmd,
        pumpFault: this.pumpFault,
        outletOpenPct: this.outletOpenPct,
      },
      TICK_MS / 1000,
    )
    this.ticks++
    this.measured = measureLevel(this.process.levelPct, this.sensorFault, this.ticks)

    if (this.ticks % SAMPLE_EVERY_TICKS === 0) {
      this.trend = [
        ...this.trend.slice(-(MAX_SAMPLES - 1)),
        { t: this.time, level: this.process.levelPct, pumpRunning: isPumpRunning(this.process) },
      ]
    }
    this.publish()
  }

  /** Back to the initial state, keeping the operator's setpoints and mode. */
  reset(): void {
    this.plc = initialPlcState()
    this.process = initialProcess(50)
    this.ticks = 0
    this.rungs = []
    this.horn = false
    this.trend = []
    this.pulses = { start: false, stop: false, ack: false, reset: false }
    this.measured = measureLevel(this.process.levelPct, this.sensorFault, 0)
    this.publish()
  }

  private get time(): number {
    return (this.ticks * TICK_MS) / 1000
  }

  private validateSetpoints(startLevel: number, stopLevel: number): string | null {
    const { thresholds } = this.config
    if (!Number.isFinite(startLevel) || !Number.isFinite(stopLevel)) return 'Enter both setpoints.'
    if (startLevel <= thresholds.low || stopLevel >= thresholds.high) {
      return `Setpoints must stay between the low alarm (${thresholds.low}%) and the high alarm (${thresholds.high}%).`
    }
    if (stopLevel - startLevel < MIN_SETPOINT_GAP) {
      return `The stop level must be at least ${MIN_SETPOINT_GAP}% above the start level.`
    }
    return null
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot()
    this.listeners.forEach((listener) => listener())
  }

  private buildSnapshot(): SimSnapshot {
    const alarms = ALARM_DEFINITIONS.map((definition) => ({
      ...definition,
      ...this.plc.alarms[definition.id],
    }))
      .filter((alarm) => alarm.active || !alarm.acked)
      .sort((a, b) => a.priority - b.priority || (a.since ?? 0) - (b.since ?? 0))

    return {
      time: this.time,
      mode: this.mode,
      levelPct: this.process.levelPct,
      measuredLevel: this.measured,
      sensorFault: this.sensorFault,
      pumpCmd: this.plc.pumpCmd,
      pumpRunning: isPumpRunning(this.process),
      pumpFaultInjected: this.pumpFault,
      outletOpenPct: this.outletOpenPct,
      eStopPressed: this.eStopPressed,
      horn: this.horn,
      config: this.config,
      alarms,
      rungs: this.rungs,
      trend: this.trend,
    }
  }
}
