import type { SimSnapshot } from '../sim/simulator'

const TANK = { x: 300, y: 70, width: 150, height: 270 }
const PUMP = { x: 130, y: 30 }
const VALVE = { x: 530, y: 310 }

const levelToY = (pct: number) => TANK.y + TANK.height * (1 - pct / 100)

function Marker({ pct, label, tone }: { pct: number; label: string; tone: 'alarm1' | 'alarm2' }) {
  const y = levelToY(pct)
  const color = tone === 'alarm1' ? 'var(--color-alarm1)' : 'var(--color-alarm2)'
  return (
    <g>
      <line
        x1={TANK.x + TANK.width}
        x2={TANK.x + TANK.width + 12}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={2}
      />
      <text x={TANK.x + TANK.width + 16} y={y + 4} fontSize={11} fill="var(--color-muted)">
        {label}
      </text>
    </g>
  )
}

function Setpoint({ pct, label }: { pct: number; label: string }) {
  const y = levelToY(pct)
  return (
    <g>
      <path d={`M ${TANK.x - 6} ${y} l -12 -6 v 12 z`} fill="var(--color-text)" />
      <text x={TANK.x - 22} y={y + 4} fontSize={11} textAnchor="end" fill="var(--color-muted)">
        {label}
      </text>
    </g>
  )
}

