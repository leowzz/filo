// Run with Vite running: ego-browser nodejs < scripts/test-space-preview.mjs
// IPC fixtures affect only this page; no real files are read or modified.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo space preview regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    window.previewCalls = [];
    window.thumbnailCalls = [];
    window.fullPreviewCalls = [];
    const volume = {
      id: 'preview-test', connection_id: 'preview-test', name: 'Preview test',
      read_only: false, root: { type: 'local', root_path: '/preview-test' },
      capabilities: { hierarchy: 'native_directory', rename: 'atomic', create_directory: true,
        delete: true, trash: true, native_open: true, native_copy: true }
    };
    const volumes = [volume,
      { ...volume, id: 's3-preview-test', name: 'Remote S3 test',
        root: { type: 's3', bucket: 'preview-test', prefix: '' } },
      { ...volume, id: 'remote-preview-test', name: 'Remote SFTP test',
        root: { type: 'remote', path: '/preview-test' } }
    ];
    window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
      if (command === 'list_volumes') return volumes;
      if (command === 'list_transfers') return [];
      if (command === 'directory_stamp') return '1';
      if (command === 'preview_entry') {
        (args.thumbnail ? window.thumbnailCalls : window.fullPreviewCalls).push(args.locator);
        if (!args.thumbnail) window.previewCalls.push(args.locator.logical_path);
        if (args.locator.logical_path === 'photo.jpg') {
          const canvas = document.createElement('canvas');
          canvas.width = 40; canvas.height = 20;
          const context = canvas.getContext('2d');
          context.fillStyle = '#396f56'; context.fillRect(0, 0, 40, 20);
          return { kind: 'image', mime: 'image/jpeg', content: canvas.toDataURL('image/jpeg').split(',')[1], truncated: false };
        }
        return { kind: 'text', mime: 'text/plain', content: 'File contents', truncated: false };
      }
      if (command === 'list_entries_page') {
        const entries = [
          { name: 'Folder', kind: 'directory', size: null },
          { name: 'a.txt', kind: 'file', size: 1024 },
          { name: 'b.txt', kind: 'file', size: 2048 },
          { name: 'empty.txt', kind: 'file', size: 0 },
          { name: 'unknown.txt', kind: 'file', size: null },
          { name: 'unknown2.txt', kind: 'file', size: null },
          { name: 'photo.jpg', kind: 'file', size: 1024 }
        ].map(entry => ({ ...entry, modified_at: null, locator: {
          volume_id: args.parent.volume_id, logical_path: entry.name, version_id: null
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
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/preview-test"]');
await page.click('.volume-nav button[title="/preview-test"]');
await page.waitForSelector('[data-entry-path="a.txt"]');

async function select(name, additive = false) {
  if (additive) await page.keyboard.down("Meta");
  await page.click(`tr[data-entry-path="${name}"] .file-name`);
  if (additive) await page.keyboard.up("Meta");
}
async function summary(expected) {
  await page.keyboard.press("Space");
  await page.waitForSelector(".selection-preview-stats");
  assert.deepEqual(
    await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(".selection-preview-stats dd"),
        (node) => node.textContent,
      ),
    ),
    expected,
  );
}
async function close() {
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog[open]", { state: "detached" });
}
async function assertLayout(width) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    const rect = dialog.getBoundingClientRect();
    const values = Array.from(
      dialog.querySelectorAll("dd"),
      (node) => node.getBoundingClientRect().right,
    );
    return {
      fits:
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        dialog.scrollWidth <= dialog.clientWidth,
      aligned: Math.abs(values[0] - values[1]) < 1,
    };
  });
  assert.deepEqual(layout, { fits: true, aligned: true });
}

await select("a.txt");
await page.keyboard.press("Space");
await page.waitForSelector(".text-preview");
assert.equal(
  await page.evaluate(
    () => document.querySelector(".text-preview").textContent,
  ),
  "File contents",
);
await page.evaluate(() => {
  document.activeElement.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      repeat: true,
      bubbles: true,
      cancelable: true,
    }),
  );
});
assert.equal(
  await page.evaluate(() => !!document.querySelector("dialog[open]")),
  true,
  "Holding the opening space key must not immediately close the preview",
);
await page.keyboard.press("Space");
await page.waitForSelector("dialog[open]", { state: "detached" });
assert.equal(
  await page.evaluate(
    () => document.querySelector('tr[aria-selected="true"]').dataset.entryPath,
  ),
  "a.txt",
);

