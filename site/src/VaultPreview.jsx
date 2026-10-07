import { useRef, useState } from "react";
import FlowSteps from "./FlowSteps";
import {
  ArrowUpRight,
  ChevronRight,
  LockKeyhole,
  Power,
  RotateCcw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
  MAX_BUDGET,
  STEP,
  PER_TX,
  DEFAULT_BUDGET,
  formatSats,
  normalizeBudget,
  budgetFromDrag,
  checkDemo,
} from "./bowlDemo";

const README = "https://github.com/futureman19/dogfood-wallet#readme";

function BowlDial({ budget, onChange }) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const fraction = budget / MAX_BUDGET;
  const angle = ((135 + fraction * 270) * Math.PI) / 180;
  const x = 90 + 77 * Math.cos(angle);
  const y = 90 + 77 * Math.sin(angle);
  function finish() {
    drag.current = null;
    setDragging(false);
  }
  function onKeyDown(event) {
    const changes = {
      ArrowRight: STEP,
      ArrowUp: STEP,
      ArrowLeft: -STEP,
      ArrowDown: -STEP,
      PageUp: STEP * 10,
      PageDown: -STEP * 10,
    };
    if (event.key === "Home" || event.key === "End" || event.key in changes) {
      event.preventDefault();
      onChange(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? MAX_BUDGET
            : normalizeBudget(budget + changes[event.key]),
      );
    }
  }
  return (
    <div className="dial-wrap">
      <div
        className={`bowl-display bowl-dial${dragging ? " is-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Demo daily allowance"
        aria-valuemin={0}
        aria-valuemax={MAX_BUDGET}
        aria-valuenow={budget}
        aria-valuetext={`${formatSats(budget)} sats per day, demo only`}
        aria-orientation="horizontal"
        aria-describedby="dial-help"
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            budget,
            width: event.currentTarget.clientWidth,
            id: event.pointerId,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (drag.current?.id === event.pointerId)
            onChange(
              budgetFromDrag(
                drag.current.budget,
                event.clientX - drag.current.x,
                drag.current.width,
              ),
            );
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      >
        <svg className="dial-ring" viewBox="0 0 180 180" aria-hidden="true">
          <circle
            className="dial-track"
            cx="90"
            cy="90"
            r="77"
            pathLength="100"
            strokeDasharray="75 100"
            transform="rotate(135 90 90)"
          />
          <circle
            className="dial-fill"
            cx="90"
            cy="90"
            r="77"
            pathLength="100"
            strokeDasharray={`${fraction * 75} 100`}
            transform="rotate(135 90 90)"
          />
          <circle className="dial-handle-halo" cx={x} cy={y} r="12" />
          <circle className="dial-handle" cx={x} cy={y} r="6" />
        </svg>
        <img src="/cyber-bowl.png" alt="" draggable="false" />
        <span className="dial-caption">FEED THE BOWL</span>
      </div>
      <p id="dial-help">
        ← Drag to set sats →<br />
        <span>or use the arrow keys</span>
      </p>
    </div>
  );
}

export default function VaultPreview() {
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [allowed, setAllowed] = useState(false);
  const [spent, setSpent] = useState(0);
  const [result, setResult] = useState(null);
  const remaining = Math.max(0, budget - spent);
  function changeBudget(value) {
    setBudget(value);
    setResult(null);
  }
  function simulate(amount) {
    const verdict = checkDemo({ budget, spent, allowed, amount });
    if (verdict.ok) setSpent(spent + amount);
    setResult({ ...verdict, amount });
  }
  function reset() {
    setBudget(DEFAULT_BUDGET);
    setAllowed(false);
    setSpent(0);
    setResult(null);
  }
  return (
    <section
      className="preview"
      aria-label="Interactive local vault demo — no real funds"
    >
      <div className="preview-caption">
        <span className="status-dot" /> TRY THE LOCAL VAULT{" "}
        <span>BROWSER DEMO / NO REAL FUNDS</span>
      </div>
      <FlowSteps />
      <div className="vault-panel interactive-vault">
        <div className="vault-heading">
          <span>
            <LockKeyhole size={14} /> LOCAL AGENT BOWL VAULT
          </span>
          <button
            className="demo-reset"
            onClick={reset}
            aria-label="Reset demo"
          >
            <RotateCcw size={13} /> Reset
          </button>
        </div>
        <div className="vault-body">
          <BowlDial budget={budget} onChange={changeBudget} />
          <div className="vault-controls">
            <div className="cap-label">DEMO DAILY ALLOWANCE</div>
            <div className="cap-value">
              <output aria-live="off">{formatSats(budget)}</output>{" "}
              <span>sats</span>
            </div>
            <div className="cap-note">
              {formatSats(PER_TX)} sats per transaction
            </div>
            <div className="budget-presets" aria-label="Demo budget presets">
              {[5000, 25000, 50000].map((value) => (
                <button
                  key={value}
                  aria-pressed={budget === value}
                  onClick={() => changeBudget(value)}
                >
                  {value / 1000}k
                </button>
              ))}
            </div>
            <a
              className="kill-switch"
              href={README}
              aria-label="Kill switch — read the documentation"
            >
              <Power size={15} /> KILL SWITCH <ArrowUpRight size={14} />
            </a>
            <span className="docs-note">Docs only. No vault connected.</span>
          </div>
        </div>
        <div className="demo-usage">
          <span>{formatSats(spent)} simulated sats used</span>
          <span>{formatSats(remaining)} remaining</span>
        </div>
        <div className="usage-track" aria-hidden="true">
          <div
            style={{
              width: `${budget ? Math.min(100, (spent / budget) * 100) : spent ? 100 : 0}%`,
            }}
          />
        </div>
        <div className="policy-row">
          <span>
            <ShieldCheck size={14} />{" "}
            {allowed ? "Demo destination allowed" : "Empty allowlist"}
          </span>
          <strong>{allowed ? "CAPS STILL APPLY" : "DENY ALL SENDS"}</strong>
        </div>
        <label className="demo-allow">
          <input
            type="checkbox"
            checked={allowed}
            onChange={(event) => {
              setAllowed(event.target.checked);
              setResult(null);
            }}
          />{" "}
          Allow an example destination <span>demo only</span>
        </label>
        <div className="demo-actions">
          <button onClick={() => simulate(1000)}>
            Try 1,000 sats <ChevronRight size={13} />
          </button>
          <button onClick={() => simulate(12000)}>Test over-cap request</button>
        </div>
        <div className="owner-row">
          <span>allow / sweep / split</span>
          <span>HUMAN-ONLY IN THE REAL VAULT</span>
        </div>
      </div>
      <div className="terminal-panel">
        <div className="terminal-bar">
          <span className="window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <Terminal size={13} /> policy playground
          </span>
          <span>SIMULATION</span>
        </div>
        <div className="terminal-content">
          <p className="terminal-comment">
            # Real MCP defaults · not connected here
          </p>
          <p className="terminal-green">http://127.0.0.1:38402/mcp</p>
          <div className="terminal-divider" />
          <p>
            <span className="terminal-muted">demo cap</span>{" "}
            {formatSats(budget)} sats/day
          </p>
          <p>
            <span className="terminal-muted">allowlist</span>{" "}
            <span className="terminal-amber">
              {allowed
                ? "example only → caps enforced"
                : "empty → sends denied"}
            </span>
          </p>
          <div
            className={`demo-result ${result?.ok ? "is-allowed" : ""}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {result ? (
              <>
                <strong>
                  {result.ok ? "PERMITTED" : "BLOCKED"} ·{" "}
                  {formatSats(result.amount)} sats
                </strong>
                <span>{result.reason}</span>
              </>
            ) : (
              <>
                <strong>YOUR AGENT ASKS. YOUR RULES DECIDE.</strong>
                <span>Drag the ring, then try a request. Nothing is sent.</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="preview-bottom">
        <LockKeyhole size={12} /> Browser-only simulation. Resets on refresh. No
        funds move.
      </div>
    </section>
  );
}
