import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkVersions,
  compareVersions,
  parseVersion,
  root,
  setVersions,
  versionFiles,
} from "./version.mjs";

export function release(
  directory = root,
  requested = process.env.V,
  rc = process.env.RC,
) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(result.stderr || `git ${args[0]} 失败`);
    return result.stdout.trim();
  };
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("工作区不干净；先提交或保存现有修改。");
  const current = checkVersions(directory);
  if (!requested && !rc && current.channel)
    throw new Error("预发布必须显式指定 V 或 RC。");
  let next = parseVersion(
    requested ||
      `${current.parts[0]}.${current.parts[1]}.${current.parts[2] + 1n}`,
  );
  if (rc) {
    if (!/^[1-9]\d*$/.test(rc) || next.channel)
      throw new Error("RC 必须是正整数，V 不能同时包含预发布后缀。");
    next = parseVersion(`${next.version}-rc.${rc}`);
  }
  if (compareVersions(next.tag, current.tag) < 0)
    throw new Error("不能发布低于当前版本的版本。");
  if (git("tag", "--list", next.tag))
    throw new Error(`tag 已存在：${next.tag}`);
  git("symbolic-ref", "--quiet", "HEAD");
  setVersions(next.tag, directory);
  git("add", "--", ...versionFiles);
  if (git("diff", "--cached", "--name-only"))
    git("commit", "-m", `chore: release ${next.tag}`);
  const commit = git("rev-parse", "HEAD");
  try {
    git("tag", "-a", next.tag, "-m", `Release ${next.tag}`);
  } catch (error) {
    throw new Error(
      `版本提交 ${commit} 已保留，但 tag 创建失败：${error.message}`,
    );
  }
  console.log(`已创建本地 annotated tag ${next.tag} (${commit})，尚未推送。`);
  return next.tag;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    release();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
