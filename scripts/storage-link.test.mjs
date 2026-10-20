import assert from "node:assert/strict";
import test from "node:test";
import { storageLink, storagePath } from "../apps/desktop/src/storageLink.ts";

const locator = {
  volume_id: "3c89c7e7-cd10-4857-a17e-d98f0c677351",
  logical_path: "media/public/photo.jpeg",
  version_id: null,
};

test("storage links identify the volume and its relative file path", () => {
  assert.equal(
    storageLink(locator),
    `filo://storage/${locator.volume_id}/media/public/photo.jpeg`,
  );
  assert.notEqual(
    storageLink({ ...locator, volume_id: "another-volume" }),
    storageLink(locator),
  );
});

test("reserved characters and Unicode round-trip without changing URL structure", () => {
  const path = "照片/旅行 100%/#1?raw&copy=1.jpeg";
  const url = new URL(storageLink({ ...locator, logical_path: path }));
  assert.equal(url.protocol, "filo:");
  assert.equal(url.host, "storage");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.deepEqual(url.pathname.slice(1).split("/").map(decodeURIComponent), [
    locator.volume_id,
    ...path.split("/"),
  ]);
});

test("storage roots retain an empty relative path", () => {
  assert.equal(
    storageLink({ ...locator, logical_path: "" }),
    `filo://storage/${locator.volume_id}/`,
  );
});

test("object version IDs remain an independent encoded query parameter", () => {
  const version = "v1+/=?#&中文";
  const url = new URL(storageLink({ ...locator, version_id: version }));
  assert.equal(url.pathname, `/${locator.volume_id}/${locator.logical_path}`);
  assert.equal(url.searchParams.get("version_id"), version);
  assert.equal(url.hash, "");
});

const volume = (root) => ({ id: locator.volume_id, root });

test("local paths are absolute and preserve filename characters and case", () => {
  assert.equal(
    storagePath(volume({ type: "local", root_path: "/Volumes/Photos/" }), {
      ...locator,
      logical_path: "旅行/IMG 100% #1?.JPEG",
    }),
    "/Volumes/Photos/旅行/IMG 100% #1?.JPEG",
  );
  assert.equal(
    storagePath(volume({ type: "local", root_path: "/" }), locator),
    "/media/public/photo.jpeg",
  );
  assert.equal(
    storagePath(
      volume({ type: "local", root_path: "/Photos\\Archive" }),
      locator,
    ),
    "/Photos\\Archive/media/public/photo.jpeg",
  );
});

test("Windows drive and UNC paths retain native separators", () => {
  for (const root of ["C:\\Photos\\", "C:\\", "\\\\nas\\photos\\"]) {
    assert.equal(
      storagePath(volume({ type: "local", root_path: root }), locator),
      `${root}media\\public\\photo.jpeg`,
    );
  }
});

test("S3 paths include the bucket and full root prefix without encoding the object key", () => {
  assert.equal(
    storagePath(
      volume({ type: "s3", bucket: "photos", prefix: "archive/2026/" }),
      {
        ...locator,
        logical_path: "旅行/IMG 100% #1?.JPEG",
      },
    ),
    "s3://photos/archive/2026/旅行/IMG 100% #1?.JPEG",
  );
  assert.equal(
    storagePath(volume({ type: "s3", bucket: "photos", prefix: "" }), locator),
    "s3://photos/media/public/photo.jpeg",
  );
});

test("remote paths preserve whether the configured root is absolute or relative", () => {
  for (const root of ["/srv/photos/", "photos/", "/", ""]) {
    const expected = root
      ? `${root}${locator.logical_path}`
      : locator.logical_path;
    assert.equal(
      storagePath(volume({ type: "remote", path: root }), locator),
      expected,
    );
  }
});

test("copying root paths does not drop drive roots or add duplicate separators", () => {
  const rootLocator = { ...locator, logical_path: "" };
  for (const root of ["/", "C:\\", "\\\\nas\\photos"]) {
    assert.equal(
      storagePath(volume({ type: "local", root_path: root }), rootLocator),
      root,
    );
  }
  assert.equal(
    storagePath(
      volume({ type: "s3", bucket: "photos", prefix: "archive" }),
      rootLocator,
    ),
    "s3://photos/archive",
  );
  assert.equal(
    storagePath(volume({ type: "remote", path: "" }), rootLocator),
    ".",
  );
});
