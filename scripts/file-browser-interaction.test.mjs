import assert from "node:assert/strict";
import test from "node:test";
import {
  destinationFor,
  isInsideSource,
  pasteBlockReason,
} from "../apps/desktop/src/fileClipboard.ts";

const sourceVolume = {
  id: "local-a",
  connection_id: "connection-a",
  name: "本地文件",
  read_only: false,
  root: { type: "local", root_path: "/tmp" },
  capabilities: {
    hierarchy: "native_directory",
    rename: "atomic",
    create_directory: true,
    write: true,
    delete: true,
    trash: true,
    native_open: true,
    native_copy: false,
  },
};

const entry = (logicalPath, kind = "file", volumeId = "local-a") => ({
  locator: { volume_id: volumeId, logical_path: logicalPath, version_id: null },
  name: logicalPath.split("/").at(-1),
  kind,
  size: 1,
  modified_at: null,
});

test("paste destination preserves the destination volume and appends the name", () => {
  const parent = {
    volume_id: "remote-a",
    logical_path: "incoming/today",
    version_id: null,
  };
  assert.deepEqual(
    destinationFor(entry("docs/readme.md", "file", "local-a"), parent),
    {
      ...parent,
      logical_path: "incoming/today/readme.md",
    },
  );
});

test("folder paste blocks the source folder and every descendant", () => {
  const folder = entry("projects/demo", "directory");
  assert.equal(
    isInsideSource(folder, {
      volume_id: "local-a",
      logical_path: "projects/demo",
      version_id: null,
    }),
    true,
  );
  assert.equal(
    pasteBlockReason(
      { mode: "copy", entries: [folder] },
      {
        volume_id: "local-a",
        logical_path: "projects/demo/build",
        version_id: null,
      },
      sourceVolume,
    ),
    "不能将文件夹粘贴到自身或其子目录",
  );
});

test("copying a file onto its current path remains available to conflict policy", () => {
  const file = entry("docs/readme.md");
  assert.equal(
    pasteBlockReason(
      { mode: "copy", entries: [file] },
      { volume_id: "local-a", logical_path: "docs", version_id: null },
      sourceVolume,
    ),
    null,
  );
});

test("paste checks both the read-only flag and provider write capability", () => {
  const file = entry("docs/readme.md");
  const destination = {
    volume_id: "local-a",
    logical_path: "incoming",
    version_id: null,
  };
  assert.equal(
    pasteBlockReason({ mode: "copy", entries: [file] }, destination, {
      ...sourceVolume,
      read_only: true,
    }),
    "当前目录为只读，无法粘贴",
  );
  assert.equal(
    pasteBlockReason({ mode: "copy", entries: [file] }, destination, {
      ...sourceVolume,
      capabilities: { ...sourceVolume.capabilities, write: false },
    }),
    "当前目录不支持写入，无法粘贴",
  );
});

test("symlinks remain excluded from clipboard transfers", () => {
  assert.equal(
    pasteBlockReason(
      { mode: "cut", entries: [entry("docs/current", "symlink")] },
      { volume_id: "remote-a", logical_path: "incoming", version_id: null },
      sourceVolume,
    ),
    "符号链接不能粘贴",
  );
});
