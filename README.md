# HMI / PLC simulator

Interactive simulator of a **tank level control** system: a PLC program with scan cycle, interlocks and acknowledged alarms drives a simulated process (tank, pump, valve), and an operator HMI shows and controls it. Everything is plain TypeScript running in the browser, and every behavior is covered by tests.

Live demo: https://krin2.github.io/hmi-plc-simulator/ (after the first deployment)

It brings together two backgrounds: ten years of industrial automation (PLCs, HMIs, safety interlocks, ISA-style alarm handling) and modern React + TypeScript development.

## The process

Pump P-101 fills tank T-101; the consumer drains it through valve XV-101. A level transmitter feeds the PLC, which commands the pump.

| Mode       | Behavior                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auto**   | The pump starts at or below the _start level_ and stops at or above the _stop level_ (hysteresis, so it does not chatter).                                      |
| **Manual** | The operator starts and stops the pump with push buttons. The run latch drops on stop, on a trip and when leaving manual, so the pump never restarts by itself. |

## The PLC program (`src/plc`)

`scan(state, inputs, config, dt)` is one scan cycle: read inputs, solve the rungs top to bottom, write outputs. It is a **pure function**, so it is deterministic and easy to test. The HMI shows every rung live, with its logic and state.

- **Interlocks** that stop the pump in every mode: level high-high, pump lockout, latched emergency stop, and a failed level signal.
- **Emergency stop** latches and needs release _and_ a deliberate reset.
- **Pump feedback timer** (`TON`, IEC 61131-3 semantics): if the pump is commanded but never reports "running" within 3 s, it is locked out until reset.
- **Rising-edge push buttons**: a held button acts once, like a real `R_TRIG`.
- **Sensor validation**: a signal outside the transmitter range (a broken 4-20 mA loop) is a failure, not a level; level alarms are suppressed because the reading is not valid and the pump stops fail-safe.

### Alarms (ISA-18.2 life cycle)

Seven alarms with priorities (critical / warning). A new alarm needs acknowledgement and sounds the horn; an alarm that returns to normal stays on the list until acknowledged, unless it was already acknowledged; a repeat occurrence needs a new acknowledgement.

## The process model (`src/process`)

Mass balance with a pump that ramps up (first-order lag) and an outlet that follows Torricelli's law (outflow grows with the square root of the level). The pump at full speed outpaces a fully open valve, which is exactly why the high-high interlock exists. A deterministic pseudo-noise makes the transmitter reading realistic and runs reproducible.

## The HMI (`src/hmi`)

Designed after high-performance HMI principles (ISA-101): a calm grey screen where normal states are neutral and **color is reserved for abnormal situations**. Alarm priority is also shown with shapes (▲▲ / ▲) and text, never with color alone; the alarm banner and list are live regions; every control is a native element and works with the keyboard; animations respect `prefers-reduced-motion`.

Try the fault panel: break the pump or the level transmitter and watch the PLC rungs, the banner and the alarm list react, then acknowledge and reset.

## Tests

```bash
npm test
```

| Layer                       | What is checked                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/plc/program.test.ts`   | Hysteresis, manual latches, every interlock, E-stop reset, pump feedback timeout and lockout, alarm life cycle, edge detection |
| `src/process/tank.test.ts`  | Mass balance, pump ramp, level limits, sensor model                                                                            |
| `src/sim/simulator.test.ts` | Closed loop over minutes of simulated time, fault scenarios end to end, setpoint validation, snapshots and subscriptions       |
| `src/App.test.tsx`          | Operator workflows through the UI with Testing Library                                                                         |

The simulator advances by explicit ticks, so tests run minutes of plant time in milliseconds.

## Scripts

```bash
npm install
npm run dev        # development server
npm test           # all tests
npm run lint       # ESLint
npm run format     # Prettier
npm run build      # type-check and production build
```

## Deployment

`.github/workflows/deploy.yml` runs lint, format check, tests and build on every push and publishes `dist/` to GitHub Pages from `master`. In the repository settings enable **Actions** and set **Pages > Source** to **GitHub Actions**. The Vite `base` (`/hmi-plc-simulator/`) must match the repository name.

## Limitations

This is a simulation to demonstrate control logic and HMI design. It is not a certified safety function and must not be used in a real plant. Browsers throttle timers in background tabs; the clock compensates by running the ticks it owes, up to a limit.

## Tech

React 19 · TypeScript (strict) · Tailwind CSS 4 · Vite · Vitest · Testing Library
