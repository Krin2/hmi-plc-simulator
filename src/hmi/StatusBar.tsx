const SPEEDS = [1, 2, 5, 10] as const

interface StatusBarProps {
  time: number
  running: boolean
  speed: number
  onToggle: () => void
  onSpeed: (speed: number) => void
  onReset: () => void
}

// Background colors live in separate classes: two competing bg-* utilities on one element are
// resolved by stylesheet order, not by the order they are written in className
const button = 'border-border cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium'
const idle = 'bg-bg hover:border-accent'
const selected = 'border-accent bg-accent text-accent-text'

export default function StatusBar({
  time,
  running,
  speed,
  onToggle,
  onSpeed,
  onReset,
}: StatusBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-muted font-mono text-sm" aria-label="Simulation time">
        t = {time.toFixed(1)} s
      </span>
      <button type="button" onClick={onToggle} className={`${button} ${idle}`}>
        {running ? 'Pause' : 'Run'}
      </button>
      <div role="group" aria-label="Simulation speed" className="flex gap-1">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={speed === value}
            onClick={() => onSpeed(value)}
            className={`${button} ${speed === value ? selected : idle}`}
          >
            {value}x
          </button>
        ))}
      </div>
      <button type="button" onClick={onReset} className={`${button} ${idle}`}>
        Reset simulation
      </button>
    </div>
  )
}
