#!/usr/bin/env node
// Repository-owned, deterministic stand-in for the QMD CLI integration contract.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../test/fixtures/topical-fake-qmd-backend.py', import.meta.url));
const result = spawnSync('python3', [backend, ...process.argv.slice(2)], {
  env: process.env, stdio: 'inherit', timeout: 30000,
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
