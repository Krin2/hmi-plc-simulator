import { useState } from 'react'
import AlarmPanel from './hmi/AlarmPanel'
import ControlPanel from './hmi/ControlPanel'
import FaultPanel from './hmi/FaultPanel'
import LogicView from './hmi/LogicView'
import ProcessView from './hmi/ProcessView'
import StatusBar from './hmi/StatusBar'
import TrendChart from './hmi/TrendChart'
import { Simulator } from './sim/simulator'
import { useSimulationClock, useSimulator } from './sim/useSimulator'

interface AppProps {
  /** Injected in tests; the app creates its own simulator otherwise */
  simulator?: Simulator
  /** Tests drive the simulation by hand instead of with a real-time clock */
  autoRun?: boolean
}

export default function App({ simulator: injected, autoRun = true }: AppProps) {
  const [simulator] = useState(() => injected ?? new Simulator())
  const [running, setRunning] = useState(autoRun)
  const [speed, setSpeed] = useState(1)

  useSimulationClock(simulator, running, speed)
  const snapshot = useSimulator(simulator)
  const send = simulator.command.bind(simulator)

  const critical = snapshot.alarms.find((alarm) => !alarm.acked && alarm.priority === 1)
  const banner = critical ?? snapshot.alarms.find((alarm) => !alarm.acked)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-[clamp(1rem,3vw,2rem)] py-6">
      <header className="flex flex-col gap-3">
        <div>
          <p className="text-accent text-xs tracking-[0.15em] uppercase">Interactive demo</p>
          <h1 className="text-2xl font-semibold">HMI / PLC simulator: tank T-101 level control</h1>
          <p className="text-muted max-w-3xl text-sm">
            A PLC program (scan cycle, hysteresis control, interlocks and acknowledged alarms)
            drives a simulated tank, pump and valve, and an operator HMI shows and controls it. The
            logic is plain TypeScript and every behavior is covered by tests.
          </p>
        </div>
        <StatusBar
          time={snapshot.time}
          running={running}
          speed={speed}
          onToggle={() => setRunning((value) => !value)}
          onSpeed={setSpeed}
          onReset={() => simulator.reset()}
        />
      </header>

      {/* Alarm banner: always at the top of an operator screen */}
      <div
        role="status"
        aria-live="polite"
        data-testid="alarm-banner"
        className={`rounded-lg border px-4 py-2 text-sm font-medium ${
          banner
            ? `${banner.priority === 1 ? 'border-alarm1 text-alarm1' : 'border-alarm2 text-alarm2'} ${snapshot.horn ? 'blink' : ''}`
            : 'border-border text-muted'
        }`}
      >
        {banner
          ? `${banner.priority === 1 ? 'CRITICAL' : 'WARNING'}: ${banner.label}`
          : 'No unacknowledged alarms'}
      </div>

      <main className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-4">
          <ProcessView snapshot={snapshot} />
          <TrendChart snapshot={snapshot} />
        </div>
        <div className="flex flex-col gap-4">
          <ControlPanel snapshot={snapshot} send={send} />
          <AlarmPanel snapshot={snapshot} send={send} />
        </div>
        <div className="lg:col-span-2 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <LogicView snapshot={snapshot} />
          <FaultPanel snapshot={snapshot} send={send} />
        </div>
      </main>

      <footer className="text-muted border-border border-t pt-4 text-xs">
        Built with React, TypeScript and Tailwind. Simulation only: not for use in a real plant.
      </footer>
    </div>
  )
}
