import { Check, Terminal, Github, ChevronRight, CircleDot } from "lucide-react";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;
const MCP = `${REPO}#mcp`;

const features = [
  "Local signer. The model never sees a WIF.",
  "Sat caps, empty allowlist fail-closed, killfile.",
  "MCP for any agent. Signer stays on this machine.",
  "Sweep is human-only. Not hosted custody.",
];

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-300 font-sans selection:bg-emerald-500 selection:text-white relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[70%] h-[70%] rounded-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-900/20 via-transparent to-transparent opacity-60 blur-3xl"></div>
        <div className="absolute bottom-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-900/10 via-transparent to-transparent opacity-50 blur-3xl"></div>
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMSIgY3k9IjEiIHI9IjEiIGZpbGw9InJnYmEoMTYsIDE4NSwgMTI5LCAwLjA1KSIvPjwvc3ZnPg==')] opacity-50 [mask-image:linear-gradient(to_bottom,white,transparent)]"></div>
      </div>

      <nav className="relative z-10 flex items-center justify-between px-6 py-6 md:px-12 max-w-7xl mx-auto">
        <a href="/" className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-emerald-500 rounded-md flex items-center justify-center font-bold text-neutral-950 shadow-[0_0_15px_rgba(16,185,129,0.4)]">
            DW
          </div>
          <span className="text-xl font-bold tracking-wider text-emerald-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]">
            DOGFOOD
          </span>
        </a>

        <div className="hidden md:flex items-center space-x-10 text-sm font-medium text-neutral-400">
          <a href={README} className="hover:text-emerald-400 transition-colors duration-200">
            Docs
          </a>
          <a href={README} className="hover:text-emerald-400 transition-colors duration-200">
            CLI
          </a>
          <a href={MCP} className="hover:text-emerald-400 transition-colors duration-200">
            MCP Server
          </a>
        </div>

        <a
          href={REPO}
          className="flex items-center space-x-2 bg-neutral-900/80 border border-neutral-800 px-4 py-2 rounded-lg hover:border-emerald-500 hover:text-emerald-400 transition-all duration-300 text-sm shadow-sm backdrop-blur-sm group"
        >
          <Github className="w-4 h-4 text-neutral-500 group-hover:text-emerald-400 transition-colors" />
          <span>★ Star on GitHub</span>
        </a>
      </nav>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-16 md:py-24 md:px-12 grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">
        <div className="space-y-10">
          <div className="space-y-6">
            <h1 className="text-5xl md:text-7xl lg:text-[5.5rem] font-extrabold text-white tracking-tighter leading-[1.05]">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-green-600 drop-shadow-[0_0_30px_rgba(16,185,129,0.2)]">
                DOGFOOD
              </span>
              <br className="hidden md:block" /> WALLET
            </h1>
            <h2 className="text-2xl md:text-3xl font-semibold text-neutral-100 leading-snug">
              Give your AI agents pocket change. <br className="hidden sm:block" />
              <span className="text-neutral-500">Not your keys.</span>
            </h2>
            <p className="text-lg text-neutral-400 max-w-xl leading-relaxed">
              Every AI agent gets a local vault they can spend from—without a human clicking approve, and without the
              model ever seeing your private key. Powered by cheap, sub-cent on-chain BSV micro-payments.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-4">
            <a
              href={REPO}
              className="inline-flex items-center justify-center min-h-11 px-6 rounded-lg bg-emerald-500 text-neutral-950 font-semibold hover:bg-emerald-400 transition-colors"
            >
              Clone the repo
              <ChevronRight className="w-4 h-4 ml-1" />
            </a>
            <a
              href={README}
              className="inline-flex items-center justify-center min-h-11 px-6 rounded-lg border border-neutral-800 bg-neutral-900/60 hover:border-emerald-500 hover:text-emerald-400 transition-all"
            >
              <Terminal className="w-4 h-4 mr-2" />
              Read the README
            </a>
          </div>

          <ul className="space-y-3">
            {features.map((line) => (
              <li key={line} className="flex items-start gap-3 text-sm text-neutral-400">
                <Check className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-emerald-500/20 via-transparent to-transparent blur-lg" />
          <div className="relative rounded-2xl border border-neutral-800 bg-neutral-900/80 backdrop-blur-sm overflow-hidden shadow-2xl">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800">
              <CircleDot className="w-3 h-3 text-red-400" />
              <CircleDot className="w-3 h-3 text-amber-400" />
              <CircleDot className="w-3 h-3 text-emerald-400" />
              <span className="ml-2 text-xs font-mono text-neutral-500">bun src/cli.ts</span>
            </div>
            <pre className="p-5 text-[13px] leading-relaxed font-mono text-neutral-300 overflow-x-auto">
              <span className="text-emerald-400">$</span> bun src/cli.ts init{"\n"}
              wrote ~/.dogfood-wallet{"\n"}
              <span className="text-emerald-400">$</span> bun src/cli.ts status{"\n"}
              killfile   off{"\n"}
              cap        10000 sats/tx{"\n"}
              allowlist  []{"\n"}
              <span className="text-emerald-400">$</span> bun src/cli.ts send 1abc… 1000{"\n"}
              <span className="text-red-400">REJECTED:</span> Allowlist is empty{"\n"}
              <span className="text-emerald-400">$</span> bun src/cli.ts kill{"\n"}
              STOP_SPENDING
            </pre>
          </div>
          <p className="mt-4 text-xs text-neutral-500 font-mono">Open source. MIT. Not a hosted wallet.</p>
        </div>
      </main>

      <footer className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 pb-12 text-xs text-neutral-600 font-mono">
        dogfoodwallet.com · futureman19/dogfood-wallet · Caps in sats, not USD.
      </footer>
    </div>
  );
}
