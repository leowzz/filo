import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const ts = require("typescript");
const source = (file) =>
  ts.transpileModule(
    readFileSync(
      new URL(`../apps/desktop/src/${file}.ts`, import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
const favoritesSource = source("folderFavorites");
const browserSource = source("store");
const key = "filo.folder-favorites";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
function load(localStorage) {
  const favorites = { exports: {} };
  runInNewContext(favoritesSource, {
    module: favorites,
    exports: favorites.exports,
    require,
    localStorage,
  });
  const browser = { exports: {} };
  runInNewContext(browserSource, {
    module: browser,
    exports: browser.exports,
    localStorage,
    require: (name) =>
      name === "./folderFavorites" ? favorites.exports : require(name),
  });
  return {
    favorites: favorites.exports.useFolderFavorites,
    browser: browser.exports.useBrowser,
  };
}
const folder = { volumeId: "local", path: "照片/旅行", name: "旅行" };

test("reordering preserves every shortcut and persists moves to the beginning, middle and end", () => {
  const disk = storage();
  const { favorites } = load(disk);
  const items = ["A", "B", "C", "D"].map((name) => ({
    ...folder,
    path: name,
    name,
  }));
  items.forEach((item) => favorites.getState().toggle(item));
  const order = () =>
    Array.from(
      load(disk).favorites.getState().favorites,
      (item) => item.name,
    ).join("");
  favorites.getState().move(items[3], items[0]);
  assert.equal(order(), "DABC");
  favorites.getState().move(items[0], null);
  assert.equal(order(), "DBCA");
  favorites.getState().move(items[0], items[2]);
  assert.equal(order(), "DBAC");
  favorites.getState().move(items[1], items[1]);
  favorites.getState().move({ ...folder, path: "missing" }, null);
  favorites.getState().move(items[0], { ...folder, path: "missing" });
  assert.equal(order(), "DBAC");
});

test("favorites survive a reload, distinguish volumes and toggle without duplicates", () => {
  const disk = storage();
  let state = load(disk).favorites.getState();
  state.toggle(folder);
  state.toggle({ ...folder, volumeId: "nas" });
  state = load(disk).favorites.getState();
  assert.equal(state.favorites.length, 2);
  assert.equal(state.favorites[0].path, folder.path);
  state.toggle({ ...folder, name: "旅行的新名称" });
  state = load(disk).favorites.getState();
  assert.equal(state.favorites.length, 1);
  assert.equal(state.favorites[0].volumeId, "nas");
  state.remove({ ...folder, volumeId: "nas" });
  assert.equal(load(disk).favorites.getState().favorites.length, 0);
});

test("removing a volume or changing its root clears only its shortcuts on disk", () => {
  for (const action of ["removeVolume", "resetVolumeRoot"]) {
    const disk = storage();
    const { favorites, browser } = load(disk);
    favorites.getState().toggle(folder);
    favorites.getState().toggle({ ...folder, path: "", name: "根目录" });
    favorites.getState().toggle({ ...folder, volumeId: "nas" });
    browser.getState()[action]("local");
    const saved = load(disk).favorites.getState().favorites;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].volumeId, "nas");
  }
});

test("damaged saved data is ignored and duplicate shortcuts are removed", () => {
  const disk = storage();
  disk.setItem(key, "broken json");
  assert.equal(load(disk).favorites.getState().favorites.length, 0);
  disk.setItem(
    key,
    JSON.stringify([null, {}, folder, folder, { ...folder, path: 42 }]),
  );
  assert.equal(load(disk).favorites.getState().favorites.length, 1);
});

test("restricted storage still allows pinning and removing for the current session", () => {
  const disk = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("full");
    },
  };
  const { favorites } = load(disk);
  favorites.getState().toggle(folder);
  assert.equal(favorites.getState().favorites.length, 1);
  favorites.getState().remove(folder);
  assert.equal(favorites.getState().favorites.length, 0);
});
