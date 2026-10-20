import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = require("typescript");
const source = await readFile(
  new URL("../apps/desktop/src/observeResize.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { observeResize } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

function setup(t) {
  const frames = new Map();
  const observers = [];
  let sequence = 0;
  const original = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  globalThis.ResizeObserver = class {
    targets = [];
    disconnected = false;
    constructor(deliver) {
      this.deliver = deliver;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  globalThis.requestAnimationFrame = (callback) => {
    const id = sequence++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  t.after(() => Object.assign(globalThis, original));
  return {
    frames,
    observers,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

test("resize updates run outside observer delivery and use the latest layout once per frame", (t) => {
  const { frames, observers, flush } = setup(t);
  const area = { width: 100 };
  const header = {};
  const widths = [];
  const stop = observeResize([area, header], () => widths.push(area.width));
  assert.deepEqual(observers[0].targets, [area, header]);
  observers[0].deliver();
  area.width = 200;
  observers[0].deliver();
  observers[0].deliver();
  assert.deepEqual(widths, []);
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(widths, [200]);
  area.width = 300;
  observers[0].deliver();
  flush();
  assert.deepEqual(widths, [200, 300]);
  stop();
});

test("disposal cancels a pending layout update, including animation frame ID zero", (t) => {
  const { frames, observers, flush } = setup(t);
  let updates = 0;
  const stop = observeResize([{}], () => updates++);
  observers[0].deliver();
  assert.equal(frames.has(0), true);
  stop();
  stop();
  assert.equal(observers[0].disconnected, true);
  assert.equal(frames.size, 0);
  flush();
  assert.equal(updates, 0);
});

test("real update failures remain visible and do not prevent subsequent updates", (t) => {
  const { observers, flush } = setup(t);
  const stop = observeResize([{}], () => {
    throw new Error("layout failure");
  });
  observers[0].deliver();
  assert.throws(flush, /layout failure/);
  observers[0].deliver();
  assert.throws(flush, /layout failure/);
  stop();
});
