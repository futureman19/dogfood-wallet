import { useEffect, useState } from "react";
import { fundRequest, payVaultWithWallet } from "./payVault.js";

function detectCwi() {
  if (typeof window === "undefined") return "loading";
  return window.CWI || window.yours ? "available" : "unavailable";
}

export default function FundWithYours() {
  const [status, setStatus] = useState(detectCwi);
  const [address, setAddress] = useState("");
  const [sats, setSats] = useState("10000");
  const [pending, setPending] = useState(false);
  const [txid, setTxid] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mark = () => setStatus(window.CWI || window.yours ? "available" : "unavailable");
    mark();
    window.addEventListener("cwiReady", mark);
    const id = window.setInterval(mark, 500);
    const timeout = window.setTimeout(() => {
      window.clearInterval(id);
      setStatus((current) => (current === "available" ? current : "unavailable"));
    }, 10_000);
    return () => {
      window.removeEventListener("cwiReady", mark);
      window.clearInterval(id);
      window.clearTimeout(timeout);
    };
  }, []);

  async function onPay(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setTxid("");
    try {
      const preview = fundRequest({ address: address.trim(), sats: Number(sats) });
      if (!preview.ok) {
        setError(preview.message);
        return;
      }
      if (!window.CWI && !window.yours) {
        setError("Install or enable Yours Wallet.");
        return;
      }
      const result = await payVaultWithWallet(window.CWI || window.yours, { address: address.trim(), sats: Number(sats) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setTxid(result.txid);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Payment failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="yours-fund" onSubmit={onPay}>
      <p className="yours-fund-label">Fund a Dogfood vault from Yours Wallet</p>
      <div className="yours-fund-row">
        <input
          name="address"
          autoComplete="off"
          spellCheck="false"
          placeholder="Vault P2PKH (bun src/cli.ts address)"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Vault address"
        />
        <input
          name="sats"
          inputMode="numeric"
          placeholder="sats"
          value={sats}
          onChange={(event) => setSats(event.target.value)}
          aria-label="Amount in sats"
        />
      </div>
      {status === "unavailable" ? (
        <p className="yours-fund-status">Install or enable Yours Wallet, then retry.</p>
      ) : null}
      <button type="submit" disabled={pending || status === "loading"}>
        {pending ? "Waiting for Yours…" : "Pay with Yours Wallet"}
      </button>
      {txid ? (
        <p className="yours-fund-ok">
          Paid in{" "}
          <a href={`https://whatsonchain.com/tx/${txid}`} rel="noreferrer">
            {txid.slice(0, 12)}…
          </a>
        </p>
      ) : null}
      {error ? (
        <p className="yours-fund-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
