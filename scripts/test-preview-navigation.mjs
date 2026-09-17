// Run with Vite running: ego-browser nodejs < scripts/test-preview-navigation.mjs
// IPC fixtures affect only this page; no real files are read or modified.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo preview navigation regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    window.previewCalls = [];
    window.listedParents = [];
    const volume = {
      id: 'preview-nav', connection_id: 'preview-nav', name: 'Preview nav',
      read_only: false, root: { type: 'local', root_path: '/preview-nav' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        delete: true, trash: true, native_open: true, native_copy: true }
    };
    const rootEntries = [
      { name: 'Folder', kind: 'directory', size: null },
      { name: 'a.txt', kind: 'file', size: 1024 },
      { name: 'b.txt', kind: 'file', size: 2048 },
      { name: 'notes.txt', kind: 'file', size: 12 }
    ].map(entry => ({ ...entry, modified_at: '2026-09-16T00:00:00Z', locator: {
      volume_id: volume.id, logical_path: entry.name, version_id: null
    }}));
    const searchEntries = ['Folder/first.txt', 'Folder/second.txt'].map(path => ({
      name: path.split('/').at(-1), kind: 'file', size: 16, modified_at: null,
      locator: { volume_id: volume.id, logical_path: path, version_id: null }
    }));
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'list_volumes') return [volume];
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'preview_entry') {
        window.previewCalls.push(args.locator.logical_path);
        return { kind: 'text', mime: 'text/plain', content: 'contents:' + args.locator.logical_path, truncated: false };
      }
      if (command === 'start_content_search') return 'preview-search';
      if (command === 'content_search_status') return {
        id: 'preview-search',
        hits: searchEntries.map((entry, index) => ({
          entry, line: index + 1, snippet: 'matching text'
        })),
        scanned: 2, skipped: 0, errors: [], done: true,
        cancelled: false, limited: false
      };
      if (command === 'list_entries_page') {
        window.listedParents.push(args.parent.logical_path);
        if (args.parent.logical_path === 'Folder') {
          const children = [{
            name: 'inner.txt', kind: 'file', size: 8, modified_at: null,
            locator: { volume_id: volume.id, logical_path: 'Folder/inner.txt', version_id: null }
          }];
          return { entries: children, total: 1, next_cursor: null };
        }
        if (args.parent.logical_path) return { entries: [], total: 0, next_cursor: null };
        const entries = rootEntries.filter(entry => entry.name.includes(args.options.search));
        return { entries, total: entries.length, next_cursor: null };
      }
      throw new Error('Unexpected test IPC: ' + command);
    }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/preview-nav"]');
await page.click('.volume-nav button[title="/preview-nav"]');
await page.waitForSelector('[data-entry-path="Folder"]');

async function selected() {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('tr[aria-selected="true"]'),
      (row) => row.dataset.entryPath,
    ),
  );
}

async function previewTitle() {
  return page.evaluate(() => document.querySelector("#modal-title")?.textContent);
}

assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="预览"]').disabled,
  ),
  true,
  "Preview stays disabled with no selection",
);

await page.click('tr[data-entry-path="Folder"] .file-name');
assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="预览"]').disabled,
  ),
  false,
  "Folder selection enables preview",
);
await page.keyboard.press("Space");
await page.waitForSelector(".directory-preview-list");
assert.equal(await previewTitle(), "预览 · Folder");
assert.deepEqual(
  await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".directory-preview-list li"),
      (node) => node.textContent.trim(),
    ),
  ),
  ["inner.txt"],
);
assert.deepEqual(
  await page.evaluate(() => window.previewCalls),
  [],
  "Folder preview does not read file contents",
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".directory-preview-heading")?.textContent ?? "",
  ),
  /1 个项目/,
);

await page.keyboard.press("ArrowDown");
await page.waitForSelector(".text-preview");
assert.equal(await previewTitle(), "预览 · a.txt");
assert.equal(
  await page.evaluate(
    () => document.querySelector(".text-preview").textContent,
  ),
  "contents:a.txt",
);
assert.deepEqual(await selected(), ["a.txt"]);

await page.keyboard.press("ArrowDown");
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "预览 · b.txt",
);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".text-preview").textContent,
  ),
  "contents:b.txt",
);
assert.deepEqual(await selected(), ["b.txt"]);

await page.keyboard.press("ArrowUp");
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "预览 · a.txt",
);
assert.deepEqual(await selected(), ["a.txt"]);

await page.keyboard.press("ArrowUp");
await page.waitForSelector(".directory-preview-list");
assert.equal(await previewTitle(), "预览 · Folder");
assert.deepEqual(await selected(), ["Folder"]);
assert.deepEqual(
  await page.evaluate(() => window.previewCalls),
  ["a.txt", "b.txt"],
  "Returning to a cached text preview does not read the file again",
);

await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });
assert.deepEqual(await selected(), ["Folder"]);

await page.click('tr[data-entry-path="notes.txt"] .file-name');
await page.keyboard.press("Space");
await page.waitForSelector(".text-preview");
await page.keyboard.press("ArrowDown");
assert.equal(await previewTitle(), "预览 · notes.txt");
await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });

await page.click('button[aria-label="Folder 操作菜单"]');
await page.click('[role="menuitem"]:text-is("预览")');
await page.waitForSelector(".directory-preview-list");
await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });

await page.click('button[aria-label="搜索文件内容"]');
await page.fill("#content-query", "matching text");
await page.click('button:text-is("开始搜索")');
await page.waitForSelector(".content-results button");
await page.click('.content-results button >> nth=0');
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "预览 · first.txt",
);
await page.keyboard.press("ArrowDown");
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "预览 · second.txt",
);
await page.keyboard.press("ArrowUp");
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "预览 · first.txt",
);
await page.keyboard.press("Escape");
await page.waitForFunction(
  () => document.querySelector("#modal-title")?.textContent === "搜索文件内容",
);
await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });

console.log(
  "PASS: folder preview, directory and content-search arrow navigation, selection sync, boundary handling, folder menu preview",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
