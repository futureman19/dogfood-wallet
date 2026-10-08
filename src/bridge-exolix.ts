import { BridgeError, type BridgeOrderStatus, type BridgeProvider } from "./bridge";

// Exolix v2 provider. No account or API key required (optional partner
// token raises limits). Amounts on the wire are crypto units; converted at
// the boundary (1e8 sats, 1e6 USDC base units). Verified live 2026-10-07:
// BSV -> USDC(BASE) pair active, min ~2.54 BSV, rate ~19.0 USDC/BSV.

const API = "https://exolix.com/api/v2";

const STATUS_MAP: Record<string, BridgeOrderStatus> = {
  wait: "waiting",
  confirming: "pending",
  exchanging: "pending",
  sending: "pending",
  success: "finished",
  overdue: "failed",
  failed: "failed",
  refunded: "failed",
};

export function exolixProvider(opts: {
  fetchFn?: typeof fetch;
  apiToken?: string;
  usdcNetwork?: string;
  rateType?: "float" | "fixed";
}): BridgeProvider {
  const fetchFn = opts.fetchFn ?? fetch;
  const networkTo = opts.usdcNetwork ?? "BASE";
  const rateType = opts.rateType ?? "float";

  async function req(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiToken) headers["Authorization"] = `Bearer ${opts.apiToken}`;
    const res = await fetchFn(`${API}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Exolix ${res.status}: ${typeof body.message === "string" ? body.message : res.statusText}`);
    }
    return body;
  }

  return {
    name: "exolix",

    async quote({ fromAmountSats }) {
      const fromAmount = fromAmountSats / 1e8;
      const body = await req(
        `/rate?coinFrom=BSV&coinTo=USDC&networkTo=${networkTo}&amount=${fromAmount}&rateType=${rateType}`,
      );
      const toAmount = Number(body.toAmount);
      if (!Number.isFinite(toAmount) || toAmount <= 0) {
        const minBsv = Number(body.minAmount);
        const minSats = Number.isFinite(minBsv) ? Math.ceil(minBsv * 1e8) : null;
        throw new BridgeError(
          "BELOW_MIN",
          `REJECTED: below Exolix minimum${minSats ? ` (${minSats} sats ≈ ${minBsv} BSV)` : ""}.`,
        );
      }
      return {
        provider: "exolix",
        fromAsset: "bsv",
        toAsset: "usdc-base",
        fromAmountSats,
        toAmount: Math.round(toAmount * 1e6),
      };
    },

    async create({ quote, payoutAddress }) {
      const body = await req(`/exchanges`, {
        method: "POST",
        body: JSON.stringify({
          coinFrom: "BSV",
          coinTo: "USDC",
          networkTo,
          amount: quote.fromAmountSats / 1e8,
          withdrawalAddress: payoutAddress,
          rateType,
        }),
      });
      const depositAddress = (body.depositAddress ?? body.deposit_address) as string | undefined;
      if (!depositAddress) throw new Error("Exolix: create response missing deposit address");
      const toAmount = Number(body.toAmount ?? body.amountTo ?? quote.toAmount / 1e6);
      return {
        provider: "exolix",
        id: String(body.id),
        depositAddress,
        depositAmountSats: quote.fromAmountSats,
        payoutAddress: (body.withdrawalAddress as string) ?? payoutAddress,
        payoutAmount: Number.isFinite(toAmount) ? Math.round(toAmount * 1e6) : quote.toAmount,
        status: "waiting",
      };
    },

    async status(id) {
      const body = await req(`/exchanges/${encodeURIComponent(id)}`);
      const raw = String(body.status ?? "");
      const toAmount = Number(body.toAmount ?? body.amountTo);
      const hash = (body.hashOut ?? body.payoutHash ?? body.hash_out) as string | undefined;
      return {
        provider: "exolix",
        id: String(body.id ?? id),
        depositAddress: ((body.depositAddress ?? body.deposit_address) as string) ?? "",
        depositAmountSats: 0,
        payoutAddress: (body.withdrawalAddress as string) ?? "",
        payoutAmount: Number.isFinite(toAmount) ? Math.round(toAmount * 1e6) : 0,
        status: STATUS_MAP[raw] ?? "pending",
        payoutHash: hash,
      };
    },
  };
}
