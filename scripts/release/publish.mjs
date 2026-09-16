import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "./version.mjs";
import { sha256, updaterManifest, verifyArtifacts } from "./artifacts.mjs";
import { run } from "./process.mjs";

export function sameAssets(local, remote) {
  return (
    JSON.stringify([...local].sort()) === JSON.stringify([...remote].sort())
  );
}
export function shouldPromote(tag, latest) {
  return (
    !parseVersion(tag).channel && (!latest || compareVersions(tag, latest) > 0)
  );
}
function releaseData(repository, path) {
  const result = spawnSync(
    "gh",
    ["api", `repos/${repository}/releases/${path}`],
    { encoding: "utf8" },
  );
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/HTTP 404/.test(result.stderr)) return null;
  throw new Error(result.stderr || "无法读取 GitHub Release");
}
export function publish(
  env = process.env,
  fetchRelease = releaseData,
  execute = run,
) {
  const { tag, version, channel } = parseVersion(env.RELEASE_TAG ?? "");
  const repository = env.GITHUB_REPOSITORY;
  if (repository !== "leowzz/filo")
    throw new Error("发布仓库必须与应用内更新地址 leowzz/filo 一致。");
  const directory = resolve(
    env.RELEASE_ASSETS ?? "target/release-assets/combined",
  );
  verifyArtifacts(directory, version);
  let release = fetchRelease(repository, `tags/${tag}`);
  if (!release) {
    execute("gh", [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--generate-notes",
      "--title",
      `Filo ${tag}`,
      ...(channel ? ["--prerelease"] : []),
    ]);
    release = fetchRelease(repository, `tags/${tag}`);
  }
  if (!release) throw new Error("Release 创建后未能读取。");
  // Stable timestamp and existing notes make retries deterministic; never rewrite notes.
  if (!channel)
    writeFileSync(
      join(directory, "latest.json"),
      JSON.stringify(
        updaterManifest(
          directory,
          version,
          repository,
          release.body ?? "",
          release.created_at,
        ),
        null,
        2,
      ) + "\n",
    );
  const names = readdirSync(directory).sort();
  if (channel && names.includes("latest.json"))
    throw new Error("预发布不应包含 latest.json。");
  if (!release.draft) {
    if (
      !sameAssets(
        names,
        release.assets.map((asset) => asset.name),
      )
    )
      throw new Error(
        "已发布 Release 的资产集合不同；拒绝覆盖，请使用新版本。",
      );
    const temporary = mkdtempSync(join(tmpdir(), "filo-release-"));
    try {
      execute("gh", [
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        temporary,
      ]);
      for (const name of names)
        if (sha256(join(directory, name)) !== sha256(join(temporary, name)))
          throw new Error(
            `已发布资产内容不同：${name}；拒绝覆盖，请使用新版本。`,
          );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    console.log(`${tag} 已完整发布，内容一致，无需重复上传。`);
    return;
  }
  // Drafts may resume after a failed upload. Published assets are immutable here.
  for (const asset of release.assets) {
    if (!names.includes(asset.name))
      throw new Error(`draft 含非预期资产：${asset.name}`);
  }
  execute("gh", [
    "release",
    "upload",
    tag,
    "--repo",
    repository,
    "--clobber",
    ...names.map((name) => join(directory, name)),
  ]);
  const uploaded = fetchRelease(repository, `tags/${tag}`);
  if (
    !sameAssets(
      names,
      uploaded.assets.map((asset) => asset.name),
    )
  )
    throw new Error("远端资产未上传完整，保留 draft。");
  for (const asset of uploaded.assets) {
    if (asset.digest !== `sha256:${sha256(join(directory, asset.name))}`)
      throw new Error(`远端 SHA-256 未匹配：${asset.name}，保留 draft。`);
  }
  const latest = fetchRelease(repository, "latest");
  execute("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    `--prerelease=${Boolean(channel)}`,
    `--latest=${shouldPromote(tag, latest?.tag_name)}`,
  ]);
  console.log(`${tag} 全部资产校验通过并已发布。`);
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    publish();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
