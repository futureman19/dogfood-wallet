import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  Coins,
  Github,
  Globe,
  Receipt,
  ShieldCheck,
  Zap,
} from "lucide-react";
import VaultPreview from "./VaultPreview";
import FundWithYours from "./FundWithYours";
import "./bowlDemo.css";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;
const MERCHANT = "https://dogfood-merchant.fly.dev/v1/fortune";

const RAILS = [
  {
    name: "USDC · Base",
    tag: "Mainnet",
    body: "EIP-3009 authorizations settled by the wallet's own self-hosted facilitator, gas paid from the pocket's ETH. Confirmed in seconds. No Coinbase account, no payment processor, no business entity required.",
    receipt:
      "https://basescan.org/tx/0xb5f3cb4356f37474dd5e3e80585c39d23958e1c03e706732b4eee8d76e9c43de",
    receiptLabel: "Mainnet receipt",
  },
  {
    name: "USDC · Solana",
    tag: "Devnet-proven",
    body: "Partially-signed transactions the merchant co-signs as fee payer and submits — the payer never needs the network token, just USDC. Finality in under a second.",
    receipt:
      "https://solscan.io/tx/25Ung41rJSNDtNVFuLLrsmZDnd3Lqf53vmENniQ3Eavf4PSCkWnJSRovP1Twy6ZGDpn6tLbX4YPCxVp9v7wACQpd?cluster=devnet",
    receiptLabel: "Devnet receipt",
  },
  {
    name: "BSV",
    tag: "Mainnet",
    body: "Direct satoshi transfers over HTTP 402 — the client builds the whole transaction, the merchant broadcasts it. A 500-sat call settles for a ~$0.00004 network fee. No facilitator at all.",
    receipt:
      "https://whatsonchain.com/tx/5e0dacad4106833a3e1cc78778dd77e1951b3c410d79080c438a031c5298119c",
    receiptLabel: "Mainnet receipt",
  },
  {
    name: "Live register",
    tag: "Try it",
    body: "A real merchant endpoint is running right now. Call it with no credentials and watch it answer HTTP 402 with a price menu — then pay it with the wallet and watch it serve.",
    receipt: MERCHANT,
    receiptLabel: "Open the endpoint",
  },
];

const FLOW = [
  { n: "01", title: "Ask", body: "The agent requests a paid resource — no account, no API key, no session." },
  { n: "02", title: "402", body: "The server answers Payment Required with a price menu and the rails it accepts." },
  { n: "03", title: "Pay", body: "The wallet signs within your policy — caps, allowlist, kill switch — and retries with payment attached." },
  { n: "04", title: "Serve", body: "The server verifies, settles in seconds, and answers. Every request is its own receipt." },
];

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
          <a href={MERCHANT}>Live 402 endpoint</a>
        </nav>
        <a className="github-link" href={REPO}>
          <Github size={16} />
          <span>Star on GitHub</span>
          <ArrowUpRight size={14} />
        </a>
      </header>
      <main id="main" className="page-width">
        <div className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" /> OPEN SOURCE / INSTANT · SUB-CENT
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
            One vault key pays on whatever rail is fastest and cheapest —
            settled in seconds, for a fraction of a cent — while your local
            signer enforces the limits and your private keys never reach the
            model.
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
          <FundWithYours />
          <p className="install-note">
            Clone the repo + install with Bun first.{" "}
            <a href={`${REPO}#install`}>
              Setup guide <ChevronRight size={12} />
            </a>
          </p>
          <ul className="features">
            <li>
              <Check size={15} />
              <span>Local policy engine. Hard caps per asset.</span>
            </li>
            <li>
              <Check size={15} />
              <span>Pays HTTP 402s in seconds, for micropennies.</span>
            </li>
            <li>
              <Check size={15} />
              <span>Merchant side included — sell to other agents.</span>
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
              <span>No account. No hosted wallet. No revenue cut — ever.</span>
            </p>
          </div>
          <a className="mobile-preview-link" href="#vault-preview">
            Inside the local vault <ArrowDown size={14} />
          </a>
        </div>
        <div id="vault-preview">
          <VaultPreview />
        </div>
        </div>

        <section className="section" aria-labelledby="vision">
          <div className="section-head">
            <Globe size={18} />
            <h2 id="vision">Fast enough for machines. Cheap enough for anything.</h2>
          </div>
          <p className="section-lede">
            HTTP 402 turns any endpoint into a stateless vending machine: the
            request carries its own payment, so there are no accounts, no API
            keys, and no billing tables. Settlement happens in seconds and the
            fee on a call is a fraction of a cent — not the $0.30 floor of
            card networks — so a $0.001 price tag finally makes sense.
            Dogfood is the wallet that answers those challenges and the
            register that accepts them.
          </p>
          <div className="flow-grid">
            {FLOW.map((s) => (
              <div className="flow-card" key={s.n}>
                <span className="flow-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="rails">
          <div className="section-head">
            <Coins size={18} />
            <h2 id="rails">Real payments. Public receipts.</h2>
          </div>
          <p className="section-lede">
            Every claim below is a real transaction you can audit on a public
            explorer — settled in seconds, costing less than a hundredth of a
            cent in network fees.
          </p>
          <div className="rails-grid">
            {RAILS.map((r) => (
              <article className="rail-card" key={r.name}>
                <header>
                  <h3>{r.name}</h3>
                  <span className="rail-tag">{r.tag}</span>
                </header>
                <p>{r.body}</p>
                <a className="receipt-link" href={r.receipt}>
                  <Receipt size={14} /> {r.receiptLabel}{" "}
                  <ArrowUpRight size={12} />
                </a>
              </article>
            ))}
          </div>
        </section>

        <section className="section gift" aria-labelledby="gift">
          <div className="section-head">
            <Zap size={18} />
            <h2 id="gift">A gift, not a business.</h2>
          </div>
          <p className="section-lede">
            Dogfood is MIT-licensed open source with no profit machinery built
            in and no revenue expectation attached. If you want to charge for
            something with it, that revenue is yours — the code never skims,
            never phones home, and never asks us for permission.
          </p>
        </section>
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
