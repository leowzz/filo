import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;
export function parseVersion(value) {
  const version = value.replace(/^v/, "");
  const match = versionPattern.exec(version);
  if (!match)
    throw new Error(
      `无效版本：${value}；使用 vX.Y.Z 或 vX.Y.Z-beta.N / rc.N / alpha.N`,
    );
  return {
    version,
    tag: `v${version}`,
    parts: match.slice(1, 4).map(BigInt),
    channel: match[4],
    sequence: BigInt(match[5] ?? 0),
  };
}
export function compareVersions(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i])
      return left.parts[i] > right.parts[i] ? 1 : -1;
  }
  const rank = { alpha: 0, beta: 1, rc: 2, undefined: 3 };
  return (
    Math.sign(rank[left.channel] - rank[right.channel]) ||
    (left.sequence > right.sequence
      ? 1
      : left.sequence < right.sequence
        ? -1
        : 0)
  );
}
export function readEnvVersion(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:export\s+)?version\s*=/.test(line));
  if (lines.length !== 1 || !/^version=v\S+$/.test(lines[0]))
    throw new Error(
      "版本文件必须包含且仅包含一行 version=vX.Y.Z，不允许多余空白或引号。",
    );
  return parseVersion(lines[0].slice(8));
}
export function setEnvVersion(text, tag) {
  readEnvVersion(text);
  return text.replace(/^version=.*$/m, `version=${parseVersion(tag).tag}`);
}
export function envPath(directory = root) {
  return resolve(directory, process.env.ENV_FILE || ".env");
}
export function readVersion(directory = root) {
  const path = envPath(directory);
  return readEnvVersion(
    readFileSync(
      existsSync(path) ? path : join(directory, ".env.example"),
      "utf8",
    ),
  );
}
const jsonFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];
export const versionFiles = [
  ".env.example",
  ...jsonFiles,
  "Cargo.toml",
  "Cargo.lock",
];
function workspaceVersion(text, value) {
  const pattern = /(\[workspace\.package\][\s\S]*?\bversion\s*=\s*")([^"]+)(")/;
  const match = text.match(pattern);
  if (!match) throw new Error("Cargo.toml 缺少 workspace.package.version");
  return value === undefined ? match[2] : text.replace(pattern, `$1${value}$3`);
}
function localPackages(directory) {
  const files = [
    "apps/desktop/src-tauri/Cargo.toml",
    ...readdirSync(join(directory, "crates")).map(
      (name) => `crates/${name}/Cargo.toml`,
    ),
  ];
  return files
    .filter((file) => existsSync(join(directory, file)))
    .map((file) => {
      const text = readFileSync(join(directory, file), "utf8");
      const block = text.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
      if (!block || !/^version\.workspace\s*=\s*true\s*$/m.test(block))
        throw new Error(`${file} 必须继承 workspace 版本`);
      return block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    });
}
function lockVersions(text, names, version) {
  const seen = new Set();
  const output = text.replace(
    /\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g,
    (block) => {
      const name = block.match(/^name = "([^"]+)"/m)?.[1];
      if (!names.includes(name) || /^source = /m.test(block)) return block;
      seen.add(name);
      const current = block.match(/^version = "([^"]+)"/m)?.[1];
      if (!current) throw new Error(`Cargo.lock 缺少 ${name} 版本`);
      if (typeof version === "function") {
        version(current, name);
        return block;
      }
      return block.replace(/^version = "[^"]+"/m, `version = "${version}"`);
    },
  );
  if (seen.size !== names.length)
    throw new Error("Cargo.lock 缺少 workspace package");
  return output;
}
export function checkVersions(directory = root, expectedTag) {
  const current = readVersion(directory);
  const check = (version, file) => {
    if (version !== current.version)
      throw new Error(`${file} 版本 ${version} 与 ${current.tag} 不一致`);
  };
  check(
    readEnvVersion(readFileSync(join(directory, ".env.example"), "utf8"))
      .version,
    ".env.example",
  );
  for (const file of jsonFiles)
    check(
      JSON.parse(readFileSync(join(directory, file), "utf8")).version,
      file,
    );
  check(
    workspaceVersion(readFileSync(join(directory, "Cargo.toml"), "utf8")),
    "Cargo.toml",
  );
  lockVersions(
    readFileSync(join(directory, "Cargo.lock"), "utf8"),
    localPackages(directory),
    check,
  );
  if (expectedTag && expectedTag !== current.tag)
    throw new Error(`tag ${expectedTag} 与 ${current.tag} 不一致`);
  return current;
}
export function setVersions(tag, directory = root) {
  const { version } = parseVersion(tag);
  const changes = new Map();
  for (const file of new Set([
    envPath(directory),
    join(directory, ".env.example"),
  ])) {
    const text = existsSync(file)
      ? readFileSync(file, "utf8")
      : readFileSync(join(directory, ".env.example"), "utf8");
    changes.set(file, setEnvVersion(text, tag));
  }
  for (const file of jsonFiles) {
    const path = join(directory, file);
    const text = readFileSync(path, "utf8");
    const old = JSON.parse(text).version;
    const output = text.replace(
      /("version"\s*:\s*")[^"]+("\s*[,}])/,
      `$1${version}$2`,
    );
    if (!old || JSON.parse(output).version !== version)
      throw new Error(`${file} 版本字段不可写`);
    changes.set(path, output);
  }
  changes.set(
    join(directory, "Cargo.toml"),
    workspaceVersion(
      readFileSync(join(directory, "Cargo.toml"), "utf8"),
      version,
    ),
  );
  changes.set(
    join(directory, "Cargo.lock"),
    lockVersions(
      readFileSync(join(directory, "Cargo.lock"), "utf8"),
      localPackages(directory),
      version,
    ),
  );
  // Parse every source before touching any file. Only workspace packages change.
  for (const [path, text] of changes) writeFileSync(path, text);
  return checkVersions(directory, parseVersion(tag).tag);
}
