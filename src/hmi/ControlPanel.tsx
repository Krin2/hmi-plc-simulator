import { useState, type FormEvent, type ReactNode } from 'react'
import type { Command, CommandResult, SimSnapshot } from '../sim/simulator'

interface ControlPanelProps {
  snapshot: SimSnapshot
  send: (command: Command) => CommandResult
}

// Background colors live in separate classes: two competing bg-* utilities on one element are
// resolved by stylesheet order, not by the order they are written in className
const button =
  'border-border cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40'
const idle = 'bg-bg hover:border-accent'
const selected = 'border-accent bg-accent text-accent-text'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="border-border flex flex-col gap-2 rounded-lg border p-3">
      <legend className="text-muted px-1 text-xs tracking-wide uppercase">{title}</legend>
      {children}
    </fieldset>
  )
}

export default function ControlPanel({ snapshot, send }: ControlPanelProps) {
  const { mode, config } = snapshot
  const auto = mode === 'auto'
  const [startLevel, setStartLevel] = useState(String(config.startLevel))
  const [stopLevel, setStopLevel] = useState(String(config.stopLevel))
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  const applySetpoints = (event: FormEvent) => {
    event.preventDefault()
    const result = send({
      type: 'setSetpoints',
      startLevel: Number(startLevel),
      stopLevel: Number(stopLevel),
    })
    setError(result.ok ? null : result.error)
    setApplied(result.ok)
  }

  return (
    <section
      aria-labelledby="control-title"
      className="bg-panel border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 id="control-title" className="text-lg font-semibold">
        Operator controls
      </h2>

      <Group title="Mode">
        <div className="flex gap-2" role="group" aria-label="Control mode">
          {(['auto', 'manual'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => send({ type: 'setMode', mode: value })}
              className={`${button} flex-1 capitalize ${mode === value ? selected : idle}`}
            >
              {value}
            </button>
          ))}
        </div>
      </Group>

      <Group title="Inlet: pump P-101 (manual mode)">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={auto}
            onClick={() => send({ type: 'start' })}
            className={`${button} ${idle} flex-1`}
          >
            Open inlet
          </button>
          <button
            type="button"
            disabled={auto}
            onClick={() => send({ type: 'stop' })}
            className={`${button} ${idle} flex-1`}
          >
            Close inlet
          </button>
        </div>
        <p className="text-muted text-xs">
          {auto
            ? 'Switch to manual mode to open or close the inlet yourself.'
            : 'The inlet cannot be opened while the level is at HH (until it falls below H).'}
        </p>
      </Group>

      <Group title="Outlet: valve XV-101">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={auto}
            onClick={() => send({ type: 'openOutlet' })}
            className={`${button} ${idle} flex-1`}
          >
            Open outlet
          </button>
          <button
            type="button"
            disabled={auto}
            onClick={() => send({ type: 'closeOutlet' })}
            className={`${button} ${idle} flex-1`}
          >
            Close outlet
          </button>
        </div>
        <p className="text-muted text-xs">
          {auto
            ? 'In auto the outlet stays open unless an interlock closes it.'
            : 'The outlet cannot be opened while the level is at LL (until it rises above L).'}
        </p>
        <div className="flex justify-between text-sm">
          <label htmlFor="outlet">Opening</label>
          <output htmlFor="outlet" className="font-mono">
            {snapshot.outletOpenPct.toFixed(0)} %
          </output>
        </div>
        <input
          id="outlet"
          type="range"
          min={0}
          max={100}
          step={5}
          value={snapshot.outletOpenPct}
          onChange={(event) => send({ type: 'setOutlet', pct: Number(event.target.value) })}
          className="accent-[var(--color-accent)]"
        />
      </Group>

      <form onSubmit={applySetpoints} noValidate>
        <Group title="Auto setpoints (% level)">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              Start at or below
              <input
                type="number"
                inputMode="numeric"
                value={startLevel}
                onChange={(event) => {
                  setStartLevel(event.target.value)
                  setApplied(false)
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'setpoint-error' : undefined}
                className="bg-bg border-border rounded-lg border px-3 py-1.5 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Stop at or above
              <input
                type="number"
                inputMode="numeric"
                value={stopLevel}
                onChange={(event) => {
                  setStopLevel(event.target.value)
                  setApplied(false)
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'setpoint-error' : undefined}
                className="bg-bg border-border rounded-lg border px-3 py-1.5 font-mono"
              />
            </label>
          </div>
          {error && (
            <p id="setpoint-error" role="alert" className="text-alarm1 text-xs">
              {error}
            </p>
          )}
          {applied && (
            <p role="status" className="text-muted text-xs">
              Setpoints applied.
            </p>
          )}
          <button type="submit" className={`${button} ${idle}`}>
            Apply setpoints
          </button>
        </Group>
      </form>

      <Group title="Safety">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={snapshot.eStopPressed}
            onClick={() => send({ type: 'eStop', pressed: !snapshot.eStopPressed })}
            className={`${button} flex-1 ${snapshot.eStopPressed ? 'border-alarm1 bg-alarm1 text-accent-text' : `${idle} text-alarm1`}`}
          >
            {snapshot.eStopPressed ? 'Release emergency stop' : 'Emergency stop'}
          </button>
          <button
            type="button"
            onClick={() => send({ type: 'reset' })}
            className={`${button} ${idle} flex-1`}
          >
            Reset trips
          </button>
        </div>
        <p className="text-muted text-xs">
          In auto, the emergency stop closes both the inlet and the outlet. In manual, the operator
          keeps control of each flow; only the HH and LL cut-offs and a failed level signal still
          hold them closed.
        </p>
      </Group>
    </section>
  )
}
