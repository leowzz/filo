import { appendFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkVersions, parseVersion, root } from "./version.mjs";
import { run } from "./process.mjs";

export function validateReleaseRef(tag, directory = root) {
  if (parseVersion(tag).tag !== tag)
    throw new Error("发布 tag 必须以 v 开头。");
  const git = (...args) =>
    run("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    });
  // checkout can replace the local annotated tag with the event's peeled commit
  // during its fallback fetch. Restore the remote tag object before inspecting it.
  git(
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `refs/tags/${tag}:refs/tags/${tag}`,
  );
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
    throw new Error("发布需要 annotated tag。");
  if (
    git("rev-parse", `refs/tags/${tag}^{commit}`) !== git("rev-parse", "HEAD")
  )
    throw new Error("远端 tag 与本次检出的提交不一致，请重新触发发布。");
  const branches = git(
    "branch",
    "-r",
    "--contains",
    "HEAD",
    "--format=%(refname)",
  );
  if (
    !branches
      .split("\n")
      .some(
        (name) =>
          name.startsWith("refs/remotes/origin/") && !name.endsWith("/HEAD"),
      )
  )
    throw new Error("tag 提交尚未推送到远端分支。");
}

function metadata() {
  copyFileSync(".env.example", ".env");
  const tag = process.env.RELEASE_TAG;
  if (!tag) throw new Error("缺少 RELEASE_TAG");
  const version = checkVersions(undefined, tag);
  validateReleaseRef(tag);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version.version}\nprerelease=${Boolean(version.channel)}\n`,
    );
  console.log(`发布校验通过：${tag}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    metadata();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
