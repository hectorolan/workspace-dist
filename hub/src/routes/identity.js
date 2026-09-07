'use strict';

const express = require('express');
const { getIdentity } = require('../lib/identity');

/**
 * GET /api/identity — the instance identity the SPA renders (nav brand =
 * identity.hubTitle). Mounted behind requireAuth in src/app.js like every data
 * route. Always 200 `{ok, identity}`: getIdentity is fail-soft, so a down log
 * API serves the generic labels, never an error (TP-ceoconf-009).
 */
function identityRouter(config) {
  const router = express.Router();
  router.get('/api/identity', async (req, res) => {
    res.json({ ok: true, identity: await getIdentity(config) });
  });
  return router;
}

module.exports = { identityRouter };
