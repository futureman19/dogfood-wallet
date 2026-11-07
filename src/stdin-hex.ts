/** Bounded stdin transport for `popnlocks-sign --stdin`.
 *
 * The deploy transaction's production covenant alone is ~71k hex chars, which
 * exceeds Windows argv limits (ENAMETOOLONG). This module is the explicitly
 * supported transport: ASCII transaction hex on stdin to EOF, with a hard byte
 * cap and a finite input deadline, fully validated BEFORE the signer is
 * invoked. Nothing here touches keys, policy, the network or the filesystem.
 */

export const POPNLOCKS_STDIN_MAX_BYTES = 1_048_576;
export const POPNLOCKS_STDIN_DEADLINE_MS = 10_000;

export type StdinHexOptions = {
  /** Byte source; defaults to process stdin. Test seams inject an iterable. */
  chunks?: AsyncIterable<Uint8Array | string>;
  maxBytes?: number;
  deadlineMs?: number;
};

/**
 * Reads stdin to EOF and returns the validated ASCII hex payload.
 * Transport contract (must match the maker's Runner):
 *  - at most `maxBytes` input bytes (default 1,048,576);
 *  - EOF must arrive within `deadlineMs` (default 10,000) of the first call;
 *  - one single trailing LF or CRLF is stripped; any other trailing
 *    whitespace or extra newlines are malformed;
 *  - the remainder must be non-empty, even-length, lowercase-or-uppercase
 *    ASCII hex — nothing else.
 * Throws Error with a `popnlocks-sign --stdin: <reason>` message on empty,
 * malformed, odd-length, oversized or timed-out input.
 */
export async function readHexFromStdin(options: StdinHexOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? POPNLOCKS_STDIN_MAX_BYTES;
  const deadlineMs = options.deadlineMs ?? POPNLOCKS_STDIN_DEADLINE_MS;
  const source = options.chunks ?? (process.stdin as unknown as AsyncIterable<Uint8Array>);
  const fail = (reason: string): Error => new Error(`popnlocks-sign --stdin: ${reason}`);
  const parts: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(fail(`no EOF within ${deadlineMs} ms input deadline`)), deadlineMs);
  });
  try {
    const reading = (async () => {
      for await (const chunk of source) {
        const buf =
          typeof chunk === 'string'
            ? Buffer.from(chunk, 'utf8')
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        total += buf.length;
        if (total > maxBytes) throw fail(`payload exceeds ${maxBytes} byte limit`);
        parts.push(buf);
      }
    })();
    await Promise.race([reading, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  let text = Buffer.concat(parts).toString('latin1');
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.length === 0) throw fail('empty payload');
  if (!/^[0-9a-fA-F]*$/.test(text)) throw fail('malformed payload: ASCII hex only, at most one trailing newline');
  if (text.length % 2 !== 0) throw fail('odd-length hex payload');
  return text;
}
