import type { SimSnapshot } from '../sim/simulator'

const W = 640
const H = 220
const PAD = { left: 40, right: 12, top: 12, bottom: 30 }
const WINDOW_S = 120

export default function TrendChart({ snapshot }: { snapshot: SimSnapshot }) {
  const { trend, config, time } = snapshot
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const tMax = Math.max(time, WINDOW_S)
  const tMin = tMax - WINDOW_S

  const x = (t: number) => PAD.left + ((t - tMin) / WINDOW_S) * innerW
  const y = (pct: number) => PAD.top + innerH * (1 - pct / 100)

  const levelPath = trend
    .filter((sample) => sample.t >= tMin)
    .map(
      (sample, i) =>
        `${i === 0 ? 'M' : 'L'} ${x(sample.t).toFixed(1)} ${y(sample.level).toFixed(1)}`,
    )
    .join(' ')

  // Pump running as a band at the bottom: one rectangle per run
  const runs: { from: number; to: number }[] = []
  let open: number | null = null
  for (const sample of trend) {
    if (sample.pumpRunning && open === null) open = sample.t
    if (!sample.pumpRunning && open !== null) {
      runs.push({ from: open, to: sample.t })
      open = null
    }
  }
  if (open !== null) runs.push({ from: open, to: time })

  return (
    <figure className="bg-panel border-border rounded-xl border p-3">
      <figcaption className="text-muted mb-1 flex flex-wrap gap-x-4 px-1 text-xs">
        <span className="text-text font-semibold">Trend, last 2 minutes</span>
        <span>— level</span>
        <span>┄ start/stop setpoints</span>
        <span>▬ pump running</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Trend of the tank level over the last two minutes"
        className="w-full"
      >
        {[0, 25, 50, 75, 100].map((pct) => (
          <g key={pct}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(pct)}
              y2={y(pct)}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(pct) + 4}
              textAnchor="end"
              fontSize={10}
              fill="var(--color-muted)"
            >
              {pct}
            </text>
          </g>
        ))}
        {[0, 30, 60, 90, 120].map((offset) => (
          <text
            key={offset}
            x={x(tMin + offset)}
            y={H - 10}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-muted)"
          >
            {Math.round(tMin + offset)}s
          </text>
        ))}

        {[config.startLevel, config.stopLevel].map((pct) => (
          <line
            key={pct}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(pct)}
            y2={y(pct)}
            stroke="var(--color-process)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        ))}

        {runs.map((run) => (
          <rect
            key={run.from}
            x={x(Math.max(run.from, tMin))}
            y={H - PAD.bottom - 6}
            width={Math.max(2, x(run.to) - x(Math.max(run.from, tMin)))}
            height={6}
            fill="var(--color-process)"
          />
        ))}

        <path d={levelPath} fill="none" stroke="var(--color-liquid)" strokeWidth={2.5} />
      </svg>
    </figure>
  )
}