await select("b.txt", true);
await summary(["2 个", "3.0 KB"]);
assert.deepEqual(
  await page.evaluate(() => window.previewCalls),
  ["a.txt"],
  "Summary never requests file contents",
);
await assertLayout(1200);
await assertLayout(960);
await page.screenshot({ path: "/tmp/filo-space-preview.png" });
await close();
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll('tr[aria-selected="true"]').length,
  ),
  2,
);
await page.click('button[aria-label="预览"]');
await page.waitForSelector(".selection-preview-stats");
await close();
await page.click('button[aria-label="b.txt 操作菜单"]');
await page.click('[role="menuitem"]:text-is("预览")');
await page.waitForSelector(".selection-preview-stats");
await close();

await select("unknown.txt", true);
await summary(["3 个", "3.0 KB"]);
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /1 个文件大小未知/,
);
await close();
await select("unknown.txt");
await select("unknown2.txt", true);
await summary(["2 个", "未知"]);
await close();
await select("empty.txt");
await select("Folder", true);
await summary(["1 个", "0 B"]);
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /未计入文件数量和空间合计/,
);
await close();

await page.focus('[aria-label="筛选当前目录"]');
await page.keyboard.press("Space");
assert.equal(
  await page.evaluate(() => document.querySelector("dialog[open]")),
  null,
  "Typing does not preview",
);
await page.fill('[aria-label="筛选当前目录"]', "");
await page.waitForSelector('[data-entry-path="a.txt"]');
await page.focus(".file-area");
await page.keyboard.press("Space");
assert.equal(
  await page.evaluate(() => document.querySelector("dialog[open]")),
  null,
  "Empty selection does not preview",
);
await select("a.txt");
await page.focus('button[aria-label="a.txt 操作菜单"]');
await page.keyboard.press("Space");
await page.waitForSelector('[role="menu"]');
assert.equal(
  await page.evaluate(() => document.querySelector("dialog[open]")),
  null,
  "Space activates focused controls normally",
);
await page.keyboard.press("Escape");

await page.waitForFunction(() => {
  const thumbnail = document.querySelector(
    '[data-entry-path="photo.jpg"] .file-thumbnail',
  );
  return thumbnail?.complete && thumbnail.naturalWidth === 40;
});
assert.match(
  await page.evaluate(
    () =>
      document.querySelector('[data-entry-path="photo.jpg"] .file-thumbnail')
        .src,
  ),
  /^data:image\/jpeg;base64,/,
);
await select("photo.jpg");
await page.keyboard.press("Space");
await page.waitForFunction(() => {
  const image = document.querySelector(".image-preview");
  return image?.complete && image.naturalWidth === 40;
});
assert.match(
  await page.evaluate(() => document.querySelector(".image-preview").src),
  /^data:image\/jpeg;base64,/,
);
await page.focus("dialog[open]");
await page.keyboard.press("Space");
await page.waitForSelector("dialog[open]", { state: "detached" });
await page.focus(".file-area");
await page.keyboard.press("Space");
await page.waitForSelector(".image-preview");
assert.equal(
  await page.evaluate(
    () => window.previewCalls.filter((path) => path === "photo.jpg").length,
  ),
  1,
  "Reopening a fresh image preview reuses memory cache without another IPC request",
);
await close();
for (const [name, id] of [
  ["Remote S3 test", "s3-preview-test"],
  ["Remote SFTP test", "remote-preview-test"],
]) {
  await page.click(`.volume-nav button[title="${name}"]`);
  await page.waitForFunction(
    (name) =>
      document.querySelector(".pathbar")?.textContent.includes(name) &&
      document.querySelector('[data-entry-path="photo.jpg"]'),
    name,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.evaluate(
      (id) =>
        window.thumbnailCalls.filter((call) => call.volume_id === id).length,
      id,
    ),
    0,
    "Remote directory listings must never request automatic thumbnails",
  );
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll(".file-thumbnail").length,
    ),
    0,
  );
  await select("photo.jpg");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const image = document.querySelector(".image-preview");
    return image?.complete && image.naturalWidth === 40;
  });
  assert.equal(
    await page.evaluate(
      (id) =>
        window.fullPreviewCalls.filter((call) => call.volume_id === id).length,
      id,
    ),
    1,
    "Remote image contents load only when explicitly previewed",
  );
  await close();
}
console.log(
  "PASS: single/multi space preview, space closes from navigation controls and dialog body, repeats are ignored, preserved selection, JPEG rendering and repeated-open cache reuse, count and total size, no content fetch for summary, toolbar/menu, unknown/zero sizes, mixed selection, input/control/empty-selection guards, local thumbnails, no automatic S3/SFTP thumbnails, explicit remote previews, 1200px/960px layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
