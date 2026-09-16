import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败，未启动开发应用。`);
}

function signingIdentity() {
  // Explicit environment values take precedence over the ignored project .env.
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) {
    try {
      identity = readFileSync(
        join(homedir(), ".config/filo/signing/identity.txt"),
        "utf8",
      ).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!identity || identity === "-") {
    throw new Error(
      "macOS 本地开发需要固定签名证书。请在 ~/.config/filo/signing/identity.txt 或 APPLE_SIGNING_IDENTITY 中配置已有证书的名称或指纹；不接受临时签名 -。",
    );
  }
  process.env.APPLE_SIGNING_IDENTITY = identity;
  return identity;
}

function xml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
}

function signDevelopmentApp(binary, identity) {
  const config = JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  const executableName = basename(binary);
  // Keep Cargo's artifact untouched. The development bundle has a stable path
  // and identifier, while the binary still loads Vite's devUrl and supports HMR.
  const bundle = join(dirname(binary), "dev-bundle", "Filo.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", executableName);
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  rmSync(executable, { force: true });
  copyFileSync(binary, executable);
  copyFileSync(
    join(root, "apps/desktop/src-tauri/icons/icon.icns"),
    join(contents, "Resources/icon.icns"),
  );
  const fields = {
    CFBundleExecutable: executableName,
    CFBundleIdentifier: config.identifier,
    CFBundleName: config.productName,
    CFBundleDisplayName: config.productName,
    CFBundleVersion: config.version,
    CFBundleShortVersionString: config.version,
    CFBundlePackageType: "APPL",
    CFBundleIconFile: "icon.icns",
  };
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(fields)
  .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
  .join("\n")}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
  );
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    identity,
    "--identifier",
    config.identifier,
    "--timestamp=none",
    bundle,
  ]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  console.error("Filo 开发应用已完成固定证书签名。");
  // stdout is reserved for the shell runner's executable path.
  process.stdout.write(`${executable}\n`);
}

function startDevelopment(args) {
  if (args[0] === "--") args.shift();
  if (
    process.platform === "darwin" &&
    !args.includes("--help") &&
    !args.includes("-h")
  ) {
    signingIdentity();
    process.env.FILO_DEV_NODE = process.execPath;
    const separator = args.indexOf("--");
    const cliArgs = separator === -1 ? args : args.slice(0, separator);
    const cargoArgs = separator === -1 ? [] : args.slice(separator + 1);
    // Structured TOML arguments preserve spaces in checkout paths. Both macOS
    // targets use Cargo's documented runner hook after each successful build.
    const runner = JSON.stringify([
      "/bin/sh",
      join(root, "scripts/dev-runner.sh"),
    ]);
    args = [
      ...cliArgs,
      "--",
      "--config",
      `target.aarch64-apple-darwin.runner=${runner}`,
      "--config",
      `target.x86_64-apple-darwin.runner=${runner}`,
      ...cargoArgs,
    ];
  }
  const child = spawn(
    "pnpm",
    ["--filter", "@filo/desktop", "tauri", "dev", ...args],
    {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
  });
}

try {
  if (process.argv[2] === "--sign-binary") {
    if (process.platform !== "darwin" || !process.argv[3])
      throw new Error("签名步骤需要 macOS 和开发可执行文件。");
    // Resolve before changing cwd: Cargo may pass a relative executable path.
    signDevelopmentApp(resolve(process.argv[3]), signingIdentity());
  } else {
    startDevelopment(process.argv.slice(2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
