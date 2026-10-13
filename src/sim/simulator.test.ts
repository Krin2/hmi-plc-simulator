import { MIN_SETPOINT_GAP, Simulator, TICK_MS, type Command } from './simulator'

function setup() {
  const sim = new Simulator()
  const run = (seconds: number) => {
    for (let i = 0; i < (seconds * 1000) / TICK_MS; i++) sim.tick()
  }
  const send = (command: Command) => sim.command(command)
  const snap = () => sim.getSnapshot()
  return { sim, run, send, snap }
}

describe('auto control loop', () => {
  it('keeps the level between the stop and start levels, cycling the pump', () => {
    const { run, snap } = setup()
    let min = 100
    let max = 0
    let starts = 0
    let wasRunning = false
    // Skip the first 20 s (initial transient), then watch five minutes
    run(20)
    for (let i = 0; i < 3000; i++) {
      run(0.1)
      const s = snap()
      min = Math.min(min, s.levelPct)
      max = Math.max(max, s.levelPct)
      if (s.pumpRunning && !wasRunning) starts++
      wasRunning = s.pumpRunning
    }
    expect(min).toBeGreaterThan(25) // the start level is 35 %, with some overshoot while the pump spins up
    expect(max).toBeLessThan(85) // below the high alarm
    expect(starts).toBeGreaterThanOrEqual(5) // it really cycles
    expect(snap().alarms).toEqual([])
  })

  it('never raises an alarm in normal operation', () => {
    const { run, snap } = setup()
    run(600)
    expect(snap().alarms).toEqual([])
    expect(snap().horn).toBe(false)
  })
})

describe('commands', () => {
  it('switches to manual mode, where the pump starts and stops on the operator buttons', () => {
    const { run, send, snap } = setup()
    send({ type: 'setMode', mode: 'manual' })
    run(5)
    expect(snap().pumpCmd).toBe(false)

    send({ type: 'start' })
    run(0.3)
    expect(snap().pumpCmd).toBe(true)
    run(3)
    expect(snap().pumpRunning).toBe(true)

    send({ type: 'stop' })
    run(0.3)
    expect(snap().pumpCmd).toBe(false)
  })

  it('makes push buttons momentary: one press is one scan', () => {
    const { send, run, snap } = setup()
    send({ type: 'setMode', mode: 'manual' })
    send({ type: 'start' })
    run(0.1)
    send({ type: 'stop' })
    run(0.2)
    expect(snap().pumpCmd).toBe(false)
    run(2) // the start press must not repeat
    expect(snap().pumpCmd).toBe(false)
  })

  it('changes the outlet valve opening and clamps it to 0-100 %', () => {
    const { send, snap } = setup()
    send({ type: 'setOutlet', pct: 30 })
    expect(snap().outletOpenPct).toBe(30)
    send({ type: 'setOutlet', pct: 500 })
    expect(snap().outletOpenPct).toBe(100)
    send({ type: 'setOutlet', pct: -3 })
    expect(snap().outletOpenPct).toBe(0)
  })

  it('applies valid setpoints and rejects invalid ones without changing anything', () => {
    const { send, snap } = setup()
    expect(send({ type: 'setSetpoints', startLevel: 40, stopLevel: 70 })).toEqual({ ok: true })
    expect(snap().config).toMatchObject({ startLevel: 40, stopLevel: 70 })

    const tooClose = send({
      type: 'setSetpoints',
      startLevel: 50,
      stopLevel: 50 + MIN_SETPOINT_GAP - 1,
    })
    expect(tooClose).toMatchObject({ ok: false })
    const outside = send({ type: 'setSetpoints', startLevel: 10, stopLevel: 70 })
    expect(outside).toMatchObject({ ok: false, error: expect.stringContaining('low alarm') })
    const high = send({ type: 'setSetpoints', startLevel: 40, stopLevel: 90 })
    expect(high).toMatchObject({ ok: false, error: expect.stringContaining('high alarm') })
    const nan = send({ type: 'setSetpoints', startLevel: Number.NaN, stopLevel: 70 })
    expect(nan).toMatchObject({ ok: false })

    expect(snap().config).toMatchObject({ startLevel: 40, stopLevel: 70 })
  })

  it('does not change the default configuration when setpoints change (no shared state)', () => {
    const a = setup()
    a.send({ type: 'setSetpoints', startLevel: 45, stopLevel: 70 })
    expect(setup().snap().config.startLevel).toBe(35)
  })
})

