import { describe, expect, test } from "bun:test";
import { changenowProvider } from "./bridge-changenow";
import {fixture} from "./test-support/bridge-schema";

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
        return { body: { ...fixture("changenow"), fromAmount: 0.001, toAmount: 0.69 } };
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

  test("quote: provider error omits its response body", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ status: 400, body: { message: "Amount is too small" } })),
    });
    await expect(p.quote({ fromAmountSats: 1 })).rejects.toThrow(/HTTP 400/);
  });

  test("create: POST exchange with payout address; parses id/payin/payout", async () => {
    let body: Record<string, unknown> | undefined;
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch((url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          body: {
            ...fixture("changenow"),
            id: "synthetic00001",
            payinAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            payoutAddress: body.address,
            fromAmount: 0.001,
            toAmount: 0.69,
          },
        };
      }),
    });
    const ord = await p.create({
      quote: { provider: "changenow", fromAsset: "bsv", toAsset: "usdc-base", fromAmountSats: 100_000, toAmount: 690_000 },
      payoutAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(body?.fromCurrency).toBe("bsv");
    expect(body?.toNetwork).toBe("base");
    expect(body?.address).toBe("0x1111111111111111111111111111111111111111");
    expect(ord).toMatchObject({
      id: "synthetic00001",
      depositAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
      depositAmountSats: 100_000,
      payoutAddress: "0x1111111111111111111111111111111111111111",
      payoutAmount: 690_000,
      status: "waiting",
    });
  });

  test("status: maps provider states; finished carries payoutHash", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ body: { ...fixture("changenow",true), amountTo: 0.69, toAmount: 0.69 } })),
    });
    const s = await p.status("synthetic00001");
    expect(s.status).toBe("finished");
    expect(s.payoutHash).toBe("0x"+"b".repeat(64));
  });

  test("status: documented confirming status maps to pending", async () => {
    const p = changenowProvider({
      apiKey: KEY,
      fetchFn: mockFetch(() => ({ body: { ...fixture("changenow",true), status: "confirming" } })),
    });
    expect((await p.status("synthetic00001")).status).toBe("pending");
  });
});
