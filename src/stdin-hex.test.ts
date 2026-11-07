import {test, expect} from 'bun:test';
import {P2PKH, Script, Transaction} from '@bsv/sdk';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initVault} from './vault';
import {readHexFromStdin, POPNLOCKS_STDIN_MAX_BYTES, POPNLOCKS_STDIN_DEADLINE_MS} from './stdin-hex';

async function* gen(chunks: (Uint8Array | string)[]) { for (const c of chunks) yield c; }
async function* hang() { yield 'aa'; await new Promise(() => {}); }
const read = (chunks: (Uint8Array | string)[], extra: Record<string, unknown> = {}) =>
  readHexFromStdin({chunks: gen(chunks), ...extra});

test('constants pin the transport contract: 1 MiB cap, 10 s deadline', () => {
  expect(POPNLOCKS_STDIN_MAX_BYTES).toBe(1048576);
  expect(POPNLOCKS_STDIN_DEADLINE_MS).toBe(10000);
});

test('accepts EOF, one trailing LF or CRLF, uppercase, split chunks and >72k payloads', async () => {
  expect(await read(['ab'])).toBe('ab');
  expect(await read(['ab\n'])).toBe('ab');
  expect(await read(['ab\r\n'])).toBe('ab');
  expect(await read(['AB'])).toBe('AB');
  expect(await read(['a', 'b', '\r', '\n'])).toBe('ab');
  expect(await read([new Uint8Array([0x61]), new Uint8Array([0x62])])).toBe('ab');
  const big = 'ab'.repeat(37000); // 74,000 hex chars — beyond the production covenant size
  expect(await read([big])).toBe(big);
  expect(await read([big.slice(0, 100), big.slice(100)])).toBe(big);
  expect(await read([big + '\n'])).toBe(big);
});

test('rejects empty, lone newline, double newline, odd-length, non-hex and non-ASCII', async () => {
  await expect(read([])).rejects.toThrow('empty');
  await expect(read(['\n'])).rejects.toThrow('empty');
  await expect(read(['\r\n'])).rejects.toThrow('empty');
  await expect(read(['ab\n\n'])).rejects.toThrow('malformed');
  await expect(read(['ab\n\r\n'])).rejects.toThrow('malformed');
  await expect(read(['ab\r'])).rejects.toThrow('malformed');
  await expect(read(['ab '])).rejects.toThrow('malformed');
  await expect(read(['abc'])).rejects.toThrow('odd-length');
  await expect(read(['ab\n0'])).rejects.toThrow('malformed');
  await expect(read(['zz'])).rejects.toThrow('malformed');
  await expect(read(['0x12'])).rejects.toThrow('malformed');
  await expect(read(['a b0'])).rejects.toThrow('malformed');
  await expect(read([new Uint8Array([0x61, 0x80])])).rejects.toThrow('malformed');
  await expect(read(['ab\t'])).rejects.toThrow('malformed');
});

test('rejects oversized input: byte cap enforced across chunks before hex validation', async () => {
  await expect(read(['ab', 'cd', 'e'], {maxBytes: 4})).rejects.toThrow('exceeds');
  await expect(read(['abcde'], {maxBytes: 4})).rejects.toThrow('exceeds');
  await expect(read(['zzzzzz'], {maxBytes: 4})).rejects.toThrow('exceeds'); // size first, not hex
  await expect(read(['ab'], {maxBytes: 2})).resolves.toBe('ab');
  await expect(read(['a'.repeat(POPNLOCKS_STDIN_MAX_BYTES + 1)])).rejects.toThrow('exceeds 1048576');
});

test('rejects when EOF misses the finite input deadline', async () => {
  await expect(readHexFromStdin({chunks: hang(), deadlineMs: 25})).rejects.toThrow('no EOF within 25 ms');
});

