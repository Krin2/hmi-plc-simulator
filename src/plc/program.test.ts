import { initialPlcState, scan, updateAlarm } from './program'
import { newTimer, ton } from './timers'
import {
  DEFAULT_PLC_CONFIG,
  type AlarmId,
  type PlcInputs,
  type PlcState,
  type ScanResult,
} from './types'

const config = DEFAULT_PLC_CONFIG
const DT = 100

const idle: PlcInputs = {
  levelPct: 50,
  pumpRunning: false,
  eStopHealthy: true,
  autoSelected: true,
  startPb: false,
  stopPb: false,
  openOutletPb: false,
  closeOutletPb: false,
  ackPb: false,
  resetPb: false,
}

/** Runs one scan; `pumpRunning` follows the previous command unless overridden. */
function run(state: PlcState, input: Partial<PlcInputs> = {}, dt = DT): ScanResult {
  return scan(state, { ...idle, ...input }, config, dt)
}

/** Several scans with the same inputs, returning the last result. */
function runFor(state: PlcState, input: Partial<PlcInputs>, scans: number): ScanResult {
  let result = run(state, input)
  for (let i = 1; i < scans; i++) result = run(result.state, input)
  return result
}

/** One-scan push button press followed by a scan with the button released. */
function press(
  state: PlcState,
  button: 'startPb' | 'stopPb' | 'openOutletPb' | 'closeOutletPb' | 'ackPb' | 'resetPb',
  input: Partial<PlcInputs> = {},
) {
  return run(run(state, { ...input, [button]: true }).state, input)
}

const alarm = (result: ScanResult, id: AlarmId) => result.state.alarms[id]

describe('TON timer', () => {
  it('accumulates while enabled and sets done at the preset', () => {
    let timer = newTimer()
    timer = ton(timer, true, 300, 100)
    expect(timer).toEqual({ elapsedMs: 100, done: false })
    timer = ton(ton(timer, true, 300, 100), true, 300, 100)
    expect(timer).toEqual({ elapsedMs: 300, done: true })
    expect(ton(timer, true, 300, 100).elapsedMs).toBe(300) // does not run past the preset
  })

  it('resets as soon as the enable drops', () => {
    const running = ton(ton(newTimer(), true, 300, 100), true, 300, 100)
    expect(ton(running, false, 300, 100)).toEqual(newTimer())
  })
})

