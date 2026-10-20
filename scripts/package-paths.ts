// Shared by the packed-inventory verifier and its offline regression tests.
export function isExcludedPackagePath(path: string): boolean {
  // Match development names at component/token boundaries, not "test" in
  // "attest". Accept either separator so Windows paths get the same protection.
  // Secret markers remain deliberately broad, including backup suffixes.
  return path.split(/[\\/]/).some(component =>
    /(?:^|[._-])(?:tests?|testdata|fixtures?)(?:$|[._-])/i.test(component) ||
    /(?:^|[._-])site(?:$|[._-])/i.test(component) ||
    /deploy|verification|\.env|\.key|\.enc|\.jsonl|node_modules|\.git/i.test(component)
  );
}
