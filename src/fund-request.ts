import { P2PKH } from "@bsv/sdk";
import { isValidAddress } from "./policy";

export type FundRequest =
  | {
      ok: true;
      address: string;
      sats: number;
      lockingScriptHex: string;
      createAction: {
        description: string;
        outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string }>;
        labels: string[];
        options: { signAndProcess: true; acceptDelayedBroadcast: false; returnTXIDOnly: true };
      };
    }
  | { ok: false; code: string; message: string };

export function fundRequest(opts: { address: string; sats: number }): FundRequest {
  if (!isValidAddress(opts.address)) {
    return { ok: false, code: "BAD_ADDRESS", message: "REJECTED: Destination is not a mainnet P2PKH address." };
  }
  if (!Number.isSafeInteger(opts.sats) || opts.sats <= 0) {
    return { ok: false, code: "BAD_AMOUNT", message: "REJECTED: Amount must be a positive integer of sats." };
  }
  const lockingScriptHex = new P2PKH().lock(opts.address).toHex();
  return {
    ok: true,
    address: opts.address,
    sats: opts.sats,
    lockingScriptHex,
    createAction: {
      description: "Fund Dogfood vault",
      outputs: [
        {
          lockingScript: lockingScriptHex,
          satoshis: opts.sats,
          outputDescription: "Fund Dogfood vault",
        },
      ],
      labels: ["dogfood-fund"],
      options: {
        signAndProcess: true,
        acceptDelayedBroadcast: false,
        returnTXIDOnly: true,
      },
    },
  };
}
