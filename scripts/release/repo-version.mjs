import { checkVersions, readVersion, setVersions } from "./version.mjs";

try {
  const command = process.argv[2] ?? "check";
  const result =
    command === "get"
      ? readVersion()
      : command === "set"
        ? setVersions(process.argv[3] ?? process.env.V ?? "")
        : command === "check"
          ? checkVersions(undefined, process.env.RELEASE_TAG)
          : null;
  if (!result)
    throw new Error("用法：repo-version.mjs get|set <version>|check");
  console.log(result.tag);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
