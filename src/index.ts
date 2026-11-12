/**
 * Curated library surface of @dogfood/wallet: keyless verification and the
 * agent-side escalation queue. Human-decision functions (approve/deny/allow)
 * and every key-loading or payment path are deliberately NOT reachable from
 * this entry — deep imports are gated by the package exports map. src/exports.test.ts
 * freezes this namespace; growing it is a deliberate, reviewed act.
 *
 * In-process MCP tools for agent frameworks: import { createServer } from
 * "@dogfood/wallet/mcp".
 */
export {
  AUTH_PREFIX,
  MAX_AUTH_MESSAGE_BYTES,
  canonicalAuthMessage,
  signAuthMessage,
  verifyAuthMessage,
} from "./auth-sign";
export type { AuthSignature } from "./auth-sign";
export { fileRequest, listRequests, MAX_PENDING_REQUESTS } from "./requests";
export type { CapField, PolicyRequest, RequestKind } from "./requests";

/** Pinned equal to package.json version by src/exports.test.ts. */
export const DOGFOOD_WALLET_VERSION = "0.1.0";
