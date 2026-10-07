import { Check, Terminal, Github, ChevronRight, CircleDot } from "lucide-react";

const REPO = "https://github.com/futureman19/dogfood-wallet";
const README = `${REPO}#readme`;
const MCP = `${REPO}#mcp`;

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

          <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-5 pt-2">
            <a href={REPO} className="group relative">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500 to-green-500 rounded-lg blur opacity-30 group-hover:opacity-60 transition duration-500"></div>
              <span className="relative w-full sm:w-auto bg-neutral-950 border border-emerald-500/50 text-emerald-400 px-6 py-3.5 rounded-lg font-mono text-sm sm:text-base font-bold flex items-center justify-center hover:bg-emerald-950/30 transition-all">
                <span className="text-emerald-500/50 mr-2">$</span> bun src/cli.ts init
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

          <ul className="space-y-4 pt-6 text-neutral-300">
            <li className="flex items-center space-x-3">
              <div className="bg-emerald-500/10 p-1 rounded-full border border-emerald-500/20">
                <Check className="w-4 h-4 text-emerald-500" />
              </div>
              <span className="text-[1.05rem]">Local policy engine & daily caps</span>
            </li>
            <li className="flex items-center space-x-3">
              <div className="bg-emerald-500/10 p-1 rounded-full border border-emerald-500/20">
                <Check className="w-4 h-4 text-emerald-500" />
              </div>
              <span className="text-[1.05rem]">One-shot instant sweep/kill-switch</span>
            </li>
            <li className="flex items-center space-x-3">
              <div className="bg-emerald-500/10 p-1 rounded-full border border-emerald-500/20">
                <Check className="w-4 h-4 text-emerald-500" />
              </div>
              <span className="text-[1.05rem]">MCP + CLI-first for easy agent attachment</span>
            </li>
          </ul>
        </div>

        <div className="relative w-full lg:max-w-lg ml-auto perspective-[1000px]">
          <div className="absolute -inset-1 bg-gradient-to-br from-emerald-500 via-green-600 to-transparent rounded-2xl blur-2xl opacity-20 transform rotate-[-2deg] scale-105"></div>

          <div className="relative bg-[#0d1117] border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/5 transform transition-transform hover:scale-[1.02] duration-500">
            <div className="flex items-center px-4 py-3 border-b border-neutral-800/80 bg-[#0d1117]/80 backdrop-blur-md">
              <div className="flex space-x-2">
                <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50 shadow-[0_0_5px_rgba(239,68,68,0.5)]"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50 shadow-[0_0_5px_rgba(234,179,8,0.5)]"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50 shadow-[0_0_5px_rgba(34,197,94,0.5)]"></div>
              </div>
              <div className="mx-auto flex items-center space-x-2 text-xs text-neutral-500 font-mono">
                <Terminal className="w-3.5 h-3.5 text-neutral-600" />
                <span>dogfood-daemon — bash</span>
              </div>
              <div className="w-11"></div>
            </div>

            <div className="p-6 font-mono text-[13px] leading-relaxed space-y-5">
              <div className="space-y-1.5">
                <div className="flex items-center text-neutral-400">
                  <span className="text-emerald-500 mr-2">~/agents</span>
                  <span className="text-white">$ bun src/cli.ts status</span>
                </div>
                <div className="text-green-400 flex items-center">
                  <span className="mr-2">[✓]</span> daemon running locally on port 38402
                </div>
                <div className="text-green-400 flex items-center">
                  <span className="mr-2">[✓]</span> agent attached (MCP)
                </div>
                <div className="text-emerald-300 flex items-center">
                  <span className="mr-2">[!]</span> allowance: 50,000 sats/day{" "}
                  <span className="text-emerald-300/50 ml-1">(spent: 2,400)</span>
                </div>
                <div className="text-emerald-300 flex items-center">
                  <span className="mr-2">[!]</span> allowlist: empty → fail-closed
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-800/80">
                <div className="text-neutral-500 text-xs font-bold tracking-widest mb-3 flex items-center">
                  <CircleDot className="w-3 h-3 mr-2 text-neutral-600" />
                  RECENT TRANSACTIONS
                </div>

                <div className="space-y-2.5">
                  <div className="flex justify-between items-center group hover:bg-white/5 p-1 -mx-1 rounded transition-colors">
                    <div className="flex items-center text-neutral-400">
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-600 mr-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <span>- send 2,000 sats</span>
                    </div>
                    <span className="text-green-500 text-xs border border-green-500/20 bg-green-500/10 px-2 py-0.5 rounded shadow-[0_0_8px_rgba(34,197,94,0.15)]">
                      Approved
                    </span>
                  </div>

                  <div className="flex justify-between items-center group hover:bg-white/5 p-1 -mx-1 rounded transition-colors">
                    <div className="flex items-center text-neutral-400">
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-600 mr-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <span>- send 5,000 sats</span>
                    </div>
                    <span className="text-green-500 text-xs border border-green-500/20 bg-green-500/10 px-2 py-0.5 rounded shadow-[0_0_8px_rgba(34,197,94,0.15)]">
                      Approved
                    </span>
                  </div>

                  <div className="flex justify-between items-center group hover:bg-white/5 p-1 -mx-1 rounded transition-colors">
                    <div className="flex items-center text-neutral-500 line-through decoration-neutral-700">
                      <ChevronRight className="w-3.5 h-3.5 text-neutral-600 mr-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <span>- send 15,000 sats</span>
                    </div>
                    <span className="text-red-500 text-xs border border-red-500/20 bg-red-500/10 px-2 py-0.5 rounded shadow-[0_0_8px_rgba(239,68,68,0.15)]">
                      BLOCKED (Policy)
                    </span>
                  </div>
                </div>
              </div>

              <div className="pt-2 flex items-center text-neutral-400">
                <span className="text-emerald-500 mr-2">~/agents</span>
                <span className="text-white">$ </span>
                <span className="w-2 h-4 bg-emerald-500 ml-1 animate-pulse"></span>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="relative z-10 max-w-7xl mx-auto px-6 md:px-12 pb-12 text-xs text-neutral-600 font-mono">
        dogfoodwallet.com · futureman19/dogfood-wallet · Caps in sats, not USD.
      </footer>
    </div>
  );
}
