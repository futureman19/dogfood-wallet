import { describe, expect, test } from "bun:test";
import { exolixProvider } from "./bridge-exolix";
import {fixture} from "./test-support/bridge-schema";

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("exolixProvider", () => {
  test("quote: GET /rate with sats->BSV conversion; payout in USDC base units", async () => {
    let url = "";
    const p = exolixProvider({
      fetchFn: mockFetch((u) => {
        url = u;
        return { body: { fromAmount: 2.6, toAmount: 49.49536133, rate: 19.036, minAmount: 2.5412 } };
      }),
    });
    const q = await p.quote({ fromAmountSats: 260_000_000 });
    expect(q.provider).toBe("exolix");
    expect(q.toAmount).toBe(49_495_361);
    expect(url).toContain("/rate?");
    expect(url).toContain("coinFrom=BSV");
    expect(url).toContain("networkTo=BASE");
    expect(url).toContain("amount=2.6");
  });

  test("quote: below minimum raises BELOW_MIN carrying the min in sats", async () => {
    const p = exolixProvider({
      fetchFn: mockFetch(() => ({
        body: { fromAmount: 0.001, toAmount: 0, message: "below min", minAmount: 2.54224537 },
      })),
    });
    await expect(p.quote({ fromAmountSats: 100_000 })).rejects.toMatchObject({ code: "BELOW_MIN" });
    await expect(p.quote({ fromAmountSats: 100_000 })).rejects.toThrow(/254224537 sats/);
  });

  test("create: POST /transactions with withdrawalAddress; parses id and deposit", async () => {
    let body: Record<string, unknown> | undefined;
    const p = exolixProvider({
      fetchFn: mockFetch((u, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          body: {
            ...fixture("exolix"), amount: 2.6,
            id: "exo-9",
            depositAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
            withdrawalAddress: body.withdrawalAddress,
            amountTo: 49.5,
          },
        };
      }),
    });
    const ord = await p.create({
      quote: { provider: "exolix", fromAsset: "bsv", toAsset: "usdc-base", fromAmountSats: 260_000_000, toAmount: 49_500_000 },
      payoutAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(body?.coinFrom).toBe("BSV");
    expect(body?.coinTo).toBe("USDC");
    expect(body?.networkTo).toBe("BASE");
    expect(body?.amount).toBe(2.6);
    expect(ord).toMatchObject({
      id: "exo-9",
      depositAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
      payoutAddress: "0x1111111111111111111111111111111111111111",
      payoutAmount: 49_500_000,
      status: "waiting",
    });
  });

  test("status: maps wait/exchanging/success; finished carries the payout hash", async () => {
    const p = exolixProvider({
      fetchFn: mockFetch((u) => {
        if (u.includes("ord-wait")) return { body: { ...fixture("exolix"), id: "ord-wait", status: "wait" } };
        if (u.includes("ord-mid")) return { body: { ...fixture("exolix"), id: "ord-mid", status: "exchanging" } };
        return { body: { ...fixture("exolix",true), id: "ord-done", amountTo: 49.5 } };
      }),
    });
    expect((await p.status("ord-wait")).status).toBe("waiting");
    expect((await p.status("ord-mid")).status).toBe("pending");
    const done = await p.status("ord-done");
    expect(done.status).toBe("finished");
    expect(done.payoutHash).toBe("0x"+"b".repeat(64));
    expect(done.payoutAmount).toBe(49_500_000);
  });
});