describe('auto mode', () => {
  it('starts the pump at the start level and stops it at the stop level (hysteresis)', () => {
    let result = run(initialPlcState(), { levelPct: 30 })
    expect(result.outputs.pumpCmd).toBe(true)

    // In between the setpoints the pump keeps running...
    result = run(result.state, { levelPct: 60, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(true)

    result = run(result.state, { levelPct: config.stopLevel, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(false)

    // ...and stays off in between until the level falls to the start level again
    result = run(result.state, { levelPct: 60 })
    expect(result.outputs.pumpCmd).toBe(false)
    result = run(result.state, { levelPct: config.startLevel })
    expect(result.outputs.pumpCmd).toBe(true)
  })

  it('ignores the manual start button', () => {
    const result = press(initialPlcState(), 'startPb', { levelPct: 60, autoSelected: true })
    expect(result.outputs.pumpCmd).toBe(false)
  })
})

describe('manual mode', () => {
  const manual = { autoSelected: false, levelPct: 60 }

  it('runs the pump after START and stops it after STOP', () => {
    let result = press(initialPlcState(), 'startPb', manual)
    expect(result.outputs.pumpCmd).toBe(true)

    result = run(result.state, { ...manual, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(true) // latched

    result = press(result.state, 'stopPb', { ...manual, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(false)
  })

  it('needs a new rising edge: holding START does not restart after STOP', () => {
    let result = run(initialPlcState(), { ...manual, startPb: true })
    expect(result.outputs.pumpCmd).toBe(true)
    result = run(result.state, { ...manual, startPb: false, stopPb: true })
    expect(result.outputs.pumpCmd).toBe(false)
    result = run(result.state, { ...manual, stopPb: false })
    expect(result.outputs.pumpCmd).toBe(false)
  })

  it('drops the run latch when switching to auto', () => {
    let result = press(initialPlcState(), 'startPb', manual)
    result = run(result.state, { ...manual, autoSelected: true, pumpRunning: true })
    expect(result.state.manualRun).toBe(false)
    // At 60 % auto has no demand, so switching back to manual must not restart the pump
    result = run(result.state, { ...manual, autoSelected: false })
    expect(result.outputs.pumpCmd).toBe(false)
  })
})

describe('interlocks', () => {
  it('trips the pump on high-high level in every mode', () => {
    expect(run(initialPlcState(), { levelPct: 30 }).outputs.pumpCmd).toBe(true)
    expect(run(initialPlcState(), { levelPct: 96, autoSelected: true }).outputs.pumpCmd).toBe(false)

    const started = press(initialPlcState(), 'startPb', { autoSelected: false })
    expect(started.outputs.pumpCmd).toBe(true)
    const tripped = run(started.state, { autoSelected: false, levelPct: 96, pumpRunning: true })
    expect(tripped.outputs.pumpCmd).toBe(false)
  })

  it('does not restart a manual pump by itself once the level is back to normal', () => {
    let result = press(initialPlcState(), 'startPb', { autoSelected: false, levelPct: 60 })
    result = run(result.state, { autoSelected: false, levelPct: 96, pumpRunning: true }) // trip
    result = run(result.state, { autoSelected: false, levelPct: 60 }) // condition gone
    expect(result.outputs.pumpCmd).toBe(false)
  })

  it('latches the E-stop and needs a reset after the circuit is healthy again', () => {
    let result = run(initialPlcState(), { levelPct: 30, eStopHealthy: false })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(alarm(result, 'eStop').active).toBe(true)

    // Releasing the button is not enough...
    result = run(result.state, { levelPct: 30, eStopHealthy: true })
    expect(result.state.eStopLatched).toBe(true)
    expect(result.outputs.pumpCmd).toBe(false)

    // ...a reset is required (and has no effect while the button is still pressed)
    expect(
      press(result.state, 'resetPb', { levelPct: 30, eStopHealthy: false }).state.eStopLatched,
    ).toBe(true)
    result = press(result.state, 'resetPb', { levelPct: 30 })
    expect(result.state.eStopLatched).toBe(false)
    expect(result.outputs.pumpCmd).toBe(true)
  })

  it('trips on a failed level signal and raises a sensor alarm instead of level alarms', () => {
    const result = run(initialPlcState(), { levelPct: -5 })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(alarm(result, 'sensorFault').active).toBe(true)
    expect(alarm(result, 'levelLowLow').active).toBe(false) // -5 % is not a real reading
  })

  it.each([Number.NaN, 150])('treats %s as a sensor failure', (levelPct) => {
    expect(alarm(run(initialPlcState(), { levelPct }), 'sensorFault').active).toBe(true)
  })

  it('locks the pump out when it does not report running within the delay', () => {
    // Commanded at 30 %, but the feedback never comes
    let result = run(initialPlcState(), { levelPct: 30 })
    expect(result.outputs.pumpCmd).toBe(true)

    const scansToTimeout = config.pumpFailDelayMs / DT
    result = runFor(result.state, { levelPct: 30, pumpRunning: false }, scansToTimeout - 1)
    expect(result.outputs.pumpCmd).toBe(true) // not yet
    expect(alarm(result, 'pumpFailToStart').active).toBe(false)

    result = run(result.state, { levelPct: 30, pumpRunning: false })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(alarm(result, 'pumpFailToStart').active).toBe(true)

    // The lockout holds even though the demand is still there...
    result = runFor(result.state, { levelPct: 30 }, 5)
    expect(result.outputs.pumpCmd).toBe(false)

    // ...until the operator resets it
    result = press(result.state, 'resetPb', { levelPct: 30 })
    expect(result.outputs.pumpCmd).toBe(true)
  })

  it('does not time out while the pump reports running', () => {
    let result = run(initialPlcState(), { levelPct: 30 })
    result = runFor(result.state, { levelPct: 30, pumpRunning: true }, 100)
    expect(alarm(result, 'pumpFailToStart').active).toBe(false)
  })
})

describe('alarms', () => {
  it('raises level alarms at their thresholds', () => {
    const at = (levelPct: number) => run(initialPlcState(), { levelPct })
    expect(alarm(at(84), 'levelHigh').active).toBe(false)
    expect(alarm(at(85), 'levelHigh').active).toBe(true)
    expect(alarm(at(94), 'levelHighHigh').active).toBe(false)
    expect(alarm(at(95), 'levelHighHigh').active).toBe(true)
    expect(alarm(at(16), 'levelLow').active).toBe(false)
    expect(alarm(at(15), 'levelLow').active).toBe(true)
    expect(alarm(at(5), 'levelLowLow').active).toBe(true)
  })

  it('sounds the horn for a new alarm until it is acknowledged', () => {
    let result = run(initialPlcState(), { levelPct: 90 })
    expect(result.outputs.horn).toBe(true)
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: true, acked: false })

    result = press(result.state, 'ackPb', { levelPct: 90 })
    expect(result.outputs.horn).toBe(false)
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: true, acked: true })
  })

  it('keeps an unacknowledged alarm after it returns to normal, then clears it on ack', () => {
    let result = run(initialPlcState(), { levelPct: 90 })
    result = run(result.state, { levelPct: 60 }) // back to normal, nobody saw it
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: false, acked: false })
    expect(result.outputs.horn).toBe(false) // only active alarms sound the horn

    result = press(result.state, 'ackPb', { levelPct: 60 })
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: false, acked: true })
  })

  it('an acknowledged alarm that clears leaves the list without another ack', () => {
    let result = run(initialPlcState(), { levelPct: 90 })
    result = press(result.state, 'ackPb', { levelPct: 90 })
    result = run(result.state, { levelPct: 60 })
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: false, acked: true })
  })

  it('a repeat occurrence needs a new acknowledgement', () => {
    let result = run(initialPlcState(), { levelPct: 90 })
    result = press(result.state, 'ackPb', { levelPct: 90 })
    result = run(result.state, { levelPct: 60 })
    result = run(result.state, { levelPct: 90 })
    expect(alarm(result, 'levelHigh')).toMatchObject({ active: true, acked: false })
    expect(result.outputs.horn).toBe(true)
  })

  it('the push button must be released and pressed again to acknowledge a later alarm', () => {
    // A held ACK button acts once, on its rising edge
    let result = run(initialPlcState(), { levelPct: 60, ackPb: true })
    result = run(result.state, { levelPct: 90, ackPb: true })
    expect(alarm(result, 'levelHigh').acked).toBe(false)
  })
})

