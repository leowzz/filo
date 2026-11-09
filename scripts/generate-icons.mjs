import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, "apps", "desktop");
const icons = join(desktop, "src-tauri", "icons");
const temporaryRoot = resolve(tmpdir());
const generated = mkdtempSync(join(temporaryRoot, "filo-icons-"));
const cli = join(desktop, "node_modules", "@tauri-apps", "cli", "tauri.js");
const files = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.ico",
  "icon.icns",
];

try {
  const result = spawnSync(
    process.execPath,
    [cli, "icon", join(icons, "source.svg"), "--output", generated],
    { cwd: desktop, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Tauri icon generation failed.");
  for (const file of files) copyFileSync(join(generated, file), join(icons, file));
  console.log(`Updated ${files.length} desktop icons from source.svg.`);
} finally {
  if (
    dirname(resolve(generated)) === temporaryRoot &&
    resolve(generated).startsWith(`${temporaryRoot}${sep}filo-icons-`)
  ) {
    rmSync(generated, { recursive: true, force: true });
  }
}
