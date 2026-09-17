// Vite must be running. Native drag events and IPC are mocked in this page only.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo external upload regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
  window.isTauri = true;
  window.calls = [];
  window.jobs = [];
  window.listeners = new Map();
  window.unhandled = [];
  window.failedUnlistens = 0;
  window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason)));
  const callbacks = new Map();
  let sequence = 0;
  const volume = (id, readOnly) => ({ id, connection_id: id, name: id, read_only: readOnly,
    root: { type: 's3', bucket: id, prefix: '' },
    capabilities: { hierarchy: 'virtual_prefix', rename: 'copy_then_delete', create_directory: !readOnly,
      delete: !readOnly, trash: false, native_open: false, native_copy: true } });
  window.emitDropEvent = (type, inside = true, paths = ['/external/a.txt', '/external/folder']) => {
    const rect = document.querySelector('.file-area').getBoundingClientRect();
    const position = { x: (inside ? rect.left + 40 : 20) * devicePixelRatio, y: (rect.top + 80) * devicePixelRatio };
    for (const [id, listener] of window.listeners) {
      if (listener.event === 'tauri://drag-' + type)
        callbacks.get(listener.handler)?.({ event: listener.event, id, payload: { paths, position } });
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: callback => { const id = ++sequence; callbacks.set(id, callback); return id; },
    unregisterCallback: id => callbacks.delete(id),
    invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      window.calls.push({ command, args });
      if (command === 'plugin:event|listen') {
        const id = ++sequence; window.listeners.set(id, args); return id;
      }
      if (command === 'plugin:event|unlisten') {
        window.listeners.delete(args.eventId);
        if (window.failUnlisten) {
          window.failedUnlistens++;
          throw new Error('fixture teardown failure');
        }
        return;
      }
      if (command === 'list_volumes') return [volume('Writable', false), volume('Read only', true)];
      if (command === 'list_connections') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'list_entries_page') return { entries: [{ name: 'nested', kind: 'directory', size: null, modified_at: null,
        locator: { ...args.parent, logical_path: 'nested' } }], total: 1, next_cursor: null };
      if (command === 'list_transfers') return window.jobs;
      if (command === 'preflight_upload') {
        if (window.preflightError) throw new Error('无法访问目标');
        if (!args.paths) return window.pickerResult ?? null;
        return { paths: args.paths, conflicts: window.noConflict ? [] : (window.conflictPaths ?? args.paths) };
      }
      if (command === 'upload_dropped_files') {
        const jobs = args.paths.map((path, i) => ({ id: String(window.jobs.length + i), kind: 'copy', state: 'running',
          source: { volume_id: 'external', logical_path: path.split('/').pop(), version_id: null },
          destination: { ...args.remote, logical_path: args.remote.logical_path + '/' + path.split('/').pop() },
          bytes_total: 1000, bytes_transferred: 100, created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
          error_code: null, error_message: null }));
        window.jobs.push(...jobs);
        jobs.forEach(job => args.onProgress.onmessage(job));
        if (window.lateConflict) {
          const job = jobs[0];
          job.state = 'failed'; job.error_code = 'already_exists'; job.error_message = '目标已存在';
          args.onProgress.onmessage(job);
        }
        return { jobs, failures: window.partialFailure ? ['folder：无法读取项目，请检查是否存在及访问权限'] : [] };
      }
      if (command === 'transfer_local_file') return null;
      throw new Error('Unexpected IPC: ' + command);
    }
  };
})();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="Writable"]');
await page.click('.volume-nav button[title="Writable"]');
await page.waitForFunction(() =>
  Array.from(window.listeners.values()).some(
    (item) => item.event === "tauri://drag-leave",
  ),
);
await page.evaluate(() => window.emitDropEvent("enter", false));
assert.equal(
  await page.evaluate(() => !!document.querySelector(".file-drop-overlay")),
  false,
);
await page.evaluate(() => window.emitDropEvent("enter"));
await page.waitForSelector(".file-drop-overlay");
assert.match(
  await page.evaluate(
    () => document.querySelector(".file-drop-overlay").textContent,
  ),
  /松开以上传/,
);
await page.evaluate(() => window.emitDropEvent("leave"));
await page.waitForSelector(".file-drop-overlay", { state: "detached" });
await page.evaluate(() => window.emitDropEvent("drop", false));
assert.equal(
  await page.evaluate(() => !!document.querySelector("dialog")),
  false,
);

