import { isDirectory, type Entry } from "./types";

export type BrowserRow =
  { entry: Entry; label?: never } | { entry?: never; label: string };

// Listing pages already put directories first. Insert fixed-height headings
// without reordering pages, so selection and virtualization share one geometry.
export function browserRows(entries: Entry[], grouped: boolean): BrowserRow[] {
  const rows: BrowserRow[] = [];
  let previous: boolean | undefined;
  for (const entry of entries) {
    const directory = isDirectory(entry);
    if (grouped && directory !== previous)
      rows.push({ label: directory ? "文件夹" : "文件及其他项目" });
    rows.push({ entry });
    previous = directory;
  }
  return rows;
}
