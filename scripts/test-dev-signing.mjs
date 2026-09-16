// macOS smoke test using the existing signing certificate. All build artifacts
// stay in a disposable Cargo project; Filo and its database are never opened.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("SKIP: development signing requires macOS");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "filo dev signing-"));
const runner = join(root, "scripts/dev-runner.sh");
const config = `target.${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.runner=${JSON.stringify(["/bin/sh", runner])}`;
const original = join(fixture, "target/debug/signing-fixture");
const bundle = join(fixture, "target/debug/dev-bundle/Filo.app");
const signed = join(bundle, "Contents/MacOS/signing-fixture");
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: fixture,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, FILO_DEV_NODE: process.execPath },
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}
function succeed(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function requirement() {
  const result = command("/usr/bin/codesign", ["-d", "-r-", bundle]);
  succeed(result);
  return `${result.stdout}\n${result.stderr}`.match(/designated => .+/)?.[0];
}
function source(version) {
  writeFileSync(
    join(fixture, "src/main.rs"),
    `fn main() {
    println!("${version}: {:?}", std::env::args().skip(1).collect::<Vec<_>>());
    if std::env::args().any(|v| v == "fail") { std::process::exit(23); }
  }`,
  );
}
try {
  // Exercise the public dev entry without launching a second desktop app or
  // competing with the main task's Vite server.
  const fakeBin = join(fixture, "bin");
  const invocation = join(fixture, "invocation.json");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "pnpm"),
    `#!${process.execPath}
require("node:fs").writeFileSync(process.env.FILO_TEST_INVOCATION, JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o755 },
  );
  succeed(
    command(
      process.execPath,
      [
        join(root, "scripts/dev.mjs"),
        "--",
        "--no-watch",
        "--",
        "--offline",
        "--",
        "argument with spaces",
      ],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FILO_TEST_INVOCATION: invocation,
        },
      },
    ),
  );
  const args = JSON.parse(readFileSync(invocation, "utf8"));
  assert.deepEqual(args.slice(0, 6), [
    "--filter",
    "@filo/desktop",
    "tauri",
    "dev",
    "--no-watch",
    "--",
  ]);
  assert.equal(args[6], "--config");
  assert.match(args[7], /target\.aarch64-apple-darwin\.runner=/);
  assert.match(args[9], /target\.x86_64-apple-darwin\.runner=/);
  assert.deepEqual(args.slice(10), ["--offline", "--", "argument with spaces"]);

  mkdirSync(join(fixture, "src"));
  writeFileSync(
    join(fixture, "Cargo.toml"),
    '[package]\nname="signing-fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n',
  );
  source("first");
  succeed(command("cargo", ["build", "--offline"]));
  const originalHash = hash(original);
  const first = succeed(
    command("cargo", [
      "run",
      "--offline",
      "--config",
      config,
      "--",
      "argument with spaces",
    ]),
  );
  assert.match(first, /first: \["argument with spaces"\]/);
  assert.equal(
    hash(original),
    originalHash,
    "signing must not modify Cargo's artifact",
  );
  const firstRequirement = requirement();
  assert.match(
    firstRequirement,
    /identifier "dev\.filo\.desktop" and certificate/,
  );
  const firstSignedHash = hash(signed);

  source("second");
  const second = succeed(
    command("cargo", ["run", "--offline", "--config", config]),
  );
  assert.match(second, /second: \[\]/);
  assert.notEqual(hash(signed), firstSignedHash);
  assert.equal(
    requirement(),
    firstRequirement,
    "rebuilds must preserve the signing requirement",
  );
  succeed(
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]),
  );
  const plist = succeed(
    command("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      join(bundle, "Contents/Info.plist"),
    ]),
  );
  assert.equal(plist.trim(), "dev.filo.desktop");

  const failedApp = command("/bin/sh", [runner, original, "fail"]);
  assert.equal(
    failedApp.status,
    23,
    "runner must preserve the application's exit code",
  );
  for (const identity of ["-", "Filo nonexistent test certificate"]) {
    const result = command("/bin/sh", [runner, original], {
      env: {
        ...process.env,
        FILO_DEV_NODE: process.execPath,
        APPLE_SIGNING_IDENTITY: identity,
      },
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stdout,
      /second:/,
      "signing failure must prevent launching the app",
    );
  }
  console.log(
    "PASS: dev entry forwarding, Cargo runner, spaced paths and args, stable signing across rebuilds, untouched Cargo artifact, strict verification, exit status, and signing failures",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
