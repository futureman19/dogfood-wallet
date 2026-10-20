import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { isBuiltin } from "node:module";
import { isExcludedPackagePath } from "./package-paths";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
export const runtimeFiles = readdirSync(resolve(root, "src")).filter(n => n.endsWith(".ts") && !n.endsWith(".test.ts")).map(n => `src/${n}`);
export const docs = ["README.md", "LICENSE", "docs/quickstart.md", "docs/payment-recovery.md", "docs/bridge-lifecycle.md", "docs/bridge-provider-contracts.md", "docs/x402-v1-client-funding-gap.md", "docs/package-install.md", "docs/gryd-attestation-spec.md", "docs/gryd-deposit.md", "docs/btc-adapter.md", "docs/doge-adapter.md"];

test("package exclusions allow every reviewed manifest path, including attestations", () => {
  expect([...manifest.files, "package.json"].filter(isExcludedPackagePath)).toEqual([]);
});

test("package exclusions reject private and development paths at any depth", () => {
  const forbidden = [
    "test/a.ts", "tests/a.ts", "testdata/a.json", "src/test-support/a.ts",
    "src/__tests__/a.ts", "fixtures/a.json", "src/__fixtures__/a.json",
    "src/wallet.test.ts", "src/test-wallet.ts", "src/wallet_tests.ts",
    "src/wallet-fixture.json", "src/fixtures.json", "docs/test-plan.md",
    "site/index.html", "nested/site/index.html", "deploy/fly.toml",
    "deployment/config.json", "docs/release-verification.md", "verification/report.md",
    ".env", ".env.local", "nested/.env.production", "nested/wallet.env.backup",
    "wrap.key", "nested/wif.enc", "nested/spends.jsonl", "nested/wrap.key.bak",
    "node_modules/lib/index.js", "nested/node_modules/lib/index.js",
    ".git/config", "nested/.git/config", ".github/workflows/ci.yml",
    "src\\test-support\\a.ts", "nested\\.env", "SRC/WALLET.TEST.TS",
  ];
  expect(forbidden.filter(path => !isExcludedPackagePath(path))).toEqual([]);
});

test("every production import declares its own direct runtime dependency", () => {
  const missing = new Set<string>();
  for (const file of runtimeFiles) {
    const ast = ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    function visit(n: ts.Node) {
      let spec: ts.Node | undefined;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) spec = n.moduleSpecifier;
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(ast) === "require")) spec = n.arguments[0];
      if (spec && ts.isStringLiteral(spec)) {
        const s = spec.text;
        if (!s.startsWith(".") && !isBuiltin(s) && s !== "bun") {
          const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
          if (!manifest.dependencies[name]) missing.add(name);
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(ast);
  }
  expect([...missing].sort()).toEqual([]);
});

test("explicit package allowlist includes runtime and only reviewed public documentation", () => {
  expect(manifest.files?.slice().sort()).toEqual([...runtimeFiles, ...docs].sort());
  expect(manifest.bin).toEqual({ "dogfood-wallet": "src/cli.ts" });
  expect(readFileSync(resolve(root, "src/cli.ts"), "utf8").split(/\r?\n/)[0]).toBe("#!/usr/bin/env bun");
});
