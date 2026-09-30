// Run with Vite: ego-browser nodejs < scripts/test-large-directory-streaming.mjs
// The fixture represents 50,000 objects; it generates only the requested page.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo large directory performance",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(() => {
localStorage.setItem('filo.browser-preferences', JSON.stringify({sort:'name',showHidden:false,showDetails:false,useGroups:false}));
window.isTauri=true; window.calls=[]; window.failMore=false;
const volume={id:'large',connection_id:'large',name:'Large bucket',root:{type:'s3',bucket:'test',prefix:''},read_only:false,capabilities:{hierarchy:'virtual_prefix',rename:'copy_then_delete',write:true,create_directory:true,delete:true,trash:false,native_open:false,native_copy:true}};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
window.calls.push({command,args});
if(command==='plugin:event|listen')return 1;
if(command==='plugin:event|unlisten')return;
if(command==='recent_backend_errors'||command==='list_transfers')return [];
if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
if(command==='list_volumes')return [volume];
if(command==='list_connections')return [{id:'large',name:'Large bucket',provider:'s3',config:{provider:'oss',endpoint:'https://oss-cn-hangzhou.aliyuncs.com',region:'cn-hangzhou',force_path_style:false}}];
if(command==='directory_stamp')return '1';
if(command==='list_entries_page'){
  const offset=Number(args.cursor||0);
  if(window.failMore && offset)throw {code:'network',message:'测试分页失败'};
  const streaming=args.options.sort==='provider'&&!args.options.search;
  const count=args.parent.logical_path==='small'?3:50000;
  const end=Math.min(offset+args.limit,count);
  const sparse=args.parent.logical_path==='sparse' && offset===0;
  let indices=Array.from({length:sparse?0:end-offset},(_,i)=>offset+i);
  if(args.options.sort==='size')indices=indices.map(i=>count-1-i);
  if(args.options.search)indices=args.options.search==='file-49999'?[49999]:[];
  const entries=indices.map(i=>({name:'file-'+String(i).padStart(5,'0')+'.txt',kind:'file',size:i,modified_at:null,metadata:{},locator:{volume_id:'large',logical_path:(args.parent.logical_path?args.parent.logical_path+'/':'')+'file-'+String(i).padStart(5,'0')+'.txt',version_id:null}}));
  return {entries,total:args.options.search?entries.length:streaming?(sparse?0:end):count,total_is_exact:!streaming||end===count,next_cursor:!args.options.search&&end<count?String(end):null};
}
throw new Error('Unexpected IPC: '+command);
}};
})();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button:has-text("Large bucket")');
await page.click('.volume-nav button:has-text("Large bucket")');
await page.waitForSelector('tr[data-entry-path="file-00000.txt"]');
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已加载 200 项.*快速浏览/,
);
assert.equal(
  await page.evaluate(
    () => window.calls.filter((c) => c.command === "list_entries_page").length,
  ),
  1,
);
assert.equal(
  await page.evaluate(
    () => window.calls.filter((c) => c.command === "directory_stamp").length,
  ),
  0,
  "remote polling is off",
);
assert.ok(
  await page.evaluate(
    () => document.querySelectorAll("tr[data-entry-path]").length < 60,
  ),
  "DOM is bounded",
);
await page.click('tr[data-entry-path="file-00000.txt"] .file-name');
await page.evaluate(() => {
  document.querySelector(".file-area").scrollTop = 145 * 29;
});
await page.waitForSelector('tr[data-entry-path="file-00150.txt"]');
await page.keyboard.down("Shift");
await page.click('tr[data-entry-path="file-00150.txt"] .file-name');
await page.keyboard.up("Shift");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 151 项/,
);
await page.keyboard.press("Meta+a");
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 200 项/,
);
await page.evaluate(() => {
  window.failMore = true;
  document.querySelector(".file-area").scrollTop = 100000;
});
await page.waitForSelector('button:text-is("重试加载")', { timeout: 20000 });
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /已选择 200 项/,
);
await page.evaluate(() => {
  window.failMore = false;
});
await page.click('button:text-is("重试加载")');
await page.waitForFunction(() =>
  document.querySelector(".statusbar").textContent.includes("已加载 400 项"),
);
await page.click('th button:text-is("大小")');
await page.waitForFunction(() =>
  window.calls.some(
    (c) => c.command === "list_entries_page" && c.args.options.sort === "size",
  ),
);
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /200 \/ 50000/,
);
await page.fill('input[aria-label="筛选当前目录"]', "file-49999");
await page.waitForFunction(() =>
  document.querySelector(".statusbar").textContent.includes("1 个项目"),
);
// Prefix navigation resets the browser to the fast mode even after global sorting.
const prefix = 'input[aria-label="桶内目录前缀"]';
await page.fill(prefix, "small/");
await page.press(prefix, "Enter");
await page.waitForFunction(() =>
  document.querySelector(".statusbar").textContent.includes("3 个项目"),
);
assert.match(
  await page.evaluate(() => document.querySelector(".statusbar").textContent),
  /快速浏览/,
);
await page.fill(prefix, "sparse/");
await page.press(prefix, "Enter");
await page.waitForFunction(() =>
  document.querySelector(".statusbar").textContent.includes("已加载 200 项"),
);
assert.equal(
  await page.evaluate(() => document.querySelector(".empty-state") === null),
  true,
  "a filtered empty page is not an empty directory",
);
// The display menu provides a way to switch back from global sorting.
await page.click('summary[aria-label="更多操作"]');
await page.click('button:has-text("查看显示选项…")');
await page.waitForSelector("#browser-sort");
await page.selectOption("#browser-sort", "name");
await page.selectOption("#browser-sort", "provider");
await page.click('dialog button:has-text("完成")');
for (const width of [1100, 760]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.ok(
    await page.evaluate(
      () => document.querySelectorAll("tr[data-entry-path]").length < 60,
    ),
  );
  assert.equal(
    await page.evaluate(() => {
      const r = document.querySelector(".pathbar-row");
      return r.scrollWidth <= r.clientWidth;
    }),
    true,
  );
}
await page.screenshot({ path: "/tmp/filo-large-directory-streaming.png" });
console.log(
  "PASS: 50,000 objects, first page only, no remote polling, bounded DOM, selection, retry, unknown/exact totals, global sort/search, prefix navigation, sparse pages and responsive layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