describe('updateAlarm', () => {
  it('records when the alarm became active', () => {
    const quiet = { active: false, acked: true, since: null }
    expect(updateAlarm(quiet, true, false, 1500)).toEqual({
      active: true,
      acked: false,
      since: 1500,
    })
  })
})

describe('logic viewer', () => {
  it('reports the state of every rung', () => {
    const result = run(initialPlcState(), { levelPct: 30 })
    const byId = Object.fromEntries(result.rungs.map((rung) => [rung.id, rung]))
    expect(Object.keys(byId)).toEqual([
      'estop',
      'pump-fail-timer',
      'lockout',
      'hh-cutoff',
      'll-cutoff',
      'auto-demand',
      'inlet-block',
      'outlet-block',
      'manual-run',
      'manual-outlet',
      'pump-cmd',
      'outlet-cmd',
    ])
    expect(byId['pump-cmd']?.energized).toBe(true)
    expect(byId['auto-demand']?.energized).toBe(true)
    expect(byId['inlet-block']?.energized).toBe(false)
    expect(byId['outlet-cmd']?.energized).toBe(true)
  })
})

describe('level switches', () => {
  it('light up exactly while the level is beyond each limit', () => {
    const at = (levelPct: number) => run(initialPlcState(), { levelPct }).levelSwitches
    expect(at(50)).toEqual({ highHigh: false, high: false, low: false, lowLow: false })
    expect(at(85)).toEqual({ highHigh: false, high: true, low: false, lowLow: false })
    expect(at(96)).toEqual({ highHigh: true, high: true, low: false, lowLow: false })
    expect(at(15)).toEqual({ highHigh: false, high: false, low: true, lowLow: false })
    expect(at(4)).toEqual({ highHigh: false, high: false, low: true, lowLow: true })
  })

  it('have a deadband: a switch that is ON turns OFF only once the level is 1 % back inside', () => {
    let result = run(initialPlcState(), { levelPct: 4.9 })
    expect(result.levelSwitches.lowLow).toBe(true)
    result = run(result.state, { levelPct: 5.5 })
    expect(result.levelSwitches.lowLow).toBe(true) // above the limit, but inside the deadband
    result = run(result.state, { levelPct: 6 })
    expect(result.levelSwitches.lowLow).toBe(false)

    result = run(initialPlcState(), { levelPct: 95 })
    expect(result.levelSwitches.highHigh).toBe(true)
    result = run(result.state, { levelPct: 94.5 })
    expect(result.levelSwitches.highHigh).toBe(true)
    result = run(result.state, { levelPct: 94 })
    expect(result.levelSwitches.highHigh).toBe(false)
  })

  it('do not re-raise an alarm when noise makes the level cross the limit back and forth', () => {
    let result = run(initialPlcState(), { levelPct: 4.9 })
    result = press(result.state, 'ackPb', { levelPct: 4.9 })
    expect(result.outputs.horn).toBe(false)

    for (const levelPct of [5.1, 4.9, 5.2, 4.8, 5.1, 4.9]) {
      result = run(result.state, { levelPct })
      expect(alarm(result, 'levelLowLow')).toMatchObject({ active: true, acked: true })
      expect(result.outputs.horn).toBe(false)
    }
  })

  it('are all off when the level signal is not valid', () => {
    expect(run(initialPlcState(), { levelPct: -5 }).levelSwitches).toEqual({
      highHigh: false,
      high: false,
      low: false,
      lowLow: false,
    })
  })
})

