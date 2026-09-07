// probe() — run an external tool and capture its output, without the DEP0190 pattern.
//
// WHY THIS EXISTS: `env-doctor.js` and `station-bootstrap.js` each carried their own
// `spawnSync(cmd, argv, { shell: true })`. Node 24 prints DEP0190 for that combination
// on every call — observed on the VM 2026-08-01, once per `ws pull` tick:
//
//   Passing args to a child process with shell option true can lead to security
//   vulnerabilities, as the arguments are not escaped, only concatenated.
//
// The warning is precise: with `shell: true` Node does NOT pass argv as a vector, it
// pastes the tokens into a command line the shell re-parses. Both call sites pass fixed
// literal argv, so nothing is injectable TODAY — but it is deprecated (an error in a
// later major) and the shape is one careless `${}` away from a real hole.
//
// THE SPLIT, and why a shell cannot simply be dropped:
//   POSIX   — no shell at all. argv goes as a real vector; nothing can be re-parsed,
//             and the deprecation does not apply.
//   Windows — `gh`, `az` and `claude` are `.cmd` shims, and Node refuses to spawn
//             `.cmd`/`.bat` without a shell (the 2024 argument-injection fix), so a
//             shell is unavoidable. What IS avoidable is handing Node an args array
//             alongside it: build ONE explicitly-quoted command line instead, so the
//             quoting is visible in our code rather than implied by Node's concatenation.
import { spawnSync } from 'node:child_process';

/** Tokens safe to leave bare on a cmd.exe command line. */
const BARE_OK = /^[A-Za-z0-9._:\\/=+-]+$/;

/**
 * Quote one token for cmd.exe. Conservative by design: anything not obviously inert is
 * wrapped, and embedded quotes are escaped. Adequate because every call site passes
 * fixed literal argv — it is not a general-purpose shell escaper, and must not become
 * the excuse to start interpolating operator input into a probe.
 * @param {string} token
 */
export function winQuote(token) {
  if (token === '') return '""';
  if (BARE_OK.test(token)) return token;
  return `"${token.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * One cmd.exe command line from a command and its argv.
 * @param {string} cmd @param {string[]} argv
 */
export const winCommandLine = (cmd, argv) => [cmd, ...argv].map(winQuote).join(' ');

/**
 * Run `cmd` with `argv`, returning combined stdout+stderr. Never throws: a missing
 * binary or a timeout comes back as `ok:false`, which is what every caller checks.
 * @param {string} cmd
 * @param {string[]} argv
 * @param {{timeout?: number, cwd?: string, platform?: string, spawn?: typeof spawnSync}} [opts]
 *   `platform`/`spawn` are test seams; production passes neither.
 * @returns {{ok: boolean, out: string, status: number|null}}
 */
export function probe(cmd, argv, { timeout = 30000, cwd, platform = process.platform, spawn = spawnSync } = {}) {
  const base = { encoding: /** @type {const} */ ('utf8'), timeout, windowsHide: true, ...(cwd ? { cwd } : {}) };
  const r = platform === 'win32'
    ? spawn(winCommandLine(cmd, argv), { ...base, shell: true })
    : spawn(cmd, argv, base);
  return {
    ok: r.status === 0 && !r.error,
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    status: r.status,
  };
}
