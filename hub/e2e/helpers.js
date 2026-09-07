'use strict';

/** Shared helpers for the browser suite: stub-API control + comment-box driving. */

const STUB_URL = `http://127.0.0.1:${Number(process.env.E2E_STUB_PORT || 8791)}`;

/** Clear captured POSTs and any armed failure mode. Call in beforeEach. */
async function resetStub(request) {
  await request.post(`${STUB_URL}/__reset`);
}

/** Everything the app POSTed to the stub log API so far. */
async function capturedPosts(request) {
  const res = await request.get(`${STUB_URL}/__captured`);
  return (await res.json()).posts;
}

/** Arm the stub so the next POST /message answers 502 (page-comment failure path). */
async function failNextPost(request) {
  await request.post(`${STUB_URL}/__fail-next`);
}

/** Arm the stub so the next GET /feature answers 500 (error-card path). */
async function failNextFeatures(request) {
  await request.post(`${STUB_URL}/__fail-features`);
}

/** Arm the stub so the next GET /station answers 500 (plain-headers soft-degrade path). */
async function failNextStations(request) {
  await request.post(`${STUB_URL}/__fail-stations`);
}

/** Locators for the page-comment box + its confirmation modal. */
function commentBox(page) {
  return {
    box: page.locator('#comment-box'),
    text: page.locator('#comment-text'),
    open: page.locator('#comment-open'),
    status: page.locator('#comment-status'),
    modal: page.locator('#comment-modal'),
    modalText: page.locator('#comment-modal-text'),
    confirm: page.locator('#comment-confirm'),
    cancel: page.locator('#comment-cancel'),
  };
}

module.exports = { STUB_URL, resetStub, capturedPosts, failNextPost, failNextFeatures, failNextStations, commentBox };
