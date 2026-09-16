// Run with the Vite server running: ego-browser nodejs < scripts/test-file-selection.mjs
// Fixtures replace Tauri IPC only in this test page; no real files are modified.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo file selection regression",
);
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
      if (command === 'list_volumes') return [volume];
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'open_entry') return;
      if (command === 'list_entries_page') { const entries = [
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

async function selected() {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('tr[aria-selected="true"]'),
      (row) => row.dataset.entryPath,
    ),
  );
}
async function point(index, right = false) {
  return page.evaluate(
    ({ index, right }) => {
      const rect = document
        .querySelectorAll(".file-table tbody tr")
        [index].getBoundingClientRect();
      return {
        x: right ? rect.right - 45 : rect.left + 70,
        y: rect.top + rect.height / 2,
      };
    },
    { index, right },
  );
}
async function clickRow(index, modifier) {
  const p = await point(index);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(p.x, p.y);
  if (modifier) await page.keyboard.up(modifier);
}
async function drag(from, to, modifier) {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

if (!(await page.evaluate(() => !!document.querySelector(".details-panel")))) {
  await page.click('[aria-label="切换详情面板"]');
}
await clickRow(1);
assert.deepEqual(await selected(), ["/file-01.txt"]);
await page.keyboard.press("ArrowDown");
assert.deepEqual(await selected(), ["/file-02.txt"]);
assert.equal(
  await page.evaluate(() => document.activeElement.dataset.entryPath),
  "/file-02.txt",
  "Arrow navigation moves focus along with selection",
);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".details-panel h3").textContent,
  ),
  "file-02.txt",
  "Details follow the selected file",
);
await page.keyboard.press("Enter");
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.find((call) => call.command === "open_entry").args
        .locator.logical_path,
  ),
  "/file-02.txt",
  "Enter opens the file selected with arrows",
);
await page.keyboard.press("Shift+ArrowDown");
assert.deepEqual(await selected(), ["/file-02.txt", "/file-03.txt"]);
await page.keyboard.press("Shift+ArrowUp");
assert.deepEqual(await selected(), ["/file-02.txt"]);
await page.keyboard.press("ArrowUp");
assert.deepEqual(await selected(), ["/file-01.txt"]);
for (let i = 0; i < 65; i++) await page.keyboard.press("ArrowDown");
await page.waitForFunction(
  () => document.activeElement.dataset.entryPath === "/file-60.txt",
);
assert.deepEqual(await selected(), ["/file-60.txt"], "Stops at the last row");
assert.equal(
  await page.evaluate(() => {
    const area = document.querySelector(".file-area");
    const row = document.activeElement.getBoundingClientRect();
    const bounds = area.getBoundingClientRect();
    return (
      area.scrollTop > 0 &&
      row.bottom <= bounds.bottom + 1 &&
      row.top >=
        document.querySelector("thead th").getBoundingClientRect().bottom - 1
    );
  }),
  true,
  "Navigation scrolls virtual rows into view below the sticky header",
);
for (let i = 0; i < 65; i++) await page.keyboard.press("ArrowUp");
await page.waitForFunction(
  () => document.activeElement.dataset.entryPath === "/Folder",
);
assert.deepEqual(await selected(), ["/Folder"], "Stops at the first row");
await page.keyboard.press("ArrowDown");
assert.deepEqual(await selected(), ["/file-01.txt"]);
await page.focus('[aria-label="筛选当前目录"]');
await page.keyboard.press("ArrowDown");
assert.deepEqual(
  await selected(),
  ["/file-01.txt"],
  "Search input keeps its keys",
);
await clickRow(1);
await clickRow(4, "Shift");
assert.equal((await selected()).length, 4, "Shift selects a contiguous range");
await clickRow(2, "Meta");
assert.deepEqual(await selected(), [
  "/file-01.txt",
  "/file-03.txt",
  "/file-04.txt",
]);
await clickRow(6, "Meta");
assert.equal((await selected()).length, 4, "Cmd adds a non-adjacent row");

await drag(await point(2), await point(5, true));
assert.deepEqual(
  await selected(),
  ["/file-02.txt", "/file-03.txt", "/file-04.txt", "/file-05.txt"],
  "Drag replaces selection and survives pointerup/click",
);
assert.equal(
  await page.evaluate(() => window.getSelection().toString()),
  "",
  "Drag does not select text",
);
assert.equal(
  await page.evaluate(() => document.querySelector(".selection-rectangle")),
  null,
);
assert.equal(
  await page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll(".browser-actions-menu button"),
      ).find((button) => button.textContent === "重命名…").disabled,
  ),
  true,
);
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 4 项/,
);

