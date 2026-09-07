'use strict';

const { createApp } = require('./app');
const { configFromEnv } = require('./config');

const config = configFromEnv();

if (!config.clientId || !config.clientSecret) {
  console.warn('warning: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set — sign-in will fail.');
}
if (config.authBypass) {
  console.warn('WARNING: AUTH_BYPASS is enabled — dev/test only, never in a real deployment.');
}

createApp(config).listen(config.port, () => {
  console.log(`hub listening on port ${config.port} (base URL ${config.baseUrl})`);
  console.log(`log API: ${config.logApiUrl || '(not configured — Conversations/Plans/Digests disabled)'}`);
});
