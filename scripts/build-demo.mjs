import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);

if (process.platform !== "darwin") {
  console.error("make demo 当前仅用于生成 macOS 本机演示包。");
  process.exit(1);
}

// Explicit shell variables take precedence over this ignored local file.
try {
  process.loadEnvFile(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

let identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
if (!identity) {
  try {
    identity = readFileSync(
      join(homedir(), ".config", "filo", "signing", "identity.txt"),
      "utf8",
    ).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
if (!identity || identity === "-") {
  console.error(
    "macOS 演示包需要固定签名，避免每次重建后重新请求文件夹权限。\n" +
      "用 security find-identity -v -p codesigning 查看已有证书，\n" +
      "将身份写入 ~/.config/filo/signing/identity.txt，\n" +
      "或在 .env / 环境变量中设置 APPLE_SIGNING_IDENTITY 后重试。",
  );
  process.exit(1);
}
process.env.APPLE_SIGNING_IDENTITY = identity;

const result = spawnSync(
  "pnpm",
  ["--filter", "@filo/desktop", "tauri", "build", "--debug", "--bundles", "app"],
  { cwd: root, stdio: "inherit", env: process.env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
