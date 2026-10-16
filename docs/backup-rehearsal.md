# Offline backup / restore rehearsal (owner runbook)

**A recovered address is not permission to spend.** This repository-only harness
creates never-funded fixtures; it cannot select, back up, restore, or repair your
operational vault. No production backup API, archive format, password UX, or
funded acceptance is added.

## Run the disposable rehearsal

Install repository dependencies beforehand. Choose an existing private scratch
parent with sufficient space. On Windows, restrict its ACL to the owner first;
POSIX mode requests do not establish Windows ACLs. From the repository:

```sh
# Bash / Git Bash; replace this with YOUR private absolute scratch parent.
export TEMP='C:/path/to/private-scratch'
export TMP="$TEMP" TMPDIR="$TEMP"
bun --no-env-file scripts/backup-rehearsal.ts --offline-fixture-only --scratch-parent "$TEMP"
```

The only path accepted is the scratch parent, **not a vault path**. The harness
exclusively creates a fresh child workspace, explicitly selects every generated
vault, ignores inherited `DOGFOOD_WALLET_DIR`, and deletes that child in `finally`
on success or failure. It never deletes the parent. A killed process/power loss
can leave private fixture files: protect them and remove only the identified
`dogfood-offline-restore-*` fixture directory after confirming the process stopped.
Deletion is not secure erasure on SSDs, snapshots, or backups.

Success prints only a JSON checklist (no address, WIF, wrapping key, ciphertext,
signature, recovery contents, or raw child output). Any failed assertion exits
nonzero with a sanitized message. Run regression tests with:

```sh
bun test scripts/backup-rehearsal.test.ts
bun run verify
```

## What is exercised

- Completed `.init` layout **and** a constructed legacy layout without `.init`.
  Recursive inventory includes hidden files/directories and all bytes, not a
  filename allowlist. `wif.enc`, `wrap.key`, current `policy.json`, address,
  `STOP_SPENDING`, spend log, lock/pending, and opaque allowance/bridge/BRC-181
  recovery fixtures survive source → backup → separate restored directory.
- Every copied file is newly written, not hardlinked to source, backup, another
  staged file, or restored root. Link count/inode checks plus deliberate backup
  corruption prove the originals/restored copies remain unchanged. The completed
  `.init` policy intentionally differs from the current owner policy and is not
  substituted for it.
- Same derived address and bidirectional SDK challenge signature verification
  with the original/restored public keys; private material stays in memory/files.
  No transaction is signed. Caps (321/654/987 sats), allowlist, kill state and
  synthetic 17-sat daily/lifetime accounting are preserved, not reset.
- A real guard reservation creates synthetic ambiguous 23-sat metadata with a
  1-sat fee and leaves the lock/pending evidence held. These are test numbers,
  **not on-chain payments**. Actual restored CLI subprocesses run `address`,
  `status`, and a denied `send`. Kill rejection is also checked directly; no hold
  or killfile is cleared. No source wallet service is run alongside the restore.
- Runtime `fetch` is denied before CLI execution, with a witness checked after
  each child. Child environments omit provider credentials and disable `.env`
  loading. No balance/provider/chain endpoints are called. This is scoped runtime
  interception, **not an OS network sandbox** or coverage of arbitrary future
  socket APIs. MCP is not separately exercised by this rehearsal.
- Missing each inventoried file and corrupted key bytes refuse restoration before
  destination creation. Decryption rejects corrupt keys even with a newly computed
  inventory. Existing targets (including empty directories) remain untouched.
  A preserved interrupted `.init` without its completion marker stays blocked by
  `address`, normal loading and re-init after copying. No replacement key is made.

## Owner procedure for a real backup (manual, separate from this script)

1. **Quiesce every writer first:** CLI, MCP/HTTP servers, scheduled/background
   agents, policy editors and external allowance spenders. Prevent automatic
   restart. Set/retain `STOP_SPENDING` as an additional guard, not a substitute
   for stopping processes. Kill does not cancel exposed authorizations, and some
   owner emergency paths intentionally bypass it. Do not clear locks or holds.
2. Preserve the **entire directory**, including hidden `.init`, every key pair,
   current policy, accounting, pending/parked/lock state, allowance archives and
   completion markers, bridge history and unknown owner files. Make an independent
   byte copy, not hardlinks, while writers remain stopped. Record a private complete
   inventory/checksum and backup time; verify readback and independent storage.
   Ordinary shell `*` globs can omit `.init`. The staged policy can be stale: never
   copy staged keys/policy over the live root or use `.init` as a wallet.
3. Treat every copy as **fully sensitive**: `wrap.key` is colocated with `wif.enc`,
   so copying them together is NOT an encrypted-backup security guarantee. Recovery
   records can contain signed transactions and keyrings too. Protect storage,
   ACLs and any separately chosen encryption/key custody; never upload these files
   to chats, issue trackers, CI artifacts or public drives.
4. Restore offline into a **new, absent private destination**, never merging into
   an existing directory or overwriting the source. Retain immutable evidence.
   Verify the complete inventory, key/address identity, current policy, kill state,
   per-asset history and all recovery metadata. Do not run `init` to fix corruption
   or absence. Preserve interrupted initialization as blocked; do not synthesize
   completion markers, remove `.init`, or silently treat it as legacy.
5. **Never run source and restored copies simultaneously. Never activate a stale
   accounting snapshot as spending-ready.** Copies share a signing identity but
   do not share filesystem locks. Independently reconcile all activity since the
   snapshot, exposed authorizations and exactly-once accounting before any separate
   owner decision about activation. An absent log row, matching address, successful
   signature, local status, or backup timestamp cannot prove non-payment. Leave
   uncertain state held and killed. Follow [payment recovery](payment-recovery.md)
   for forensic escalation, not a reset/unlock recipe.

## Limits

The harness's trusted inventory exists only in memory: it detects test copy loss
and corruption, not malicious replacement of both backup and manifest, omitted
history before capture, or stale snapshots. It is not a durable authenticated
backup product and does not fsync copied directories/files for disaster recovery.
Opaque allowance/bridge fixtures test byte preservation, not semantic validity,
chain reconciliation or recovery of every real lifecycle. Legacy fixtures retain
an existing policy; historical missing-policy defaults are not endorsed for restore.
Windows ACL enforcement, hardware power loss, filesystem races/adversarial links,
remote filesystems, secure deletion, lost key fragments and funded recovery remain
unverified. No real vault, treasury, global tools or provider configuration is read.
