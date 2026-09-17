// Run against the Vite preview with:
//   ego-browser nodejs < scripts/test-file-browser-workflow.mjs
// The IPC fixture exercises the browser state machine without touching files.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo file browser workflow regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page(globalThis.filoTestPage ?? "p1");

await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
  window.isTauri = true;
  window.calls = [];
  window.jobs = [];
  window.transferAttempts = {};
  const volumes = [
    {
      id: 'source', connection_id: 'source', name: 'Source', read_only: false,
      root: { type: 'local', root_path: '/source' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        write: true, delete: true, recursive_delete: true, trash: true,
        native_open: true, native_copy: true }
    },
    {
      id: 'target', connection_id: 'target', name: 'Target', read_only: false,
      root: { type: 'local', root_path: '/target' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        write: true, delete: true, recursive_delete: true, trash: true,
        native_open: true, native_copy: true }
    },
    {
      id: 'ftp-read-only', connection_id: 'ftp-read-only', name: 'FTP 下载', read_only: false,
      root: { type: 'remote', path: '/' },
      capabilities: { hierarchy: 'native_directory', rename: 'unsupported', create_directory: false,
        write: false, delete: true, recursive_delete: false, trash: false,
        native_open: false, native_copy: false }
    }
  ];
  const files = {
    source: {
      '': [
        { name: 'folder', kind: 'directory', size: null },
        { name: 'good.txt', kind: 'file', size: 40 },
        { name: 'flaky.txt', kind: 'file', size: 10 },
        { name: '.hidden.txt', kind: 'file', size: 1 }
      ],
      folder: [{ name: 'nested.txt', kind: 'file', size: 2 }]
    },
    target: {
      '': [{ name: 'dest', kind: 'directory', size: null }],
      dest: []
    },
    'ftp-read-only': { '': [{ name: 'download.txt', kind: 'file', size: 3 }] }
  };
  const makeEntry = (volumeId, parent, item) => ({
    ...item,
    modified_at: '2026-09-16T00:00:00Z',
    locator: { volume_id: volumeId,
      logical_path: parent ? parent + '/' + item.name : item.name,
      version_id: null }
  });
  const sortEntries = (entries, sort) => {
    const result = [...entries];
    if (sort === 'size') result.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
    else if (sort === 'modified') result.reverse();
    else result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      window.calls.push({ command, args });
      if (command === 'list_volumes') return volumes;
      if (command === 'list_connections') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'list_transfers') return window.jobs;
      if (command === 'list_entries_page') {
        const volumeFiles = files[args.parent.volume_id] ?? {};
        let entries = (volumeFiles[args.parent.logical_path] ?? [])
          .filter(item => args.options.show_hidden || !item.name.startsWith('.'))
          .filter(item => item.name.includes(args.options.search))
          .map(item => makeEntry(args.parent.volume_id, args.parent.logical_path, item));
        entries = sortEntries(entries, args.options.sort);
        return { entries, total: entries.length, next_cursor: null };
      }
      if (command === 'start_transfer') {
        const sourceName = args.source.logical_path.split('/').pop();
        const attempt = (window.transferAttempts[sourceName] ?? 0) + 1;
        window.transferAttempts[sourceName] = attempt;
        const failed = sourceName === 'flaky.txt' && attempt === 1;
        const job = {
          id: 'paste-' + window.jobs.length + '-' + sourceName,
          kind: args.kind,
          source: args.source,
          destination: args.destination,
          state: failed ? 'failed' : 'completed',
          created_at: '2026-09-16T00:00:00Z',
          updated_at: '2026-09-16T00:00:00Z',
          error_code: failed ? 'conflict' : null,
          error_message: failed ? '目标已有同名项目' : null,
          bytes_total: 10,
          bytes_transferred: failed ? 0 : 10
        };
        window.jobs.push(job);
        args.onProgress?.onmessage?.(job);
        return job;
      }
      throw new Error('Unexpected IPC: ' + command);
    }
  };
})();`,
});

await page.goto("http://127.0.0.1:1420");
// Make this script repeatable when the browser profile already has a prior
// run's preferences, then reload so Zustand reads the cleared value.
await page.evaluate(() => localStorage.removeItem("filo.browser-preferences"));
await page.reload();
await page.waitForSelector('.volume-nav button[title="/source"]');
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="good.txt"]');

const calls = (command) =>
  page.evaluate(
    (name) => window.calls.filter((call) => call.command === name),
    command,
  );
const selected = () =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll('tr[aria-selected="true"]'),
      (row) => row.dataset.entryPath,
    ),
  );
const rowPoint = (path) =>
  page.evaluate((entryPath) => {
    const row = document.querySelector(`tr[data-entry-path="${entryPath}"]`);
    const rect = row.getBoundingClientRect();
    return { x: rect.left + 70, y: rect.top + rect.height / 2 };
  }, path);
const clickRow = async (path, modifier) => {
  const point = await rowPoint(path);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y);
  if (modifier) await page.keyboard.up(modifier);
};

await clickRow("good.txt");
await clickRow("flaky.txt", "ControlOrMeta");
assert.deepEqual((await selected()).sort(), ["flaky.txt", "good.txt"]);
await page.keyboard.press("ControlOrMeta+c");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已复制 2 项/,
  "Ctrl+C reports a copy clipboard",
);

// Input shortcuts must remain available to the input itself and must not
// submit a paste operation from the global handler.
const beforeInputPaste = (await calls("start_transfer")).length;
await page.fill('input[aria-label="筛选当前目录"]', "good");
await page.keyboard.paste("fixture-text");
assert.equal(
  (await calls("start_transfer")).length,
  beforeInputPaste,
  "Ctrl+V in the search input does not start a transfer",
);
await page.fill('input[aria-label="筛选当前目录"]', "");

await page.click('.volume-nav button[title="/target"]');
await page.waitForSelector('tr[data-entry-path="dest"]');
await page.keyboard.press("ControlOrMeta+v");
await page.waitForFunction(() =>
  document
    .querySelector("#floating-notices")
    ?.textContent.includes("1 项已完成，1 项未完成"),
);
assert.deepEqual(
  (await calls("start_transfer"))
    .sort((a, b) =>
      b.args.source.logical_path.localeCompare(a.args.source.logical_path),
    )
    .map((call) => ({
      source: call.args.source.logical_path,
      destination: call.args.destination.logical_path,
      kind: call.args.kind,
      policy: call.args.conflictPolicy,
    })),
  [
    {
      source: "good.txt",
      destination: "good.txt",
      kind: "copy",
      policy: "reject",
    },
    {
      source: "flaky.txt",
      destination: "flaky.txt",
      kind: "copy",
      policy: "reject",
    },
  ],
  "Paste submits each selected item to the destination volume",
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".paste-retry-bar").textContent,
  ),
  /还有 1 项未完成/,
);

await page.selectOption("#conflict-policy", "overwrite");
await page.click('button:text-is("重试未完成项")');
await page.waitForFunction(() =>
  document.querySelector("#floating-notices")?.textContent.includes("已完成复制 1 项"),
);
const pasteCalls = await calls("start_transfer");
assert.equal(
  pasteCalls.filter((call) => call.args.source.logical_path === "good.txt")
    .length,
  1,
  "Retry does not resubmit the completed item",
);
assert.equal(
  pasteCalls.filter((call) => call.args.source.logical_path === "flaky.txt")
    .length,
  2,
  "Retry resubmits the failed item once",
);
assert.equal(
  pasteCalls.at(-1).args.conflictPolicy,
  "overwrite",
  "Retry uses the chosen conflict policy",
);

await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="folder"]');
await clickRow("folder");
await page.keyboard.press("ControlOrMeta+x");
assert.equal(
  await page.evaluate(() =>
    document
      .querySelector('tr[data-entry-path="folder"]')
      .classList.contains("cut"),
  ),
  true,
  "Cut marks the source row until the move finishes",
);
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /剪切待粘贴 1 项/,
);
await page.click('.volume-nav button[title="/target"]');
await page.waitForSelector('tr[data-entry-path="dest"]');
await page.dblclick('tr[data-entry-path="dest"] .file-name');
await page.waitForFunction(() =>
  document.querySelector(".pathbar").textContent.includes("dest"),
);
await page.keyboard.press("ControlOrMeta+v");
await page.waitForFunction(() =>
  document.querySelector("#floating-notices")?.textContent.includes("已完成移动 1 项"),
);
assert.equal(
  await page.evaluate(() =>
    document.querySelector(".statusbar").textContent.includes("剪切待粘贴"),
  ),
  false,
  "Completed move clears the cut clipboard",
);
const moveCall = (await calls("start_transfer")).at(-1);
assert.deepEqual(
  {
    source: moveCall.args.source,
    destination: moveCall.args.destination,
    kind: moveCall.args.kind,
  },
  {
    source: { volume_id: "source", logical_path: "folder", version_id: null },
    destination: {
      volume_id: "target",
      logical_path: "dest/folder",
      version_id: null,
    },
    kind: "move",
  },
  "Cut and paste keeps source and destination locators separate",
);

// A folder cannot be pasted inside itself, while the destination remains
// selectable and no impossible transfer is submitted.
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="folder"]');
await clickRow("folder");
await page.keyboard.press("ControlOrMeta+c");
await page.dblclick('tr[data-entry-path="folder"] .file-name');
await page.waitForSelector('tr[data-entry-path="folder/nested.txt"]');
const beforeSelfPaste = (await calls("start_transfer")).length;
await page.keyboard.press("ControlOrMeta+v");
await page.waitForFunction(() =>
  document
    .querySelector("#floating-notices")
    ?.textContent.includes("不能将文件夹粘贴到自身或其子目录"),
);
assert.equal((await calls("start_transfer")).length, beforeSelfPaste);

// Browser preferences survive a reload, including the hidden-file toggle and
// sort order. The 760px layout should still fit without horizontal overflow.
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="folder"]');
await page.click('summary[aria-label="更多操作"]');
await page.click('.browser-actions-popover button:has-text("显示隐藏文件")');
await page.waitForSelector('tr[data-entry-path=".hidden.txt"]');
await page.click('th button:has-text("大小")');
await page.waitForFunction(
  () =>
    document.querySelector("tr[data-entry-path]")?.dataset.entryPath ===
    "good.txt",
);
await page.reload();
await page.waitForSelector('.volume-nav button[title="/source"]');
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path=".hidden.txt"]');
assert.equal(
  await page.evaluate(
    () => document.querySelector("tr[data-entry-path]").dataset.entryPath,
  ),
  "good.txt",
  "Sort preference survives reload",
);
await page.click('summary[aria-label="更多操作"]');
assert.equal(
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".browser-actions-popover button"))
      .find((button) => button.textContent === "显示隐藏文件")
      .getAttribute("aria-pressed"),
  ),
  "true",
  "Hidden-file preference survives reload",
);
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 760,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
  "Narrow browser layout fits the viewport",
);

await page.click('.volume-nav button[title="FTP 下载"]');
await page.waitForSelector('tr[data-entry-path="download.txt"]');
assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="上传文件"]').disabled,
  ),
  true,
  "Remote provider write capability disables upload",
);
assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="下载文件"]').disabled,
  ),
  true,
  "Download waits for a selected file",
);
await page.click('tr[data-entry-path="download.txt"] .file-name');
assert.equal(
  await page.evaluate(
    () => document.querySelector('button[aria-label="下载文件"]').disabled,
  ),
  false,
  "Read-only remote provider keeps download available",
);

console.log(
  "PASS: Ctrl+C/X/V, input isolation, cross-volume paste, async partial failure, conflict retry without duplicate success, cut feedback and completion, self-folder guard, persistent browsing preferences, narrow layout and read-only remote upload/download gating",
);
if (!globalThis.filoKeepBrowser && !globalThis.filoKeepSpace)
  await task.finish({ keep: [] });
