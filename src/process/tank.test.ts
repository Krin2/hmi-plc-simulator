import {
  INFLOW_PCT_PER_S,
  PUMP_RUNNING_SPEED,
  initialProcess,
  isPumpRunning,
  measureLevel,
  stepProcess,
  type ProcessInputs,
  type ProcessState,
} from './tank'

const off: ProcessInputs = { pumpCmd: false, pumpFault: false, outletOpenPct: 0 }

function simulate(state: ProcessState, input: ProcessInputs, seconds: number, dt = 0.1) {
  let current = state
  // Integer step count: accumulating 0.1 s in a float would run one step too many
  for (let i = 0; i < Math.round(seconds / dt); i++) current = stepProcess(current, input, dt)
  return current
}

describe('pump', () => {
  it('ramps up instead of jumping and reports running above 90 % speed', () => {
    let state = initialProcess(50)
    state = stepProcess(state, { ...off, pumpCmd: true }, 0.1)
    expect(state.pumpSpeed).toBeGreaterThan(0)
    expect(isPumpRunning(state)).toBe(false)

    state = simulate(state, { ...off, pumpCmd: true }, 3)
    expect(state.pumpSpeed).toBeGreaterThan(PUMP_RUNNING_SPEED)
    expect(isPumpRunning(state)).toBe(true)
  })

  it('coasts down after being stopped', () => {
    const running = simulate(initialProcess(50), { ...off, pumpCmd: true }, 5)
    const stopped = simulate(running, off, 5)
    expect(stopped.pumpSpeed).toBeLessThan(0.05)
  })

  it('never runs while the fault is injected, even when commanded', () => {
    const state = simulate(initialProcess(50), { ...off, pumpCmd: true, pumpFault: true }, 10)
    expect(state.pumpSpeed).toBe(0)
  })

  it('stops when the fault appears while it was running', () => {
    const running = simulate(initialProcess(50), { ...off, pumpCmd: true }, 5)
    expect(isPumpRunning(running)).toBe(true)
    const failed = simulate(running, { ...off, pumpCmd: true, pumpFault: true }, 3)
    expect(isPumpRunning(failed)).toBe(false)
  })
})

describe('tank level', () => {
  it('rises with the pump at full speed (mass balance with a closed outlet)', () => {
    const start = simulate(initialProcess(5), { ...off, pumpCmd: true }, 10) // reach full speed
    expect(start.pumpSpeed).toBeGreaterThan(0.999)
    const later = simulate(start, { ...off, pumpCmd: true }, 5)
    expect(later.levelPct - start.levelPct).toBeCloseTo(5 * INFLOW_PCT_PER_S, 1)
  })

  it('falls through the open outlet and drains more slowly as the level drops', () => {
    const open = { ...off, outletOpenPct: 100 }
    const first = simulate(initialProcess(80), open, 10)
    const dropHigh = 80 - first.levelPct
    const second = simulate(first, open, 10)
    const dropLow = first.levelPct - second.levelPct
    expect(dropHigh).toBeGreaterThan(0)
    expect(dropLow).toBeGreaterThan(0)
    expect(dropLow).toBeLessThan(dropHigh)
  })

  it('stays between 0 and 100 %', () => {
    expect(simulate(initialProcess(99), { ...off, pumpCmd: true }, 60).levelPct).toBe(100)
    expect(
      simulate(initialProcess(2), { ...off, outletOpenPct: 100 }, 120).levelPct,
    ).toBeGreaterThanOrEqual(0)
  })

  it('does not change with the pump off and the outlet closed', () => {
    expect(simulate(initialProcess(42), off, 30).levelPct).toBe(42)
  })

  it('can overflow even with the outlet wide open, which is why the high-high interlock exists', () => {
    // At full speed the pump (3.2 %/s) outpaces a fully open outlet (3.0 %/s at most)
    const state = simulate(
      initialProcess(50),
      { pumpCmd: true, pumpFault: false, outletOpenPct: 100 },
      600,
    )
    expect(state.levelPct).toBe(100)
  })
})

describe('measureLevel', () => {
  it('adds only a little deterministic noise', () => {
    for (let tick = 0; tick < 200; tick++) {
      expect(Math.abs(measureLevel(60, false, tick) - 60)).toBeLessThanOrEqual(0.15)
    }
    expect(measureLevel(60, false, 7)).toBe(measureLevel(60, false, 7))
  })

  it('returns a signal below the valid range when the sensor wire is broken', () => {
    expect(measureLevel(60, true, 1)).toBeLessThan(0)
  })
})
