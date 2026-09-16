import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkVersions, root, envPath } from "./version.mjs";
import { pnpm } from "./process.mjs";
import {
  assetNames,
  collectArtifacts,
  reportInstallers,
  targets,
} from "./artifacts.mjs";
import { releaseSigningEnvironment } from "./signing.mjs";
import { withMacSigning } from "./macos-signing.mjs";

try {
  if (existsSync(envPath())) process.loadEnvFile(envPath());
  const { version } = checkVersions(root, process.env.RELEASE_TAG);
  const release = process.argv.includes("--release");
  const target = process.env.RELEASE_TARGET;
  const args = ["--filter", "@filo/desktop", "tauri", "build"];
  let buildEnv = process.env;
  if (release) {
    if (!targets.includes(target))
      throw new Error(
        "发布需要 RELEASE_TARGET：macOS Apple Silicon 或 Windows x64。",
      );
    if ((target === targets[0]) !== (process.platform === "darwin"))
      throw new Error("发布目标与构建主机不匹配。");
    buildEnv = releaseSigningEnvironment(process.env, process.platform);
    const config = JSON.parse(
      readFileSync(
        join(root, "apps/desktop/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    );
    if (
      !config.plugins?.updater?.pubkey ||
      !config.plugins.updater.endpoints?.length
    )
      throw new Error("先配置 updater 公钥与公开下载地址。");
    // Avoid accepting stale files left by an earlier local or CI attempt.
    rmSync(join(root, "target", target, "release/bundle"), {
      recursive: true,
      force: true,
    });
    args.push(
      "--target",
      target,
      "--config",
      "src-tauri/tauri.updater.conf.json",
      "--bundles",
      target === targets[0] ? "app,dmg" : "nsis",
    );
  } else {
    rmSync(join(root, "target/release/bundle"), {
      recursive: true,
      force: true,
    });
    args.push(
      "--bundles",
      process.platform === "darwin"
        ? "app,dmg"
        : process.platform === "win32"
          ? "nsis"
          : "deb,appimage",
    );
  }
  args.push("--", "--locked");
  if (release && process.platform === "darwin") {
    withMacSigning(buildEnv, (env) => pnpm(args, { env }));
  } else {
    pnpm(args, { env: buildEnv });
  }
  if (release) {
    const output = join(root, "target/release-assets", target);
    rmSync(output, { recursive: true, force: true });
    collectArtifacts(
      join(root, "target", target, "release/bundle"),
      output,
      version,
      target,
    );
    console.log(
      `发布文件及 SHA-256：${output}\n${assetNames(version, target).join("\n")}`,
    );
  } else {
    reportInstallers(join(root, "target/release/bundle"), process.platform);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
