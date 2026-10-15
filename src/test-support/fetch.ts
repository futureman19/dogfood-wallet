// Bun's fetch includes a preconnect method. Keep injected test fetches structurally
// honest without ever connecting to a real host through that auxiliary method.
export function mockFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(fn, {
    preconnect: (() => { throw new Error("Unexpected fetch.preconnect in offline test"); }) satisfies typeof fetch.preconnect,
  });
}
