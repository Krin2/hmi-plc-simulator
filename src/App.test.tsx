// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach } from 'vitest'
import App from './App'
import { Simulator, TICK_MS } from './sim/simulator'

afterEach(cleanup)

function setup() {
  const simulator = new Simulator()
  // The tests drive time by hand: no real-time clock, so they are fast and deterministic
  render(<App simulator={simulator} autoRun={false} />)
  const advance = (seconds: number) =>
    act(() => {
      for (let i = 0; i < (seconds * 1000) / TICK_MS; i++) simulator.tick()
    })
  return { simulator, advance }
}

const banner = () => screen.getByTestId('alarm-banner')

describe('HMI', () => {
  it('shows the process, the controls, the alarms and the PLC program', () => {
    setup()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('tank T-101 level control')
    expect(
      screen.getByRole('img', { name: /Process diagram: tank at 50 percent/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operator controls' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Alarms' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'PLC program (live)' })).toBeInTheDocument()
    expect(screen.getByText('No active alarms.')).toBeInTheDocument()
    expect(banner()).toHaveTextContent('No unacknowledged alarms')
    expect(screen.getByRole('button', { name: 'auto' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('lists the rungs of the PLC program once it has scanned', () => {
    const { advance } = setup()
    advance(0.1)
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows).toHaveLength(13) // header + 12 rungs
    expect(screen.getByText('Inlet: pump command')).toBeInTheDocument()
    expect(screen.getByText('Outlet: valve open command')).toBeInTheDocument()
    expect(screen.getByText(/TON\(PUMP_CMD AND NOT PUMP_RUN, 3 s\)/)).toBeInTheDocument()
  })

  it('advances the clock display and the trend as the simulation runs', () => {
    const { advance } = setup()
    advance(10)
    expect(screen.getByLabelText('Simulation time')).toHaveTextContent('t = 10.0 s')
    const trend = screen.getByRole('img', { name: /Trend of the tank level/ })
    expect(trend.querySelector('path')?.getAttribute('d')).toMatch(/^M /)
  })

  it('pauses and resumes, and picks the simulation speed', async () => {
    setup()
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }))

    await userEvent.click(screen.getByRole('button', { name: '5x' }))
    expect(screen.getByRole('button', { name: '5x' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '1x' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('manual operation', () => {
  const manualButtons = ['Open inlet', 'Close inlet', 'Open outlet', 'Close outlet']

  it('only enables the inlet and outlet buttons in manual mode', async () => {
    setup()
    for (const name of manualButtons) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    for (const name of manualButtons) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
  })

  it('opens and closes the inlet from the HMI', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open inlet' }))
    advance(4)
    expect(screen.getByText('P-101 RUN')).toBeInTheDocument()
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet open')

    await userEvent.click(screen.getByRole('button', { name: 'Close inlet' }))
    advance(8)
    expect(screen.getByText('P-101 STOP')).toBeInTheDocument()
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed by operator')
  })

  it('opens and closes the outlet independently of the inlet', async () => {
    const { advance } = setup()
    advance(0.5)
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 60%')

    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    advance(0.5)
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 60%') // keeps its position

    await userEvent.click(screen.getByRole('button', { name: 'Close outlet' }))
    advance(0.5)
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 CLOSED by operator')
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed by operator')

    await userEvent.click(screen.getByRole('button', { name: 'Open outlet' }))
    advance(0.5)
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 60%')
  })

  it('moves the outlet valve with the slider', () => {
    const { advance } = setup()
    advance(0.5)
    const slider = screen.getByLabelText('Opening')
    expect(slider).toHaveValue('60')
    // userEvent cannot drag a range input, so fire the change event the browser would send
    fireEvent.change(slider, { target: { value: '25' } })
    expect(slider).toHaveValue('25')
    expect(screen.getByText('XV-101 25%')).toBeInTheDocument()
    expect(screen.getByText('25 %', { selector: 'output' })).toBeInTheDocument()
  })
})

describe('setpoints', () => {
  it('applies valid setpoints', async () => {
    setup()
    const start = screen.getByLabelText('Start at or below')
    const stop = screen.getByLabelText('Stop at or above')
    await userEvent.clear(start)
    await userEvent.type(start, '40')
    await userEvent.clear(stop)
    await userEvent.type(stop, '70')
    await userEvent.click(screen.getByRole('button', { name: 'Apply setpoints' }))

    expect(screen.getByText('Setpoints applied.')).toBeInTheDocument()
    expect(screen.getByText('Start 40%')).toBeInTheDocument()
    expect(screen.getByText('Stop 70%')).toBeInTheDocument()
  })

  it('explains why invalid setpoints are rejected and keeps the old ones', async () => {
    setup()
    const stop = screen.getByLabelText('Stop at or above')
    await userEvent.clear(stop)
    await userEvent.type(stop, '90')
    await userEvent.click(screen.getByRole('button', { name: 'Apply setpoints' }))

    expect(screen.getByRole('alert')).toHaveTextContent('high alarm')
    expect(stop).toBeInvalid()
    expect(screen.getByText('Stop 75%')).toBeInTheDocument()
  })
})

describe('alarms', () => {
  it('emergency stop: critical banner, horn, acknowledge, release and reset', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Emergency stop' }))
    advance(0.5)

    expect(banner()).toHaveTextContent('CRITICAL: Emergency stop activated')
    expect(screen.getByTestId('horn')).toHaveTextContent('HORN ON')
    expect(screen.getByText('Emergency stop activated', { selector: 'p' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Acknowledge all \(1\)/ }))
    advance(0.3)
    expect(screen.getByTestId('horn')).toHaveTextContent('HORN OFF')
    expect(banner()).toHaveTextContent('No unacknowledged alarms')
    expect(screen.getByText(/Active, acknowledged/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Release emergency stop' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset trips' }))
    advance(0.5)
    expect(screen.getByText('No active alarms.')).toBeInTheDocument()
  })

  it('pump failure: alarm after the timeout, with the PLC rung showing the timer', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Pump P-101 cannot run/ }))
    advance(150)

    expect(banner()).toHaveTextContent('CRITICAL: Pump P-101 failed to run')
    expect(screen.getByText('P-101 FAULT')).toBeInTheDocument()
    const row = screen.getByText('Pump lockout').closest('tr') as HTMLElement
    expect(within(row).getByText('ON')).toBeInTheDocument()
  })

  it('sensor failure shows a bad reading and a critical alarm', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Level transmitter wire break/ }))
    advance(0.5)

    expect(screen.getByText('BAD')).toBeInTheDocument()
    expect(banner()).toHaveTextContent('Level sensor failure')
  })

  it('shows priority with text for assistive technology, not only with color', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Emergency stop' }))
    advance(0.5)
    expect(screen.getByText('Critical alarm:')).toBeInTheDocument()
  })
})

