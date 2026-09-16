// Run with node scripts/test-error-lifecycle.mjs. Native IPC is a fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = require("typescript");
async function load(name) {
  const source = await readFile(
    new URL(`../apps/desktop/src/${name}.ts`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)(require, exports);
  return exports;
}

const { describeError } = await load("errorDiagnostics");
const details = describeError({
  message:
    'failed Authorization="Bearer private-token" password=private-password https://user:pass@example.test/?token=private-query',
  stack:
    "Error: ignored\n at load (https://user:pass@example.test/src/listing.ts?token=private-query:42:9)",
});
assert.match(details, /listing.ts:42:9/);
assert.doesNotMatch(details, /private-|user:pass|example.test/);
const circular = { message: "circular fixture" };
circular.self = circular;
assert.equal(describeError(circular), "circular fixture");
assert.equal(
  describeError({
    get message() {
      throw Error("private getter");
    },
  }),
  "无法读取异常详情",
);
assert.equal(describeError("x".repeat(10000)).length, 2000);

const listeners = new Map();
const cleaned = [];
const unhandled = [];
let sequence = 0;
let failSetup = false;
let failCleanup = false;
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
globalThis.window = {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWebview: { label: "main" },
      currentWindow: { label: "main" },
    },
    transformCallback: () => ++sequence,
    invoke: async (command, args) => {
      if (command === "plugin:event|listen") {
        if (failSetup && args.event === "tauri://drag-drop")
          throw Error("setup failure");
        listeners.set(++sequence, args);
        return sequence;
      }
      if (command === "plugin:event|unlisten") {
        cleaned.push(args.event);
        listeners.delete(args.eventId);
        if (failCleanup) throw Error("cleanup failure");
        return;
      }
      throw Error("Unexpected command " + command);
    },
  },
};
try {
  const { listenFileDrop } = await load("fileDropEvents");
  const dispose = await listenFileDrop(() => {});
  assert.equal(listeners.size, 4);
  failCleanup = true;
  await assert.rejects(dispose(), /cleanup failure/);
  assert.equal(listeners.size, 0);
  assert.equal(cleaned.length, 4);
  await dispose();
  assert.equal(cleaned.length, 4);
  failSetup = true;
  await assert.rejects(
    listenFileDrop(() => {}),
    /setup failure/,
  );
  assert.equal(listeners.size, 0);
  assert.equal(cleaned.length, 6);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, []);
  console.log(
    "PASS: async cleanup, partial setup rollback, original error, idempotent disposal, credential redaction, source locations, circular/hostile/bounded diagnostics",
  );
} finally {
  process.off("unhandledRejection", onUnhandled);
  delete globalThis.window;
}
