// Build the Claude Desktop extension (MCP Bundle) from this package.
//
//   node scripts/build-mcpb.mjs     -> packages/mcp-server/stacktree.mcpb
//
// Stages the built server with its production dependencies only, fills the
// manifest's version from package.json and its tools list from the generated
// annotations (so the listing names exactly the tools the server answers),
// then validates and packs with the official mcpb CLI.

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(pkgDir, '.mcpb-build');
const out = join(pkgDir, 'stacktree.mcpb');
const run = (cmd, cwd = pkgDir) => execSync(cmd, { cwd, stdio: 'inherit' });

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
run('npx tsc -p .');

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
cpSync(join(pkgDir, 'dist'), join(stage, 'server'), { recursive: true, filter: (f) => !f.endsWith('.d.ts') });
cpSync(join(pkgDir, 'mcpb', 'icon.png'), join(stage, 'icon.png'));
cpSync(join(pkgDir, 'README.md'), join(stage, 'README.md'));

// Production dependencies only, installed fresh into the bundle.
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: 'stacktree-mcpb', version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies,
}, null, 2));
run('npm install --omit=dev --no-audit --no-fund --silent', stage);

const annotations = (await import(join(pkgDir, 'dist', 'annotations.gen.js'))).ANNOTATIONS;
const manifest = JSON.parse(readFileSync(join(pkgDir, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
manifest.tools = Object.entries(annotations).map(([name, a]) => ({ name, description: String(a.title ?? name) }));
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

run(`npx -y @anthropic-ai/mcpb validate ${join(stage, 'manifest.json')}`);
rmSync(out, { force: true });
run(`npx -y @anthropic-ai/mcpb pack ${stage} ${out}`);
console.log(`built ${out}`);