describe('level switches and cut-offs', () => {
  const sw = (label: string) => screen.getByTestId(`switch-${label}`)

  it('marks every level switch as ON only while the level is beyond its limit', async () => {
    const { advance } = setup()
    advance(0.5)
    for (const label of ['HH', 'H', 'L', 'LL'])
      expect(sw(label)).toHaveAttribute('data-active', 'false')

    // Fill with the outlet closed: H and then HH switch on, in that order
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close outlet' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open inlet' }))
    advance(14)
    expect(sw('H')).toHaveAttribute('data-active', 'true')
    expect(sw('HH')).toHaveAttribute('data-active', 'false')
    expect(screen.getByText('H ON')).toBeInTheDocument()

    advance(10)
    expect(sw('HH')).toHaveAttribute('data-active', 'true')
    expect(screen.getByText('HH ON')).toBeInTheDocument()
  })

  it('HH closes the inlet, and it stays closed until the level is back below H', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close outlet' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open inlet' }))
    advance(25)
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed: HH level')

    // Open the outlet wide: the level falls, the HH switch goes off but the inlet stays closed
    fireEvent.change(screen.getByLabelText('Opening'), { target: { value: '100' } })
    await userEvent.click(screen.getByRole('button', { name: 'Open outlet' }))
    advance(3)
    expect(sw('HH')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed: HH level')

    advance(10)
    expect(sw('H')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed by operator')
  })

  it('LL closes the outlet', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /Pump P-101 cannot run/ }))
    advance(250)

    expect(sw('LL')).toHaveAttribute('data-active', 'true')
    expect(screen.getByText('LL ON')).toBeInTheDocument()
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 CLOSED: LL level')
  })

  it('in auto, the emergency stop closes both the inlet and the outlet', async () => {
    const { advance } = setup()
    advance(0.5)
    await userEvent.click(screen.getByRole('button', { name: 'Emergency stop' }))
    advance(0.5)
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet closed: emergency stop')
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 CLOSED: emergency stop')
  })

  it('in manual, the emergency stop leaves each flow under operator control', async () => {
    const { advance } = setup()
    advance(0.5) // the PLC scans in auto first, so the outlet is open when manual starts
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    await userEvent.click(screen.getByRole('button', { name: 'Emergency stop' }))
    advance(0.5)
    expect(banner()).toHaveTextContent('Emergency stop activated')

    await userEvent.click(screen.getByRole('button', { name: 'Open inlet' }))
    advance(0.5)
    expect(screen.getByTestId('inlet-state')).toHaveTextContent('Inlet open')
    expect(screen.getByTestId('outlet-state')).toHaveTextContent('XV-101 60%')
  })
})

describe('reset', () => {
  it('returns the simulation to its initial state', async () => {
    const { advance } = setup()
    advance(30)
    await userEvent.click(screen.getByRole('button', { name: 'Reset simulation' }))
    expect(screen.getByLabelText('Simulation time')).toHaveTextContent('t = 0.0 s')
  })
})
