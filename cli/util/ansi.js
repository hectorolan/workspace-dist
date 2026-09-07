// ANSI escape stripping for machine-read subprocess output.
//
// WHY THIS EXISTS (proved live on the windows-pc station, 2026-08-17/18): every
// gate the ci-guard runs is parsed line-by-line with anchored regexes — a failing
// case line, a `pass N` tally line, an `error TS7006` line. A `node --test` child
// that decides to colourise prefixes each of those with an ESC sequence, so the
// anchor never matches: the guard saw a genuinely RED suite as "exited 1 with no
// recognisable diagnostics (toolchain problem)", skipped the gate, and let the push
// through — and the baseline tally came back -1, which silently starved plan-close
// of covered case IDs. Colour is a display concern; anything that PARSES output
// must be blind to it.
//
// Two layers use this (belt and braces, deliberately): the spawner neutralises
// colour in the child env (util/ciguard.js `runGate`), and every parser strips what
// arrives anyway — output can also reach a parser from a log file, a CI artefact or
// a differently-spawned run this module does not own.

/**
 * CSI and OSC escape sequences as emitted by terminal colourisers: the colour and
 * cursor forms (ESC [ ... m, ESC [ 2K) plus OSC hyperlinks (ESC ] ... BEL), which
 * is everything a test reporter or a compiler can put around a line. The control
 * bytes are built with fromCharCode, never typed literally: a raw ESC in source is
 * invisible in diffs and review, which is how this class of bug hides.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\))`, 'g');

/**
 * Remove ANSI escape sequences from text. Non-strings are coerced rather than
 * thrown on — parsers call this on whatever a child process handed back.
 * @param {unknown} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * Environment overrides that force a spawned child to emit PLAIN text, whatever the
 * parent shell exported. `FORCE_COLOR` is the one that bites: Claude Code sessions
 * and many CI shells export `FORCE_COLOR=3`, which makes Node colourise even when
 * stdout is a pipe. `NO_COLOR` is the standard opt-out; `TERM=dumb` stops anything
 * inferring capability from the terminal type (callers also drop `COLORTERM`).
 * @returns {Record<string, string>} keys to merge into a child env
 */
export function plainOutputEnv() {
  return { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' };
}
