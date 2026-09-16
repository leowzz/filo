import { X509Certificate, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function signingCommand(command, args, stage) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never include command arguments or captured output: they may contain passwords.
  if (result.error || result.status !== 0)
    throw new Error(
      `macOS 签名：${stage}失败${result.error?.code === "ETIMEDOUT" ? "（超时）" : ""}。`,
    );
  return result.stdout;
}

// Tauri's automatic P12 importer only discovers Apple-named certificates.
// Import explicitly so the same certificate fingerprint works for self-signed
// identities too. No persistent local trust settings are changed.
export function withMacSigning(env, build, command = signingCommand) {
  const originalKeychains = command(
    "security",
    ["list-keychains", "-d", "user"],
    "读取钥匙串",
  )
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), "filo-release-signing-"));
  const keychain = join(dir, "release.keychain-db");
  const p12 = join(dir, "certificate.p12");
  const pem = join(dir, "certificate.pem");
  const password = randomBytes(24).toString("hex");
  let created = false;
  let trusted = false;
  let failure;
  try {
    writeFileSync(p12, Buffer.from(env.APPLE_CERTIFICATE, "base64"), {
      mode: 0o600,
    });
    command(
      "security",
      ["create-keychain", "-p", password, keychain],
      "创建临时钥匙串",
    );
    created = true;
    command(
      "security",
      ["set-keychain-settings", "-lut", "7200", keychain],
      "设置钥匙串超时",
    );
    command(
      "security",
      ["unlock-keychain", "-p", password, keychain],
      "解锁钥匙串",
    );
    command(
      "security",
      [
        "import",
        p12,
        "-k",
        keychain,
        "-P",
        env.APPLE_CERTIFICATE_PASSWORD,
        "-T",
        "/usr/bin/codesign",
      ],
      "导入证书",
    );
    rmSync(p12);
    command(
      "security",
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ],
      "设置非交互签名权限",
    );
    const certificates =
      command(
        "security",
        ["find-certificate", "-a", "-p", keychain],
        "读取证书",
      ).match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      ) ?? [];
    const identity = env.APPLE_SIGNING_IDENTITY.trim();
    const cert = certificates
      .map((value) => new X509Certificate(value))
      .find(
        (candidate) =>
          candidate.fingerprint.replaceAll(":", "").toUpperCase() ===
            identity.toUpperCase() ||
          candidate.subject.split("\n").includes(`CN=${identity}`),
      );
    if (!cert)
      throw new Error("macOS 签名：P12 与 APPLE_SIGNING_IDENTITY 不匹配。");
    const fingerprint = cert.fingerprint.replaceAll(":", "");
    if (
      Date.now() < Date.parse(cert.validFrom) ||
      Date.now() >= Date.parse(cert.validTo)
    )
      throw new Error("macOS 签名：证书尚未生效或已经过期。");
    writeFileSync(pem, cert.toString(), { mode: 0o600 });
    if (
      cert.subject === cert.issuer &&
      cert.verify(cert.publicKey) &&
      env.GITHUB_ACTIONS === "true" &&
      env.RUNNER_ENVIRONMENT === "github-hosted"
    ) {
      // Scope trust to code signing on the disposable hosted runner only.
      command(
        "sudo",
        [
          "-n",
          "security",
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-p",
          "codeSign",
          "-k",
          keychain,
          pem,
        ],
        "信任 CI 自签证书",
      );
      trusted = true;
    }
    command(
      "security",
      ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains],
      "注册临时钥匙串",
    );
    const identities = command(
      "security",
      ["find-identity", "-v", "-p", "codesigning", keychain],
      "验证签名身份",
    );
    if (!identities.toUpperCase().includes(fingerprint.toUpperCase()))
      throw new Error("macOS 签名：证书没有可用的签名私钥或未受信任。");
    const probe = join(dir, "signing-probe");
    copyFileSync("/usr/bin/true", probe);
    command(
      "codesign",
      [
        "--force",
        "--sign",
        fingerprint,
        "--keychain",
        keychain,
        "--timestamp=none",
        probe,
      ],
      "预检证书签名",
    );
    command("codesign", ["--verify", "--strict", probe], "校验预检签名");
    const childEnv = { ...env, APPLE_SIGNING_IDENTITY: fingerprint };
    // Use the imported identity directly; do not re-enter Tauri's P12 importer.
    delete childEnv.APPLE_CERTIFICATE;
    delete childEnv.APPLE_CERTIFICATE_PASSWORD;
    console.log("macOS 证书签名预检通过，开始发布构建。");
    return build(childEnv);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const clean = (action) => {
      try {
        action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (trusted)
      clean(() =>
        command(
          "sudo",
          ["-n", "security", "remove-trusted-cert", "-d", pem],
          "移除 CI 证书信任",
        ),
      );
    if (created) {
      clean(() =>
        command(
          "security",
          ["list-keychains", "-d", "user", "-s", ...originalKeychains],
          "恢复钥匙串列表",
        ),
      );
      clean(() =>
        command("security", ["delete-keychain", keychain], "删除临时钥匙串"),
      );
    }
    clean(() => rmSync(dir, { recursive: true, force: true }));
    if (cleanupErrors.length) {
      if (!failure) throw cleanupErrors[0];
      console.error("macOS 签名临时资源清理失败，请检查 runner。");
    }
  }
}
