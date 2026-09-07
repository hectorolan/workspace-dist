// plans-import — one-call migration of a directory of plan md files into the plan
// table (design brief: the DB is the source of truth for plans, 2026-07-23).
// Usage: node cli/util-tools/plans-import.js <dir>   (a dir of plan .md files; the
// original source tree is retired — the DB is the source of truth for plans)
// Idempotent: PUT /plan/:slug is an upsert, so re-runs simply refresh bodies.
// Sends no `status` — creates default to 'active', re-imports never clobber a
// status set later via `ws plan set`. Excludes README.md.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceDir, planSet } from '../util/index.js';

/** Slug from filename: strip `.md`, leading `YYYY-MM-DD-`, trailing `-plan`. @param {string} filename */
export function deriveSlug(filename) {
  return path.basename(filename, '.md')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/-plan$/, '');
}

/** Title from the first `# ` heading; fallback: the slug. @param {string} markdown @param {string} slug */
export function deriveTitle(markdown, slug) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : slug;
}

/** Importable plan files in a directory (md only, README.md excluded). @param {string} dir */
export function planFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('plans-import: usage: plans-import <dir>');
    process.exitCode = 2;
    return;
  }
  const files = planFiles(dir);
  if (files.length === 0) {
    console.error(`plans-import: no md files in ${dir}`);
    process.exitCode = 1;
    return;
  }
  let failed = false;
  for (const f of files) {
    const body = readFileSync(path.join(dir, f), 'utf8');
    const slug = deriveSlug(f);
    try {
      const { line, created } = await planSet(slug, {
        title: deriveTitle(body, slug),
        body,
        agent: 'plans-import',
      });
      console.log(`${created ? 'created' : 'updated'}: ${line}`);
    } catch (e) {
      failed = true;
      console.error(`FAILED ${slug} (${f}): ${e instanceof Error ? e.message : e}`);
    }
  }
  // exitCode, not process.exit(): hard-exiting while undici keep-alive sockets
  // tear down trips a libuv assertion on Windows (exit 127 despite success).
  process.exitCode = failed ? 1 : 0;
}

// Main guard so cli/test can load the derivation helpers without running the import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