describe('fault scenarios', () => {
  it('pump failure: alarm after the feedback timeout, lockout, and recovery after reset', () => {
    const { send, run, snap } = setup()
    run(5)
    send({ type: 'fault', fault: 'pump', on: true })
    // Wait until the pump should have started (the level drops to the start level)
    run(120)
    expect(snap().alarms.map((alarm) => alarm.id)).toContain('pumpFailToStart')
    expect(snap().pumpCmd).toBe(false) // locked out
    expect(snap().horn).toBe(true)

    send({ type: 'ack' })
    run(0.3)
    expect(snap().horn).toBe(false)

    // Repair the pump, acknowledge and reset the lockout: the loop resumes
    send({ type: 'fault', fault: 'pump', on: false })
    send({ type: 'reset' })
    run(10)
    expect(snap().pumpCmd).toBe(true)
    run(5)
    expect(snap().pumpRunning).toBe(true)
    expect(snap().alarms.find((alarm) => alarm.id === 'pumpFailToStart')).toBeUndefined()
  })

  it('sensor failure: the pump is stopped fail-safe and a critical alarm is raised', () => {
    const { send, run, snap } = setup()
    run(60)
    send({ type: 'fault', fault: 'sensor', on: true })
    run(1)
    const s = snap()
    expect(s.pumpCmd).toBe(false)
    expect(s.sensorFault).toBe(true)
    expect(s.measuredLevel).toBeLessThan(0)
    expect(s.alarms[0]).toMatchObject({ id: 'sensorFault', priority: 1 })
    // The tank itself is fine: level alarms are suppressed because the reading is not valid
    expect(s.alarms.map((alarm) => alarm.id)).not.toContain('levelLowLow')
  })

  it('emergency stop: stops the pump, needs release plus reset, and does not restart by itself', () => {
    const { send, run, snap } = setup()
    send({ type: 'setOutlet', pct: 0 }) // the level stays low so auto demands the pump
    run(1)
    send({ type: 'eStop', pressed: true })
    run(1)
    expect(snap().pumpCmd).toBe(false)
    expect(snap().alarms.map((alarm) => alarm.id)).toContain('eStop')

    send({ type: 'eStop', pressed: false })
    run(1)
    expect(snap().pumpCmd).toBe(false) // still latched

    send({ type: 'reset' })
    run(0.3)
    expect(snap().alarms.some((alarm) => alarm.id === 'eStop' && alarm.active)).toBe(false)
  })

  it('high-high level: the interlock stops the pump even in manual mode', () => {
    const { send, run, snap } = setup()
    send({ type: 'setMode', mode: 'manual' })
    send({ type: 'setOutlet', pct: 0 })
    send({ type: 'start' })
    run(30)
    expect(snap().levelPct).toBeGreaterThan(90)
    // Keep running: the level must be stopped at the high-high threshold
    run(30)
    expect(snap().levelPct).toBeLessThan(100)
    expect(snap().pumpCmd).toBe(false)
    expect(snap().alarms.map((alarm) => alarm.id)).toContain('levelHighHigh')
  })
})

