import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = require("typescript");
const source = await readFile(
  new URL("../apps/desktop/src/photoPreviewCache.ts", import.meta.url),
  "utf8",
);
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  })
  .outputText.replace(
    /import[^;]+from "\.\/photoApi";/,
    "const reviewApi = {};",
  );
const { PhotoPreviewCache } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const preview = (id) => ({
  mime: "image/jpeg",
  content: id,
  width: 2400,
  height: 1600,
  embedded: false,
});
const ids = Array.from({ length: 20 }, (_, i) => String(i));

function controlled() {
  const calls = [],
    decoded = [];
  const cache = new PhotoPreviewCache(
    (...args) =>
      new Promise((resolve, reject) => {
        calls.push({ args, resolve: () => resolve(preview(args[0])), reject });
      }),
    async (value) => {
      decoded.push(value.content);
      return {};
    },
  );
  return { cache, calls, decoded };
}

test("current photo starts first; a single background worker preloads the next five in navigation order", async () => {
  const { cache, calls } = controlled();
  const thumb = cache.get("thumbnail", false, true);
  cache.setWindow(
    ["a", "filtered-b", "filtered-c", "d", "e", "f", "g"],
    "a",
    false,
  );
  const current = cache.get("a");
  await tick();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ["a", "filtered-b", "thumbnail"],
  );
  calls[2].resolve();
  await thumb;
  const full = () => calls.filter((call) => !call.args[2]);
  calls[0].resolve();
  await current;
  await tick();
  assert.equal(
    full().length,
    2,
    "only one speculative preview read runs at a time",
  );
  for (let i = 1; i <= 5; i++) {
    full()[i].resolve();
    await tick();
  }
  assert.deepEqual(
    full().map((call) => call.args[0]),
    ["a", "filtered-b", "filtered-c", "d", "e", "f"],
  );
  assert.equal(cache.peek("g"), undefined);
});

test("navigating to a queued preload promotes it ahead of older speculative work and deduplicates IPC", async () => {
  const { cache, calls } = controlled();
  cache.setWindow(ids, "0", false);
  const first = cache.get("0");
  await tick();
  cache.setWindow(ids, "4", false);
  const selected = cache.get("4");
  assert.equal(cache.get("4"), selected);
  calls[0].resolve();
  await first;
  await tick();
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ["0", "1", "4"],
  );
  calls[2].resolve();
  await selected;
  assert.equal(cache.peek("4").content, "4");
  cache.clearWindow();
  calls[1].resolve();
  await tick();
  assert.equal(calls.length, 3, "obsolete queued reads are discarded");
});

test("advancing retains the previous three decoded previews and evicts photos outside the window", async () => {
  const calls = [],
    decoded = [];
  const cache = new PhotoPreviewCache(
    async (id) => {
      calls.push(id);
      return preview(id);
    },
    async (value) => {
      decoded.push(value.content);
      return {};
    },
  );
  for (let i = 0; i <= 8; i++) {
    cache.setWindow(ids, String(i), false);
    await cache.get(String(i));
    await tick();
  }
  for (const id of ["5", "6", "7", "8", "9", "10", "11", "12", "13"])
    assert.ok(cache.peek(id), id);
  assert.equal(cache.peek("4"), undefined);
  const before = calls.length;
  for (const id of ["7", "6", "5"]) await cache.get(id);
  assert.equal(
    calls.length,
    before,
    "going back three photos needs no IPC or decode",
  );
  assert.equal(decoded.filter((id) => id === "5").length, 1);
});

test("jumping and changing RAW mode discard stale work without repopulating the cache", async () => {
  const { cache, calls, decoded } = controlled();
  cache.setWindow(ids, "0", false);
  const old = cache.get("0");
  await tick();
  cache.setWindow(ids, "10", true);
  const selected = cache.get("10", false, false, true);
  calls[0].resolve();
  await old;
  await tick();
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["0", false, false, false],
      ["1", false, false, false],
      ["10", false, false, true],
    ],
  );
  calls[1].resolve();
  calls[2].resolve();
  await selected;
  await tick();
  assert.equal(cache.peek("0"), undefined);
  assert.equal(cache.peek("1"), undefined);
  assert.equal(cache.peek("10"), undefined);
  assert.equal(cache.peek("10", false, false, true).content, "10");
  assert.deepEqual(decoded, ["10"]);
  cache.clearWindow();
  calls[3].resolve();
  await tick();
  assert.equal(cache.peek("11", false, false, true), undefined);
});

test("failed preloads can be retried when selected and decoded memory has a bound", async () => {
  let failed = false;
  const cache = new PhotoPreviewCache(
    async (id) => {
      if (id === "1" && !failed) {
        failed = true;
        throw new Error("offline");
      }
      return {
        ...preview(id),
        width: id === "huge" ? 24000 : 2400,
        height: id === "huge" ? 24000 : 1600,
      };
    },
    async () => ({}),
  );
  cache.setWindow(["0", "1"], "0", false);
  await cache.get("0");
  await tick();
  assert.equal(cache.peek("1"), undefined);
  assert.equal((await cache.get("1")).content, "1");
  cache.setWindow(["huge"], "huge", false);
  await cache.get("huge");
  assert.equal(cache.peek("huge"), undefined);
});

test("thumbnail cache pressure does not evict retained main previews", async () => {
  const cache = new PhotoPreviewCache(
    async (id, _original, thumbnail) => ({
      ...preview(id),
      content: thumbnail ? "x".repeat(128 * 1024) : id,
    }),
    async () => ({}),
  );
  cache.setWindow(["current"], "current", false);
  await cache.get("current");
  for (let i = 0; i < 90; i++) await cache.get(`thumb-${i}`, false, true);
  assert.ok(cache.peek("current"));
  assert.equal(cache.peek("thumb-0", false, true), undefined);
  assert.ok(cache.peek("thumb-89", false, true));
});

test("debug state updates after decoding and eviction, and ignores thumbnail-only cache entries", async () => {
  let finishDecode;
  const cache = new PhotoPreviewCache(
    async (id) => preview(id),
    () =>
      new Promise((resolve) => {
        finishDecode = () => resolve({});
      }),
  );
  cache.setWindow(["current"], "current", false);
  const states = [cache.state("current", false)];
  const unsubscribe = cache.subscribe(() =>
    states.push(cache.state("current", false)),
  );
  const current = cache.get("current");
  await tick();
  assert.equal(
    cache.state("current", false),
    "pending",
    "IPC data alone is not ready",
  );
  await cache.get("thumbnail-only", false, true);
  assert.equal(cache.state("thumbnail-only", false), "empty");
  finishDecode();
  await current;
  await tick();
  assert.equal(cache.state("current", false), "ready");
  assert.equal(
    cache.state("current", true),
    "empty",
    "RAW has separate cache state",
  );
  cache.setWindow(["next"], "next", false);
  assert.deepEqual(states, ["empty", "pending", "ready", "empty"]);
  unsubscribe();
  cache.clearWindow();
  assert.equal(states.length, 4);
});