await drag(await point(7, true), await point(4));
assert.deepEqual(
  await selected(),
  ["/file-04.txt", "/file-05.txt", "/file-06.txt", "/file-07.txt"],
  "Reverse drag works",
);
await drag(await point(1), await point(2, true), "Meta");
assert.equal(
  (await selected()).length,
  6,
  "Modified drag preserves earlier selection",
);

const margin = await page.evaluate(() => {
  const rect = document.querySelector(".file-area").getBoundingClientRect();
  return { x: rect.left + 3, y: rect.top + 70 };
});
await page.mouse.click(margin.x, margin.y);
assert.equal((await selected()).length, 0, "Blank space clears selection");
await drag(margin, await point(4));
assert.ok((await selected()).length > 1, "Drag can start in blank space");
await page.keyboard.press("Meta+a");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 61 项/,
  "Select all includes unmounted rows",
);
await page.keyboard.press("Escape");
assert.equal((await selected()).length, 0);

const cancelStart = await point(1);
const cancelEnd = await point(5, true);
await page.mouse.move(cancelStart.x, cancelStart.y);
await page.mouse.down();
await page.mouse.move(cancelEnd.x, cancelEnd.y);
await page.keyboard.press("Escape");
await page.mouse.up();
assert.equal((await selected()).length, 0, "Escape cancels an active drag");
assert.equal(
  await page.evaluate(() => document.querySelector(".selection-rectangle")),
  null,
);
await page.click('button[aria-label="file-01.txt 操作菜单"]');
await page.waitForSelector('[role="menu"]');
await page.keyboard.press("Escape");

await drag(await point(1), { x: margin.x - 30, y: cancelEnd.y });
assert.equal(
  (await selected()).length,
  5,
  "Releasing outside the file area keeps selection",
);
assert.equal(
  await page.evaluate(() => document.querySelector(".selection-rectangle")),
  null,
);

const start = await point(1);
await page.mouse.move(start.x, start.y);
await page.mouse.down();
const edge = await page.evaluate(() => {
  const rect = document.querySelector(".file-area").getBoundingClientRect();
  return { x: rect.right - 50, y: rect.bottom - 2 };
});
await page.mouse.move(edge.x, edge.y);
await page.waitForFunction(
  () => document.querySelector(".file-area").scrollTop > 30,
);
await page.mouse.up();
assert.ok(
  (await selected()).length > 10,
  "Edge drag scrolls and selects offscreen rows",
);
assert.equal(
  await page.evaluate(() => document.querySelector(".selection-rectangle")),
  null,
);

await page.evaluate(() => {
  document.querySelector(".file-area").scrollTop = 0;
});
await clickRow(1);
await page.fill('[aria-label="筛选当前目录"]', "file-02");
assert.equal((await selected()).length, 0, "Filtering clears stale selection");
await page.fill('[aria-label="筛选当前目录"]', "");
assert.equal(
  (await selected()).length,
  0,
  "Clearing a filter does not resurrect selection",
);
await clickRow(1);
assert.equal(
  await page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll(".browser-actions-menu button"),
      ).find((button) => button.textContent === "重命名…").disabled,
  ),
  false,
);
await page.dblclick('.file-table tbody tr[data-entry-path="/file-01.txt"]');
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.filter((call) => call.command === "open_entry").length,
  ),
  2,
  "Double click still opens files once after the earlier Enter",
);
await page.click('button[aria-label="file-01.txt 操作菜单"]');
await page.waitForSelector('[role="menu"]');
await page.keyboard.press("Escape");
await page.dblclick('.file-table tbody tr[data-entry-path="/Folder"]');
await page.waitForSelector('[data-entry-path="/Folder/Folder"]');
assert.equal((await selected()).length, 0, "Navigation clears selection");
console.log(
  "PASS: arrow navigation, focus, boundaries, virtual scrolling, Shift+arrows, input isolation, click, modifier/range selection, forward/reverse/additive/blank-space drag, text suppression, toolbar/status, select all, escape, edge scrolling, filtering, double click, menu, navigation",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
