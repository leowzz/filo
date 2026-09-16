// With Vite running: ego-browser nodejs < scripts/test-parallel-transfers.mjs
// IPC fixtures exercise the real UI without accessing remote storage.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo parallel transfer regression");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
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
    if (cmd === 'list_volumes') return [volume];
    if (cmd === 'list_entries') { window.reads++; return [...window.entries]; }
    if (cmd === 'list_transfers') return window.jobs.map(job => ({...job}));
    if (cmd === 'transfer_local_file') {
      observer = args.onProgress.onmessage;
      window.jobs = Array.from({length: 5}, (_, i) => ({
        id: String(i), kind: 'copy', state: i < 3 ? 'running' : 'queued',
        source: {volume_id:'local-'+i, logical_path:'upload-'+i+'.pdf',version_id:null},
        destination: {...args.remote,logical_path:'upload-'+i+'.pdf'},
        bytes_total: i === 2 ? null : 1000, bytes_transferred: i === 0 ? 200 : i === 1 ? 500 : 0,
        created_at: timestamp(), updated_at: timestamp(), error_code: null, error_message: null,
      }));
      window.jobs.forEach(job => observer({...job}));
      return {jobs: window.jobs.map(job => ({...job})), failures: ['denied.pdf：无法读取文件']};
    }
    if (cmd === 'cancel_transfer') { window.advance(args.jobId, 'cancelled', 0); return; }
    throw new Error('Unexpected IPC: '+cmd);
  }
};
` });
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="并行测试"]');
await page.click('.volume-nav button[title="并行测试"]');
await page.waitForSelector('button[aria-label="上传文件"]');
await page.click('button[aria-label="上传文件"]');
await page.waitForSelector('button[aria-label="上传中 3"]');
assert.equal(await page.evaluate(() => !!document.querySelector('.file-table')), true);
assert.equal(await page.evaluate(() => !!document.querySelector('.transfer-tasks-popover')), false);
assert.match(await page.evaluate(() => document.querySelector('.notice').textContent), /已提交 5 项，1 项未开始/);
await page.click('button[aria-label="上传中 3"]');
await page.waitForSelector('.transfer-tasks-popover');
assert.match(await page.evaluate(() => document.querySelector('.transfer-tasks-header').textContent), /3 项传输中 · 2 项等待中/);
assert.equal(await page.evaluate(() => document.querySelectorAll('.transfer-tasks-list article').length), 5);
assert.equal(await page.evaluate(() => document.querySelector('progress[aria-label="upload-0.pdf 传输进度"]').value), 20);
assert.equal(await page.evaluate(() => document.querySelector('progress[aria-label="upload-2.pdf 传输进度"]').hasAttribute('value')), false);
const order = await page.evaluate(() => [...document.querySelectorAll('.transfer-tasks-list strong')].map(node => node.textContent));
await page.evaluate(() => window.advance('0', 'running', 650));
await page.waitForFunction(() => document.querySelector('progress[aria-label="upload-0.pdf 传输进度"]').value === 65);
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.transfer-tasks-list strong')].map(node => node.textContent)), order);
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
console.log('PASS: multi-upload submission, partial failures, concurrent/queued counts, live percentages, stable row order, unknown and zero sizes, cancellation isolation, channel/poll completion refresh');
await task.finish({ keep: [] });
