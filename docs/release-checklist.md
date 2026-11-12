# First registry release checklist — @dogfood/wallet

Status: **ready for the human phase.** Everything code-side is green.
This document is operational, not product docs — it stays out of the package
(the `files` allowlist controls what ships; this file is not in it).

## Phase 0 — preflight (already done, 2026-11-12)

- [x] `bun run verify` green — 1094 tests + typecheck (commit `a3a019e`)
- [x] `bun run verify:package` green — real `npm pack` + isolated install smoke
- [x] Pack inventory: 66 files, ~188 KB packed / ~641 KB unpacked
- [x] Version decision: ship **0.1.0** as-is (never published; no bump needed)
- [x] Tag namespace clean (no existing tags); local npm CLI 11.6.2 (≥11.5.1 ✓)
- [ ] Open call: Codex's x402-permits slice is in flight. **Recommendation:
      wait for it to land (it completes the permits story), release after.
      If it blocks, release 0.1.0 without it — permits already work on `send`.**

## Phase 1 — human at the keyboard (one-time, ~15 min)

Why manual: npm trusted publishing (OIDC) cannot create a brand-new package —
the registry entry must exist before a trusted publisher can be configured
(npm/cli#8544). So v0.1.0 publishes by hand; every release after goes through
the tag-triggered OIDC workflow.

1. `npm login` — browser flow with your 2FA.
2. From the repo root: `npm publish --access public`
   - `prepublishOnly` runs `bun run verify && bun run verify:package`
     automatically; the publish aborts if either fails.
   - `--access public` is required for the first publish of a scoped package.
   - Expect an OTP prompt if your 2FA covers writes.
   - Local publishes cannot attach provenance (OIDC-only) — fine for 0.1.0;
     every CI release after this one carries it.
3. Verify it landed:
   - `npm view @dogfood/wallet` shows 0.1.0
   - In a scratch dir: `npm i -g @dogfood/wallet` then `dogfood-wallet --help`
4. Configure the trusted publisher (npmjs.com → package → Settings →
   Trusted Publisher → GitHub Actions):
   - Organization/user: `futureman19`
   - Repository: `dogfood-wallet`
   - Workflow filename: `publish.yml` (exact, case-sensitive)
   - Environment: leave empty (the workflow has none)
   - Allowed actions: `npm publish`
   - ⚠️ npm expires a new trusted-publisher config if its first successful
     publish doesn't happen within 2 days — so do Phase 2 right after.
5. Recommended hardening on the same settings page: disallow token-based
   publishing (OIDC becomes the only way to publish).
6. `npm logout` to clear the local credential.

## Phase 2 — prove the OIDC path (immediately after Phase 1)

1. Bump the version: `npm version patch --no-git-tag-version` (0.1.1) —
   or `minor` (0.2.0) if x402-permits landed first. Commit the bump.
2. `git tag v<version> && git push origin v<version>` — pushing the tag IS the
   release act; `.github/workflows/publish.yml` verifies the tag matches
   package.json, runs both verify gates, then `npm publish --provenance`.
3. Confirm the run in GitHub Actions and the provenance badge on npmjs.com.

## Phase 3 — after the first registry release

- [ ] README: replace "Registry installation becomes available after the
      human-gated first release" with the live install command.
- [ ] docs/package-install.md: same flip (both files are in the package
      allowlist — the docs list in `scripts/package.test.ts` must not change;
      editing content is fine, adding NEW doc files to `files` is a tripwire).
- [ ] Site: flip the `$ npm i -g @dogfood/wallet` CTA from the GitHub link to
      the real registry package; `cd site && vercel deploy --prod --yes`.
- [ ] Update the dogfood-wallet skill note (registry live, tag-release flow).