describe('flow cut-offs', () => {
  it('LL closes the outlet: the tank stops draining and the outlet reopens above L', () => {
    const { send, run, snap } = setup()
    run(5)
    send({ type: 'fault', fault: 'pump', on: true }) // nothing refills the tank
    run(250)

    let s = snap()
    expect(s.levelSwitches.lowLow).toBe(true)
    expect(s.blocks.outlet).toBe('level-ll')
    expect(s.outletOpen).toBe(false)
    expect(s.levelPct).toBeGreaterThan(3)
    expect(s.levelPct).toBeLessThan(6)

    // With the outlet shut the level holds: nothing drains it any further
    const before = s.levelPct
    run(60)
    expect(Math.abs(snap().levelPct - before)).toBeLessThan(0.1)

    // Repair the pump and reset the lockout: the tank fills, and the outlet reopens above L
    send({ type: 'fault', fault: 'pump', on: false })
    send({ type: 'reset' })
    run(2)
    expect(snap().outletOpen).toBe(false) // 5-6 % is still below L (15 %)
    run(8)
    s = snap()
    expect(s.levelPct).toBeGreaterThan(15)
    expect(s.blocks.outlet).toBeNull()
    expect(s.outletOpen).toBe(true)
  })

  it('HH closes the inlet: the level stops rising and the operator cannot reopen it yet', () => {
    const { send, run, snap } = setup()
    run(1)
    send({ type: 'setMode', mode: 'manual' })
    send({ type: 'closeOutlet' })
    send({ type: 'start' })
    run(30)

    let s = snap()
    expect(s.levelSwitches.highHigh).toBe(true)
    expect(s.blocks.inlet).toBe('level-hh')
    expect(s.pumpCmd).toBe(false)
    expect(s.levelPct).toBeLessThan(100)

    // Still above H: a new start press has no effect
    send({ type: 'start' })
    run(2)
    expect(snap().pumpCmd).toBe(false)

    // Drain below H through the outlet, then the operator can open the inlet again
    send({ type: 'setOutlet', pct: 100 })
    send({ type: 'openOutlet' })
    run(15)
    s = snap()
    expect(s.levelPct).toBeLessThan(85)
    expect(s.blocks.inlet).toBeNull()
    send({ type: 'start' })
    run(0.3)
    expect(snap().pumpCmd).toBe(true)
  })

  it('emergency stop in auto closes both flows, so the level stays put', () => {
    const { send, run, snap } = setup()
    run(10)
    send({ type: 'eStop', pressed: true })
    run(5) // let the pump coast down
    const s = snap()
    expect(s.pumpCmd).toBe(false)
    expect(s.outletOpen).toBe(false)
    expect(s.blocks).toEqual({ inlet: 'e-stop', outlet: 'e-stop' })

    const level = s.levelPct
    run(30)
    expect(Math.abs(snap().levelPct - level)).toBeLessThan(0.05)
  })

  it('emergency stop in manual leaves the operator in control of each flow', () => {
    const { send, run, snap } = setup()
    run(1)
    send({ type: 'setMode', mode: 'manual' })
    send({ type: 'eStop', pressed: true })
    run(1)
    expect(snap().alarms.map((alarm) => alarm.id)).toContain('eStop')
    expect(snap().outletOpen).toBe(true) // the valve keeps its position

    send({ type: 'start' })
    run(0.3)
    expect(snap().pumpCmd).toBe(true)
    send({ type: 'closeOutlet' })
    run(0.3)
    expect(snap().outletOpen).toBe(false)
    expect(snap().pumpCmd).toBe(true) // independent of the inlet
  })
})

describe('snapshot and subscription', () => {
  it('keeps the same snapshot object until something changes (required by useSyncExternalStore)', () => {
    const { sim, snap } = setup()
    expect(sim.getSnapshot()).toBe(sim.getSnapshot())
    const before = snap()
    sim.tick()
    expect(snap()).not.toBe(before)
  })

  it('notifies subscribers on every tick and command, and stops after unsubscribe', () => {
    const { sim, send } = setup()
    let calls = 0
    const unsubscribe = sim.subscribe(() => calls++)
    sim.tick()
    send({ type: 'setOutlet', pct: 10 })
    expect(calls).toBe(2)
    unsubscribe()
    sim.tick()
    expect(calls).toBe(2)
  })

  it('records a trend sample every 500 ms and keeps only the last two minutes', () => {
    const { run, snap } = setup()
    run(10)
    expect(snap().trend).toHaveLength(20)
    run(200)
    expect(snap().trend).toHaveLength(240)
    expect(snap().trend.at(-1)?.t).toBeCloseTo(210, 0)
  })

  it('reset returns the process and the PLC to their initial state', () => {
    const { sim, send, run, snap } = setup()
    send({ type: 'setOutlet', pct: 0 })
    run(30)
    sim.reset()
    expect(snap()).toMatchObject({ time: 0, levelPct: 50, pumpCmd: false, alarms: [] })
    expect(snap().trend).toEqual([])
    expect(snap().outletOpenPct).toBe(0) // operator settings are kept
  })

  it('sorts alarms by priority, then by time of activation', () => {
    const { send, run, snap } = setup()
    send({ type: 'setMode', mode: 'manual' })
    send({ type: 'setOutlet', pct: 0 })
    send({ type: 'start' })
    run(40) // level crosses high (priority 2) and then high-high (priority 1)
    const ids = snap().alarms.map((alarm) => alarm.id)
    expect(ids.indexOf('levelHighHigh')).toBeLessThan(ids.indexOf('levelHigh'))
  })
})