// ---- Real subprocess transport through the CLI (offline: preload mocks all network) ----
function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'popnlocks-stdin-'));
  const {address} = initVault(root);
  writeFileSync(join(root, 'policy.json'), JSON.stringify({popnlocks: {maxPerTxSats: 100000, maxPerDaySats: 900000}}));
  const source = new Transaction();
  source.addInput({sourceTXID: '12'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_0')});
  source.addOutput({satoshis: 90000, lockingScript: new P2PKH().lock(address)});
  const source2 = new Transaction();
  source2.addInput({sourceTXID: '34'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_0')});
  source2.addOutput({satoshis: 50000, lockingScript: new P2PKH().lock(address)});
  source2.addOutput({satoshis: 1, lockingScript: Script.fromASM('OP_1')});
  const tx = new Transaction();
  tx.addInput({sourceTXID: source.id('hex'), sourceOutputIndex: 0, unlockingScript: new Script()});
  tx.addInput({sourceTXID: source2.id('hex'), sourceOutputIndex: 0, unlockingScript: new Script()});
  // Production-sized covenant: single 36,500-byte push -> ~73,100 hex chars total.
  tx.addOutput({satoshis: 89000, lockingScript: new Script().writeOpCode(0x51).writeBin(new Array(36500).fill(0xab))});
  const hex = tx.toHex();
  expect(hex.length).toBeGreaterThan(72000);
  const preload = join(root, 'preload.ts');
  writeFileSync(preload, `const m=new Map(${JSON.stringify([
    [`/tx/${source.id('hex')}/hex`, source.toHex()],
    [`/tx/${source2.id('hex')}/hex`, source2.toHex()],
    [`/address/${address}/unspent`, [{tx_hash: source.id('hex'), tx_pos: 0, value: 90000}, {tx_hash: source2.id('hex'), tx_pos: 0, value: 50000}]],
  ])});globalThis.fetch=async(u,i)=>{if(i?.method!=='GET')throw Error('Network write forbidden');const k=String(u).replace('https://api.whatsonchain.com/v1/bsv/main','');if(!m.has(k))throw Error('Unexpected network');const v=m.get(k);return new Response(typeof v==='string'?v:JSON.stringify(v));};`);
  const cwd = join(import.meta.dir, '..');
  const env = {...process.env, DOGFOOD_WALLET_DIR: root};
  const runSync = (args: string[], stdin: string | Buffer) =>
    Bun.spawnSync([process.execPath, '--preload', preload, 'src/cli.ts', 'popnlocks-sign', ...args], {cwd, env, stdin: typeof stdin === 'string' ? Buffer.from(stdin) : stdin});
  return {root, tx, hex, runSync, spawnArgs(extra: string[]) {
    return {cmd: [process.execPath, '--preload', preload, 'src/cli.ts', 'popnlocks-sign', ...extra] as string[], cwd, env};
  }, clean() { rmSync(root, {recursive: true, force: true}); }};
}

test('CLI --stdin signs a >72,000 char production-sized payload, LF and CRLF endings', async () => {
  const h = cliFixture();
  try {
    for (const ending of ['', '\n', '\r\n']) {
      const r = h.runSync(['--stdin', '0'], h.hex + ending);
      expect(r.stderr.toString()).toBe('');
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString().trim();
      expect(out).toMatch(/^[a-f0-9]+$/);
      const signed = Transaction.fromHex(out);
      expect(signed.inputs[0]!.unlockingScript!.toHex()).not.toBe('');
      expect(signed.inputs[1]!.unlockingScript!.toHex()).toBe('');
      expect(signed.outputs[0]!.lockingScript.toHex()).toBe(h.tx.outputs[0]!.lockingScript.toHex());
    }
  } finally { h.clean(); }
}, 30000);

test('CLI --stdin strict input index and usage rejections', () => {
  const h = cliFixture();
  try {
    for (const args of [['--stdin'], ['--stdin', '-1'], ['--stdin', '0x0'], ['--stdin', '0.5'], ['--stdin', '0', 'extra'], ['--stdin', '0', '--stdin']]) {
      const r = h.runSync(args, h.hex);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain('Usage: popnlocks-sign');
      expect(r.stdout.toString()).toBe('');
    }
    const other = h.runSync(['--stdin', '1'], h.hex + '\n');
    expect(other.exitCode).toBe(0);
    expect(Transaction.fromHex(other.stdout.toString().trim()).inputs[1]!.unlockingScript!.toHex()).not.toBe('');
  } finally { h.clean(); }
}, 30000);

test('CLI --stdin rejects empty, malformed and odd-length stdin before keys/network/signing', () => {
  const h = cliFixture();
  try {
    writeFileSync(join(h.root, 'wif.enc'), 'broken'); // proves refusal precedes key decrypt
    for (const [stdin, reason] of [['', 'empty'], ['\n', 'empty'], ['zz', 'malformed'], ['abc', 'odd-length'], [h.hex + '\n\n', 'malformed'], [h.hex.slice(0, 99) + ' ', 'malformed']] as const) {
      const r = h.runSync(['--stdin', '0'], stdin);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain(`popnlocks-sign --stdin: ${reason}`);
      expect(r.stdout.toString()).toBe('');
    }
    expect(existsSync(join(h.root, 'popnlocks-signs'))).toBe(false);
    expect(existsSync(join(h.root, 'spends.jsonl'))).toBe(false);
  } finally { h.clean(); }
}, 30000);

test('CLI --stdin rejects oversized stdin above the 1 MiB cap', () => {
  const h = cliFixture();
  try {
    writeFileSync(join(h.root, 'wif.enc'), 'broken');
    const r = h.runSync(['--stdin', '0'], Buffer.alloc(1048577, 0x61));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('exceeds 1048576 byte limit');
    expect(r.stdout.toString()).toBe('');
    expect(existsSync(join(h.root, 'popnlocks-signs'))).toBe(false);
  } finally { h.clean(); }
}, 30000);

test('CLI --stdin rejects when stdin never reaches EOF within 10 s', async () => {
  const h = cliFixture();
  try {
    writeFileSync(join(h.root, 'wif.enc'), 'broken');
    const {cmd, cwd, env} = h.spawnArgs(['--stdin', '0']);
    const proc = Bun.spawn(cmd, {cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    proc.stdin.write('aa');
    await proc.stdin.flush(); // payload delivered but never EOF'd
    const outcome = await Promise.race([proc.exited, new Promise<'hang'>(r => setTimeout(() => r('hang'), 25000))]);
    if (outcome === 'hang') { proc.kill(); throw new Error('child did not enforce the 10 s input deadline'); }
    expect(outcome).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain('no EOF within 10000 ms');
    expect(existsSync(join(h.root, 'popnlocks-signs'))).toBe(false);
  } finally { h.clean(); }
}, 45000);

test('CLI legacy argv transport still signs (ENAMETOOLONG-safe sizes) and package ships the module', () => {
  const h = cliFixture();
  try {
    const small = new Transaction();
    small.addInput({sourceTXID: h.tx.inputs[0]!.sourceTXID!, sourceOutputIndex: 0, unlockingScript: new Script()});
    small.addInput({sourceTXID: '34'.repeat(32), sourceOutputIndex: 1, unlockingScript: new Script()});
    small.addOutput({satoshis: 89000, lockingScript: Script.fromASM('OP_1')});
    const r = h.runSync([small.toHex(), '0'], '');
    expect(r.exitCode).toBe(0);
    expect(Transaction.fromHex(r.stdout.toString().trim()).inputs[0]!.unlockingScript!.toHex()).not.toBe('');
    expect(JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')).files).toContain('src/stdin-hex.ts');
  } finally { h.clean(); }
}, 30000);
