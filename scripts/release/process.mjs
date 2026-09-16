import { spawnSync } from "node:child_process";
import { root } from "./version.mjs";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} 失败 (${result.status})`);
  return result.stdout?.trim();
}
export function pnpm(args, options = {}) {
  // Windows cannot spawn pnpm.cmd without a shell. The corepack JS shim can.
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], options);
  }
  return run("pnpm", args, options);
}
