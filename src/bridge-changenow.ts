import type { BridgeOrderStatus, BridgeProvider } from "./bridge";

// ChangeNOW v2 provider. Free instant API key; BSV -> USDC(Base) pair is
// live. Auth: x-changenow-api-key header. Amounts on the wire are crypto
// units (BSV / USDC), converted at the boundary (1e8 sats, 1e6 base units).

const API = "https://api.changenow.io/v2";

const STATUS_MAP: Record<string, BridgeOrderStatus> = {
  waiting: "waiting",
  confirming: "pending",
  exchanging: "pending",
  sending: "pending",
  verifying: "pending",
  finished: "finished",
  failed: "failed",
  refunded: "failed",
  expired: "failed",
};

export function changenowProvider(opts: {
  apiKey: string;
  fetchFn?: typeof fetch;
  usdcCurrency?: string;
  usdcNetwork?: string;
}): BridgeProvider {
  const fetchFn = opts.fetchFn ?? fetch;
  const toCurrency = opts.usdcCurrency ?? "usdc";
  const toNetwork = opts.usdcNetwork ?? "base";

  async function req(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetchFn(`${API}${path}`, {
      ...init,
      headers: { "x-changenow-api-key": opts.apiKey, "content-type": "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`ChangeNOW ${res.status}: ${typeof body.message === "string" ? body.message : res.statusText}`);
    }
    return body;
  }

  return {
    name: "changenow",

    async quote({ fromAmountSats }) {
      const fromAmount = fromAmountSats / 1e8;
      const body = await req(
        `/exchange/estimated-amount?fromCurrency=bsv&toCurrency=${toCurrency}&fromNetwork=bsv&toNetwork=${toNetwork}&fromAmount=${fromAmount}&flow=standard`,
      );
      const toAmount = Number(body.toAmount ?? body.estimatedAmount);
      if (!Number.isFinite(toAmount)) throw new Error("ChangeNOW: quote response missing toAmount");
      return {
        provider: "changenow",
        fromAsset: "bsv",
        toAsset: "usdc-base",
        fromAmountSats,
        toAmount: Math.round(toAmount * 1e6),
      };
    },

    async create({ quote, payoutAddress }) {
      const body = await req(`/exchange`, {
        method: "POST",
        body: JSON.stringify({
          fromCurrency: "bsv",
          toCurrency,
          fromNetwork: "bsv",
          toNetwork,
          fromAmount: quote.fromAmountSats / 1e8,
          address: payoutAddress,
          flow: "standard",
        }),
      });
      if (typeof body.payinAddress !== "string" || !body.payinAddress) {
        throw new Error("ChangeNOW: create response missing payinAddress");
      }
      const toAmount = Number(body.toAmount ?? quote.toAmount / 1e6);
      return {
        provider: "changenow",
        id: String(body.id),
        depositAddress: body.payinAddress,
        depositAmountSats: quote.fromAmountSats,
        payoutAddress: typeof body.payoutAddress === "string" ? body.payoutAddress : payoutAddress,
        payoutAmount: Number.isFinite(toAmount) ? Math.round(toAmount * 1e6) : quote.toAmount,
        status: "waiting",
      };
    },

    async status(id) {
      const body = await req(`/exchange/by-id?id=${encodeURIComponent(id)}`);
      const raw = String(body.status ?? "");
      const toAmount = Number(body.toAmount);
      return {
        provider: "changenow",
        id: String(body.id ?? id),
        depositAddress: typeof body.payinAddress === "string" ? body.payinAddress : "",
        depositAmountSats: 0,
        payoutAddress: typeof body.payoutAddress === "string" ? body.payoutAddress : "",
        payoutAmount: Number.isFinite(toAmount) ? Math.round(toAmount * 1e6) : 0,
        status: STATUS_MAP[raw] ?? "pending",
        payoutHash: typeof body.payoutHash === "string" ? body.payoutHash : undefined,
      };
    },
  };
}
