import { randomUUID } from "node:crypto";
import { BSM, type PrivateKey, Utils } from "@bsv/sdk";
import { loadVault } from "./vault";

// Agent subset of locus-protocol/src/signed-write.ts; see frozen vectors and
// scripts/gryd-agent-vectors.ts. No runtime dependency on the sibling repository.
export const AGENT_WRITE_ACTIONS = [
  "agent.create", "agent.update", "agent.fund", "agent.withdraw", "agent.authorize",
  "agent.mine", "agent.transactions", "agent.conversation", "agent.runs",
  "agent.invoke", "agent.approach", "agent.invoke_agent", "agent.brain.read", "agent.brain.update",
  "agent.list", "agent.cancel_listing", "agent.buy", "agent.lock", "agent.unlock",
  "agent.capabilities.read", "agent.capability.grant", "agent.capability.revoke",
  "agent.action.dry_run", "agent.action.execute", "agent.actions.read",
  "agent.schedule.create", "agent.schedule.list", "agent.schedule.update", "agent.schedule.delete",
] as const;
export type SignedWriteAction = (typeof AGENT_WRITE_ACTIONS)[number];
export interface SignedWriteEnvelope<A extends SignedWriteAction | "object.mint" = SignedWriteAction> {
  mode: "signed_write";
  method: "POST" | "PUT" | "DELETE";
  path: string;
  action: A;
  body: Record<string, unknown>;
  timestamp: number;
  nonce: string;
  /** Required by the deployed backend since the split-identity release — missing is NOT mainnet. */
  network: "mainnet" | "testnet";
  /** Required: API deployment host this envelope is intended for (prod = the-grid-api.fly.dev). */
  audience: string;
}
export interface SignedAgentRequest<A extends SignedWriteAction | "object.mint" = SignedWriteAction> {
  payload: SignedWriteEnvelope<A>;
  signature: string;
  pubkey: string;
  address: string;
}
type RequestBinding = Pick<SignedWriteEnvelope, "method" | "path">;
type EnvelopeOptions = Partial<Pick<SignedWriteEnvelope, "timestamp" | "nonce" | "network" | "audience">>;
/** The vault is mainnet-only and talks to the prod Gryd API; both are bound into every signature. */
export const GRYD_ENVELOPE_SCOPE = { network: "mainnet", audience: "the-grid-api.fly.dev" } as const;

// Serialize directly: JSON.stringify on a reconstructed sorted object re-orders
// integer-looking keys. Refuse non-JSON data that changes during transport.
function canonicalJson(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null) throw new Error("Body must contain only JSON values");
  if (parents.has(value)) throw new Error("Body must not contain cycles");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Body must contain plain JSON objects");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Body must contain only JSON keys");
  parents.add(value);
  try {
    if (array) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) throw new Error("Body must contain dense JSON arrays");
        parts.push(canonicalJson(descriptor.value, parents));
      }
      return `[${parts.join(",")}]`;
    }
    const parts = Object.keys(value).sort().map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if (!("value" in descriptor)) throw new Error("Body must not contain accessors");
      return `${JSON.stringify(name)}:${canonicalJson(descriptor.value, parents)}`;
    });
    return `{${parts.join(",")}}`;
  } finally { parents.delete(value); }
}

/** Byte-identical to the protocol helper for JSON-compatible envelopes. */
export function canonicalSignedWriteMessage(payload: SignedWriteEnvelope<SignedWriteAction | "object.mint">): string {
  return "Locus Signed Write\n" + canonicalJson(payload);
}

function buildEnvelope(action: SignedWriteAction, body: Record<string, unknown>, request: RequestBinding, options: EnvelopeOptions): SignedWriteEnvelope {
  if (!(AGENT_WRITE_ACTIONS as readonly unknown[]).includes(action)) throw new Error("Unsupported agent signed-write action");
  if (!["POST", "PUT", "DELETE"].includes(request.method)) throw new Error("Method must be POST, PUT or DELETE");
  if (typeof request.path !== "string" || !request.path.startsWith("/") || request.path.startsWith("//") || /[\s\x00-\x1f\x7f]/.test(request.path)) throw new Error("Path must be an exact absolute request path, not a URL");
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Body must be a JSON object");
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = options.nonce ?? randomUUID();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Timestamp must be nonnegative integer seconds");
  if (typeof nonce !== "string" || !nonce.trim()) throw new Error("Nonce must be a nonempty string");
  if (options.network !== undefined && options.network !== "mainnet" && options.network !== "testnet") throw new Error("Network must be mainnet or testnet");
  const audience = options.audience ?? GRYD_ENVELOPE_SCOPE.audience;
  if (typeof audience !== "string" || !audience.trim() || /[\s/]/.test(audience)) throw new Error("Audience must be a bare deployment host");
  const payload: SignedWriteEnvelope = { mode: "signed_write", method: request.method, path: request.path, action, body: JSON.parse(canonicalJson(body)), timestamp, nonce, network: options.network ?? GRYD_ENVELOPE_SCOPE.network, audience };
  return payload;
}

function signEnvelope<A extends SignedWriteAction | "object.mint">(payload: SignedWriteEnvelope<A>, key: PrivateKey): SignedAgentRequest<A> {
  const message = canonicalSignedWriteMessage(payload);
  const signature = BSM.sign(Utils.toArray(message, "utf8"), key, "base64") as string;
  return { payload, signature, pubkey: key.toPublicKey().toString(), address: key.toAddress() };
}

/** Pure offline signer. Explicit clock/nonce overrides support reproducible vectors. */
export function signAgentRequest(action: SignedWriteAction, body: Record<string, unknown>, request: RequestBinding, key: PrivateKey, options: EnvelopeOptions = {}): SignedAgentRequest {
  return signEnvelope(buildEnvelope(action, body, request, options), key);
}

/** Internal origination signer: fixed action and route; agent-call stays agent-only. */
export function signObjectMintRequest(body: Record<string, unknown>, key: PrivateKey): SignedAgentRequest<"object.mint"> {
  const base = buildEnvelope("agent.create", body, {method: "POST", path: "/api/v1/objects/mint"}, {network: "mainnet"});
  return signEnvelope({...base, action: "object.mint"}, key);
}

/** Human-supervised vault boundary: validate before key access; no HTTP or writes. */
export function signVaultAgentRequest(root: string, action: SignedWriteAction, body: Record<string, unknown>, request: RequestBinding): SignedAgentRequest {
  const payload = buildEnvelope(action, body, request, {network: "mainnet"});
  const vault = loadVault(root);
  if (vault.policy.killfileOn) throw new Error("STOP_SPENDING is on; refusing agent signing");
  return signEnvelope(payload, vault.key);
}
