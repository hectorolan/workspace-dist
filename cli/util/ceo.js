// The CEO's identity as CONFIG, not a hardcoded name.
//
// WHY: the system used to say "Hector" in its code — the CEO block's lead line,
// the regexes that decide whether a test case is waiting on a human, and the
// prompts handed to the orchestrator. CLAUDE.md's own invariant says a fresh
// clone of this repo must already be a fully-functioning agent system for its
// operator; a name baked into the source breaks that for anyone but the original
// one. This module is the single read path for "who is the CEO".
//
// SCOPE — deliberately just the NAME (and pronouns). The CEO's *email* is NOT
// here and must not be: `OWNER_EMAIL` / `AGENT_EMAIL` already own that fact and
// `smtp.js` / `inbox.js` read them straight from env. Nothing in the mail path
// needs the name and nothing in the CEO-block path needs the address, so keeping
// them apart avoids a second source of truth for the same fact (CLAUDE.md:
// "each fact lives in ONE doc — others cross-reference it, never restate it").
//
// FAIL-SOFT, unlike mail identity. `smtp.js` refuses to send with no
// OWNER_EMAIL because a wrong address silently mails the wrong human — real
// blast radius. A missing display name has none: it degrades to the generic
// role label the docs already use, which is readable and obviously unconfigured
// rather than silently wrong. So this one gets a default and mail identity
// never will.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Used when `ceo.name` is unset — a role label, never a guess at someone's name. */
export const DEFAULT_CEO_NAME = 'the CEO';

/** Used when `ceo.hubTitle` is unset — generic, obviously unconfigured, still a working brand. */
export const DEFAULT_HUB_TITLE = 'Hub';

/** Role words that mean "the human in charge", whatever they are called. */
export const ROLE_WORDS = ['ceo', 'owner', 'human'];

/** Articles carry no identity — a bare "the" in a pattern would match everything. */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and']);

/** @type {{name: string, pronouns: string, hubTitle: string}|null} */
let cached = null;

/**
 * Resolve the workspace root the same way the other config readers do: an
 * explicit root wins, then `WS_ROOT`, then this file's grandparent (cli/util/..).
 * @param {string} [root]
 */
function configPath(root) {
  const dir = root || process.env.WS_ROOT
    || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  return path.join(dir, 'configs', 'environments.json');
}

/**
 * The configured CEO. Reads `ceo` from `configs/environments.json` once and
 * caches it (config does not change inside a process; `reset()` exists for tests).
 * Never throws — an unreadable or absent config yields the defaults.
 * `hubTitle` (2026-08-15, the CEO's naming-is-config ruling) is the operator's
 * chosen name for their hub web page — served to the hub app via the log API's
 * `GET /identity`, so the fact lives here once and renders wherever needed.
 * @param {string} [root]
 * @returns {{name: string, pronouns: string, hubTitle: string}}
 */
export function ceo(root) {
  if (cached && !root) return cached;
  /** @type {{name: string, pronouns: string, hubTitle: string}} */
  let out = { name: DEFAULT_CEO_NAME, pronouns: 'they/them', hubTitle: DEFAULT_HUB_TITLE };
  const file = configPath(root);
  if (existsSync(file)) {
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const c = cfg && typeof cfg.ceo === 'object' && cfg.ceo ? cfg.ceo : {};
      if (typeof c.name === 'string' && c.name.trim()) out.name = c.name.trim();
      if (typeof c.pronouns === 'string' && c.pronouns.trim()) out.pronouns = c.pronouns.trim();
      if (typeof c.hubTitle === 'string' && c.hubTitle.trim()) out.hubTitle = c.hubTitle.trim();
    } catch {
      // Malformed config: the defaults are correct-and-obvious, and every other
      // reader of this file already fails loudly on its own key.
    }
  }
  if (!root) cached = out;
  return out;
}

/** The CEO's name for display — "Hector", or "the CEO" when unconfigured. @param {string} [root] */
export const ceoName = (root) => ceo(root).name;

/** Clear the cache (tests only). */
export function reset() { cached = null; }

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex alternation matching any way a plan might name the person in charge:
 * the configured name plus the generic role words. Used by the "is this case
 * waiting on a human" test (prwatch) and the "Needs <CEO>" heading (planclose),
 * so a plan written before a name change still resolves.
 * @param {string} [root]
 * @returns {string} regex source, no anchors, no flags
 */
export function ceoPattern(root) {
  const name = ceoName(root);
  /** @type {string[]} */
  const words = [];
  for (const w of name.split(/\s+/)) {
    const t = w.trim();
    // Skip articles only. Punctuation is ESCAPED, never stripped: stripping turned
    // "A.C" into "AC" (matching "AXC" and not the real name), and a length rule
    // silently dropped short names like "Bo" so the pattern held role words alone.
    if (!t || STOPWORDS.has(t.toLowerCase())) continue;
    words.push(escapeRe(t.toLowerCase()));
  }
  return [...new Set([...words, ...ROLE_WORDS])].join('|');
}
