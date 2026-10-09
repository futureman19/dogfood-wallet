import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import "./flowSteps.css";

const steps = [
  {
    title: "User Wallet",
    sub: "Funding",
    Icon: Wallet,
    summary:
      "You send a small amount from your own wallet to your local vault address. Keep the rest of your funds separate—your agent only gets pocket change.",
  },
  {
    title: "Local Vault",
    sub: "Signer Daemon",
    Icon: LockKeyhole,
    summary:
      "The signer runs on your machine and keeps your private key away from the model. It checks the destination allowlist, sats limits and kill switch before signing a payment.",
  },
  {
    title: "Digital Bowl",
    sub: "MCP Server Wallet",
    Icon: ShieldCheck,
    summary:
      "The local MCP server gives agents a way to request wallet actions. It passes requests to the same policy-controlled vault—it is not a second wallet or a hosted service.",
  },
  {
    title: "AI Agents",
    sub: "MCP clients",
    Icon: Bot,
    summary:
      "Your agent uses an MCP client to check the balance or request a payment. The local signer decides what is allowed. Adding destinations, sweeping funds and splitting coins stay human-only.",
  },
];

export default function FlowSteps() {
  const [open, setOpen] = useState(null);
  return (
    <div className="flow-panel">
      <div className="panel-eyebrow">A SMALL BUDGET. A CLEAR BOUNDARY.</div>
      <ol className="flow flow-accordion">
        {steps.map(({ title, sub, Icon, summary }, i) => (
          <li key={title}>
            <div className="flow-step">
              <button
                type="button"
                className="flow-trigger"
                id={`flow-trigger-${i}`}
                aria-expanded={open === i}
                aria-controls={`flow-drawer-${i}`}
                onClick={() => setOpen((current) => (current === i ? null : i))}
              >
                <span className="flow-icon">
                  <Icon size={19} strokeWidth={1.5} />
                </span>
                <strong>{title}</strong>
                <span className="flow-sub">{sub}</span>
                <ChevronDown
                  className="flow-chevron"
                  size={13}
                  aria-hidden="true"
                />
              </button>
              {i < steps.length - 1 && (
                <ChevronRight
                  className="flow-arrow"
                  size={15}
                  aria-hidden="true"
                />
              )}
            </div>
            <div
              className="flow-drawer"
              id={`flow-drawer-${i}`}
              role="region"
              aria-labelledby={`flow-trigger-${i}`}
              hidden={open !== i}
            >
              <p>{summary}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
