import { newTimer, ton } from './timers'
import {
  ALARM_DEFINITIONS,
  type AlarmId,
  type AlarmState,
  type PlcConfig,
  type PlcInputs,
  type PlcState,
  type Rung,
  type ScanResult,
} from './types'

const quiet = (): AlarmState => ({ active: false, acked: true, since: null })

export function initialPlcState(): PlcState {
  return {
    time: 0,
    prev: { startPb: false, stopPb: false, ackPb: false, resetPb: false },
    pumpCmd: false,
    eStopLatched: false,
    pumpLockout: false,
    autoDemand: false,
    manualRun: false,
    pumpFailTimer: newTimer(),
    alarms: Object.fromEntries(ALARM_DEFINITIONS.map((def) => [def.id, quiet()])) as Record<
      AlarmId,
      AlarmState
    >,
  }
}

/**
 * Alarm life cycle (ISA-18.2): a new activation needs acknowledgement; an alarm that returns to
 * normal stays on the list until it is acknowledged, unless it was already acknowledged.
 */
export function updateAlarm(
  alarm: AlarmState,
  condition: boolean,
  ackEdge: boolean,
  now: number,
): AlarmState {
  if (condition && !alarm.active) return { active: true, acked: false, since: now }
  return { ...alarm, active: condition, acked: alarm.acked || ackEdge }
}

const rising = (current: boolean, previous: boolean) => current && !previous

/**
 * One PLC scan: read inputs, solve the logic top to bottom, write outputs. It is a pure
 * function of (state, inputs), which keeps it deterministic and easy to test.
 */
export function scan(
  state: PlcState,
  input: PlcInputs,
  config: PlcConfig,
  dtMs: number,
): ScanResult {
  const time = state.time + dtMs
  const start = rising(input.startPb, state.prev.startPb)
  const stop = rising(input.stopPb, state.prev.stopPb)
  const ack = rising(input.ackPb, state.prev.ackPb)
  const reset = rising(input.resetPb, state.prev.resetPb)
  const level = input.levelPct
  const auto = input.autoSelected
  const { thresholds } = config

  // Rung 1: the E-stop latches and needs a deliberate reset once the circuit is healthy again
  const eStopLatched = !input.eStopHealthy || (state.eStopLatched && !reset)

  // Rung 2: the pump has dropped out if it was commanded and never reports "running"
  const pumpFailTimer = ton(
    state.pumpFailTimer,
    state.pumpCmd && !input.pumpRunning,
    config.pumpFailDelayMs,
    dtMs,
  )

  // Rung 3: pump lockout, held until the operator resets it
  const pumpLockout = pumpFailTimer.done || (state.pumpLockout && !reset)

  // A signal outside the transmitter range is a failure, not a level
  const sensorFault =
    !Number.isFinite(level) || level < config.sensorRange.min || level > config.sensorRange.max

  const levelHighHigh = !sensorFault && level >= thresholds.highHigh
  const levelHigh = !sensorFault && level >= thresholds.high
  const levelLow = !sensorFault && level <= thresholds.low
  const levelLowLow = !sensorFault && level <= thresholds.lowLow

  // Rung 4: auto demand with hysteresis (start low, stop high) so the pump does not chatter
  const autoDemand =
    !sensorFault && (level <= config.startLevel || (state.autoDemand && level < config.stopLevel))

  // Rung 5: interlocks that stop the pump in every mode
  const trip = levelHighHigh || pumpLockout || eStopLatched || sensorFault

  // Rung 6: manual run latch. It drops on stop, on a trip and when leaving manual mode, so the
  // pump never restarts by itself after the cause of a trip has gone away.
  const manualRun = !auto && !trip && (start || (state.manualRun && !stop))

  // Rung 7: pump command
  const pumpCmd = !trip && ((auto && autoDemand) || manualRun)

  const conditions: Record<AlarmId, boolean> = {
    eStop: eStopLatched,
    sensorFault,
    pumpFailToStart: pumpLockout,
    levelHighHigh,
    levelHigh,
    levelLow,
    levelLowLow,
  }
  const alarms = Object.fromEntries(
    ALARM_DEFINITIONS.map(({ id }) => [
      id,
      updateAlarm(state.alarms[id], conditions[id], ack, time),
    ]),
  ) as Record<AlarmId, AlarmState>

  const horn = Object.values(alarms).some((alarm) => alarm.active && !alarm.acked)

  const rungs: Rung[] = [
    {
      id: 'estop',
      label: 'Emergency stop latch',
      logic: 'ESTOP_LATCH = NOT ESTOP_OK OR (ESTOP_LATCH AND NOT RESET)',
      energized: eStopLatched,
    },
    {
      id: 'pump-fail-timer',
      label: 'Pump feedback timer',
      logic: `TON(PUMP_CMD AND NOT PUMP_RUN, ${config.pumpFailDelayMs / 1000} s)`,
      energized: pumpFailTimer.done,
      detail: `${(pumpFailTimer.elapsedMs / 1000).toFixed(1)} / ${config.pumpFailDelayMs / 1000} s`,
    },
    {
      id: 'lockout',
      label: 'Pump lockout',
      logic: 'LOCKOUT = TON.DN OR (LOCKOUT AND NOT RESET)',
      energized: pumpLockout,
    },
    {
      id: 'auto-demand',
      label: 'Auto demand (hysteresis)',
      logic: 'DEMAND = LEVEL <= START_SP OR (DEMAND AND LEVEL < STOP_SP)',
      energized: autoDemand,
      detail: `${config.startLevel}% / ${config.stopLevel}%`,
    },
    {
      id: 'trip',
      label: 'Interlock trip',
      logic: 'TRIP = LEVEL_HH OR LOCKOUT OR ESTOP_LATCH OR SENSOR_FAULT',
      energized: trip,
    },
    {
      id: 'manual-run',
      label: 'Manual run latch',
      logic: 'MAN_RUN = NOT AUTO AND NOT TRIP AND (START OR (MAN_RUN AND NOT STOP))',
      energized: manualRun,
    },
    {
      id: 'pump-cmd',
      label: 'Pump command',
      logic: 'PUMP_CMD = NOT TRIP AND ((AUTO AND DEMAND) OR MAN_RUN)',
      energized: pumpCmd,
    },
  ]

  return {
    state: {
      time,
      prev: {
        startPb: input.startPb,
        stopPb: input.stopPb,
        ackPb: input.ackPb,
        resetPb: input.resetPb,
      },
      pumpCmd,
      eStopLatched,
      pumpLockout,
      autoDemand,
      manualRun,
      pumpFailTimer,
      alarms,
    },
    outputs: { pumpCmd, horn },
    rungs,
  }
}
