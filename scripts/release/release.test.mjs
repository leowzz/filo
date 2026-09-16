import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkVersions,
  compareVersions,
  parseVersion,
  readEnvVersion,
  root,
  setEnvVersion,
  setVersions,
  versionFiles,
} from "./version.mjs";
import { release } from "./release.mjs";
import { validateSigning } from "./signing.mjs";
import {
  assetNames,
  collectArtifacts,
  sha256,
  targets,
  updaterManifest,
  verifyArtifacts,
} from "./artifacts.mjs";
import { publish, sameAssets, shouldPromote } from "./publish.mjs";

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "filo-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const dir = temporary(t);
  for (const file of versionFiles) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
  }
  // Only source-less Cargo packages belong to this workspace.
  const lock = readFileSync(join(dir, "Cargo.lock"), "utf8");
  for (const block of lock.split("[[package]]").slice(1)) {
    if (/^source = /m.test(block)) continue;
    const name = block.match(/^name = "([^"]+)"/m)[1];
    const file =
      name === "filo-desktop"
        ? "apps/desktop/src-tauri/Cargo.toml"
        : `crates/${name}/Cargo.toml`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(
      join(dir, file),
      `[package]\nname = "${name}"\nversion.workspace = true\n`,
    );
  }
  writeFileSync(
    join(dir, ".env"),
    readFileSync(join(dir, ".env.example"), "utf8") + "LOCAL_SETTING=keep-me\n",
  );
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Release Test");
  git(dir, "config", "user.email", "release-test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}
test("strict versions and ordered prereleases", () => {
  for (const invalid of [
    "01.0.0",
    "1.0",
    "1.2.3-rc.0",
    "1.2.3-rc.01",
    "1.2.3+meta",
    "1.2.3 ",
  ])
    assert.throws(() => parseVersion(invalid));
  const ordered = [
    "1.0.0-alpha.9",
    "1.0.0-beta.1",
    "1.0.0-rc.2",
    "1.0.0-rc.10",
    "1.0.0",
    "1.0.1",
  ];
  for (let i = 1; i < ordered.length; i++)
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
});
test("mixed env retains unrelated configuration, rejects malformed/duplicate lines", () => {
  assert.equal(
    setEnvVersion("# hello\nversion=v1.0.0\nSECRET=unchanged\n", "v1.0.1"),
    "# hello\nversion=v1.0.1\nSECRET=unchanged\n",
  );
  for (const text of [
    "",
    "version =v1.0.0",
    " version=v1.0.0",
    "version=v1.0.0 ",
    "version='v1.0.0'",
    "version=v1.0.0\nversion=v1.0.1",
    "version=v1.0.0\nexport version=v1.0.1",
  ])
    assert.throws(() => readEnvVersion(text));
});
test("release commits only versions, preserves env and tags without pushing", (t) => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, "Cargo.lock"), "utf8")
    .split("[[package]]")
    .filter((b) => /^source = /m.test(b));
  const current = checkVersions(dir);
  const tag = release(dir, undefined, undefined);
  assert.equal(
    tag,
    `v${current.parts[0]}.${current.parts[1]}.${current.parts[2] + 1n}`,
  );
  assert.equal(git(dir, "cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(git(dir, "status", "--porcelain"), "");
  assert.match(
    readFileSync(join(dir, ".env"), "utf8"),
    /LOCAL_SETTING=keep-me/,
  );
  assert.deepEqual(
    readFileSync(join(dir, "Cargo.lock"), "utf8")
      .split("[[package]]")
      .filter((b) => /^source = /m.test(b)),
    before,
  );
  checkVersions(dir, tag);
});
test("rejects dirty and untracked trees, duplicate tag and downgrade before mutation", (t) => {
  const dir = fixture(t);
  const version = checkVersions(dir);
  writeFileSync(join(dir, "untracked"), "work");
  assert.throws(() => release(dir, "v9.0.0"), /工作区/);
  rmSync(join(dir, "untracked"));
  git(dir, "tag", "-a", "v9.0.0", "-m", "already exists");
  assert.throws(() => release(dir, "v9.0.0"), /tag 已存在/);
  assert.throws(() => release(dir, "v0.0.0"), /低于/);
  assert.equal(checkVersions(dir).tag, version.tag);
  assert.equal(git(dir, "status", "--porcelain"), "");
});
test("version mismatch fails; explicit prereleases and same-version first tags work", (t) => {
  const dir = fixture(t);
  const current = checkVersions(dir);
  writeFileSync(join(dir, ".env"), "version=v9.0.0\n");
  assert.throws(() => checkVersions(dir), /不一致/);
  writeFileSync(join(dir, ".env"), `version=${current.tag}\n`);
  assert.equal(release(dir, current.tag), current.tag);
  release(dir, "v9.0.0", "2");
  assert.throws(() => release(dir), /预发布必须/);
  assert.throws(() => release(dir, "v9.0.0-beta.1", "3"), /RC/);
  assert.equal(release(dir, "v9.0.0", "10"), "v9.0.0-rc.10");
  assert.equal(release(dir, "v9.0.0"), "v9.0.0");
});
test("ENV_FILE is honored on read, write and check", (t) => {
  const dir = fixture(t);
  const old = process.env.ENV_FILE;
  t.after(() =>
    old === undefined
      ? delete process.env.ENV_FILE
      : (process.env.ENV_FILE = old),
  );
  process.env.ENV_FILE = join(dir, "alternate.env");
  writeFileSync(
    process.env.ENV_FILE,
    `version=${checkVersions(dir).tag}\nOTHER=preserved\n`,
  );
  setVersions("v9.0.0-rc.1", dir);
  assert.match(readFileSync(process.env.ENV_FILE, "utf8"), /OTHER=preserved/);
  assert.equal(checkVersions(dir).tag, "v9.0.0-rc.1");
});
test("updater signing required, Apple groups all-or-none, notarization requires Developer ID", () => {
  assert.throws(() => validateSigning({}, "win32"), /TAURI_SIGNING/);
  const basic = { TAURI_SIGNING_PRIVATE_KEY: "test" };
  validateSigning(basic, "darwin");
  assert.throws(
    () => validateSigning({ ...basic, APPLE_ID: "test" }, "darwin"),
    /不完整/,
  );
  assert.throws(
    () =>
      validateSigning(
        {
          ...basic,
          APPLE_ID: "test",
          APPLE_PASSWORD: "test",
          APPLE_TEAM_ID: "test",
        },
        "darwin",
      ),
    /公证需要/,
  );
  assert.throws(
    () => validateSigning({ ...basic, APPLE_CERTIFICATE: "test" }, "darwin"),
    /不完整/,
  );
});
function assets(t) {
  const dir = temporary(t);
  for (const target of targets) {
    for (const name of assetNames("1.2.3", target)) {
      writeFileSync(join(dir, name), `fixture ${name}`);
      writeFileSync(
        join(dir, `${name}.sha256`),
        `${sha256(join(dir, name))}  ${name}\r\n`,
      );
    }
  }
  return dir;
}
test("artifacts, hashes and manifest cover every supported platform", (t) => {
  const dir = assets(t);
  assert.equal(verifyArtifacts(dir, "1.2.3").length, 10);
  const manifest = updaterManifest(dir, "1.2.3", "leowzz/filo");
  assert.equal(Object.keys(manifest.platforms).length, 3);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    manifest.platforms["darwin-x86_64"].url,
  );
  assert.match(
    manifest.platforms["darwin-aarch64"].url,
    /v1.2.3\/.*\.app.tar.gz$/,
  );
  assert.equal(
    manifest.platforms["windows-x86_64"].signature,
    "fixture Filo_1.2.3_x64-setup.exe.sig",
  );
  writeFileSync(join(dir, "Filo_1.2.3_x64-setup.exe"), "tampered");
  assert.throws(() => verifyArtifacts(dir, "1.2.3"), /SHA-256/);
});
test("missing or stale artifacts fail; prereleases never promote stable channel", (t) => {
  const dir = assets(t);
  rmSync(join(dir, "Filo_1.2.3_x64-setup.exe.sig"));
  assert.throws(() => verifyArtifacts(dir, "1.2.3"), /不完整/);
  assert.throws(
    () => collectArtifacts(temporary(t), temporary(t), "1.2.3", targets[0]),
    /预期唯一/,
  );
  assert.equal(shouldPromote("v1.2.4-rc.1", "v1.2.3"), false);
  assert.equal(shouldPromote("v1.2.2", "v1.2.3"), false);
  assert.equal(shouldPromote("v1.2.4", "v1.2.3"), true);
  assert.equal(sameAssets(["a", "b"], ["b", "a"]), true);
  assert.equal(sameAssets(["a", "b"], ["a"]), false);
});
test("draft publication resumes, preserves notes and verifies remote hashes before publishing", (t) => {
  const dir = assets(t);
  const data = {
    draft: true,
    body: "Preserve existing release notes",
    created_at: "2026-01-01T00:00:00Z",
    assets: [],
  };
  const commands = [];
  const execute = (_command, args) => {
    commands.push(args);
    if (args[1] === "upload")
      data.assets = readdirSync(dir).map((name) => ({
        name,
        digest: `sha256:${sha256(join(dir, name))}`,
      }));
  };
  publish(
    {
      RELEASE_TAG: "v1.2.3",
      GITHUB_REPOSITORY: "leowzz/filo",
      RELEASE_ASSETS: dir,
    },
    (_repo, path) => (path === "latest" ? { tag_name: "v1.2.4" } : data),
    execute,
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, "latest.json"))).notes,
    data.body,
  );
  assert.deepEqual(
    commands.map((args) => args[1]),
    ["upload", "edit"],
  );
  assert.ok(commands[1].includes("--latest=false"));
  assert.ok(commands.every((args) => !args.includes("--notes")));
});
test("published retry accepts identical bytes and rejects changed assets without uploading", (t) => {
  const dir = assets(t);
  const data = {
    draft: false,
    body: "notes",
    created_at: "2026-01-01T00:00:00Z",
    assets: [],
  };
  const env = {
    RELEASE_TAG: "v1.2.3",
    GITHUB_REPOSITORY: "leowzz/filo",
    RELEASE_ASSETS: dir,
  };
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify(
      updaterManifest(dir, "1.2.3", "leowzz/filo", data.body, data.created_at),
      null,
      2,
    ) + "\n",
  );
  data.assets = readdirSync(dir).map((name) => ({ name }));
  const commands = [];
  const execute = (_command, args) => {
    commands.push(args[1]);
    const dest = args[args.indexOf("--dir") + 1];
    for (const name of readdirSync(dir))
      copyFileSync(join(dir, name), join(dest, name));
  };
  publish(env, () => data, execute);
  assert.deepEqual(commands, ["download"]);
  assert.throws(
    () =>
      publish(
        env,
        () => data,
        (command, args) => {
          execute(command, args);
          writeFileSync(
            join(args[args.indexOf("--dir") + 1], "latest.json"),
            "different",
          );
        },
      ),
    /拒绝覆盖/,
  );
  assert.ok(!commands.includes("upload"));
});
test("remote upload with missing hash stays draft", (t) => {
  const dir = assets(t);
  const data = {
    draft: true,
    body: "notes",
    created_at: "2026-01-01T00:00:00Z",
    assets: [],
  };
  let edited = false;
  assert.throws(
    () =>
      publish(
        {
          RELEASE_TAG: "v1.2.3",
          GITHUB_REPOSITORY: "leowzz/filo",
          RELEASE_ASSETS: dir,
        },
        () => data,
        (_cmd, args) => {
          if (args[1] === "upload")
            data.assets = readdirSync(dir).map((name) => ({
              name,
              digest: null,
            }));
          if (args[1] === "edit") edited = true;
        },
      ),
    /SHA-256/,
  );
  assert.equal(edited, false);
});
