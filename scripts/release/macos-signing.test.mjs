import assert from "node:assert/strict";
import { test } from "node:test";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { rootCertificates } from "node:tls";
import { withMacSigning } from "./macos-signing.mjs";

// Public CA certificate used only as an X509 parser fixture; commands are mocked.
const pem = rootCertificates.find((value) => {
  const cert = new X509Certificate(value);
  return (
    cert.subject === cert.issuer &&
    cert.verify(cert.publicKey) &&
    Date.parse(cert.validFrom) < Date.now() &&
    Date.parse(cert.validTo) > Date.now()
  );
});
const fingerprint = new X509Certificate(pem).fingerprint.replaceAll(":", "");
const env = {
  APPLE_CERTIFICATE: Buffer.from("test P12").toString("base64"),
  APPLE_CERTIFICATE_PASSWORD: "test password",
  APPLE_SIGNING_IDENTITY: fingerprint,
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
};

function mock(failAt) {
  const calls = [];
  const command = (name, args) => {
    calls.push([name, ...args]);
    if (args.includes(failAt)) throw new Error("injected failure");
    if (args[0] === "list-keychains" && !args.includes("-s"))
      return '"/original.keychain-db"\n';
    if (args[0] === "find-certificate") return pem;
    if (args[0] === "find-identity") return fingerprint;
    return "";
  };
  return { command, calls };
}

test("failed certificate import restores the search list and deletes temporary files", () => {
  const { command, calls } = mock("import");
  assert.throws(
    () => withMacSigning(env, () => assert.fail("must not build"), command),
    /injected failure/,
  );
  const deleted = calls.find((call) => call[1] === "delete-keychain");
  assert.ok(deleted);
  assert.equal(existsSync(deleted[2]), false);
  assert.deepEqual(calls.at(-2), [
    "security",
    "list-keychains",
    "-d",
    "user",
    "-s",
    "/original.keychain-db",
  ]);
});

for (const runner of [
  { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
  { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" },
  { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: undefined },
])
  test(`certificate trust is disabled for ${JSON.stringify(runner)}`, () => {
    const { command, calls } = mock("find-identity");
    assert.throws(
      () =>
        withMacSigning(
          { ...env, ...runner },
          () => assert.fail("must not build"),
          command,
        ),
      /injected failure/,
    );
    assert.equal(
      calls.some((call) => call[0] === "sudo"),
      false,
    );
  });

test(
  "failed signing preflight deletes keychain and certificate files",
  { skip: process.platform === "win32" },
  () => {
    const { command, calls } = mock("--sign");
    assert.throws(
      () => withMacSigning(env, () => assert.fail("must not build"), command),
      /injected failure/,
    );
    assert.ok(calls.some((call) => call.includes("add-trusted-cert")));
    const removed = calls.find((call) => call[1] === "delete-keychain");
    assert.ok(removed);
    assert.equal(existsSync(dirname(removed[2])), false);
  },
);

test(
  "build uses the imported fingerprint and cleanup runs even when the build fails",
  { skip: process.platform === "win32" },
  () => {
    const { command, calls } = mock();
    assert.throws(
      () =>
        withMacSigning(
          env,
          (child) => {
            assert.equal(child.APPLE_SIGNING_IDENTITY, fingerprint);
            assert.equal(Object.hasOwn(child, "APPLE_CERTIFICATE"), false);
            assert.equal(
              Object.hasOwn(child, "APPLE_CERTIFICATE_PASSWORD"),
              false,
            );
            throw new Error("build failed");
          },
          command,
        ),
      /build failed/,
    );
    assert.ok(calls.some((call) => call.includes("--verify")));
    assert.equal(
      calls.some((call) => call.includes("remove-trusted-cert")),
      false,
    );
    assert.ok(calls.some((call) => call[1] === "delete-keychain"));
    assert.ok(env.APPLE_CERTIFICATE);
  },
);

test(
  "hosted runner teardown handles trust while private key material is deleted immediately",
  { skip: process.platform === "win32" },
  (t) => {
    const warning = t.mock.method(console, "warn", () => {});
    const { command, calls } = mock("remove-trusted-cert");
    const result = withMacSigning(env, () => "built artifacts", command);
    assert.equal(result, "built artifacts");
    assert.equal(warning.mock.callCount(), 0);
    assert.ok(calls.some((call) => call.includes("add-trusted-cert")));
    assert.equal(
      calls.some((call) => call.includes("remove-trusted-cert")),
      false,
    );
    const removed = calls.find((call) => call[1] === "delete-keychain");
    assert.ok(removed);
    assert.equal(existsSync(dirname(removed[2])), false);
    assert.deepEqual(calls.at(-2), [
      "security",
      "list-keychains",
      "-d",
      "user",
      "-s",
      "/original.keychain-db",
    ]);
    // Deferring trust teardown must never hide a genuine build failure.
    assert.throws(
      () =>
        withMacSigning(
          env,
          () => {
            throw new Error("build failed");
          },
          command,
        ),
      /build failed/,
    );
  },
);

test(
  "private key cleanup failure still fails a successful build",
  { skip: process.platform === "win32" },
  () => {
    const { command, calls } = mock("delete-keychain");
    assert.throws(
      () => withMacSigning(env, () => "built artifacts", command),
      /injected failure/,
    );
    const removed = calls.find((call) => call[1] === "delete-keychain");
    assert.equal(existsSync(dirname(removed[2])), false);
  },
);
