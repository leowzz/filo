import { appendFileSync, copyFileSync } from "node:fs";
import { checkVersions } from "./version.mjs";
import { run } from "./process.mjs";

try {
  copyFileSync(".env.example", ".env");
  const tag = process.env.RELEASE_TAG;
  if (!tag) throw new Error("缺少 RELEASE_TAG");
  const version = checkVersions(undefined, tag);
  if (
    run("git", ["cat-file", "-t", `refs/tags/${tag}`], {
      encoding: "utf8",
      stdio: "pipe",
    }) !== "tag"
  )
    throw new Error("发布需要 annotated tag。");
  const branches = run(
    "git",
    ["branch", "-r", "--contains", "HEAD", "--format=%(refname)"],
    { encoding: "utf8", stdio: "pipe" },
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
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version.version}\nprerelease=${Boolean(version.channel)}\n`,
    );
  console.log(`发布校验通过：${tag}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
