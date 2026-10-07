import { P2PKH } from "@bsv/sdk";

function isValidAddress(address) {
  try {
    new P2PKH().lock(address);
    return true;
  } catch {
    return false;
  }
}

export function fundRequest(opts) {
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

export function walletCreateActionArgs(request) {
  if (!request?.ok) {
    throw new Error(request?.message || "REJECTED: Fund request is not valid.");
  }
  return request.createAction;
}

export async function payVaultWithWallet(wallet, opts) {
  const request = fundRequest({ address: opts.address.trim(), sats: Number(opts.sats) });
  if (!request.ok) return request;
  if (!wallet) {
    return { ok: false, code: "NO_WALLET", message: "Install or enable Yours Wallet." };
  }
  if (typeof wallet.waitForAuthentication === "function") {
    await wallet.waitForAuthentication({});
  }
  const result = await wallet.createAction(walletCreateActionArgs(request));
  if (!result?.txid) {
    return { ok: false, code: "NO_TXID", message: "Wallet did not return a transaction ID." };
  }
  return { ok: true, txid: result.txid, address: request.address, sats: request.sats };
}
