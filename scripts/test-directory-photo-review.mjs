// Synthetic IPC fixtures; never reads or writes a real configured storage.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo directory review",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    sessionStorage.setItem('filo.photography-tab', 'review');
    const volume = (id, read_only = false) => ({id, connection_id: id, name: id, read_only,
      root: {type: 's3', bucket: 'photos', prefix: ''},
      capabilities: {hierarchy: 'virtual_prefix', rename: 'unsupported', create_directory: !read_only,
        delete: !read_only, trash: false, native_open: false, native_copy: false}});
    const volumes = [volume('Cloud photos'), volume('Read only', true)];
    window.catalog = {photos: [], sessions: [], archives: [], preset: null};
    window.reviewCalls = []; window.markCalls = []; window.positionCalls = []; window.importCalls = [];
    window.holdOpen = false; window.holdMark = false;
    const photo = (id) => ({id, archive_id: 'archive', original_path: id + '.jpg',
      capture_date: null, issues: [], files: [{id: 'file-' + id, kind: 'jpg', original_name: id + '.jpg', path: id + '.jpg',
      sha256: '', size: 100, verified: false, error: null}], rating: 0, flag: 'none', reviewed: false, excluded: false, revision: 0,
      xmp_hash: null, xmp_synced_revision: null});
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    window.__TAURI_INTERNALS__ = {metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}},
      transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command.startsWith('photo_')) window.importCalls.push(command);
      if (command === 'recent_backend_errors' || command === 'list_transfers' || command === 'list_connections') return [];
      if (command === 'list_volumes') return volumes;
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'directory_stamp') return '1';
      if (command === 'list_entries_page') return {total: 1, total_is_exact: true, next_cursor: null,
        entries: [{name: 'trip', kind: 'virtual_prefix', size: null, modified_at: null,
          locator: {...args.parent, logical_path: [args.parent.logical_path, 'trip'].filter(Boolean).join('/')}}]};
      if (command === 'review_catalog') return structuredClone(window.catalog);
      if (command === 'review_open_directory') {
        window.reviewCalls.push(args);
        if (args.root.volume_id === 'Read only') throw {code: 'access_denied', message: '此存储为只读，无法在目录的 .filo 下保存审图进度，请先设为可写'};
        if (window.holdOpen) await new Promise(resolve => window.releaseOpen = resolve);
        if (window.catalog.sessions[0]?.directory.volume_id === args.root.volume_id &&
            window.catalog.sessions[0]?.directory.logical_path === args.root.logical_path) return structuredClone(window.catalog.sessions[0]);
        const session = {id: 'directory-review', archive_id: 'archive', name: args.root.logical_path || 'Cloud photos',
          card_name: '', created_at: '2026-10-19', source: null, directory: args.root, photo_ids: ['one', 'two'],
          revision: 1, synced_revision: 1, nas_hash: 'saved', sync_error: null, handed_off: false,
          position: {current: 'one', filter: 'all', minimum_rating: 0, auto_advance: false}, undo: [], layout: 'original', keep_hierarchy: true};
        window.catalog = {photos: [photo('one'), photo('two')], sessions: [session], archives: [], preset: null};
        return structuredClone(session);
      }
      if (command === 'review_preview') return {mime: 'image/svg+xml', content: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#4e7088"/></svg>'), width: 800, height: 600, embedded: false};
      if (command === 'review_mark') {
        window.markCalls.push(args);
        if (window.holdMark) await new Promise(resolve => window.releaseMark = resolve);
        const p = window.catalog.photos.find(p => p.id === args.photoId);
        Object.assign(p, {rating: args.rating, flag: args.flag, reviewed: true, revision: p.revision + 1});
        return structuredClone(p);
      }
      if (command === 'review_save_position') { window.positionCalls.push(args); window.catalog.sessions[0].position = args.position; return; }
      throw new Error('Unexpected IPC: ' + command);
    }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 850,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button:has-text("Cloud photos")');
