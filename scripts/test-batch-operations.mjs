// Vite must be running. Fixtures replace IPC; no real files or credentials are used.
// ego-browser nodejs < scripts/test-batch-operations.mjs
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo batch operations regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
window.isTauri = true;
window.testCalls = [];
window.allowTransfer = false;
window.allowDelete = false;
window.testJobs = [];
window.testItems = [{ name: 'Folder', kind: 'directory', size: null }, { name: 'one.txt', kind: 'file', size: 10 }, { name: 'denied.txt', kind: 'file', size: 20 }];
const volumes = ['source', 'target'].map(id => ({ id, connection_id: id, name: id, read_only: false,
  root: { type: 'local', root_path: '/' + id }, capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true, write: true, delete: true, recursive_delete: true, trash: true, native_open: true } }));
window.__TAURI_INTERNALS__ = {
 metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
 transformCallback: () => 1, unregisterCallback: () => {},
 invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
   window.testCalls.push({command, args});
   if (command === 'directory_stamp') return { value: 'fixture', complete: true };
   if (command.startsWith('plugin:menu|')) return 1;
   if (command === 'list_volumes') return volumes;
   if (command === 'list_transfers') return window.testJobs;
   if (command === 'list_entries_page') { const entries = args.parent.volume_id === 'source' && !args.parent.logical_path ? window.testItems.filter(item => !args.options.folders_only || item.kind === 'directory').sort((a,b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name)).map(item => ({ ...item, locator: { volume_id: 'source', logical_path: item.name, version_id: null } })) : []; return {entries, total: entries.length, next_cursor: null}; }
   if (command === 'start_transfer') {
     if (args.source.logical_path === 'denied.txt' && !window.allowTransfer) throw {code:'access_denied',message:'测试：无法读取此项目'};
     const job = { id: String(window.testJobs.length + 1), kind: args.kind, source: args.source, destination: args.destination, state: 'completed', created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z', error_code: null, error_message: null, bytes_total: 10, bytes_transferred: 10 };
     window.testJobs.push(job); return job;
   }
   if (command === 'delete_entry') {
     if (args.locator.logical_path === 'one.txt' && args.mode === 'default') throw {code:'trash_unavailable',message:'测试：回收站不可用'};
     if (args.locator.logical_path === 'denied.txt' && !window.allowDelete) throw {code:'access_denied',message:'测试：访问被拒绝'};
     window.testItems = window.testItems.filter(item => item.name !== args.locator.logical_path);
     return args.mode === 'permanent' ? 'permanently_deleted' : 'trashed';
   }
   if (command === 'rename_entry') return;
   throw new Error('Unexpected IPC: ' + command);
 }
};

})();
`,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/source"]');
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="Folder"]');
await page.click('tr[data-entry-path="Folder"] .file-name');
assert.equal(
  await page.evaluate(
    () => [...document.querySelectorAll(".browser-actions-popover button")].find(button => button.textContent.trim() === "重命名…").disabled,
  ),
  false,
  "folder rename enabled",
);
await page.keyboard.press("ControlOrMeta+a");
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll('tr[aria-selected="true"]').length,
  ),
  3,
);
assert.equal(
  await page.evaluate(
    () => [...document.querySelectorAll(".browser-actions-popover button")].find(button => button.textContent.trim() === "复制到…").disabled,
  ),
  false,
);
assert.equal(
  await page.evaluate(
    () => [...document.querySelectorAll(".browser-actions-popover button")].find(button => button.textContent.trim() === "移动到…").disabled,
  ),
  false,
);
assert.equal(
  await page.evaluate(
    () => [...document.querySelectorAll(".browser-actions-popover button")].find(button => button.textContent.trim() === "重命名…").disabled,
  ),
  true,
);
await page.click('button[aria-label="Folder 操作菜单"]');
await page.waitForSelector('[role="menu"]');
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll('tr[aria-selected="true"]').length,
  ),
  3,
  "ellipsis preserves multiple selection",
);
assert.equal(
  await page.evaluate(() =>
    document.querySelector('[role="menu"]').getAttribute("aria-label"),
  ),
  "3 项操作菜单",
);
await page.keyboard.press("Escape");
await page.focus('tr[data-entry-path="Folder"]');
await page.keyboard.press("Shift+F10");
await page.waitForSelector('[role="menu"]');
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll('tr[aria-selected="true"]').length,
  ),
  3,
  "context menu preserves selection",
);
await page.click('button[role="menuitem"]:has-text("复制到")');
await page.waitForSelector("dialog");
assert.equal(
  await page.evaluate(() => document.querySelector("#target-name")),
  null,
  "batch preserves original names",
);
await page.click('button:text-is("开始复制")');
await page.waitForFunction(() =>
  document.querySelector("dialog").textContent.includes("2 项，1 项未开始"),
);
assert.deepEqual(
  await page.evaluate(() =>
    window.testCalls
      .filter((c) => c.command === "start_transfer")
      .map((c) => c.args.destination.logical_path),
  ),
  ["Folder", "denied.txt", "one.txt"],
);
await page.evaluate(() => (window.allowTransfer = true));
await page.click('button:text-is("开始复制")');
await page.waitForFunction(() => !document.querySelector("dialog"));
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter(
        (c) =>
          c.command === "start_transfer" &&
          c.args.source.logical_path === "Folder",
      ).length,
  ),
  1,
  "retry never repeats a successful item",
);
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter(
        (c) =>
          c.command === "start_transfer" &&
          c.args.source.logical_path === "denied.txt",
      ).length,
  ),
  2,
);
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="Folder"]');
await page.click('tr[data-entry-path="Folder"] .file-name');
await page.keyboard.press("ControlOrMeta+a");
await page.click('button[aria-label="移入回收站"]');
await page.waitForSelector("dialog");
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /全部文件及子文件夹/,
);
await page.click('dialog button:text-is("移入回收站")');
await page.waitForFunction(() =>
  document.querySelector("dialog").textContent.includes("2 项未完成"),
);
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter(
        (c) => c.command === "delete_entry" && c.args.mode === "permanent",
      ).length,
  ),
  0,
  "trash failure does not cause permanent deletion",
);
await page.click('button:has-text("改为永久删除 1 项")');
await page.waitForSelector('button:text-is("确认永久删除")');
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter(
        (c) => c.command === "delete_entry" && c.args.mode === "permanent",
      ).length,
  ),
  0,
  "second confirmation must be explicit",
);
await page.click('button:text-is("确认永久删除")');
await page.waitForFunction(() =>
  document.querySelector("dialog").textContent.includes("1 项未完成"),
);
assert.deepEqual(
  await page.evaluate(() =>
    window.testCalls
      .filter(
        (c) => c.command === "delete_entry" && c.args.mode === "permanent",
      )
      .map((c) => c.args.locator.logical_path),
  ),
  ["one.txt"],
);
await page.evaluate(() => (window.allowDelete = true));
await page.click('button:text-is("重试移入回收站")');
await page.waitForFunction(() => !document.querySelector("dialog"));
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter(
        (c) =>
          c.command === "delete_entry" &&
          c.args.locator.logical_path === "Folder",
      ).length,
  ),
  1,
);
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.find(
        (c) =>
          c.command === "delete_entry" &&
          c.args.locator.logical_path === "Folder",
      ).args.recursive,
  ),
  true,
);
assert.match(
  await page.evaluate(() => document.querySelector("#floating-notices").textContent),
  /2 项已移入回收站，1 项已永久删除/,
);
console.log(
  "PASS: folder actions, batch toolbar, selection menus, per-item transfer failures and retries, recursive deletion confirmation, mixed outcomes and explicit trash fallback",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
