import { Check, Github, ChevronRight, CircleDot, Terminal, Star } from "lucide-react";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;
const MCP = `${REPO}#mcp`;

const flow = [
  { title: "User Wallet", sub: "Funding" },
  { title: "Local Vault", sub: "Signer Daemon" },
  { title: "Digital Bowl", sub: "MCP Server Wallet" },
  { title: "AI Agents", sub: "Claude · Cursor · Hermes" },
];

function BowlMeter() {
  const r = 54;
  const c = 2 * Math.PI * r;
  const pct = 0.12;
  return (
    <svg viewBox="0 0 140 140" className="w-36 h-36 drop-shadow-[0_0_18px_rgba(16,185,129,0.45)]">
      <circle cx="70" cy="70" r={r} fill="none" stroke="#122018" strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke="#34d399"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 70 70)"
      />
      <ellipse cx="70" cy="78" rx="34" ry="14" fill="none" stroke="#10b981" strokeWidth="1.5" opacity="0.7" />
      <ellipse cx="70" cy="72" rx="28" ry="10" fill="#064e3b" opacity="0.5" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <circle
          key={i}
          cx={70 + Math.cos(i * 0.9) * 12}
          cy={70 + Math.sin(i * 0.7) * 6}
          r={2.2}
          fill="#6ee7b7"
        />
      ))}
      <text x="70" y="108" textAnchor="middle" fill="#6ee7b7" fontSize="11" fontFamily="ui-monospace, monospace">
        Agent Bowl 12%
      </text>
    </svg>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-300 font-sans selection:bg-emerald-500 selection:text-white relative overflow-hidden">
      <div className="absolute inset-0 -z-10 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.04)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="absolute top-[-20%] right-[-10%] w-[70%] h-[70%] rounded-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-900/25 via-transparent to-transparent blur-3xl" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-900/20 via-transparent to-transparent blur-3xl" />
      </div>

      <nav className="relative z-10 flex items-center justify-between px-6 py-5 md:px-12 max-w-7xl mx-auto">
        <a href="/" className="flex items-center gap-3">
          <img src="/logo.png" alt="Dogfood Wallet" className="h-12 w-auto max-w-[160px] object-contain rounded-sm" />
        </a>
        <div className="hidden md:flex items-center space-x-8 text-sm font-medium text-emerald-700/80">
          <a href={README} className="hover:text-emerald-400 transition-colors">Docs</a>
          <a href={README} className="hover:text-emerald-400 transition-colors">CLI</a>
          <a href={MCP} className="hover:text-emerald-400 transition-colors">MCP Server</a>
          <a href={REPO} className="hover:text-emerald-400 transition-colors">GitHub</a>
        </div>
        <a
          href={REPO}
          className="flex items-center space-x-2 border border-emerald-500/40 text-emerald-400 px-4 py-2 rounded-full hover:bg-emerald-500/10 transition-all text-sm"
        >
          <Star className="w-4 h-4 fill-emerald-400" />
          <span>star on GitHub</span>
        </a>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-10 md:py-16 md:px-12 grid lg:grid-cols-2 gap-12 lg:gap-16 items-start">
        <div className="space-y-8">
          <div className="space-y-5">
            <h1 className="text-5xl md:text-7xl font-extrabold text-white tracking-tighter leading-[1.05]">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-green-300 drop-shadow-[0_0_30px_rgba(16,185,129,0.35)]">
                DOGFOOD
              </span>
              <br />
              <span className="text-white">WALLET</span>
            </h1>
            <h2 className="text-2xl md:text-3xl font-semibold text-neutral-100 leading-snug">
              Give your AI agents pocket change. <br className="hidden sm:block" />
              <span className="text-neutral-500">Not your keys.</span>
            </h2>
            <p className="text-lg text-neutral-400 max-w-xl leading-relaxed">
              Every AI agent gets a local vault they can spend from—without a human clicking approve, and without the
              model ever seeing your private key. Powered by cheap, sub-cent on-chain BSV micro-payments, a local CLI
              with an MCP server so Hermes, Cursor, or Claude can pay for APIs, data, and on-chain tasks autonomously.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-5">
            <a href={REPO} className="group relative">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500 to-green-500 rounded-lg blur opacity-40 group-hover:opacity-70 transition duration-500" />
              <span className="relative w-full sm:w-auto bg-neutral-950 border border-emerald-500/50 text-emerald-400 px-6 py-3.5 rounded-lg font-mono text-sm sm:text-base font-bold flex items-center justify-center hover:bg-emerald-950/30 transition-all">
                <span className="text-emerald-500/50 mr-2">$</span> npm i -g @dogfood/wallet
              </span>
            </a>
            <a
              href={REPO}
              className="w-full sm:w-auto px-6 py-3.5 border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 rounded-lg font-medium transition-all flex items-center justify-center space-x-2 bg-neutral-900/30 backdrop-blur-sm"
            >
              <Github className="w-5 h-5" />
              <span>View GitHub Repo</span>
            </a>
          </div>

          <ul className="space-y-4 pt-2 text-neutral-300">
            {["Local policy engine & daily caps", "One-shot instant sweep/kill-switch", "MCP + CLI-first for easy agent attachment"].map((line) => (
              <li key={line} className="flex items-center space-x-3">
                <div className="bg-emerald-500/10 p-1 rounded-full border border-emerald-500/20">
                  <Check className="w-4 h-4 text-emerald-500" />
                </div>
                <span className="text-[1.05rem]">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative space-y-6">
          <div className="grid grid-cols-2 gap-3">
            {flow.map((node, i) => (
              <div
                key={node.title}
                className="relative rounded-xl border border-emerald-500/30 bg-neutral-950/80 px-4 py-3 shadow-[0_0_20px_rgba(16,185,129,0.12)]"
              >
                <div className="text-[10px] tracking-widest text-emerald-600 font-mono mb-1">0{i + 1}</div>
                <div className="text-emerald-300 font-semibold text-sm">{node.title}</div>
                <div className="text-neutral-500 text-xs">{node.sub}</div>
                {i < flow.length - 1 && (
                  <ChevronRight className="hidden lg:block absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-500/60" />
                )}
              </div>
            ))}
          </div>

          <div className="relative rounded-2xl border border-emerald-500/40 bg-[#07140f]/90 p-5 shadow-[0_0_40px_rgba(16,185,129,0.15)]">
            <div className="text-emerald-400 font-mono text-xs tracking-[0.2em] mb-3">LOCAL AGENT BOWL VAULT</div>
            <div className="flex items-center gap-6">
              <BowlMeter />
              <div className="flex-1 space-y-3">
                <div className="text-neutral-500 text-xs font-mono">Limit: 50%</div>
                <a
                  href={README}
                  className="block w-full text-center py-3 rounded-md bg-red-950/80 border border-red-500/70 text-red-400 font-extrabold tracking-[0.25em] text-sm shadow-[0_0_24px_rgba(239,68,68,0.35)] hover:bg-red-900/80"
                >
                  KILL SWITCH
                </a>
              </div>
            </div>
            <div className="mt-4 space-y-2 font-mono text-xs">
              <div className="flex justify-between text-neutral-400">
                <span>- Paid 0.02 to API...</span>
                <span className="text-green-500">Approved</span>
              </div>
              <div className="flex justify-between text-neutral-400">
                <span>- Paid 0.05 to Data Shard...</span>
                <span className="text-green-500">Approved</span>
              </div>
              <div className="flex justify-between text-neutral-500 line-through decoration-neutral-700">
                <span>- Paid 1.50 to Unk...</span>
                <span className="text-red-500 no-underline">BLOCKED (Policy)</span>
              </div>
            </div>
          </div>

          <div className="relative bg-[#0d1117] border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-emerald-500/10">
            <div className="flex items-center px-4 py-3 border-b border-neutral-800/80">
              <div className="flex space-x-2">
                <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
                <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50" />
              </div>
              <div className="mx-auto flex items-center space-x-2 text-xs text-neutral-500 font-mono">
                <Terminal className="w-3.5 h-3.5" />
                <span>dogfood status</span>
              </div>
              <div className="w-11" />
            </div>
            <div className="p-5 font-mono text-[13px] leading-relaxed space-y-1.5">
              <div className="text-neutral-400">
                <span className="text-emerald-500">$</span> dogfood status
              </div>
              <div className="text-green-400">[✔] daemon running locally on port 8880</div>
              <div className="text-green-400">[✔] agent: claude-3.5-sonnet attached (MCP)</div>
              <div className="text-emerald-300">[!] allowance: $2.00/day max (spent: $0.24)</div>
              <div className="text-emerald-300">[!] allowlist: api.paywall.com, github.com</div>
              <div className="pt-3 flex items-center text-neutral-400">
                <span className="text-emerald-500 mr-2">$</span>
                <span className="w-2 h-4 bg-emerald-500 animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 pb-12 pt-4 text-center">
        <p className="text-neutral-500 text-sm mb-4">The zero-trust wallet for agentic commerce.</p>
        <div className="flex flex-wrap items-center justify-center gap-8 text-neutral-600 text-xs tracking-[0.2em] uppercase font-semibold">
          <span>Claude</span>
          <CircleDot className="w-2 h-2 text-emerald-700" />
          <span>Cursor</span>
          <CircleDot className="w-2 h-2 text-emerald-700" />
          <span>Hermes</span>
          <CircleDot className="w-2 h-2 text-emerald-700" />
          <span>Codex</span>
        </div>
      </footer>
    </div>
  );
}
