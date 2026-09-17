// Run with Vite running: ego-browser nodejs < scripts/test-syntax-preview.mjs
// IPC fixtures affect only this page; no real files are read or modified.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo syntax preview regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    window.previewCalls = [];
    const volume = {
      id: 'preview-test', connection_id: 'preview-test', name: 'Preview test',
      read_only: false, root: { type: 'local', root_path: '/preview-test' },
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
        window.previewCalls.push(args.locator.logical_path);
        return { kind: 'text', mime: 'text/plain', content: window.syntaxFixtures[args.locator.logical_path], truncated: args.locator.logical_path === 'large.js' };
      }
      if (command === 'list_entries_page') {
        const entries = Object.keys(window.syntaxFixtures).map(name => ({ name, kind: 'file', size: 1024 })).map(entry => ({ ...entry, modified_at: null, locator: {
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
const fixtures = {
  "sample.tsx":
    'const title: string = "你好";\nexport const App = () => <div>{title}</div>;\n',
  "Cargo.toml": '[package]\nname = "filo"\nversion = "0.1.0"\n',
  Dockerfile: "FROM node:22\nRUN echo hello\n",
  "payload.html":
    '<script>window.syntaxInjected = true</script><img src=x onerror="window.syntaxInjected=true">',
  "notes.txt": "<b>普通文本 & 原样显示</b>\n",
  "unknown.xyz": "const value = 42;\n",
  "large.js": "// large preview\n" + "const value = 42;\n".repeat(13000),
};
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.syntaxFixtures = ${JSON.stringify(fixtures)};`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/preview-test"]');
await page.click('.volume-nav button[title="/preview-test"]');
await page.waitForSelector('[data-entry-path="sample.tsx"]');

for (const [name, content] of Object.entries(fixtures)) {
  await page.click(`tr[data-entry-path="${name}"] .file-name`);
  await page.keyboard.press("Space");
  await page.waitForSelector(".text-preview code");
  const highlighted = !["notes.txt", "unknown.xyz", "large.js"].includes(name);
  if (highlighted)
    await page.waitForSelector('.text-preview code [class^="hljs-"]');
  assert.equal(
    await page.evaluate(
      () => document.querySelector(".text-preview").textContent,
    ),
    content,
  );
  assert.equal(await page.evaluate(() => !!window.syntaxInjected), false);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelectorAll(".text-preview script, .text-preview img")
          .length,
    ),
    0,
  );
  if (!highlighted) {
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll(".text-preview span").length,
      ),
      0,
    );
  }
  if (name === "large.js") {
    assert.match(
      await page.evaluate(() => document.querySelector("dialog").textContent),
      /仅预览前 1 MiB/,
    );
  }
  if (name === "sample.tsx") {
    assert.notEqual(
      await page.evaluate(
        () => getComputedStyle(document.querySelector(".hljs-keyword")).color,
      ),
      await page.evaluate(
        () => getComputedStyle(document.querySelector(".text-preview")).color,
      ),
    );
    for (const width of [1200, 960]) {
      await page.cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await page.evaluate(() => {
          const dialog = document.querySelector("dialog");
          const rect = dialog.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            dialog.scrollWidth <= dialog.clientWidth
          );
        }),
        true,
      );
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog[open]", { state: "detached" });
}
console.log(
  "PASS: TSX/TOML/Dockerfile/HTML highlighting, escaped HTML, exact source preservation, plain/unknown/large fallback, truncation notice, 1200/960px layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
