import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = require("typescript");
const source = ts.transpileModule(
  readFileSync(
    new URL("../apps/desktop/src/appSettings.ts", import.meta.url),
    "utf8",
  ),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
function load(storage) {
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    exports: module.exports,
    require,
    localStorage: storage,
  });
  return module.exports.useAppSettings;
}
test("animation duration defaults to 500 ms and persists independently of auto-advance", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const settings = load(storage);
  assert.equal(settings.getState().reviewAnimationDuration, 500);
  settings.getState().setReviewAnimationDuration(1000);
  settings.getState().setRatingAdvanceDelay(1500);
  assert.equal(load(storage).getState().reviewAnimationDuration, 1000);
  assert.equal(load(storage).getState().ratingAdvanceDelay, 1500);
  settings.getState().setReviewAnimationDuration(-100);
  assert.equal(settings.getState().reviewAnimationDuration, 1000);
  data.set("filo.review-animation-duration", "not a number");
  assert.equal(load(storage).getState().reviewAnimationDuration, 500);
});
test("animation settings remain usable when storage is unavailable", () => {
  const settings = load({
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  });
  assert.equal(settings.getState().reviewAnimationDuration, 500);
  settings.getState().setReviewAnimationDuration(300);
  assert.equal(settings.getState().reviewAnimationDuration, 300);
});
