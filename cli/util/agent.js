// THE provider seam — the only module that knows which AI CLI is installed
// (port of scripts/container/run-agent.sh). Swap providers by setting
// AGENT_PROVIDER and adding a case branch; nothing else in the system changes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { workspaceDir } from './apiclient.js';

/**
 * Run one headless agent session. The outer session only dispatches to a
 * subagent, so it runs on the cheapest model (AGENT_MODEL, default haiku);
 * the subagent's own `model:` frontmatter governs the real work.
 * Runs from the sources dir (parent of the workspace) so .claude config loads.
 * @param {string} prompt
 * @param {{tools?: string, model?: string, env?: Record<string, string>, log?: (line: string) => void}} [opts]
 * @returns {Promise<{code: number, output: string}>}
 */
export function runAgent(prompt, opts = {}) {
  const provider = process.env.AGENT_PROVIDER || 'claude';
  const model = opts.model || process.env.AGENT_MODEL || 'haiku';
  const tools = opts.tools || process.env.AGENT_ALLOWED_TOOLS || 'Read,Write,Glob,Grep,WebSearch,WebFetch';
  const cwd = path.dirname(workspaceDir());
  const env = { ...process.env, ...(opts.env || {}) };

  /** @type {string} */
  let cmd;
  /** @type {string[]} */
  let args;
  switch (provider) {
    case 'claude':
      cmd = 'claude';
      args = ['-p', prompt, '--model', model, '--allowedTools', tools];
      break;
    // Example future backends — one branch each, nothing else changes:
    // case 'gemini': cmd = 'gemini'; args = ['-p', prompt]; break;
    case 'exec': {
      // Test seam: WS_AGENT_EXEC = "node script.js" — receives the prompt as argv,
      // tools/model via env. Never used in production.
      const parts = (process.env.WS_AGENT_EXEC || '').split(/\s+/).filter(Boolean);
      if (parts.length === 0) return Promise.resolve({ code: 1, output: 'WS_AGENT_EXEC not set' });
      cmd = parts[0];
      args = [...parts.slice(1), prompt];
      break;
    }
    default:
      return Promise.resolve({ code: 1, output: `unknown AGENT_PROVIDER '${provider}'` });
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: 1, output: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}