await page.evaluate(() => {
  window.failUnlisten = true;
});
await page.dblclick('tr[data-entry-path="nested"]');
await page.waitForFunction(() =>
  document.querySelector(".pathbar").textContent.includes("nested"),
);
await page.waitForFunction(
  () =>
    Array.from(window.listeners.values()).filter(
      (item) => item.event === "tauri://drag-leave",
    ).length === 1,
);
await page.waitForFunction(() => window.failedUnlistens >= 4);
// Cross an event-loop turn so unhandledrejection has time to dispatch.
await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
assert.deepEqual(
  await page.evaluate(() => window.unhandled),
  [],
  "Opening an S3 directory must consume all async listener cleanup failures",
);
await page.evaluate(() => {
  window.failUnlisten = false;
});
await page.evaluate(() => window.emitDropEvent("drop"));
await page.waitForSelector(".upload-dialog");
assert.match(
  await page.evaluate(
    () => document.querySelector(".upload-dialog").textContent,
  ),
  /将 2 个项目上传到 Writable\/nested，以下 2 个项目存在同名/,
);
assert.deepEqual(
  await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".batch-items li"),
      (node) => node.textContent,
    ),
  ),
  ["a.txt", "folder"],
);
await page.evaluate(() =>
  window.emitDropEvent("drop", true, ["/external/other.txt"]),
);
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".batch-items li").length,
  ),
  2,
  "An open dialog blocks replacement drops",
);
await page.click('button:text-is("取消")');
assert.equal(
  await page.evaluate(
    () =>
      window.calls.filter((call) => call.command === "upload_dropped_files")
        .length,
  ),
  0,
);

await page.evaluate(() => window.emitDropEvent("drop"));
await page.waitForSelector(".upload-dialog");
await page.click('input[value="rename"]');
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 960,
  height: 640,
  deviceScaleFactor: 2,
  mobile: false,
});
const layout = await page.evaluate(() => {
  const dialog = document.querySelector(".upload-dialog");
  const rect = dialog.getBoundingClientRect();
  const choices = Array.from(
    document.querySelectorAll(".conflict-choice"),
    (node) => node.getBoundingClientRect(),
  );
  return {
    fits:
      rect.left >= 0 &&
      rect.right <= innerWidth &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight &&
      dialog.scrollWidth <= dialog.clientWidth,
    aligned: choices.every(
      (choice) =>
        choice.left === choices[0].left && choice.width === choices[0].width,
    ),
  };
});
assert.deepEqual(layout, { fits: true, aligned: true });
if (globalThis.filoCaptureScreenshot)
  await page.screenshot({ path: "/tmp/filo-external-upload.png" });
await page.click('button:text-is("继续上传")');
await page.waitForSelector(".transfer-tasks-popover");
const uploads = await page.evaluate(() =>
  window.calls
    .filter((call) => call.command === "upload_dropped_files")
    .map((call) => ({
      paths: call.args.paths,
      remote: call.args.remote,
      policy: call.args.conflictPolicy,
    })),
);
assert.equal(uploads.length, 1);
assert.deepEqual(uploads[0], {
  paths: ["/external/a.txt", "/external/folder"],
  remote: { volume_id: "Writable", logical_path: "nested", version_id: null },
  policy: "rename",
});
assert.equal(
  await page.evaluate(
    () =>
      window.calls.filter((call) => call.command === "transfer_local_file")
        .length,
  ),
  0,
  "Dropped files bypass the picker",
);
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".transfer-tasks-list article").length,
  ),
  2,
);
await page.keyboard.press("Escape");

await page.evaluate(() => {
  window.partialFailure = true;
  window.emitDropEvent("drop");
});
await page.waitForSelector(".upload-dialog");
await page.click('button:text-is("继续上传")');
await page.waitForFunction(() =>
  document.querySelector(".notice")?.textContent.includes("1 项未开始"),
);
await page.keyboard.press("Escape");
await page.click('.volume-nav button[title="Read only"]');
await page.waitForFunction(
  () =>
    Array.from(window.listeners.values()).filter(
      (item) => item.event === "tauri://drag-leave",
    ).length === 1,
);
await page.evaluate(() => window.emitDropEvent("enter"));
await page.waitForSelector(".file-drop-overlay");
assert.match(
  await page.evaluate(
    () => document.querySelector(".file-drop-overlay").textContent,
  ),
  /只读/,
);
await page.evaluate(() => window.emitDropEvent("drop"));
await page.waitForFunction(() =>
  document.querySelector(".notice")?.textContent.includes("只读"),
);
assert.equal(
  await page.evaluate(() => !!document.querySelector("dialog")),
  false,
);
assert.equal(
  await page.evaluate(
    () =>
      window.calls.filter((call) => call.command === "upload_dropped_files")
        .length,
  ),
  2,
);

