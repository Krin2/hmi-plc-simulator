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
    expect(rows).toHaveLength(8) // header + 7 rungs
    expect(screen.getByText('Pump command')).toBeInTheDocument()
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
  it('only enables the pump buttons in manual mode', async () => {
    setup()
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('starts and stops the pump from the HMI', async () => {
    const { advance } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'manual' }))
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    advance(4)
    expect(screen.getByText('P-101 RUN')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    advance(8)
    expect(screen.getByText('P-101 STOP')).toBeInTheDocument()
  })

  it('moves the outlet valve with the slider', () => {
    setup()
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

describe('reset', () => {
  it('returns the simulation to its initial state', async () => {
    const { advance } = setup()
    advance(30)
    await userEvent.click(screen.getByRole('button', { name: 'Reset simulation' }))
    expect(screen.getByLabelText('Simulation time')).toHaveTextContent('t = 0.0 s')
  })
})
