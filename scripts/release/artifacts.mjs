import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const targets = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"];
export function assetNames(version, target) {
  if (!targets.includes(target)) throw new Error(`不支持的发布目标：${target}`);
  return target === targets[0]
    ? [
        `Filo_${version}_aarch64.dmg`,
        `Filo_${version}_aarch64.app.tar.gz`,
        `Filo_${version}_aarch64.app.tar.gz.sig`,
      ]
    : [`Filo_${version}_x64-setup.exe`, `Filo_${version}_x64-setup.exe.sig`];
}
export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function reportInstallers(directory, platform) {
  const suffixes =
    platform === "darwin"
      ? [".dmg"]
      : platform === "win32"
        ? [".exe"]
        : [".deb", ".AppImage"];
  for (const suffix of suffixes) {
    const matches = files(directory).filter((file) => file.endsWith(suffix));
    if (matches.length !== 1 || statSync(matches[0]).size === 0)
      throw new Error(`缺少唯一安装包 ${suffix}`);
    const file = matches[0];
    const digest = sha256(file);
    writeFileSync(
      `${file}.sha256`,
      `${digest}  ${file.split(/[\\/]/).pop()}\n`,
    );
    console.log(`${file}\nSHA-256: ${digest}`);
  }
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() && !entry.name.endsWith(".app")
      ? files(path)
      : entry.isFile()
        ? [path]
        : [];
  });
}
export function collectArtifacts(bundle, output, version, target) {
  const all = files(bundle);
  const suffixes =
    target === targets[0]
      ? [".dmg", ".app.tar.gz", ".app.tar.gz.sig"]
      : [".exe", ".exe.sig"];
  const names = assetNames(version, target);
  mkdirSync(output, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    const matches = all.filter((path) => path.endsWith(suffixes[i]));
    if (matches.length !== 1 || statSync(matches[0]).size === 0)
      throw new Error(
        `预期唯一且非空的 ${suffixes[i]} 产物，实际 ${matches.length} 个`,
      );
    const destination = join(output, names[i]);
    copyFileSync(matches[0], destination);
    writeFileSync(
      `${destination}.sha256`,
      `${sha256(destination)}  ${names[i]}\n`,
    );
  }
  return names;
}
export function verifyArtifacts(directory, version) {
  const names = targets.flatMap((target) => assetNames(version, target));
  const expected = names.flatMap((name) => [name, `${name}.sha256`]).sort();
  const actual = readdirSync(directory)
    .filter((name) => name !== "latest.json")
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("发布产物集合不完整或包含额外文件。");
  for (const name of names) {
    const path = join(directory, name);
    if (statSync(path).size === 0) throw new Error(`空产物：${name}`);
    const expectedHash = readFileSync(`${path}.sha256`, "utf8").trim();
    if (expectedHash !== `${sha256(path)}  ${name}`)
      throw new Error(`SHA-256 不匹配：${name}`);
  }
  return expected;
}
export function updaterManifest(
  directory,
  version,
  repository,
  notes = "",
  date = new Date().toISOString(),
) {
  verifyArtifacts(directory, version);
  if (version.includes("-"))
    throw new Error("预发布不能生成稳定通道 latest.json。");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("无效 Release 仓库名。");
  const entry = (name) => ({
    url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
    signature: readFileSync(join(directory, `${name}.sig`), "utf8").trim(),
  });
  return {
    version,
    notes,
    pub_date: date,
    platforms: {
      "darwin-aarch64": entry(assetNames(version, targets[0])[1]),
      "windows-x86_64": entry(assetNames(version, targets[1])[0]),
    },
  };
}
