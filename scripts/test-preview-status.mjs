// Run with Vite running: ego-browser nodejs < scripts/test-preview-status.mjs
// IPC fixtures affect only this page; no real files are read or modified.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo preview status dialog regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    window.previewCalls = [];
    window.pendingPreviews = {};
    const volume = {
      id: 'preview-status', connection_id: 'preview-status', name: 'Preview status',
      read_only: false, root: { type: 'local', root_path: '/preview-status' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        delete: true, trash: true, native_open: true, native_copy: true }
    };
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'list_volumes') return [volume];
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'preview_entry') {
        const path = args.locator.logical_path;
        window.previewCalls.push(path);
        if (path === 'r730xd-ompublication-zh-cn.pdf') {
          await new Promise((resolve) => { window.pendingPreviews[path] = resolve; });
          return { kind: 'text', mime: 'text/plain', content: 'pdf-ok', truncated: false };
        }
        if (path === 'app_dir_rename.exe') {
          throw { message: '此文件暂不支持预览，请下载或使用系统应用打开' };
        }
        return { kind: 'text', mime: 'text/plain', content: 'ok', truncated: false };
      }
      if (command === 'list_entries_page') {
        const entries = [
          { name: 'r730xd-ompublication-zh-cn.pdf', kind: 'file', size: 12_100_000 },
          { name: 'app_dir_rename.exe', kind: 'file', size: 2048 },
          { name: 'notes.txt', kind: 'file', size: 12 }
        ].map(entry => ({ ...entry, modified_at: null, locator: {
          volume_id: volume.id, logical_path: entry.name, version_id: null
        }})).filter(entry => entry.name.includes(args.options.search));
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
await page.waitForSelector('.volume-nav button[title="/preview-status"]');
await page.click('.volume-nav button[title="/preview-status"]');
await page.waitForSelector('[data-entry-path="notes.txt"]');

async function dialogState() {
  return page.evaluate(() => {
    const dialog = document.querySelector("dialog.preview-modal");
    if (!dialog) return null;
    const title = dialog.querySelector("#modal-title");
    return {
      width: Math.round(dialog.getBoundingClientRect().width),
      compact: !!dialog.querySelector(".preview-content.is-compact"),
      title: title?.textContent ?? "",
      titleAttr: title?.getAttribute("title") ?? "",
      status: dialog.querySelector("[role=status]")?.textContent?.trim() ?? null,
      alert: dialog.querySelector("[role=alert] p")?.textContent?.trim() ?? null,
      retry: Array.from(dialog.querySelectorAll("[role=alert] button")).some(
        (button) => button.textContent?.trim() === "重试",
      ),
    };
  });
}

async function close() {
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog[open]", { state: "detached" });
}

await page.click(
  'tr[data-entry-path="r730xd-ompublication-zh-cn.pdf"] .file-name',
);
await page.keyboard.press("Space");
await page.waitForSelector("dialog.preview-modal .is-compact [role=status]");
await page.waitForFunction(
  () => typeof window.pendingPreviews["r730xd-ompublication-zh-cn.pdf"] === "function",
);
let state = await dialogState();
assert.equal(state.status, "正在读取预览…");
assert.equal(state.compact, true);
assert.ok(state.width <= 420, `loading dialog too wide: ${state.width}`);
assert.equal(state.title, "预览 · r730xd-ompublication-zh-cn.pdf");
assert.equal(state.titleAttr, state.title);
await page.evaluate(() =>
  window.pendingPreviews["r730xd-ompublication-zh-cn.pdf"](),
);
await page.waitForSelector(".text-preview");
state = await dialogState();
assert.equal(state.compact, false);
assert.ok(state.width >= 700, `content dialog too narrow: ${state.width}`);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".text-preview").textContent,
  ),
  "pdf-ok",
);
await close();

await page.click('tr[data-entry-path="app_dir_rename.exe"] .file-name');
await page.keyboard.press("Space");
await page.waitForSelector("dialog.preview-modal .is-compact [role=alert]");
state = await dialogState();
assert.equal(state.compact, true);
assert.ok(state.width <= 420, `unsupported dialog too wide: ${state.width}`);
assert.equal(
  state.alert,
  "此文件暂不支持预览，请下载或使用系统应用打开",
);
assert.equal(state.retry, true);
await close();

await page.click('tr[data-entry-path="notes.txt"] .file-name');
await page.keyboard.press("Space");
await page.waitForSelector(".text-preview");
state = await dialogState();
assert.equal(state.compact, false);
assert.ok(state.width >= 700, `text dialog too narrow: ${state.width}`);
await close();

console.log(
  "PASS: compact loading/unsupported preview dialogs, expanded content preview, retry control",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
