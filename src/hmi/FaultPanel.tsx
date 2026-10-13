import type { Command, SimSnapshot } from '../sim/simulator'

export default function FaultPanel({
  snapshot,
  send,
}: {
  snapshot: SimSnapshot
  send: (command: Command) => unknown
}) {
  return (
    <section aria-labelledby="fault-title" className="bg-panel border-border rounded-xl border p-4">
      <h2 id="fault-title" className="text-lg font-semibold">
        Simulate field faults
      </h2>
      <p className="text-muted mb-3 text-xs">
        Break something in the field and watch how the PLC program and the alarms react.
      </p>
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={snapshot.pumpFaultInjected}
            onChange={(event) => send({ type: 'fault', fault: 'pump', on: event.target.checked })}
            className="mt-1 size-4 accent-[var(--color-accent)]"
          />
          <span>
            Pump P-101 cannot run
            <span className="text-muted block text-xs">
              The motor does not start, so the PLC never receives the running feedback.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={snapshot.sensorFault}
            onChange={(event) => send({ type: 'fault', fault: 'sensor', on: event.target.checked })}
            className="mt-1 size-4 accent-[var(--color-accent)]"
          />
          <span>
            Level transmitter wire break
            <span className="text-muted block text-xs">
              The 4-20 mA signal drops below 4 mA and the PLC must not trust the level.
            </span>
          </span>
        </label>
      </div>
    </section>
  )
}
