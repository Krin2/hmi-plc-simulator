import type { Command, SimSnapshot, VisibleAlarm } from '../sim/simulator'

function stateOf(alarm: VisibleAlarm): string {
  if (!alarm.active) return 'Returned to normal, not acknowledged'
  return alarm.acked ? 'Active, acknowledged' : 'Active, not acknowledged'
}

function formatTime(seconds: number | null): string {
  if (seconds === null) return ''
  const total = Math.floor(seconds / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export default function AlarmPanel({
  snapshot,
  send,
}: {
  snapshot: SimSnapshot
  send: (command: Command) => unknown
}) {
  const { alarms, horn } = snapshot
  const unacked = alarms.filter((alarm) => !alarm.acked).length

  return (
    <section
      aria-labelledby="alarm-title"
      className="bg-panel border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="alarm-title" className="text-lg font-semibold">
          Alarms
        </h2>
        <span
          className={`rounded-full border px-3 py-0.5 font-mono text-xs ${horn ? 'border-alarm1 text-alarm1 blink' : 'border-border text-muted'}`}
          data-testid="horn"
        >
          {horn ? 'HORN ON' : 'HORN OFF'}
        </span>
      </div>

      {alarms.length === 0 ? (
        <p className="text-muted text-sm">No active alarms.</p>
      ) : (
        <ul aria-live="polite" className="flex flex-col gap-2">
          {alarms.map((alarm) => (
            <li
              key={alarm.id}
              className={`flex items-start gap-3 rounded-lg border-l-4 px-3 py-2 ${
                alarm.priority === 1 ? 'border-alarm1' : 'border-alarm2'
              } bg-bg ${!alarm.acked ? 'ring-1 ring-current' : ''}`}
            >
              {/* Priority is shown with a shape and text, never with color alone */}
              <span
                aria-hidden="true"
                className={`mt-0.5 font-mono text-xs font-bold ${alarm.priority === 1 ? 'text-alarm1' : 'text-alarm2'}`}
              >
                {alarm.priority === 1 ? '▲▲' : '▲'}
              </span>
              <div className="flex-1 text-sm">
                <p className="font-medium">
                  <span className="sr-only">
                    {alarm.priority === 1 ? 'Critical alarm: ' : 'Warning: '}
                  </span>
                  {alarm.label}
                </p>
                <p className="text-muted text-xs">
                  {stateOf(alarm)} · since {formatTime(alarm.since)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => send({ type: 'ack' })}
        disabled={unacked === 0}
        className="border-border bg-bg hover:border-accent cursor-pointer rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
      >
        Acknowledge all{unacked > 0 ? ` (${unacked})` : ''}
      </button>
    </section>
  )
}
