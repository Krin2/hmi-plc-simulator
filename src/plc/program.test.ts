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
  button: 'startPb' | 'stopPb' | 'ackPb' | 'resetPb',
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
      'auto-demand',
      'trip',
      'manual-run',
      'pump-cmd',
    ])
    expect(byId['pump-cmd']?.energized).toBe(true)
    expect(byId['auto-demand']?.energized).toBe(true)
    expect(byId['trip']?.energized).toBe(false)
  })
})
