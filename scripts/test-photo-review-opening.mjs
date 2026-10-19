// Synthetic IPC fixtures; no real photos, directories or credentials are changed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo review opening");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    sessionStorage.setItem('filo.photography-tab', 'review');
    window.openCalls = [];
    window.pickCalls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    window.__TAURI_INTERNALS__ = {
      metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === 'recent_backend_errors' || command === 'list_volumes' || command === 'list_transfers') return [];
        if (command === 'review_catalog') return {photos: [], sessions: [], archives: [], preset: null};
        if (command === 'photo_has_active_imports') return false;
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        if (command === 'photo_pick_directory') {
          window.pickCalls.push(args);
          return await new Promise((resolve, reject) => window.pendingPick = {resolve, reject});
        }
        if (command === 'review_open') {
          window.openCalls.push(args);
          return await new Promise(resolve => window.finishOpen = () => resolve({id: 'review'}));
        }
        throw new Error('Unexpected IPC: ' + command);
      }
    };
  })();`,
});
await page.goto("http://127.0.0.1:1420");
await page.click('.main-nav button:has-text("摄影")');
await page.waitForSelector(
  '.photo-page-actions button:has-text("打开照片目录")',
);
const openDialog = () =>
  page.click('.photo-page-actions button:has-text("打开照片目录")');
const start = '.modal-actions button:has-text("开始审图")';
const raw = ".photo-directory-field button.secondary >> nth=1";
const jpg = ".photo-directory-field button.secondary >> nth=0";
const picked = (id) =>
  page.evaluate((id) => {
    window.pendingPick.resolve({
      locator: { volume_id: id, logical_path: "", version_id: null },
      path: "/photos/" + id,
    });
  }, id);
await openDialog();
assert.equal(
  await page.evaluate(
    (selector) => document.querySelector(selector).disabled,
    ".modal-actions .primary",
  ),
  true,
);
await page.click(raw);
await page.waitForFunction(() => !!window.pendingPick);
assert.equal(
  await page.evaluate(() =>
    document
      .querySelectorAll(".photo-directory-field button.secondary")[1]
      .textContent.trim(),
  ),
  "正在选择目录…",
);
assert.equal(
  await page.evaluate(() => window.pickCalls.at(-1).title),
  "选择 RAW 照片目录",
);
await picked("NEF-only");
await page.waitForFunction(
  () => !document.querySelector(".modal-actions .primary").disabled,
);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".photo-import-fields input").value,
  ),
  "NEF-only",
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".photo-import-fields").textContent,
  ),
  /将直接审阅所选 RAW 目录/,
);
await page.click(start);
await page.waitForFunction(() => window.openCalls.length === 1);
assert.deepEqual(await page.evaluate(() => window.openCalls[0]), {
  name: "NEF-only",
  jpg: { volume_id: "NEF-only", logical_path: "", version_id: null },
  raw: null,
});
assert.match(
  await page.evaluate(
    () => document.querySelector(".modal-actions .primary").textContent,
  ),
  /正在读取照片目录/,
);
await page.evaluate(() => window.finishOpen());
await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

await openDialog();
await page.click(jpg);
await picked("JPG");
await page.waitForFunction(() =>
  document
    .querySelectorAll(".photo-directory-field button.secondary")[0]
    .textContent.includes("/photos/JPG"),
);
await page.click(raw);
await picked("RAW");
await page.waitForFunction(
  () => !document.querySelector(".modal-actions .primary").disabled,
);
await page.click(start);
await page.waitForFunction(() => window.openCalls.length === 2);
assert.deepEqual(await page.evaluate(() => window.openCalls[1]), {
  name: "JPG",
  jpg: { volume_id: "JPG", logical_path: "", version_id: null },
  raw: { volume_id: "RAW", logical_path: "", version_id: null },
});
await page.evaluate(() => window.finishOpen());
await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

await openDialog();
await page.click(raw);
await page.evaluate(() => window.pendingPick.resolve(null));
await page.waitForFunction(
  () =>
    !document.querySelectorAll(".photo-directory-field button.secondary")[1]
      .disabled,
);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".modal-actions .primary").disabled,
  ),
  true,
);
await page.click(raw);
await page.evaluate(() => window.pendingPick.reject(new Error("目录不可用")));
await page.waitForSelector('[role="alert"]');
assert.match(
  await page.evaluate(
    () => document.querySelector('[role="alert"]').textContent,
  ),
  /目录不可用/,
);
await page.click(raw);
await picked("retry");
await page.waitForFunction(
  () => !document.querySelector(".modal-actions .primary").disabled,
);
assert.equal(
  await page.evaluate(() => !!document.querySelector('[role="alert"]')),
  false,
);
console.log(
  "PASS: RAW-only opening, split JPG/RAW pairing, directory selection feedback, automatic naming, cancel/error/retry, scan begins only on submit",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