await page.click('.volume-nav button:has-text("Cloud photos")');
await page.waitForSelector('tr[data-entry-path="trip"]');
await page.dblclick('tr[data-entry-path="trip"] .file-name');
await page.waitForFunction(() =>
  document.querySelector(".pathbar").textContent.includes("trip"),
);
await page.evaluate(() => (window.holdOpen = true));
await page.click('.toolbar-actions button:has-text("进入审图")');
await page.waitForFunction(() => window.reviewCalls.length === 1);
assert.deepEqual(await page.evaluate(() => window.reviewCalls[0].root), {
  volume_id: "Cloud photos",
  logical_path: "trip",
  version_id: null,
});
assert.equal(
  await page.evaluate(
    () =>
      [...document.querySelectorAll(".toolbar-actions button")].find((b) =>
        b.textContent.includes("正在读取照片"),
      ).disabled,
  ),
  true,
);
await page.evaluate(() => {
  window.holdOpen = false;
  window.releaseOpen();
});
await page.waitForSelector('section[aria-label="照片审图"]');
assert.match(
  await page.evaluate(
    () => document.querySelector(".photo-review-syncbar").textContent,
  ),
  /此目录的 .filo/,
);
assert.equal(
  await page.evaluate(() => !!document.querySelector(".file-table")),
  false,
);
await page.evaluate(() => (window.holdMark = true));
await page.keyboard.press("4");
await page.waitForFunction(() => window.markCalls.length === 1);
assert.equal(
  await page.evaluate(() => window.catalog.photos[0].rating),
  0,
  "held persistence has not completed",
);
await page.evaluate(() => {
  window.holdMark = false;
  window.releaseMark();
});
await page.waitForFunction(() => window.catalog.photos[0].rating === 4);
await page.keyboard.press("ArrowRight");
await page.waitForFunction(
  () => window.positionCalls.at(-1)?.position.current === "two",
);
await page.click('.photo-review-toolbar button:has-text("返回文件夹")');
await page.waitForSelector('tr[data-entry-path="trip/trip"]');
assert.match(
  await page.evaluate(() => document.querySelector(".pathbar").textContent),
  /trip/,
);
await page.click('.toolbar-actions button:has-text("进入审图")');
await page.waitForSelector('section[aria-label="照片审图"]');
assert.equal(
  await page.evaluate(() =>
    document
      .querySelector('.photo-filmstrip button[aria-current="true"]')
      .getAttribute("aria-label"),
  ),
  "查看 two.jpg",
);
assert.equal(await page.evaluate(() => window.catalog.photos[0].rating), 4);
await page.click('.photo-review-toolbar button:has-text("返回文件夹")');
await page.waitForSelector('tr[data-entry-path="trip/trip"]');
await page.click('button[aria-label="trip 操作菜单"]');
await page.click('.entry-menu button:has-text("进入审图")');
await page.waitForSelector('section[aria-label="照片审图"]');
assert.equal(
  await page.evaluate(() => window.reviewCalls.at(-1).root.logical_path),
  "trip/trip",
);
assert.deepEqual(
  await page.evaluate(() => window.importCalls),
  [],
  "review never consults import history",
);
const wideFits = await page.evaluate(
  () => document.documentElement.scrollWidth <= innerWidth,
);
assert.equal(wideFits, true);
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 960,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
});
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
);
await page.click('.photo-review-toolbar button:has-text("返回文件夹")');
// Recent folder reviews must not start a save/refetch loop in the library UI.
await page.click('.main-nav button:has-text("摄影")');
if (
  await page.evaluate(
    () => !!document.querySelector(".photo-session-list button"),
  )
) {
  await page.click(".photo-session-list button");
}
await page.click('.photo-session-toolbar button:has-text("继续审图")');
await page.waitForSelector('section[aria-label="照片审图"]');
const positionCount = await page.evaluate(() => window.positionCalls.length);
await page.waitForFunction(
  (before) => window.positionCalls.length > before,
  positionCount,
);
const settledCount = await page.evaluate(() => window.positionCalls.length);
// Observe longer than two debounce windows to detect repeated background saves.
await new Promise((resolve) => setTimeout(resolve, 1200));
assert.equal(
  await page.evaluate(() => window.positionCalls.length),
  settledCount,
);
await page.click('.volume-nav button:has-text("Read only")');
await page.click('.toolbar-actions button:has-text("进入审图")');
await page.waitForFunction(() =>
  document.querySelector(".floating-notice")?.textContent.includes("只读"),
);
assert.equal(
  await page.evaluate(
    () => !!document.querySelector('section[aria-label="照片审图"]'),
  ),
  false,
);
await page.click('.volume-nav button:has-text("Cloud photos")');
await page.evaluate(() => (window.holdOpen = true));
await page.click('.toolbar-actions button:has-text("进入审图")');
await page.waitForFunction(() => window.reviewCalls.length === 5);
await page.click('.main-nav button:has-text("概览")');
await page.evaluate(() => window.releaseOpen());
await page.waitForFunction(() => document.querySelector(".overview"));
assert.equal(
  await page.evaluate(
    () => !!document.querySelector('section[aria-label="照片审图"]'),
  ),
  false,
);
console.log(
  "PASS: configured S3 subdirectory review, context-menu entry, pending feedback, save before acknowledgement, position, back navigation, read-only errors, stale navigation, import isolation, 1280/960 layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
