// Bundles the TypeScript tests with esbuild, then runs them with Node's test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';

const out = '.test-build';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const entries = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => 'tests/' + f);
await esbuild.build({ entryPoints: entries, bundle: true, platform: 'node', format: 'esm', outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const files = readdirSync(out).map((f) => `${out}/${f}`);
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
