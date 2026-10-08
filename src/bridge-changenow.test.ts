import { describe, expect, test } from "bun:test";
import { changenowProvider } from "./bridge-changenow";

const KEY = "test-api-key";

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("changenowProvider", () => {
  test("quote: GET estimated-amount with sats->BSV conversion and api key header; payout in USDC base units", async () => {
    let seen: { url: string; key?: string } | undefined;
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch((url, init) => {
        seen = { url, key: (init?.headers as Record<string, string>)?.["x-changenow-api-key"] };
        return { body: { fromAmount: 0.001, toAmount: 0.69 } };
      }),
    });
    const q = await p.quote({ fromAmountSats: 100_000 });
    expect(q.provider).toBe("changenow");
    expect(q.fromAmountSats).toBe(100_000);
    expect(q.toAmount).toBe(690_000); // 0.69 USDC in base units
    expect(seen?.key).toBe(KEY);
    expect(seen?.url).toContain("estimated-amount");
    expect(seen?.url).toContain("fromAmount=0.001");
    expect(seen?.url).toContain("fromCurrency=bsv");
    expect(seen?.url).toContain("toNetwork=base");
  });

  test("quote: provider error surfaces with its message", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ status: 400, body: { message: "Amount is too small" } })),
    });
    await expect(p.quote({ fromAmountSats: 1 })).rejects.toThrow(/too small/i);
  });

  test("create: POST exchange with payout address; parses id/payin/payout", async () => {
    let body: Record<string, unknown> | undefined;
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch((url, init) => {
        body = JSON.parse(String(init?.body));
        return {
          body: {
            id: "cn-123",
            payinAddress: "1PayinAddressxxxxxxxxxxxxxxxxxxx",
            payoutAddress: body.address,
            fromAmount: 0.001,
            toAmount: 0.69,
          },
        };
      }),
    });
    const ord = await p.create({
      quote: { provider: "changenow", fromAsset: "bsv", toAsset: "usdc-base", fromAmountSats: 100_000, toAmount: 690_000 },
      payoutAddress: "0x3285Bb4b72eCa1d2955928Fb8437Ac7ED167abdd",
    });
    expect(body?.fromCurrency).toBe("bsv");
    expect(body?.toNetwork).toBe("base");
    expect(body?.address).toBe("0x3285Bb4b72eCa1d2955928Fb8437Ac7ED167abdd");
    expect(ord).toMatchObject({
      id: "cn-123",
      depositAddress: "1PayinAddressxxxxxxxxxxxxxxxxxxx",
      depositAmountSats: 100_000,
      payoutAddress: "0x3285Bb4b72eCa1d2955928Fb8437Ac7ED167abdd",
      payoutAmount: 690_000,
      status: "waiting",
    });
  });

  test("status: maps provider states; finished carries payoutHash", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ body: { id: "cn-123", status: "finished", payoutHash: "0xdeadbeef", toAmount: 0.69 } })),
    });
    const s = await p.status("cn-123");
    expect(s.status).toBe("finished");
    expect(s.payoutHash).toBe("0xdeadbeef");
  });

  test("status: unknown provider status maps to pending", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ body: { id: "x", status: "confirming" } })),
    });
    expect((await p.status("x")).status).toBe("pending");
  });
});
