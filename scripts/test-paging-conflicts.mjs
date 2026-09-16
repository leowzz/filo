// Run with ego-browser nodejs while Vite is running. IPC fixtures touch no real files.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo paging and conflict regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
window.isTauri = true;
window.testCalls = []; window.testJobs = []; window.failMore = false;
const volumes = ['source', 'target'].map(id => ({ id, connection_id: id, name: id, read_only: false,
 root: {type:'local',root_path:'/'+id}, capabilities:{hierarchy:'native_directory',rename:'atomic',create_directory:true,write:true,delete:true,recursive_delete:true,trash:true,native_open:true} }));
window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command,args) => {
 window.testCalls.push({command,args});
 if(command==='list_volumes') return volumes;
 if(command==='list_transfers') return window.testJobs;
 if(command==='list_entries_page') {
   if(args.cursor && window.failMore && args.parent.volume_id==='source') throw {code:'io',message:'测试分页失败'};
   const target = args.parent.volume_id === 'target';
   let entries = args.parent.logical_path ? [] : Array.from({length:target?450:3000}, (_,i) => ({
     name:(target?'folder-':'file-')+String(i).padStart(4,'0')+(target?'':'.txt'),kind:target?'directory':'file',size:target?null:i,
     modified_at:'2026-09-16T00:00:00Z',locator:{volume_id:args.parent.volume_id,logical_path:(target?'folder-':'file-')+String(i).padStart(4,'0')+(target?'':'.txt'),version_id:null}
   }));
   entries=entries.filter(e=>(!args.options.folders_only || e.kind==='directory') && e.name.includes(args.options.search));
   if(args.options.sort==='size') entries.sort((a,b)=>b.size-a.size);
   const offset=Number(args.cursor||0), total=entries.length;
   return {entries:entries.slice(offset,offset+args.limit),total,next_cursor:offset+args.limit<total?String(offset+args.limit):null};
 }
 if(command==='start_transfer') {
   const job={id:String(window.testJobs.length+1),kind:args.kind,source:args.source,destination:args.destination,state:'completed',created_at:'2026-09-16T00:00:00Z',updated_at:'2026-09-16T00:00:00Z',bytes_total:10,bytes_transferred:10,error_code:null,error_message:null};
   window.testJobs.push(job); return job;
 }
 if(command==='rename_entry') return args.conflictPolicy==='skip'?'skipped':'completed';
 throw new Error('Unexpected IPC: '+command);
}};

})();
`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 900,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button[title="/source"]');
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="file-0000.txt"]');
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /200 \/ 3000/,
);
assert.ok(
  (await page.evaluate(
    () => document.querySelectorAll("tr[data-entry-path]").length,
  )) < 60,
  "DOM is bounded",
);
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector("tr[data-entry-path]").getBoundingClientRect()
        .height,
  ),
  29,
  "virtual row geometry matches rendered rows",
);
await page.click('tr[data-entry-path="file-0000.txt"] .file-name');
await page.evaluate(() => {
  document.querySelector(".file-area").scrollTop = 145 * 29;
});
await page.waitForSelector('tr[data-entry-path="file-0150.txt"]');
await page.keyboard.down("Shift");
await page.click('tr[data-entry-path="file-0150.txt"] .file-name');
await page.keyboard.up("Shift");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 151 项/,
  "range selection crosses unmounted rows",
);
await page.keyboard.press("Meta+a");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 200 项/,
  "select all includes loaded rows",
);
await page.evaluate(() => {
  window.failMore = true;
  const area = document.querySelector(".file-area");
  area.scrollTop = area.scrollHeight;
});
await page.waitForSelector('button:text-is("重试加载")', { timeout: 20000 });
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 200 项/,
  "page failure preserves selection",
);
await page.evaluate(() => {
  window.failMore = false;
});
await page.click('button:text-is("重试加载")');
await page.waitForFunction(() =>
  document.querySelector(".statusbar").textContent.includes("400 / 3000"),
);
assert.ok(
  (await page.evaluate(
    () => document.querySelectorAll("tr[data-entry-path]").length,
  )) < 60,
);
await page.fill('input[placeholder="搜索当前目录"]', "file-2999");
await page.waitForSelector('tr[data-entry-path="file-2999.txt"]');
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /1 个项目/,
  "search includes unloaded files",
);
await page.fill('input[placeholder="搜索当前目录"]', "");
await page.click('th button:text-is("大小")');
await page.waitForFunction(
  () =>
    document.querySelector("tr[data-entry-path]")?.dataset.entryPath ===
    "file-2999.txt",
);
await page.click('tr[data-entry-path="file-2999.txt"] .file-name');
await page.click('button[aria-label="复制到"]');
await page.waitForSelector("#conflict-policy");
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".destination-folders > button").length,
  ),
  200,
);
await page.click('button:text-is("下一页")');
await page.waitForFunction(() =>
  document
    .querySelector(".destination-folders > button")
    ?.textContent.includes("folder-0200"),
);
await page.click('button:text-is("下一页")');
await page.waitForFunction(() =>
  document
    .querySelector(".destination-folders > button")
    ?.textContent.includes("folder-0400"),
);
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".destination-folders > button").length,
  ),
  50,
);
await page.selectOption("#conflict-policy", "overwrite");
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /目标独有的内容保留/,
);
await page.selectOption("#conflict-policy", "rename");
assert.equal(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
  true,
  "narrow layout fits viewport",
);
await page.click('button:text-is("开始复制")');
await page.waitForFunction(() => !document.querySelector("dialog"));
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.find((c) => c.command === "start_transfer").args
        .conflictPolicy,
  ),
  "rename",
);
await page.click('.volume-nav button[title="/source"]');
await page.waitForSelector('tr[data-entry-path="file-2999.txt"]');
await page.click('tr[data-entry-path="file-2999.txt"] .file-name');
await page.click('button[aria-label="重命名"]');
await page.selectOption("#conflict-policy", "skip");
await page.fill("dialog input.text-input", "existing.txt");
await page.click("dialog button.primary");
await page.waitForFunction(() => !document.querySelector("dialog"));
assert.match(
  await page.evaluate(() => document.querySelector(".notice").textContent),
  /跳过/,
);
assert.equal(
  await page.evaluate(
    () =>
      window.testCalls.find((c) => c.command === "rename_entry").args
        .conflictPolicy,
  ),
  "skip",
);
console.log(
  "PASS: 3000 rows, bounded DOM, pagination retry, virtual range selection, loaded-only select all, global search/sort, paginated destination folders, conflict policy IPC, skipped rename and 900px layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
