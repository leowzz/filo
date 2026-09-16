// With Vite running: ego-browser nodejs < scripts/test-parallel-transfers.mjs
// IPC fixtures exercise the real UI without accessing remote storage.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo parallel transfer regression");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
(() => {
window.isTauri = true;
window.jobs = [];
window.entries = [];
window.reads = 0;
const volume = { id: 's3', connection_id: 's3', name: '并行测试', read_only: false,
  root: { type: 's3', bucket: 'test', prefix: '' },
  capabilities: { hierarchy: 'virtual_prefix', rename: 'copy_then_delete', create_directory: true, delete: true, trash: false, native_open: false, native_copy: true } };
let observer;
let tick = 0;
const timestamp = () => new Date(Date.UTC(2026, 8, 16, 0, 0, tick++)).toISOString();
window.advance = (id, state, bytes, channel = true) => {
  const job = window.jobs.find(job => job.id === id);
  Object.assign(job, { state, bytes_transferred: bytes, updated_at: timestamp() });
  if (state === 'completed') window.entries.push({ name: job.source.logical_path, locator: job.destination, size: job.bytes_total, kind: 'file', modified_at: job.updated_at });
  if (state === 'failed') job.error_message = '连接中断，请重新上传';
  if (channel) observer({...job});
};
window.__TAURI_INTERNALS__ = {
  transformCallback: () => 1, unregisterCallback: () => {},
  invoke: async (cmd, args) => {
      if (cmd === 'recent_backend_errors') return [];
      if (cmd === 'plugin:event|listen') return 1;
      if (cmd === 'plugin:event|unlisten') return;
    if (cmd === 'list_volumes') return [volume];
    if (cmd === 'list_entries') { window.reads++; return [...window.entries]; }
    if (cmd === 'list_entries_page') { window.reads++; return {entries:[...window.entries], total:window.entries.length, next_cursor:null}; }
    if (cmd === 'list_transfers') return window.jobs.map(job => ({...job}));
    if (cmd === 'transfer_local_file') {
      if (window.cancelPicker) return null;
      observer = args.onProgress.onmessage;
      const start = window.jobs.length;
      const batch = Array.from({length: 5}, (_, i) => ({
        id: String(start + i), kind: 'copy', state: i < 3 ? 'running' : 'queued',
        source: {volume_id:'local-'+i, logical_path:'upload-'+(start+i)+'.pdf',version_id:null},
        destination: {...args.remote,logical_path:'upload-'+(start+i)+'.pdf'},
        bytes_total: i === 2 ? null : 1000, bytes_transferred: i === 0 ? 200 : i === 1 ? 500 : 0,
        created_at: timestamp(), updated_at: timestamp(), error_code: null, error_message: null,
      }));
      window.jobs.unshift(...batch);
      batch.forEach(job => observer({...job}));
      return {jobs: batch.map(job => ({...job})), failures: ['denied.pdf：无法读取文件']};
    }
    if (cmd === 'cancel_transfer') { window.advance(args.jobId, 'cancelled', 0); return; }
    throw new Error('Unexpected IPC: '+cmd);
  }
};
})();
` });
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="并行测试"]');
await page.click('.volume-nav button[title="并行测试"]');
await page.waitForSelector('button[aria-label="上传文件"]');
await page.click('button[aria-label="上传文件"]');
await page.click('button:text-is("选择文件…")');
await page.waitForSelector('button[aria-label="上传中 3"]');
assert.equal(await page.evaluate(() => !!document.querySelector('.file-table')), true);
await page.waitForSelector('.transfer-tasks-popover');
assert.equal(await page.evaluate(() => document.querySelectorAll('.transfer-item.is-highlighted').length), 5);
assert.equal(await page.evaluate(() => document.querySelector('.transfer-tasks-popover').getBoundingClientRect().height <= 440), true);
assert.match(await page.evaluate(() => document.querySelector('.notice').textContent), /已提交 5 项，1 项未开始/);
await page.waitForSelector('.transfer-tasks-popover');
assert.match(await page.evaluate(() => document.querySelector('.transfer-tasks-header').textContent), /3 项传输中 · 2 项等待中/);
assert.equal(await page.evaluate(() => document.querySelectorAll('.transfer-tasks-list article').length), 5);
assert.equal(await page.evaluate(() => document.querySelector('progress[aria-label="upload-0.pdf 传输进度"]').value), 20);
assert.equal(await page.evaluate(() => document.querySelector('progress[aria-label="upload-2.pdf 传输进度"]').hasAttribute('value')), false);
const order = await page.evaluate(() => [...document.querySelectorAll('.transfer-tasks-list strong')].map(node => node.textContent));
await page.evaluate(() => window.advance('0', 'running', 650));
await page.waitForFunction(() => document.querySelector('progress[aria-label="upload-0.pdf 传输进度"]').value === 65);
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.transfer-tasks-list strong')].map(node => node.textContent)), order);
await page.evaluate(() => window.advance('0', 'verifying', 1000));
await page.waitForSelector('progress[aria-label="upload-0.pdf 校验进度"]');
assert.equal(await page.evaluate(() => document.querySelector('progress[aria-label="upload-0.pdf 校验进度"]').hasAttribute('value')), false, 'verification must not pretend to be complete');
assert.match(await page.evaluate(() => document.querySelector('[data-transfer-id="0"] .transfer-percent').textContent), /正在校验/);
await page.evaluate(() => window.advance('0', 'completed', 1000));
await page.waitForSelector('tr[data-entry-path="upload-0.pdf"]');
assert.equal(await page.evaluate(() => window.reads), 2, 'completion refreshes the directory');
await page.evaluate(() => window.advance('3', 'running', 0));
await page.waitForSelector('button[aria-label="上传中 3"]');
await page.click('button:text-is("查看全部任务")');
await page.waitForSelector('.transfers-page');
assert.match(await page.evaluate(() => document.querySelector('.transfer-summary').textContent), /3 项传输中 · 1 项等待中/);
await page.click('button[aria-label="取消 upload-4.pdf"]');
await page.waitForSelector('.transfer-state.cancelled');
assert.equal(await page.evaluate(() => window.jobs.filter(job => job.state === 'running').length), 3);
await page.evaluate(() => window.advance('1', 'failed', 500));
await page.waitForSelector('.transfer-state.failed');
assert.match(await page.evaluate(() => document.querySelector('.transfers-page').textContent), /连接中断，请重新上传/);
await page.evaluate(() => window.advance('3', 'completed', 1000, false));
await page.waitForFunction(() => [...document.querySelectorAll('.transfer-state.completed')].length === 2);
await page.click('.volume-nav button[title="并行测试"]');
await page.waitForSelector('tr[data-entry-path="upload-3.pdf"]');
const edges = await page.evaluate(async () => {
  const {transferPercent, updateTransfer} = await import('/src/transferPresentation.ts');
  const job = window.jobs[0];
  return {
    empty: transferPercent({...job, state:'completed',bytes_total:0,bytes_transferred:0}),
    unknown: transferPercent({...job,state:'running',bytes_total:null}) === undefined,
    overflow: transferPercent({...job,state:'running',bytes_total:10,bytes_transferred:20}),
    staleIgnored: updateTransfer([job], {...job,state:'running',bytes_transferred:0})[0].state === 'completed',
  };
});
assert.deepEqual(edges, {empty:100,unknown:true,overflow:100,staleIgnored:true});
// A new selection reopens the list and highlights only that batch, even when
// the user had scrolled through older tasks.
await page.click('button[aria-label="上传文件"]');
await page.click('button:text-is("选择文件…")');
await page.waitForSelector('.transfer-tasks-popover');
assert.equal(await page.evaluate(() => document.querySelectorAll('.transfer-item.is-highlighted').length), 5);
assert.equal(await page.evaluate(() => document.querySelector('.transfer-tasks-list article').dataset.transferId), '9');
await page.click('button[aria-label="关闭任务列表"]');
await page.evaluate(() => window.advance('5', 'running', 600));
assert.equal(await page.evaluate(() => !!document.querySelector('.transfer-tasks-popover')), false, 'progress never reopens a dismissed list');
await page.evaluate(() => window.cancelPicker = true);
await page.click('button[aria-label="上传文件"]');
await page.click('button:text-is("选择文件…")');
assert.equal(await page.evaluate(() => !!document.querySelector('.transfer-tasks-popover')), false, 'cancelling the picker does not open the list');
await page.click('.transfer-tasks-trigger');
await page.waitForFunction(() => document.querySelectorAll('.transfer-item.is-highlighted').length === 0);
await page.cdp('Emulation.setDeviceMetricsOverride', {width:960,height:540,deviceScaleFactor:1,mobile:false});
assert.equal(await page.evaluate(() => {
  const panel = document.querySelector('.transfer-tasks-popover').getBoundingClientRect();
  return panel.height <= 440 && panel.bottom <= innerHeight && panel.right <= innerWidth;
}), true, 'compact list fits minimum desktop size');
console.log('PASS: automatic reveal, compact size, latest-batch priority, temporary highlights, manual dismissal, cancelled picker, stable progress and completion refresh');
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
