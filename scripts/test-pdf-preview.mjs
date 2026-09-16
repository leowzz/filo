// Run with Vite running: ego-browser nodejs < scripts/test-pdf-preview.mjs
// IPC and missing runtime APIs are simulated only in this test page/workers.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo PDF compatibility regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");

// Two pages with different solid fills verify completed rendering, without fonts.
const streams = ["1 0 0 rg 0 0 200 200 re f", "0 0 1 rg 0 0 200 200 re f"];
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  ...[5, 6].map(
    (id) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents ${id} 0 R >>`,
  ),
  ...streams.map(
    (stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ),
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
pdf += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join("");
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    delete Map.prototype.getOrInsertComputed;
    delete WeakMap.prototype.getOrInsertComputed;
    window.pdfCompatibility = { missingInitially: typeof Map.prototype.getOrInsertComputed === 'undefined', workers: [] };
    window.pdfPreviewRequests = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const workerUrl = new URL(url, location.href).href;
        const source = 'delete Map.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsertComputed; await import(' + JSON.stringify(workerUrl) + ');';
        const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        super(blobUrl, options);
        window.pdfCompatibility.workers.push(workerUrl);
        this.addEventListener('message', () => URL.revokeObjectURL(blobUrl), { once: true });
      }
    };
    window.isTauri = true;
    const volume = {
      id: 'pdf-test', connection_id: 'pdf-test', name: 'PDF test', read_only: true,
      root: { type: 'local', root_path: '/pdf-test' },
      capabilities: { hierarchy: 'native_directory', rename: 'unsupported', create_directory: false,
        delete: false, trash: false, native_open: true, native_copy: false }
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command) => {
        if (command === 'recent_backend_errors' || command === 'list_transfers') return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'plugin:event|unlisten') return;
        if (command === 'list_volumes') return [volume];
        if (command === 'directory_stamp') return '1';
        if (command === 'list_entries_page') return { entries: [{
          name: 'compatibility.pdf', kind: 'file', size: ${pdf.length}, modified_at: null,
          locator: { volume_id: volume.id, logical_path: 'compatibility.pdf', version_id: null }
        }], total: 1, next_cursor: null };
        if (command === 'preview_entry') { window.pdfPreviewRequests++; return {
          kind: 'pdf', mime: 'application/pdf', content: ${JSON.stringify(Buffer.from(pdf).toString("base64"))}, truncated: false
        }; }
        throw new Error('Unexpected test IPC: ' + command);
      }
    };
  })();`,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/pdf-test"]');
await page.click('.volume-nav button[title="/pdf-test"]');
await page.waitForSelector('[data-entry-path="compatibility.pdf"]');
assert.equal(
  await page.evaluate(() => window.pdfCompatibility.missingInitially),
  true,
);
await page.click('[data-entry-path="compatibility.pdf"] .file-name');
await page.keyboard.press("Space");

async function expectPage(number, rgb) {
  await page.waitForFunction(
    ({ number, rgb }) => {
      if (document.querySelector("dialog [role=alert]")) return true;
      const canvas = document.querySelector("canvas.pdf-preview");
      if (!canvas || !canvas.width || !canvas.height) return false;
      const pixel = canvas.getContext("2d").getImageData(50, 50, 1, 1).data;
      return (
        document.querySelector(".preview-pages span")?.textContent.trim() ===
          `${number} / 2` && rgb.every((value, index) => pixel[index] === value)
      );
    },
    { number, rgb },
  );
  assert.equal(
    await page.evaluate(
      () => document.querySelector("dialog [role=alert]")?.textContent ?? null,
    ),
    null,
  );
}

await expectPage(1, [255, 0, 0]);
const initialWorkers = await page.evaluate(
  () => window.pdfCompatibility.workers.length,
);
await page.click('.preview-pages button:text-is("下一页")');
await expectPage(2, [0, 0, 255]);
await page.click('.preview-pages button:text-is("上一页")');
await expectPage(1, [255, 0, 0]);
assert.equal(
  await page.evaluate(() => window.pdfCompatibility.workers.length),
  initialWorkers,
  "Page changes reuse the loaded document and worker",
);
assert.ok(
  await page.evaluate(() => window.pdfCompatibility.workers.length > 0),
  "Uses a real PDF worker",
);
await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });
await page.click('button[aria-label="预览"]');
await expectPage(1, [255, 0, 0]);
assert.equal(
  await page.evaluate(() => window.pdfPreviewRequests),
  1,
  "Reopening an unchanged preview reuses downloaded contents",
);
await page.keyboard.press("Escape");
await page.waitForSelector("dialog[open]", { state: "detached" });
await page.click('button[aria-label="刷新"]');
await page.click('button[aria-label="预览"]');
await expectPage(1, [255, 0, 0]);
assert.equal(
  await page.evaluate(() => window.pdfPreviewRequests),
  2,
  "Explicit refresh invalidates cached preview contents",
);
console.log(
  "PASS: PDF rendering, document/worker reuse across pages, cached reopen, refresh invalidation, compatibility with missing getOrInsertComputed in main and worker runtimes",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