await page.click('.volume-nav button[title="Writable"]');
await page.click('button[aria-label="上传文件"]');
await page.waitForFunction(() =>
  window.calls.some(
    (call) => call.command === "preflight_upload" && call.args.paths === null,
  ),
);
assert.equal(
  await page.evaluate(() => !!document.querySelector(".upload-dialog")),
  false,
);
// No conflict: drop goes straight to transfer, always with reject policy.
await page.evaluate(() => {
  window.noConflict = true;
  window.partialFailure = false;
  window.emitDropEvent("drop");
});
await page.waitForFunction(
  () =>
    window.calls.filter((call) => call.command === "upload_dropped_files")
      .length === 3,
);
assert.equal(
  await page.evaluate(() => !!document.querySelector(".upload-dialog")),
  false,
);
assert.deepEqual(
  await page.evaluate(() => {
    const args = window.calls
      .filter((call) => call.command === "upload_dropped_files")
      .at(-1).args;
    return { policy: args.conflictPolicy, conflicts: args.conflictPaths };
  }),
  { policy: "reject", conflicts: [] },
);
await page.keyboard.press("Escape");
// Failure to inspect the destination must not be treated as an empty directory.
await page.evaluate(() => {
  window.preflightError = true;
  window.emitDropEvent("drop");
});
await page.waitForFunction(() =>
  document.querySelector(".notice")?.textContent.includes("上传预检测失败"),
);
assert.equal(
  await page.evaluate(
    () =>
      window.calls.filter((call) => call.command === "upload_dropped_files")
        .length,
  ),
  3,
);
// Picker selection uses the same preflight and safe automatic upload path.
await page.evaluate(() => {
  window.preflightError = false;
  window.pickerResult = { paths: ["/external/picked.txt"], conflicts: [] };
});
await page.click('button[aria-label="上传文件"]');
await page.waitForFunction(
  () =>
    window.calls.filter((call) => call.command === "upload_dropped_files")
      .length === 4,
);
assert.equal(
  await page.evaluate(() => !!document.querySelector(".upload-dialog")),
  false,
);
await page.keyboard.press("Escape");
// A conflict delivered after streaming must surface in the main window.
await page.evaluate(() => {
  window.lateConflict = true;
  window.emitDropEvent("drop");
});
await page.waitForFunction(() =>
  document.querySelector(".notice")?.textContent.includes("上传发生冲突"),
);
assert.equal(
  await page.evaluate(() => !!document.querySelector(".upload-dialog")),
  false,
);
// In a mixed batch the choice is scoped only to preflight conflicts.
await page.keyboard.press("Escape");
await page.evaluate(() => {
  window.lateConflict = false;
  window.noConflict = false;
  window.conflictPaths = ["/external/a.txt"];
  window.emitDropEvent("drop");
});
await page.waitForSelector(".upload-dialog");
assert.deepEqual(
  await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".batch-items li"),
      (node) => node.textContent,
    ),
  ),
  ["a.txt"],
);
await page.click('input[value="overwrite"]');
await page.click('button:text-is("继续上传")');
await page.waitForFunction(
  () =>
    window.calls.filter((call) => call.command === "upload_dropped_files")
      .length === 6,
);
assert.deepEqual(
  await page.evaluate(() => {
    const args = window.calls
      .filter((call) => call.command === "upload_dropped_files")
      .at(-1).args;
    return {
      policy: args.conflictPolicy,
      conflicts: args.conflictPaths,
      count: args.paths.length,
    };
  }),
  { policy: "overwrite", conflicts: ["/external/a.txt"], count: 2 },
);
console.log(
  "PASS: native event bridge, HiDPI hit testing, enter/leave/outside/modal guards, multi-file drop, cancellation, nested destination, conflict policy, picker bypass, progress, partial failure, read-only guard, listener cleanup, preflight errors, conflict-free drop/picker upload, late conflict notification and mixed-batch overwrite scope",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
