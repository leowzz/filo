// Run: ego-browser nodejs < scripts/test-directory-menu.mjs
// Mock IPC in this page only; no user files are changed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo directory menu regression");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
    window.isTauri = true;
    window.testCalls = [];
    const volume = {
      id: 'selection-test', connection_id: 'selection-test', name: 'Selection test',
      read_only: false, root: { type: 'local', root_path: '/selection-test' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        delete: true, trash: true, native_open: true, native_copy: true }
    };
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      window.testCalls.push({ command, args });
      if (command === 'list_volumes') return [volume, { ...volume, id: 'readonly-test', name: 'Read only', read_only: true, root: {type: 'local', root_path: '/readonly-test'} }];
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'open_entry') return;
      if (command === 'create_directory') return;
      if (command === 'list_entries_page') { if (args.parent.logical_path) return {entries:[], total:0, next_cursor:null}; const entries = [
        { name: 'Folder', kind: 'directory', size: null },
        ...Array.from({ length: 60 }, (_, i) => ({ name: 'file-' + String(i + 1).padStart(2, '0') + '.txt', kind: 'file', size: i + 100 }))
      ].map(entry => ({ ...entry, modified_at: '2026-09-16T00:00:00Z', locator: {
        volume_id: volume.id, logical_path: args.parent.logical_path + '/' + entry.name, version_id: null
      }})).filter(entry => entry.name.includes(args.options.search)); return {entries, total: entries.length, next_cursor: null}; }
      throw new Error('Unexpected test IPC: ' + command);
    }};

})();
`,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/selection-test"]');
await page.click('.volume-nav button[title="/selection-test"]');
await page.waitForSelector(".file-table tbody tr");


async function openMenu(edge = false) {
  const point = await page.evaluate((edge) => {
    const rect = document.querySelector('.file-area').getBoundingClientRect();
    return { x: edge ? rect.right - 2 : rect.left + 2, y: rect.bottom - 12 };
  }, edge);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForSelector('[aria-label="当前目录操作菜单"]');
}
const item = (label) => 'loc=role:' + (label === '使用群组' ? 'menuitemcheckbox' : 'menuitem') + '[name="' + label + '"]';
await openMenu();
assert.equal(await page.evaluate(() => document.querySelector('[aria-label="当前目录操作菜单"] button:nth-child(2)').disabled), true);
await page.click(item('新建文件夹'));
await page.fill('#entry-name', 'Context folder');
await page.click('button[type=submit]');
await page.waitForFunction(() => window.testCalls.some(c => c.command === 'create_directory'));
await page.waitForSelector('dialog', { state: 'hidden' });
await openMenu();
await page.click(item('显示简介'));
assert.equal(await page.evaluate(() => document.querySelector('.details-panel h3').textContent), 'Selection test');

await openMenu();
const grouped = await page.evaluate(() => document.querySelector('[role=menuitemcheckbox]').getAttribute('aria-checked') === 'true');
if (!grouped) await page.click(item('使用群组'));
else await page.keyboard.press('Escape');
await page.waitForSelector('.file-group');
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.file-group')].map(r => r.textContent)), ['文件夹', '文件及其他项目']);
await page.click('[data-entry-path="/Folder"]');
await page.keyboard.press('ArrowDown');
assert.equal(await page.evaluate(() => document.activeElement.dataset.entryPath), '/file-01.txt', 'Keyboard skips group headings');
// Drag over a group heading and the first two file rows; headings cannot select a file.
const drag = await page.evaluate(() => {
  const first = document.querySelector('[data-entry-path="/file-01.txt"]').getBoundingClientRect();
  const second = document.querySelector('[data-entry-path="/file-02.txt"]').getBoundingClientRect();
  return { x: first.left + 70, top: first.top + 3, bottom: second.bottom - 3 };
});
await page.mouse.move(drag.x, drag.top);
await page.mouse.down();
await page.mouse.move(drag.x + 80, drag.bottom);
await page.mouse.up();
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[aria-selected=true]')].map(r => r.dataset.entryPath)), ['/file-01.txt', '/file-02.txt']);

await openMenu(true);
await page.click(item('排序方式'));
await page.waitForSelector('[aria-label="排序方式"][role=menu]');
assert.equal(await page.evaluate(() => [...document.querySelectorAll('.directory-menu')].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })), true, 'Both menu panels fit viewport');
await page.keyboard.press('ArrowLeft');
assert.equal(await page.evaluate(() => document.activeElement.textContent), '排序方式');
await page.keyboard.press('ArrowRight');
await page.click('[role=menu] button:has-text("大小（从大到小）")');
await page.waitForFunction(() => window.testCalls.some(c => c.command === 'list_entries_page' && c.args.options.sort === 'size'));

await openMenu();
await page.click(item('查看显示选项…'));
await page.selectOption('#browser-sort', 'modified');
assert.equal(await page.evaluate(() => !!document.querySelector('dialog[open]')), true, 'Options stay open when sorting changes');
if (!(await page.evaluate(() => [...document.querySelectorAll('dialog label')].find(el => el.textContent.includes('显示隐藏文件')).querySelector('input').checked))) await page.click('dialog label:has-text("显示隐藏文件")');
await page.waitForFunction(() => window.testCalls.some(c => c.command === 'list_entries_page' && c.args.options.show_hidden));
await page.click('dialog button:has-text("完成")');
await page.focus('.file-area');
await page.keyboard.press('Shift+F10');
await page.waitForSelector('[aria-label="当前目录操作菜单"]');
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => document.activeElement.classList.contains('file-area')), true);

// An entry's context menu must not bubble into the directory menu.
await page.click('[data-entry-path="/Folder"]');
await page.keyboard.press('Shift+F10');
assert.equal(await page.evaluate(() => document.querySelector('[role=menu]').getAttribute('aria-label')), 'Folder 操作菜单');
await page.keyboard.press('Escape');
await page.dblclick('[data-entry-path="/Folder"]');
await openMenu();
await page.click(item('显示简介'));
assert.equal(await page.evaluate(() => document.querySelector('.details-panel h3').textContent), 'Folder', 'Blank-area details describe current folder');
await page.cdp('Emulation.setDeviceMetricsOverride', {width: 820, height: 620, deviceScaleFactor: 1, mobile: false});
await openMenu(true);
await page.click(item('显示'));
assert.equal(await page.evaluate(() => [...document.querySelectorAll('.directory-menu')].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })), true);
await page.keyboard.press('Escape');
await page.click('.volume-nav button[title="/readonly-test"]');
await openMenu();
assert.equal(await page.evaluate(() => document.querySelector('[aria-label="当前目录操作菜单"] button').disabled), true, 'Read-only folders cannot create directories');
await page.keyboard.press('Escape');
await page.reload();
await page.waitForSelector('.volume-nav button[title="/selection-test"]');
await page.click('.volume-nav button[title="/selection-test"]');
await page.waitForSelector('.file-group');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('filo.browser-preferences')).useGroups), true);
// Return to the normal ungrouped view for other interaction regressions.
await openMenu();
await page.click(item('使用群组'));
await page.cdp('Emulation.clearDeviceMetricsOverride', {});
console.log('PASS: creation, directory info, grouping selection, submenus, sorting, options, keyboard, edge positioning');
if (!globalThis.filoKeepBrowser) await task.finish({keep: []});
