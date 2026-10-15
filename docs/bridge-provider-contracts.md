# Provider contract evidence (documentation only)

Retrieved via browser on 2026-10-15. No provider transaction API, wallet, chain RPC, or credentials were accessed. Fixtures are synthetic, adapted to BSV → native USDC on Base from the documented field schemas, NOT captures of real transactions or evidence of route availability.

## Exolix API v2

Source: https://exolix.com/developers (current version linked by that page).

- POST `/api/v2/transactions`, not `/exchanges`. Required body: `coinFrom`, `networkFrom`, `coinTo`, `networkTo`, `amount`, `withdrawalAddress`. `rateType` float/fixed. Optional key header is `api-key`, not bearer Authorization.
- GET `/api/v2/transactions/{id}`.
- Both return `id`, `amount`, `amountTo`, `depositAddress`, `withdrawalAddress`, `coinFrom` and `coinTo` objects with `coinCode`, `network`, `contract`. `hashIn` and `hashOut` are objects with `hash` and `link`; examples use null hashes before settlement.
- Status enum: `wait`, `confirmation`, `confirmed`, `exchanging`, `sending`, `success`, `overdue`, `refund`, `refunded`.
- `depositExtraId` and `withdrawalExtraId` must be absent/empty/null on our restricted no-memo route.
- `/rate` quote amounts remain estimates, not chain receipt evidence.

## ChangeNOW API v2

Official landing page https://changenow.io/api links “See API Docs” to:
https://documenter.getpostman.com/view/8180765/SVfTPnM8?version=latest#intro

Create section: https://documenter.getpostman.com/view/8180765/SVfTPnM8?version=latest#3c8edfd0-ae3f-4738-a01c-de3e196bd761
(API v2 → Create exchange transaction; adjacent Transaction status section.)
The old https://changenow.io/api/docs/standard-flow/method-transaction-status rendered an empty main section; it is not the schema used here.

- POST `https://api.changenow.io/v2/exchange`: explicit `fromCurrency`, `fromNetwork`, `toCurrency`, `toNetwork`, `fromAmount`, `address`, `flow: standard`, `type: direct`.
- Create response: `id`, `fromAmount`, `toAmount`, `flow`, `type`, `payinAddress`, `payoutAddress`, `fromCurrency`, `fromNetwork`, `toCurrency`, `toNetwork`. No status is required by the documented create response; create is not settlement proof.
- GET `/v2/exchange/by-id?id=...`: response includes exact `id`, route fields, `expectedAmountFrom`, `expectedAmountTo`, actual `amountFrom`, actual `amountTo`, addresses, `payinHash`, `payoutHash`, `status`. **Status uses amountTo, not toAmount.** Amounts and hashes can be null before settlement; response fields vary by state.
- Status enum: `new`, `waiting`, `confirming`, `exchanging`, `sending`, `finished`, `failed`, `refunded`, `verifying`.
- Authentication: `x-changenow-api-key`. Documentation says access to some v2 endpoints requires partner enablement.
- The troubleshooting documentation specifies exchange IDs are exactly 14 characters.

## Trust boundary

Provider statements establish order metadata and assert deposit/order/payout attribution. Neither documented schema provides a cryptographic BSV-deposit-to-USDC-transfer commitment; the returned hashes and amounts are provider assertions, not independent order identity. The durable pre-order Base boundary excludes historical receipts but cannot distinguish two contemporaneous unrelated transfers to the same pocket. Completion therefore retains centralized-provider attribution trust; applications requiring independent attribution must not use this mode. See [bridge-lifecycle.md](bridge-lifecycle.md#chain-settlement-checks-and-provider-attribution). They cannot prove deposited BSV or received USDC. Exact returned IDs, networks, assets, addresses and amounts must be validated; request values must never fill absent response evidence. Unknown states, missing route evidence, invalid amounts, mismatched IDs and non-Base configurations fail closed. Native Base USDC is pinned locally to chain 8453 and contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913. Synthetic BSV/Base fixtures instantiate that restricted route; public schemas do not establish present-day trading availability or live compatibility.