describe('outlet (valve XV-101)', () => {
  it('is open in auto mode while no interlock holds it closed', () => {
    const result = run(initialPlcState(), { levelPct: 50 })
    expect(result.outputs.outletOpen).toBe(true)
    expect(result.blocks.outlet).toBeNull()
  })

  it('closes at LL and reopens only once the level is back above L (hysteresis)', () => {
    let result = run(initialPlcState(), { levelPct: 5 })
    expect(result.outputs.outletOpen).toBe(false)
    expect(result.blocks.outlet).toBe('level-ll')

    // Back above LL but still below L: the outlet stays closed
    result = run(result.state, { levelPct: 10 })
    expect(result.outputs.outletOpen).toBe(false)
    expect(result.blocks.outlet).toBe('level-ll')
    expect(result.levelSwitches.lowLow).toBe(false) // the switch is off, the cut-off is still latched

    result = run(result.state, { levelPct: 14.9 })
    expect(result.outputs.outletOpen).toBe(false)

    result = run(result.state, { levelPct: 15 })
    expect(result.outputs.outletOpen).toBe(true)
  })

  it('does not close the inlet: LL only stops the outlet', () => {
    const result = run(initialPlcState(), { levelPct: 4 })
    expect(result.outputs.outletOpen).toBe(false)
    expect(result.outputs.pumpCmd).toBe(true) // auto demand fills the tank
  })

  it('is opened and closed by the operator in manual mode, independently of the inlet', () => {
    const manual = { autoSelected: false, levelPct: 50 }
    let result = press(initialPlcState(), 'openOutletPb', manual)
    expect(result.outputs.outletOpen).toBe(true)
    expect(result.outputs.pumpCmd).toBe(false) // the inlet is not affected

    result = press(result.state, 'startPb', manual)
    expect(result.outputs.pumpCmd).toBe(true)
    expect(result.outputs.outletOpen).toBe(true)

    result = press(result.state, 'closeOutletPb', { ...manual, pumpRunning: true })
    expect(result.outputs.outletOpen).toBe(false)
    expect(result.outputs.pumpCmd).toBe(true) // still filling, the outlet is closed on purpose

    result = press(result.state, 'stopPb', { ...manual, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(result.outputs.outletOpen).toBe(false)
  })

  it('keeps its position when switching from auto to manual (bumpless transfer)', () => {
    let result = run(initialPlcState(), { levelPct: 50 })
    expect(result.outputs.outletOpen).toBe(true)
    result = run(result.state, { levelPct: 50, autoSelected: false })
    expect(result.outputs.outletOpen).toBe(true)
    result = run(result.state, { levelPct: 50, autoSelected: false })
    expect(result.outputs.outletOpen).toBe(true) // and it stays that way

    result = press(result.state, 'closeOutletPb', { levelPct: 50, autoSelected: false })
    expect(result.outputs.outletOpen).toBe(false)
  })

  it('cannot be opened by the operator while the LL cut-off holds it closed', () => {
    const manual = { autoSelected: false }
    let result = run(initialPlcState(), { ...manual, levelPct: 4 })
    result = press(result.state, 'openOutletPb', { ...manual, levelPct: 4 })
    expect(result.outputs.outletOpen).toBe(false)

    // Once the level is above L, a new press opens it
    result = press(result.state, 'openOutletPb', { ...manual, levelPct: 20 })
    expect(result.outputs.outletOpen).toBe(true)
  })

  it('is closed by LL even if the operator had it open, and stays closed afterwards', () => {
    const manual = { autoSelected: false }
    let result = press(initialPlcState(), 'openOutletPb', { ...manual, levelPct: 30 })
    expect(result.outputs.outletOpen).toBe(true)
    result = run(result.state, { ...manual, levelPct: 4 })
    expect(result.outputs.outletOpen).toBe(false)
    result = run(result.state, { ...manual, levelPct: 30 })
    expect(result.outputs.outletOpen).toBe(false) // no automatic reopening in manual
  })
})

describe('inlet (pump P-101) HH cut-off', () => {
  it('closes at HH and reopens below H (hysteresis) in auto mode', () => {
    // Auto demand would not ask for the pump here, so check the block itself
    let result = run(initialPlcState(), { levelPct: 96 })
    expect(result.blocks.inlet).toBe('level-hh')
    expect(result.outputs.pumpCmd).toBe(false)

    result = run(result.state, { levelPct: 90 }) // below HH, above H: still closed
    expect(result.blocks.inlet).toBe('level-hh')

    result = run(result.state, { levelPct: 85 })
    expect(result.blocks.inlet).toBeNull()
  })

  it('does not close the outlet: HH only stops the inlet', () => {
    const result = run(initialPlcState(), { levelPct: 96 })
    expect(result.outputs.outletOpen).toBe(true)
  })

  it('cannot be opened by the operator in manual mode until the level is below H', () => {
    const manual = { autoSelected: false }
    let result = run(initialPlcState(), { ...manual, levelPct: 96 })
    result = press(result.state, 'startPb', { ...manual, levelPct: 96 })
    expect(result.outputs.pumpCmd).toBe(false)
    result = press(result.state, 'startPb', { ...manual, levelPct: 90 })
    expect(result.outputs.pumpCmd).toBe(false) // still latched
    result = press(result.state, 'startPb', { ...manual, levelPct: 80 })
    expect(result.outputs.pumpCmd).toBe(true)
  })
})

describe('emergency stop and the two flows', () => {
  it('in auto mode it closes both the inlet and the outlet', () => {
    let result = run(initialPlcState(), { levelPct: 30 })
    expect(result.outputs).toMatchObject({ pumpCmd: true, outletOpen: true })

    result = run(result.state, { levelPct: 30, pumpRunning: true, eStopHealthy: false })
    expect(result.outputs).toMatchObject({ pumpCmd: false, outletOpen: false })
    expect(result.blocks).toEqual({ inlet: 'e-stop', outlet: 'e-stop' })
    expect(alarm(result, 'eStop').active).toBe(true)
  })

  it('in auto mode both flows stay closed after release until a reset', () => {
    let result = run(initialPlcState(), { levelPct: 30, eStopHealthy: false })
    result = run(result.state, { levelPct: 30, eStopHealthy: true })
    expect(result.outputs).toMatchObject({ pumpCmd: false, outletOpen: false })

    result = press(result.state, 'resetPb', { levelPct: 30 })
    expect(result.outputs).toMatchObject({ pumpCmd: true, outletOpen: true })
  })

  it('in manual mode the operator can still open and close each flow', () => {
    const manual = { autoSelected: false, levelPct: 50, eStopHealthy: false }
    let result = run(initialPlcState(), manual)
    expect(alarm(result, 'eStop').active).toBe(true) // the alarm is raised in every mode
    expect(result.blocks).toEqual({ inlet: null, outlet: null })

    result = press(result.state, 'startPb', manual)
    expect(result.outputs.pumpCmd).toBe(true)
    result = press(result.state, 'openOutletPb', { ...manual, pumpRunning: true })
    expect(result.outputs.outletOpen).toBe(true)

    result = press(result.state, 'stopPb', { ...manual, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(result.outputs.outletOpen).toBe(true) // independent of each other
  })

  it('in manual mode the HH and LL cut-offs still apply with the emergency stop pressed', () => {
    const manual = { autoSelected: false, eStopHealthy: false }
    let result = press(initialPlcState(), 'startPb', { ...manual, levelPct: 50 })
    result = run(result.state, { ...manual, levelPct: 96, pumpRunning: true })
    expect(result.outputs.pumpCmd).toBe(false)
    expect(result.blocks.inlet).toBe('level-hh')

    result = press(initialPlcState(), 'openOutletPb', { ...manual, levelPct: 50 })
    result = run(result.state, { ...manual, levelPct: 4 })
    expect(result.outputs.outletOpen).toBe(false)
    expect(result.blocks.outlet).toBe('level-ll')
  })

  it('switching from manual to auto applies a pressed emergency stop at once', () => {
    const base = { eStopHealthy: false, levelPct: 30 }
    let result = press(initialPlcState(), 'startPb', { ...base, autoSelected: false })
    expect(result.outputs.pumpCmd).toBe(true)
    result = run(result.state, { ...base, autoSelected: true, pumpRunning: true })
    expect(result.outputs).toMatchObject({ pumpCmd: false, outletOpen: false })
  })

  it('a failed level signal closes both flows in every mode', () => {
    for (const autoSelected of [true, false]) {
      const result = run(initialPlcState(), { autoSelected, levelPct: -5 })
      expect(result.outputs).toMatchObject({ pumpCmd: false, outletOpen: false })
      expect(result.blocks).toEqual({ inlet: 'sensor-fault', outlet: 'sensor-fault' })
    }
  })
})
