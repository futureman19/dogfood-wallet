import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  Github,
  ShieldCheck,
} from "lucide-react";
import VaultPreview from "./VaultPreview";
import "./bowlDemo.css";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;

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
