import { newTimer, ton } from './timers'
import {
  ALARM_DEFINITIONS,
  type AlarmId,
  type AlarmState,
  type BlockReason,
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
    prev: {
      startPb: false,
      stopPb: false,
      openOutletPb: false,
      closeOutletPb: false,
      ackPb: false,
      resetPb: false,
    },
    auto: true,
    pumpCmd: false,
    outletOpen: false,
    eStopLatched: false,
    pumpLockout: false,
    hhCutoff: false,
    llCutoff: false,
    switches: { highHigh: false, high: false, low: false, lowLow: false },
    autoDemand: false,
    manualRun: false,
    manualOutletOpen: false,
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
 *
 * Two flows are controlled: the INLET (pump P-101) and the OUTLET (valve XV-101).
 * - Level HH closes the inlet; level LL closes the outlet, in every mode.
 * - The emergency stop closes both flows in AUTO. In MANUAL the operator keeps control of the
 *   inlet and the outlet independently; only the level cut-offs and a failed level signal
 *   still hold the flows closed.
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
  const openOutlet = rising(input.openOutletPb, state.prev.openOutletPb)
  const closeOutlet = rising(input.closeOutletPb, state.prev.closeOutletPb)
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

  // Level switches with deadband: ON at the limit, OFF only once the level is back inside it by
  // the deadband (noise right at the limit must not flicker the marks or re-raise the alarm)
  const { levelDeadbandPct: band } = config
  const above = (limit: number, wasOn: boolean) =>
    !sensorFault && (level >= limit || (wasOn && level > limit - band))
  const below = (limit: number, wasOn: boolean) =>
    !sensorFault && (level <= limit || (wasOn && level < limit + band))
  const switches = {
    highHigh: above(thresholds.highHigh, state.switches.highHigh),
    high: above(thresholds.high, state.switches.high),
    low: below(thresholds.low, state.switches.low),
    lowLow: below(thresholds.lowLow, state.switches.lowLow),
  }
  const levelHighHigh = switches.highHigh
  const levelHigh = switches.high
  const levelLow = switches.low
  const levelLowLow = switches.lowLow

  // Rung 4: HH closes the inlet and LL closes the outlet. Both have hysteresis, so the valve
  // does not chatter at the limit: the inlet reopens below H, the outlet reopens above L.
  const hhCutoff =
    !sensorFault && (level >= thresholds.highHigh || (state.hhCutoff && level > thresholds.high))
  const llCutoff =
    !sensorFault && (level <= thresholds.lowLow || (state.llCutoff && level < thresholds.low))

  // Rung 5: auto demand with hysteresis (start low, stop high) so the pump does not chatter
  const autoDemand =
    !sensorFault && (level <= config.startLevel || (state.autoDemand && level < config.stopLevel))

  // Rung 6: what holds each flow closed. The E-stop only counts in auto.
  const eStopTrip = auto && eStopLatched
  const inletBlock: BlockReason | null = sensorFault
    ? 'sensor-fault'
    : eStopTrip
      ? 'e-stop'
      : hhCutoff
        ? 'level-hh'
        : pumpLockout
          ? 'pump-lockout'
          : null
  const outletBlock: BlockReason | null = sensorFault
    ? 'sensor-fault'
    : eStopTrip
      ? 'e-stop'
      : llCutoff
        ? 'level-ll'
        : null

  // Rung 7: manual inlet latch. It drops on close, when blocked and when leaving manual mode, so
  // the pump never restarts by itself after the cause of a trip has gone away.
  const manualRun = !auto && !inletBlock && (start || (state.manualRun && !stop))

  // Rung 8: manual outlet latch, independent of the inlet. Entering manual mode keeps the valve
  // where it was (bumpless transfer), so the consumer is not cut off by the mode switch.
  const enteringManual = !auto && state.auto
  const outletWasOpen = enteringManual ? state.outletOpen : state.manualOutletOpen
  const manualOutletOpen = !auto && !outletBlock && (openOutlet || (outletWasOpen && !closeOutlet))

  // Rungs 9 and 10: commands
  const pumpCmd = !inletBlock && ((auto && autoDemand) || manualRun)
  const outletOpen = !outletBlock && (auto || manualOutletOpen)

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
      id: 'hh-cutoff',
      label: 'HH cut-off (closes the inlet)',
      logic: 'HH_CUT = LEVEL >= HH OR (HH_CUT AND LEVEL > H)',
      energized: hhCutoff,
      detail: `HH ${thresholds.highHigh}% / reopens below H ${thresholds.high}%`,
    },
    {
      id: 'll-cutoff',
      label: 'LL cut-off (closes the outlet)',
      logic: 'LL_CUT = LEVEL <= LL OR (LL_CUT AND LEVEL < L)',
      energized: llCutoff,
      detail: `LL ${thresholds.lowLow}% / reopens above L ${thresholds.low}%`,
    },
    {
      id: 'auto-demand',
      label: 'Auto demand (hysteresis)',
      logic: 'DEMAND = LEVEL <= START_SP OR (DEMAND AND LEVEL < STOP_SP)',
      energized: autoDemand,
      detail: `${config.startLevel}% / ${config.stopLevel}%`,
    },
    {
      id: 'inlet-block',
      label: 'Inlet blocked',
      logic: 'IN_BLOCK = SENSOR_FAULT OR (AUTO AND ESTOP_LATCH) OR HH_CUT OR LOCKOUT',
      energized: inletBlock !== null,
    },
    {
      id: 'outlet-block',
      label: 'Outlet blocked',
      logic: 'OUT_BLOCK = SENSOR_FAULT OR (AUTO AND ESTOP_LATCH) OR LL_CUT',
      energized: outletBlock !== null,
    },
    {
      id: 'manual-run',
      label: 'Manual inlet latch',
      logic: 'MAN_IN = NOT AUTO AND NOT IN_BLOCK AND (OPEN_IN OR (MAN_IN AND NOT CLOSE_IN))',
      energized: manualRun,
    },
    {
      id: 'manual-outlet',
      label: 'Manual outlet latch',
      logic: 'MAN_OUT = NOT AUTO AND NOT OUT_BLOCK AND (OPEN_OUT OR (MAN_OUT AND NOT CLOSE_OUT))',
      energized: manualOutletOpen,
    },
    {
      id: 'pump-cmd',
      label: 'Inlet: pump command',
      logic: 'PUMP_CMD = NOT IN_BLOCK AND ((AUTO AND DEMAND) OR MAN_IN)',
      energized: pumpCmd,
    },
    {
      id: 'outlet-cmd',
      label: 'Outlet: valve open command',
      logic: 'XV_OPEN = NOT OUT_BLOCK AND (AUTO OR MAN_OUT)',
      energized: outletOpen,
    },
  ]

  return {
    state: {
      time,
      prev: {
        startPb: input.startPb,
        stopPb: input.stopPb,
        openOutletPb: input.openOutletPb,
        closeOutletPb: input.closeOutletPb,
        ackPb: input.ackPb,
        resetPb: input.resetPb,
      },
      auto,
      pumpCmd,
      outletOpen,
      eStopLatched,
      pumpLockout,
      hhCutoff,
      llCutoff,
      switches,
      autoDemand,
      manualRun,
      manualOutletOpen,
      pumpFailTimer,
      alarms,
    },
    outputs: { pumpCmd, outletOpen, horn },
    rungs,
    blocks: { inlet: inletBlock, outlet: outletBlock },
    levelSwitches: switches,
  }
}
