// Rolling-30-day rotation of the per-machine data dir (WS_DATA_DIR). The central
// DB holds the FULL history of digests, reports, inbox captures and audit lines;
// the data dir only holds transient runtime state (run logs, job outputs, inbox
// working files), so anything older than 30 days is deleted outright. Pure
// mechanics, no AI, no git — the workspace repo no longer carries any of this.
import { readdirSync, statSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './clock.js';

const KEEP_DAYS = 30;

/** Delete files under a data-dir subtree older than the cutoff (best effort). @param {string} dir @param {number} cutoff */
function rotateOld(dir, cutoff) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const p = path.join(dir, entry);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
    } catch { /* best effort */ }
  }
}

/**
 * Rotate the data-dir working directories at 30 days. Takes no arguments — the
 * data dir is the one shared definition (cli/util/clock.js). Never touches git.
 * The processed.log dedup ledger is left alone (the DB inbox_seen is the ledger;
 * the file is a tiny offline fallback that must survive rotation).
 */
export function pruneRepo() {
  const data = dataDir();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const rel of ['jobs', 'job-out']) rotateOld(path.join(data, rel), cutoff);
  // inbox-tmp: rotate captured requests + replies, but keep processed.log.
  const inbox = path.join(data, 'inbox-tmp');
  if (existsSync(inbox)) {
    for (const entry of readdirSync(inbox, { recursive: true, encoding: 'utf8' })) {
      if (path.basename(entry) === 'processed.log') continue;
      const p = path.join(inbox, entry);
      try {
        const st = statSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
      } catch { /* best effort */ }
    }
    // Drop the empty replayed-archive dir if it aged out entirely.
    const replayed = path.join(data, 'fallback', 'replayed');
    if (existsSync(replayed)) {
      try {
        for (const f of readdirSync(replayed)) {
          const p = path.join(replayed, f);
          if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
        }
      } catch { /* best effort */ }
    }
  }
}