export default function ProcessView({ snapshot }: { snapshot: SimSnapshot }) {
  const { config, pumpRunning, pumpCmd, levelPct, measuredLevel, sensorFault } = snapshot
  const fillY = levelToY(levelPct)
  const pumpTripped =
    pumpCmd && !pumpRunning && snapshot.alarms.some((a) => a.id === 'pumpFailToStart')
  const pumpState = pumpRunning
    ? 'RUN'
    : pumpTripped || snapshot.pumpFaultInjected
      ? 'FAULT'
      : 'STOP'
  const pumpFill = pumpRunning ? 'var(--color-text)' : 'var(--color-panel)'
  const pumpStroke = pumpState === 'FAULT' ? 'var(--color-alarm1)' : 'var(--color-process)'
  const outletFlowing = snapshot.outletOpenPct > 0 && levelPct > 0.5

  // The transmitter noise can read slightly below zero in an empty tank; show 0.0 instead of -0.1
  const reading = sensorFault ? 'BAD' : `${Math.max(0, measuredLevel).toFixed(1)} %`

  return (
    <figure className="bg-panel border-border rounded-xl border p-3">
      <svg
        viewBox="0 0 640 380"
        role="img"
        aria-label={`Process diagram: tank at ${levelPct.toFixed(0)} percent, pump ${pumpState.toLowerCase()}, outlet valve ${snapshot.outletOpenPct.toFixed(0)} percent open`}
        className="w-full"
      >
        {/* Inlet pipe: source -> pump -> tank */}
        <path
          d={`M 20 ${PUMP.y} H ${PUMP.x - 24} M ${PUMP.x + 24} ${PUMP.y} H ${TANK.x + 75} V ${TANK.y}`}
          fill="none"
          stroke="var(--color-process)"
          strokeWidth={8}
        />
        {pumpRunning && (
          <path
            d={`M 20 ${PUMP.y} H ${PUMP.x - 24} M ${PUMP.x + 24} ${PUMP.y} H ${TANK.x + 75} V ${TANK.y + 10}`}
            fill="none"
            stroke="var(--color-liquid)"
            strokeWidth={3}
            strokeDasharray="8 16"
            className="flow"
          />
        )}
        <text x={20} y={PUMP.y - 14} fontSize={11} fill="var(--color-muted)">
          Supply
        </text>

        {/* Pump P-101 */}
        <circle
          cx={PUMP.x}
          cy={PUMP.y}
          r={24}
          fill={pumpFill}
          stroke={pumpStroke}
          strokeWidth={3}
        />
        <path
          d={`M ${PUMP.x - 9} ${PUMP.y - 12} L ${PUMP.x + 13} ${PUMP.y} L ${PUMP.x - 9} ${PUMP.y + 12} z`}
          fill={pumpRunning ? 'var(--color-bg)' : 'var(--color-process)'}
        />
        <text
          x={PUMP.x}
          y={PUMP.y + 44}
          textAnchor="middle"
          fontSize={12}
          fill="var(--color-text)"
          className={pumpState === 'FAULT' ? 'blink' : undefined}
          fontWeight={600}
        >
          P-101 {pumpState}
        </text>

        {/* Tank T-101 */}
        <rect
          x={TANK.x}
          y={TANK.y}
          width={TANK.width}
          height={TANK.height}
          fill="var(--color-bg)"
          stroke="var(--color-process)"
          strokeWidth={4}
          rx={6}
        />
        <rect
          x={TANK.x + 2}
          y={fillY}
          width={TANK.width - 4}
          height={Math.max(0, TANK.y + TANK.height - fillY - 2)}
          fill="var(--color-liquid)"
          opacity={0.9}
        />
        <line
          x1={TANK.x + 2}
          x2={TANK.x + TANK.width - 2}
          y1={fillY}
          y2={fillY}
          stroke="var(--color-text)"
          strokeWidth={1.5}
        />
        <text
          x={TANK.x + TANK.width / 2}
          y={TANK.y - 12}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill="var(--color-text)"
        >
          T-101
        </text>

        {/* Level readout (large, in the middle of the tank) */}
        <rect
          x={TANK.x + 25}
          y={TANK.y + 110}
          width={100}
          height={36}
          rx={4}
          fill="var(--color-bg)"
          opacity={0.85}
        />
        <text
          x={TANK.x + TANK.width / 2}
          y={TANK.y + 136}
          textAnchor="middle"
          fontSize={22}
          fontWeight={600}
          fontFamily="var(--font-mono)"
          fill={sensorFault ? 'var(--color-alarm1)' : 'var(--color-text)'}
          className={sensorFault ? 'blink' : undefined}
        >
          {reading}
        </text>

        {/* Alarm limits (right) and auto setpoints (left) */}
        <Marker pct={config.thresholds.highHigh} label="HH" tone="alarm1" />
        <Marker pct={config.thresholds.high} label="H" tone="alarm2" />
        <Marker pct={config.thresholds.low} label="L" tone="alarm2" />
        <Marker pct={config.thresholds.lowLow} label="LL" tone="alarm1" />
        <Setpoint pct={config.stopLevel} label={`Stop ${config.stopLevel}%`} />
        <Setpoint pct={config.startLevel} label={`Start ${config.startLevel}%`} />

        {/* Outlet pipe and valve to the consumer */}
        <path
          d={`M ${TANK.x + TANK.width} ${VALVE.y} H ${VALVE.x - 20} M ${VALVE.x + 20} ${VALVE.y} H 620`}
          fill="none"
          stroke="var(--color-process)"
          strokeWidth={8}
        />
        {outletFlowing && (
          <path
            d={`M ${TANK.x + TANK.width} ${VALVE.y} H ${VALVE.x - 20} M ${VALVE.x + 20} ${VALVE.y} H 620`}
            fill="none"
            stroke="var(--color-liquid)"
            strokeWidth={3}
            strokeDasharray="8 16"
            className="flow"
          />
        )}
        <path
          d={`M ${VALVE.x - 20} ${VALVE.y - 14} L ${VALVE.x + 20} ${VALVE.y + 14} V ${VALVE.y - 14} L ${VALVE.x - 20} ${VALVE.y + 14} z`}
          fill="var(--color-panel)"
          stroke="var(--color-process)"
          strokeWidth={3}
        />
        <text
          x={VALVE.x}
          y={VALVE.y + 38}
          textAnchor="middle"
          fontSize={12}
          fill="var(--color-text)"
          fontWeight={600}
        >
          XV-101 {snapshot.outletOpenPct.toFixed(0)}%
        </text>
        <text x={620} y={VALVE.y - 14} textAnchor="end" fontSize={11} fill="var(--color-muted)">
          Consumer
        </text>
      </svg>
      <figcaption className="text-muted px-1 pt-1 text-xs">
        Level shown as read by the PLC. Triangles on the left are the auto start and stop levels;
        marks on the right are the alarm limits.
      </figcaption>
    </figure>
  )
}
