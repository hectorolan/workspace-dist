'use strict';

/**
 * Before/after density report for the responsive rework (test plan
 * hn-test-plan-2026-08-01-mobile-density) — the reusable measurement tool
 * behind the PR's numbers, so nobody derives cpl/chrome by hand twice.
 *
 * Boots the same two servers as playwright.config.js (stub log API +
 * src/server.js with AUTH_BYPASS) on their own ports, then measures the
 * digest reading page at 375/768/1280 with e2e/density-metrics.js and
 * writes:
 *   - docs/density/measurements.md   (appends one labelled section per run)
 *   - docs/density/<label>-<width>.png (viewport screenshots)
 *
 * Usage:  npm run build && node e2e/measure-density.js --label before
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { measureDensity } = require('./density-metrics.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'density');
const APP_PORT = Number(process.env.MEASURE_APP_PORT || 8098);
const STUB_PORT = Number(process.env.MEASURE_STUB_PORT || 8792);
const PAGE = '/digests/2026-01-03'; // stub fixture digest with a .prose body
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

function waitFor(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main() {
  const labelIdx = process.argv.indexOf('--label');
  const label = labelIdx === -1 ? 'run' : process.argv[labelIdx + 1];
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('dist/ missing — run `npm run build` first.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const stub = spawn('node', ['e2e/fixtures/stub-log-api.js', '--port', String(STUB_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const app = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      BASE_URL: `http://127.0.0.1:${APP_PORT}`,
      AUTH_BYPASS: 'true',
      AUTH_BYPASS_EMAIL: 'e2e-owner@example.com',
      ALLOWED_EMAIL: 'e2e-owner@example.com',
      SESSION_SECRET: 'measure-density-secret',
      LOG_API_URL: `http://127.0.0.1:${STUB_PORT}`,
      LOG_API_KEY: 'measure-density-key',
    },
  });

  let browser;
  try {
    await waitFor(`http://127.0.0.1:${STUB_PORT}/__captured`);
    await waitFor(`http://127.0.0.1:${APP_PORT}/healthz`);

    browser = await chromium.launch();
    const rows = [];
    for (const { width, height } of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${APP_PORT}${PAGE}`);
      await page.waitForSelector('.prose');
      const m = await page.evaluate(measureDensity);
      rows.push({ width, ...m });
      await page.screenshot({ path: path.join(OUT_DIR, `${label}-${width}.png`) });
      await page.close();
    }

    const table = [
      `## ${label} — ${new Date().toISOString()} (page: ${PAGE})`,
      '',
      '| viewport | prose px | chrome px | chrome % | font px | line-height px | avg glyph px | cpl | h-overflow |',
      '|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.width} | ${r.prosePx} | ${r.chromePx} | ${r.chromePct}% | ${r.fontSizePx} | ${r.lineHeightPx} | ${r.avgCharPx} | ${r.cpl} | ${r.hasHorizontalOverflow ? 'YES' : 'no'} |`
      ),
      '',
    ].join('\n');
    const outFile = path.join(OUT_DIR, 'measurements.md');
    if (!fs.existsSync(outFile)) {
      fs.writeFileSync(
        outFile,
        '# Density measurements — feat/mobile-density\n\nProduced by `node e2e/measure-density.js --label <label>` (metrics defined in `e2e/density-metrics.js`). Chrome = viewport − card content box (at 1280 this includes the shell\'s centering margins — the 1080px `--shell-max` cap, deliberate whitespace, not chrome in the 375px sense).\n\n'
      );
    }
    fs.appendFileSync(outFile, table + '\n');
    console.log(table);
  } finally {
    if (browser) await browser.close();
    stub.kill();
    app.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
