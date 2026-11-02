// Run with ego-browser nodejs on stdin. Uses synthetic IPC, never real photos.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoFilmstripTestSpace ?? "Filo filmstrip QA",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    sessionStorage.setItem('filo.review-session', 'review');
    window.skippedThumbnail = false;
    const photos = Array.from({length: 241}, (_, i) => ({
      id: 'p' + i, archive_id: 'archive', original_path: 'DSC_' + (6166 + i) + '.JPG',
      capture_date: null, issues: [], files: [{id: 'f' + i, kind: 'jpg', path: 'DSC_' + (6166 + i) + '.JPG',
        verified: false, sha256: '', size: 100, error: null}],
      rating: i === 8 ? 4 : 0, flag: 'none', excluded: false, revision: 0,
      xmp_hash: null, xmp_synced_revision: null
    }));
    const session = {id: 'review', archive_id: 'archive', name: 'Filmstrip', card_name: '',
      created_at: '2026-10-20', source: null, photo_ids: photos.map(p => p.id),
      revision: 1, synced_revision: 1, nas_hash: null, sync_error: null, handed_off: false,
      position: {current: 'p8', sort: 'name_asc', filter: 'all', minimum_rating: 0,
        auto_advance: false, raw_only: false}, undo: [], layout: 'original', keep_hierarchy: false};
    const catalog = {photos, sessions: [session], archives: [], preset: null};
    window.__TAURI_INTERNALS__ = {transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        if (['recent_backend_errors', 'list_volumes', 'list_transfers', 'list_connections'].includes(command)) return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        if (command === 'review_catalog') return structuredClone(catalog);
        if (command === 'review_save_position') {session.position = args.position; return;}
        if (command === 'review_preview' && args.thumbnail && args.photoId === 'p5') {
          window.skippedThumbnail = true;
          throw {code:'unsupported',message:'此文件需要完整下载才能生成缩略图'};
        }
        if (command === 'review_preview' && args.thumbnail && ['p4', 'p8'].includes(args.photoId))
          throw {message:'模拟缩略图失败'};
        if (command === 'review_preview') return {mime: 'image/svg+xml',
          content: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#4e7088"/></svg>'),
          width: 800, height: 600, embedded: false};
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
await page.click('.main-nav button:text-is("审图")');
await page.click('button:text-is("继续审图")');
await page.waitForSelector(".photo-stage img");
const centered = () => {
  const strip = document.querySelector(".photo-filmstrip");
  const current = strip?.querySelector('button[aria-current="true"]');
  if (!current) return false;
  const thumb = current.getBoundingClientRect();
  return (
    Math.abs(
      thumb.top +
        thumb.height / 2 -
        strip.getBoundingClientRect().top -
        strip.clientHeight / 2,
    ) < 1
  );
};
const metrics = () =>
  page.evaluate(() => {
    const strip = document.querySelector(".photo-filmstrip");
    return {
      top: strip.scrollTop,
      maximum: strip.scrollHeight - strip.clientHeight,
      rendered: strip.querySelectorAll("button").length,
      current: strip
        .querySelector('button[aria-current="true"]')
        ?.getAttribute("aria-label"),
      debug: !!document.querySelector(".photo-cache-cover"),
      fits: document.documentElement.scrollWidth <= innerWidth,
    };
  });
await page.waitForFunction(centered);
const restored = await metrics();
assert.equal(restored.current, "查看 DSC_6174.JPG");
assert.equal(
  restored.debug,
  false,
  "ordinary review centers without debug mode",
);
assert.ok(restored.rendered < 30, "only nearby thumbnails mount");
await page.waitForSelector('.photo-filmstrip button[aria-current="true"] img');
await page.waitForFunction(() => window.skippedThumbnail);
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector(
        'button[aria-label="查看 DSC_6171.JPG"] .photo-thumbnail-placeholder',
      )?.textContent,
  ),
  "预览",
  "skipping a full download is not shown as a thumbnail failure",
);
await page.waitForFunction(
  () =>
    document.querySelector(
      'button[aria-label="查看 DSC_6170.JPG"] .photo-thumbnail-placeholder',
    )?.title === "模拟缩略图失败",
);
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector(
        'button[aria-label="查看 DSC_6174.JPG"] .photo-thumbnail-placeholder',
      ) === null,
  ),
  true,
  "a cached main preview keeps the current thumbnail visible after thumbnail failure",
);
assert.equal(
  await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".photo-filmstrip")).overflowX,
  ),
  "hidden",
);
for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
await page.waitForFunction(centered);
const advanced = await metrics();
assert.equal(advanced.current, "查看 DSC_6194.JPG");
assert.ok(
  advanced.top > restored.top + 1500,
  "scrollbar advances through the full sequence",
);
await page.click('button[aria-label="查看 DSC_6195.JPG"]');
await page.waitForFunction(centered);
assert.ok(
  (await metrics()).top > advanced.top,
  "thumbnail clicks also center",
);

