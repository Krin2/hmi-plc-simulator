import type { SimSnapshot } from '../sim/simulator'

/** Live view of the PLC program: one row per rung with its logic and current state. */
export default function LogicView({ snapshot }: { snapshot: SimSnapshot }) {
  return (
    <section aria-labelledby="logic-title" className="bg-panel border-border rounded-xl border p-4">
      <h2 id="logic-title" className="text-lg font-semibold">
        PLC program (live)
      </h2>
      <p className="text-muted mb-3 text-xs">
        Scan cycle: read inputs, solve the rungs top to bottom, write outputs, every 100 ms.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted text-xs uppercase">
            <tr>
              <th scope="col" className="py-1 pr-3">
                State
              </th>
              <th scope="col" className="py-1 pr-3">
                Rung
              </th>
              <th scope="col" className="py-1">
                Logic
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.rungs.map((rung) => (
              <tr key={rung.id} className="border-border border-t align-top">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">
                  <span aria-hidden="true" className={rung.energized ? 'text-text' : 'text-border'}>
                    {rung.energized ? '●' : '○'}
                  </span>{' '}
                  <span className={rung.energized ? 'text-text' : 'text-muted'}>
                    {rung.energized ? 'ON' : 'OFF'}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  {rung.label}
                  {rung.detail && (
                    <span className="text-muted block font-mono text-xs">{rung.detail}</span>
                  )}
                </td>
                <td className="text-muted py-2 font-mono text-xs">{rung.logic}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
