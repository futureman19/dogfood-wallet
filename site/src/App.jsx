import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Github,
  LockKeyhole,
  Power,
  ShieldCheck,
  Terminal,
  Wallet,
} from "lucide-react";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;
const flow = [
  { title: "User Wallet", sub: "Funding", Icon: Wallet },
  { title: "Local Vault", sub: "Signer Daemon", Icon: LockKeyhole },
  { title: "Digital Bowl", sub: "MCP Server Wallet", Icon: ShieldCheck },
  { title: "AI Agents", sub: "MCP clients", Icon: Bot },
];

function Bowl() {
  return (
    <div className="bowl-display" aria-hidden="true">
      <div className="bowl-orbit" />
      <img src="/cyber-bowl.png" alt="" />
      <span>YOUR KEYS STAY HERE</span>
    </div>
  );
}

function VaultPreview() {
  return (
    <section
      className="preview"
      aria-label="Illustrated local vault architecture — not a live wallet"
    >
      <div className="preview-caption">
        <span className="status-dot" /> ON YOUR MACHINE{" "}
        <span>ILLUSTRATION / NOT LIVE</span>
      </div>
      <div className="flow-panel">
        <div className="panel-eyebrow">A SMALL BUDGET. A CLEAR BOUNDARY.</div>
        <ol className="flow">
          {flow.map(({ title, sub, Icon }, i) => (
            <li key={title}>
              <div className="flow-icon">
                <Icon size={19} strokeWidth={1.5} />
              </div>
              <strong>{title}</strong>
              <span>{sub}</span>
              {i < flow.length - 1 && (
                <ChevronRight
                  className="flow-arrow"
                  size={15}
                  aria-hidden="true"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
      <div className="vault-panel">
        <div className="vault-heading">
          <span>
            <LockKeyhole size={14} /> LOCAL AGENT BOWL VAULT
          </span>
          <span className="local-badge">LOCAL ONLY</span>
        </div>
        <div className="vault-body">
          <Bowl />
          <div className="vault-controls">
            <div className="cap-label">DEFAULT DAILY CAP</div>
            <div className="cap-value">
              50,000 <span>sats</span>
            </div>
            <div className="cap-note">10,000 sats per transaction</div>
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
        <div className="policy-row">
          <span>
            <ShieldCheck size={14} /> Empty allowlist
          </span>
          <strong>DENY ALL SENDS</strong>
        </div>
        <div className="owner-row">
          <span>allow / sweep / split</span>
          <span>HUMAN-ONLY</span>
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
            <Terminal size={13} /> local / setup notes
          </span>
          <span>EXAMPLE</span>
        </div>
        <div className="terminal-content">
          <p>
            <span className="prompt">$</span> bun src/cli.ts mcp-http
          </p>
          <p className="terminal-comment"># Default MCP HTTP endpoint</p>
          <p className="terminal-green">http://127.0.0.1:38402/mcp</p>
          <div className="terminal-divider" />
          <p>
            <span className="terminal-muted">policy</span>{" "}
            <span>10,000 sats/tx · 50,000 sats/day</span>
          </p>
          <p>
            <span className="terminal-muted">allowlist</span>{" "}
            <span className="terminal-amber">empty → sends denied</span>
          </p>
          <p>
            <span className="terminal-muted">keys</span>{" "}
            <span>local signer only. Never the model.</span>
          </p>
        </div>
      </div>
      <div className="preview-bottom">
        <LockKeyhole size={12} /> Local signer. Local MCP. No hosted custody.
      </div>
    </section>
  );
}

export default function App() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header page-width">
        <a className="brand" href="/" aria-label="Dogfood Wallet home">
          <img src="/cyber-bowl.png" alt="" />
          <span className="brand-words">
            <img
              className="brand-wordmark"
              src="/dogfood-wordmark.png"
              alt=""
            />
            <img className="brand-wallet" src="/wallet-wordmark.png" alt="" />
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href={README}>Docs</a>
          <a href={`${REPO}#install`}>CLI</a>
          <a href={`${REPO}#mcp`}>MCP Server</a>
        </nav>
        <a className="github-link" href={REPO}>
          <Github size={16} />
          <span>Star on GitHub</span>
          <ArrowUpRight size={14} />
        </a>
      </header>
      <main id="main" className="hero page-width">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" /> OPEN SOURCE / LOCAL BSV VAULT
          </div>
          <h1>
            <img
              className="hero-wordmark"
              src="/dogfood-wordmark.png"
              alt="DOGFOOD"
              width="571"
              height="84"
            />
            WALLET
          </h1>
          <h2>
            Give your AI agents pocket change.
            <br />
            <span>Not your keys.</span>
          </h2>
          <p className="intro">
            Fund a little. Set the rules. Let your agents spend within them.
            Your local signer enforces the limits. Your private keys never reach
            the model.
          </p>
          <div className="hero-actions">
            <a className="install-link" href={`${REPO}#install`}>
              <span className="prompt">$</span>
              <code>bun src/cli.ts init</code>
              <ArrowUpRight size={18} />
            </a>
            <a className="source-link" href={REPO}>
              <Github size={16} /> View source <ArrowUpRight size={14} />
            </a>
          </div>
          <p className="install-note">
            Clone the repo + install with Bun first.{" "}
            <a href={`${REPO}#install`}>
              Setup guide <ChevronRight size={12} />
            </a>
          </p>
          <ul className="features">
            <li>
              <Check size={15} />
              <span>Local policy engine. Hard caps in sats.</span>
            </li>
            <li>
              <Check size={15} />
              <span>Stop agent spending. Sweep funds yourself.</span>
            </li>
            <li>
              <Check size={15} />
              <span>MCP + CLI. Built for your agent stack.</span>
            </li>
          </ul>
          <div className="ownership-note">
            <ShieldCheck size={16} />
            <p>
              Your machine. Your funds. Your rules.
              <span>No account. No hosted wallet.</span>
            </p>
          </div>
          <a className="mobile-preview-link" href="#vault-preview">
            Inside the local vault <ArrowDown size={14} />
          </a>
        </div>
        <div id="vault-preview">
          <VaultPreview />
        </div>
      </main>
      <footer className="site-footer page-width">
        <div>
          <p>The zero-trust wallet for agentic commerce.</p>
          <span>
            Open-source software. This site holds no keys and runs no signer or
            MCP server.
          </span>
        </div>
        <div className="agent-list" aria-label="Agent ecosystem">
          Claude <b>·</b> Cursor <b>·</b> Hermes <b>·</b> Codex
        </div>
      </footer>
    </div>
  );
}