for (const [width, height] of [[940, 850], [2048, 1000], [700, 850]]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForFunction(centered);
  assert.equal((await metrics()).fits, true);
}

// Both mouse directions stay on the left, including after the wing disappears.
const panelsBefore = await page.evaluate(() => ({
  stageWidth: document.querySelector('.photo-stage').clientWidth,
  current: document.querySelector('.photo-stage img').alt,
  modeTop: document.querySelector('[aria-label="审图模式"]').getBoundingClientRect().top,
}));
await page.click('button[aria-label="收起右侧栏"]');
await page.waitForSelector('button[aria-label="展开右侧栏"]');
const rightCollapsed = await page.evaluate(() => ({
  hidden: document.querySelector('#review-side-panel').hidden,
  width: document.querySelector('.photo-review-side-container').clientWidth,
  stageWidth: document.querySelector('.photo-stage').clientWidth,
}));
assert.equal(rightCollapsed.hidden, true);
assert.equal(rightCollapsed.width, 36);
assert.ok(rightCollapsed.stageWidth > panelsBefore.stageWidth);
await page.click('button[aria-label="收起照片序列"]');
await page.waitForSelector('button[aria-label="展开照片序列"]');
assert.equal(await page.evaluate(() => !!document.querySelector(".photo-filmstrip")), false);
assert.equal(await page.evaluate(() => !!document.querySelector('.photo-review-film-rail .photo-review-back')), true, "back remains available with both panels collapsed");
await page.click('button[aria-label="展开右侧栏"]');
await page.click('button[aria-label="展开照片序列"]');
await page.waitForFunction(centered);
assert.equal((await metrics()).current, "查看 DSC_6195.JPG");
assert.deepEqual(await page.evaluate(() => ({
  stageWidth: document.querySelector('.photo-stage').clientWidth,
  current: document.querySelector('.photo-stage img').alt,
  modeTop: document.querySelector('[aria-label="审图模式"]').getBoundingClientRect().top,
})), panelsBefore, "restoring both panels preserves the photo and fixed mode position");

await page.keyboard.press("t");
assert.equal(await page.evaluate(() => !!document.querySelector(".photo-filmstrip")), false);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
await page.keyboard.press("t");
await page.waitForFunction(centered);
assert.equal((await metrics()).current, "查看 DSC_6195.JPG");

await page.evaluate(() => {
  const strip = document.querySelector(".photo-filmstrip");
  strip.scrollTop = strip.scrollHeight;
});
await page.waitForSelector('button[aria-label="查看 DSC_6406.JPG"]');
await page.click('button[aria-label="查看 DSC_6406.JPG"]');
const last = await metrics();
assert.equal(last.current, "查看 DSC_6406.JPG");
assert.ok(Math.abs(last.top - last.maximum) < 1);
await page.keyboard.press("ArrowRight");
assert.equal(
  (await metrics()).current,
  last.current,
  "last photo stays selected",
);

await page.evaluate(() => {
  document.querySelector(".photo-filmstrip").scrollTop = 0;
});
await page.waitForSelector('button[aria-label="查看 DSC_6166.JPG"]');
await page.click('button[aria-label="查看 DSC_6166.JPG"]');
assert.equal((await metrics()).top, 0);
await page.click('.photo-quick-filters button:text-is("≥3 星")');
await page.waitForFunction(
  () => document.querySelectorAll(".photo-filmstrip button").length === 1,
);
assert.equal((await metrics()).current, "查看 DSC_6174.JPG");
assert.equal((await metrics()).top, 0);
await page.click('.photo-quick-filters button:text-is("保留")');
await page.waitForFunction(
  () => document.querySelectorAll(".photo-filmstrip button").length === 0,
);
await page.click('.photo-quick-filters button:text-is("全部")');
await page.waitForSelector('.photo-filmstrip button[aria-current="true"]');
await page.selectOption('select[aria-label="照片排序"]', "name_desc");
await page.waitForFunction(() =>
  document.querySelector(".photo-counter").textContent.includes("241 / 241"),
);
const sorted = await metrics();
assert.equal(sorted.current, "查看 DSC_6166.JPG");
assert.ok(Math.abs(sorted.top - sorted.maximum) < 1);
console.log({
  passed:
    "restore, keyboard/click centering, scrollbar progress, manual scroll, resize, boundaries, filters, sort",
  restored,
  advanced,
});
await task.finish({ keep: [] });
