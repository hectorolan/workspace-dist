#!/usr/bin/env node
// log-api-tunnel — keeps the encrypted (SSH) path to the central log API open.
//
//   node cli/util-tools/log-api-tunnel.js             # ensure: up? no-op : start a detached supervisor
//   node cli/util-tools/log-api-tunnel.js --supervise # foreground supervisor (restarts ssh forever)
//   node cli/util-tools/log-api-tunnel.js --status    # is the local port answering?
//
// Config: configs/environments.json → environments.<WS_ENV>.logApiTunnel. Environments
// without that key (the container, which hosts the API) print "no config" and exit 0.
// `ws pull` calls the ensure path every tick, so the tunnel heals itself unattended;
// run this by hand only to heal it immediately or to debug (log: <WS_DATA_DIR>/tunnel/).
import { ensureTunnel, superviseTunnel, tunnelConfig, portOpen, tunnelLogFile } from '../util/tunnel.js';

const mode = process.argv[2] || '--ensure';

if (mode === '--supervise') {
  process.exit(await superviseTunnel());
} else if (mode === '--status') {
  const cfg = tunnelConfig();
  if (!cfg) {
    console.log('log-api-tunnel: no config for this environment');
    process.exit(0);
  }
  const up = await portOpen(cfg.localPort);
  console.log(`log-api-tunnel: ${up ? 'up' : 'DOWN'} — 127.0.0.1:${cfg.localPort} → ${cfg.sshTarget}:${cfg.remotePort} (log: ${tunnelLogFile()})`);
  process.exit(up ? 0 : 1);
} else {
  const result = await ensureTunnel();
  console.log(`log-api-tunnel: ${result}`);
  process.exit(result === 'failed' ? 1 : 0);
}
