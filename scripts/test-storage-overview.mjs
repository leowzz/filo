// IPC fixtures only; no real bucket, files or credentials are changed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo storage overview",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    window.overviewCalls = [];
    window.overview = {object_count: 42, total_size: 10485760, complete: true};
    window.overviewError = false;
    window.holdOverview = false;
    const volume = (id, root) => ({id, connection_id: id, name: id, read_only: true, root,
      capabilities: {hierarchy: 'virtual_prefix', rename: 'unsupported', create_directory: false, delete: false, trash: false, native_open: false, native_copy: false}});
    const volumes = [volume('S3 demo', {type: 's3', bucket: 'demo', prefix: ''}),
      volume('Prefix demo', {type: 's3', bucket: 'demo', prefix: 'projects/photos'}),
      volume('Local demo', {type: 'local', root_path: '/demo'})];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    window.__TAURI_INTERNALS__ = {metadata: {currentWindow: {label: 'main'}, currentWebview: {label: 'main'}}, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'list_volumes') return volumes;
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'list_entries_page') return {total: 1, next_cursor: null, entries: [{name: 'folder', kind: 'virtual_prefix', size: null, modified_at: null, locator: {...args.parent, logical_path: 'folder'}}]};
      if (command === 'manage_s3' && args.action.action === 'storage_overview') {
        window.overviewCalls.push(args);
        if (window.holdOverview) await new Promise(resolve => window.releaseOverview = resolve);
        if (window.overviewError) throw {message: 'S3 拒绝访问，请检查此操作的权限'};
        return window.overview;
      }
      throw new Error('Unexpected IPC: ' + command);
    }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector(".volume-nav button");
await page.click('.volume-nav button:has-text("S3 demo")');
await page.click('button[aria-label="切换详情面板"]');
await page.waitForFunction(() =>
  document.querySelector(".storage-overview")?.textContent.includes("42 个"),
);
let text = await page.evaluate(
  () => document.querySelector(".storage-overview").textContent,
);
assert.match(text, /对象数量42 个/);
assert.match(text, /对象总容量10.0 MB/);
assert.match(text, /整个 Bucket/);
assert.equal(await page.evaluate(() => window.overviewCalls.length), 1);
await page.dblclick('tr[data-entry-path="folder"] .file-name');
await page.waitForFunction(() =>
  document.querySelector(".pathbar").textContent.includes("folder"),
);
assert.equal(
  await page.evaluate(() => window.overviewCalls.length),
  1,
  "directory navigation reuses the volume overview",
);
assert.equal(
  await page.evaluate(() => window.overviewCalls[0].locator.logical_path),
  "",
);
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
);

await page.evaluate(
  () =>
    (window.overview = {
      object_count: 1000,
      total_size: 2048,
      complete: false,
    }),
);
await page.click('button[aria-label="刷新存储概览"]');
await page.waitForFunction(() =>
  document
    .querySelector(".storage-overview")
    .textContent.includes("已统计对象"),
);
text = await page.evaluate(
  () => document.querySelector(".storage-overview").textContent,
);
assert.match(text, /统计结果不准确/);
assert.match(text, /已统计对象1,000\+ 个/);
assert.doesNotMatch(text, /对象总容量|已统计容量|2\.0 KB/);
assert.equal(
  await page.evaluate(() => window.overviewCalls.length),
  2,
  "partial results do not trigger more requests",
);

await page.evaluate(() => (window.overviewError = true));
await page.click('button[aria-label="刷新存储概览"]');
await page.waitForSelector('.storage-overview [role="alert"]');
assert.doesNotMatch(
  await page.evaluate(
    () => document.querySelector(".storage-overview").textContent,
  ),
  /0 个/,
);
await page.evaluate(() => {
  window.overviewError = false;
  window.overview = { object_count: 0, total_size: 0, complete: true };
});
await page.click('.storage-overview button:text-is("重试")');
await page.waitForFunction(() =>
  document.querySelector(".storage-overview").textContent.includes("0 个"),
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".storage-overview").textContent,
  ),
  /对象总容量0 B/,
);

await page.evaluate(() => (window.holdOverview = true));
await page.click('.volume-nav button:has-text("Prefix demo")');
await page.waitForSelector('.storage-overview [role="status"]');
assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="刷新存储概览"]').disabled,
  ),
  true,
);
await page.evaluate(() => {
  window.overview = { object_count: 7, total_size: 1024, complete: true };
  window.releaseOverview();
  window.holdOverview = false;
});
await page.waitForFunction(() =>
  document.querySelector(".storage-overview").textContent.includes("7 个"),
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".storage-overview").textContent,
  ),
  /projects\/photos\//,
);
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 960,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
});
const geometry = await page.evaluate(() => {
  const panel = document.querySelector(".details-panel");
  const values = [...document.querySelectorAll(".storage-overview dd")].map(
    (node) => node.getBoundingClientRect().left,
  );
  return {
    pageFits: document.documentElement.scrollWidth <= innerWidth,
    panelFits: panel.scrollWidth <= panel.clientWidth,
    aligned: values[0] === values[1],
  };
});
assert.deepEqual(geometry, { pageFits: true, panelFits: true, aligned: true });
await page.evaluate(() => {
  window.overview = {
    object_count: 1234567,
    total_size: 1073741824,
    complete: true,
    source: "tos_bucket_stat",
  };
});
await page.click('button[aria-label="刷新存储概览"]');
await page.waitForFunction(() =>
  document
    .querySelector(".storage-overview")
    .textContent.includes("存储桶概览"),
);
text = await page.evaluate(
  () => document.querySelector(".storage-overview").textContent,
);
assert.match(text, /范围：整个桶（demo）/);
assert.match(text, /桶级别数据.*并非当前配置位置/);
assert.match(text, /桶内对象数量1,234,567 个/);
assert.match(text, /桶占用空间1\.0 GB/);
assert.match(text, /延迟可能超过一小时/);
assert.doesNotMatch(text, /projects\/photos|仅统计当前版本|不含历史版本/);
await page.screenshot({ path: "/tmp/filo-tos-bucket-overview.png" });
await page.evaluate(() => {
  window.overview = {
    object_count: 1000,
    total_size: 1024,
    complete: false,
    bucket_stats_error: "TOS 拒绝读取桶统计，请检查 tos:GetBucketStat 权限",
  };
});
await page.click('button[aria-label="刷新存储概览"]');
await page.waitForFunction(() =>
  document
    .querySelector(".storage-overview")
    .textContent.includes("tos:GetBucketStat"),
);
text = await page.evaluate(
  () => document.querySelector(".storage-overview").textContent,
);
assert.match(text, /范围：projects\/photos/);
assert.match(text, /当前显示的是配置位置的统计/);
assert.match(text, /1,000\+ 个/);
assert.doesNotMatch(text, /桶占用空间|已统计容量|整个桶/);
const calls = await page.evaluate(() => window.overviewCalls.length);
await page.click('.volume-nav button:has-text("Local demo")');
await page.waitForFunction(() => !document.querySelector(".storage-overview"));
assert.equal(await page.evaluate(() => window.overviewCalls.length), calls);
console.log(
  "PASS: complete/partial/empty/error/loading states, TOS bucket scope/capacity/delay, scoped fallback, retry, cache, no automatic pagination, local isolation, 1280px/960px layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
