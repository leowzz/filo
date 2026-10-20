// Synthetic desktop IPC. Real file selection/copy/persistence is covered in Rust.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoExportSpace ?? "Filo RAW export");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
  window.isTauri = true;
  sessionStorage.setItem('filo.review-session', 'review');
  const root = {volume_id:'photos', logical_path:'', version_id:null};
  const session = {id:'review',archive_id:'archive',name:'Photos',card_name:'',created_at:'2026-10-20',
    source:null,directory:root,photo_ids:['one'],revision:1,synced_revision:1,nas_hash:'saved',sync_error:null,
    handed_off:false,position:{current:'one',sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false},
    undo:[],layout:'original',keep_hierarchy:true,
    last_export:{directory:'/previous/export',exported_at:'2026-10-20T01:00:00Z',total:1,copied:1,skipped:0,failures:[]}};
  window.catalog={sessions:[session],photos:[{id:'one',archive_id:'archive',original_path:'one.NEF',
    capture_date:null,issues:[],files:[{id:'raw',kind:'raw',original_name:'one.NEF',path:'one.NEF',
    sha256:'',size:100,verified:false,error:null}],rating:3,flag:'none',excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null}],
    archives:[],preset:null};
  if (!sessionStorage.getItem('filo.export-fixture-initialized')) {
    sessionStorage.setItem('filo.export-fixture-original', localStorage.getItem('filo.photo-export-directories') ?? 'null');
    localStorage.setItem('filo.photo-export-directories', JSON.stringify({directories:[],selectedPath:null}));
    sessionStorage.setItem('filo.export-fixture-initialized', 'true');
  }
  window.exportCalls=[]; window.pickCalls=0; window.pickCancelled=false; window.holdExport=false;
  window.nextDirectory={locator:{volume_id:'export',logical_path:'',version_id:null},path:'/destination/精选照片'};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
    transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args={})=>{
      if(command==='list_volumes') return [{id:'photos',connection_id:'photos',name:'Photos',read_only:false,
        root:{type:'local',root_path:'/fixture/photos'},capabilities:{hierarchy:'directory_tree',rename:'native',
        create_directory:true,delete:true,trash:false,native_open:false,native_copy:false}}];
      if(['recent_backend_errors','list_connections','list_transfers'].includes(command)) return [];
      if(command==='get_credential_settings') return {mode:'plain',locked:false,legacy_import_available:false};
      if(command==='get_transfer_settings') return {upload_kib_per_second:0,download_kib_per_second:0};
      if(command==='photo_has_active_imports') return false;
      if(command==='plugin:event|listen') return 1;
      if(command==='review_catalog') return structuredClone(window.catalog);
      if(command==='photo_catalog') return {sessions:[],photos:[],archives:[],preset:null};
      if(command==='directory_stamp') return '1';
      if(command==='list_entries_page') return {entries:[],total:0,total_is_exact:true,next_cursor:null};
      if(command==='review_scan') return structuredClone(session);
      if(command==='review_save_position') { session.position=args.position; return; }
      if(command==='photo_pick_directory') { window.pickCalls++; return window.pickCancelled ? null : structuredClone(window.nextDirectory); }
      if(command==='review_export') {
        window.exportCalls.push(args);
        args.onProgress.onmessage({session_id:'review',completed:0,total:2,path:'one.NEF'});
        if(window.holdExport) await new Promise(resolve=>window.releaseExport=resolve);
        session.last_export={directory:args.destination.volume_id==='export' ? '/destination/精选照片' : '/second/精修',filter:args.filter,exported_at:'2026-10-20T09:00:00Z',
          total:2,copied:1,skipped:0,failures:['nested/two.NEF：目标已有不同内容的同名文件，未覆盖']};
        return structuredClone(session.last_export);
      }
      if(command==='review_preview') return {mime:'image/svg+xml',
        content:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#56798c"/></svg>'),
        width:800,height:600,embedded:false};
      return null;
    }};
})();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 850,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto(globalThis.filoExportUrl ?? "http://127.0.0.1:1420");
await page.click('.main-nav button:text-is("审图")');
await page.click('.photo-session-toolbar button:text-is("继续审图")');
await page.waitForSelector(".photo-stage img");
await page.click('.photo-review-toolbar button:text-is("导出到目录")');
await page.waitForSelector("dialog[open]");
const controls = await page.evaluate(() => [...document.querySelectorAll("dialog select")].map(select => ({
  appearance: getComputedStyle(select).appearance,
  height: select.getBoundingClientRect().height,
  hasChevron: !!select.parentElement.querySelector("svg"),
})));
assert.ok(controls.every(control => control.appearance === "none" && control.height === 38 && control.hasChevron), "all export selectors use styled controls");
assert.equal(
  await page.evaluate(
    () => document.querySelector('select[aria-label="星级条件"]').value,
  ),
  "at_least",
);
assert.equal(
  await page.evaluate(
    () => document.querySelector('select[aria-label="导出星级"]').value,
  ),
  "3",
);
assert.equal(
  await page.evaluate(() => document.querySelector("dialog .primary").disabled),
  true,
);
await page.evaluate(() => {
  window.pickCancelled = true;
});
await page.click('dialog button:text-is("添加目录")');
await page.waitForFunction(
  () => !document.querySelector("dialog fieldset").disabled,
);
assert.equal(await page.evaluate(() => window.exportCalls.length), 0);
assert.equal(
  await page.evaluate(() => document.querySelector("dialog .primary").disabled),
  true,
);
await page.evaluate(() => {
  window.pickCancelled = false;
});
await page.click('dialog button:text-is("添加目录")');
await page.waitForSelector(
  '.photo-export-directory-choice[aria-pressed="true"]',
);
assert.equal(
  await page.evaluate(() => window.exportCalls.length),
  0,
  "selecting a directory must not copy files",
);
await page.evaluate(() => {
  window.nextDirectory = {
    locator: { volume_id: "second", logical_path: "", version_id: null },
    path: "/second/精修",
  };
});
await page.click('dialog button:text-is("添加目录")');
await page.waitForFunction(
  () =>
    document.querySelectorAll(".photo-export-directory-choice").length === 2,
);
await page.selectOption('select[aria-label="星级条件"]', "at_most");
await page.selectOption('select[aria-label="导出星级"]', "2");
await page.selectOption('select[aria-label="导出旗标"]', "pick");
await page.evaluate(() => {
  window.holdExport = true;
});
await page.click('dialog button:text-is("开始导出")');
await page.waitForSelector("dialog progress");
assert.deepEqual(await page.evaluate(() => window.exportCalls[0].filter), {
  rating_mode: "at_most",
  rating: 2,
  flag: "pick",
});
assert.equal(
  await page.evaluate(() => window.exportCalls[0].destination.volume_id),
  "second",
);
assert.equal(
  await page.evaluate(() => window.pickCalls),
  3,
  "export reuses the selected directory without a picker",
);
assert.equal(
  await page.evaluate(() => document.querySelector("dialog .primary").disabled),
  true,
);
assert.equal(
  await page.evaluate(() => document.querySelector("dialog fieldset").disabled),
  true,
);
await page.keyboard.press("Escape");
assert.equal(
  await page.evaluate(() => !!document.querySelector("dialog[open]")),
  true,
);
await page.evaluate(() => window.releaseExport());
await page.waitForSelector("dialog details");
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /部分导出完成/,
);
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 800,
  height: 650,
  deviceScaleFactor: 1,
  mobile: false,
});
const layout = await page.evaluate(() => {
  const dialog = document.querySelector("dialog");
  const rect = dialog.getBoundingClientRect();
  const selects = [
    ...dialog.querySelectorAll(".photo-export-rating select"),
  ].map((e) => e.getBoundingClientRect().toJSON());
  return {
    left: rect.left,
    right: rect.right,
    width: innerWidth,
    overflow: dialog.scrollWidth > dialog.clientWidth,
    selects,
  };
});
assert.ok(layout.left >= 0 && layout.right <= layout.width);
assert.equal(layout.overflow, false);
assert.equal(layout.selects[0].top, layout.selects[1].top);
assert.equal(layout.selects[0].height, layout.selects[1].height);
assert.ok(layout.selects[0].height >= 36, "export form styles must be loaded");
await page.click('dialog .modal-actions button:text-is("关闭")');
await page.click(".photo-review-back");
await page.waitForSelector(".photo-handoff");
assert.match(
  await page.evaluate(
    () => document.querySelector(".photo-handoff").textContent,
  ),
  /second\/精修/,
);
await page.click('.photo-session-toolbar button:text-is("导出到目录")');
await page.waitForSelector("dialog[open]");
assert.equal(
  await page.evaluate(
    () => document.querySelector('select[aria-label="导出星级"]').value,
  ),
  "3",
);
assert.equal(
  await page.evaluate(
    () => document.querySelector('select[aria-label="星级条件"]').value,
  ),
  "at_least",
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector(
        '.photo-export-directory-choice[aria-pressed="true"]',
      ).textContent,
  ),
  /second\/精修/,
);
await page.click(
  '.photo-export-directory-choice:has-text("/destination/精选照片")',
);
await page.selectOption('select[aria-label="星级条件"]', "any");
assert.equal(
  await page.evaluate(
    () => document.querySelector('select[aria-label="导出星级"]').disabled,
  ),
  true,
);
await page.evaluate(() => {
  window.holdExport = false;
});
await page.click('dialog button:text-is("开始导出")');
await page.waitForSelector("dialog details");
assert.equal(
  await page.evaluate(() => window.exportCalls[1].destination.volume_id),
  "export",
);
assert.equal(
  await page.evaluate(() => window.exportCalls[1].filter.rating_mode),
  "any",
);
await page.click('dialog .modal-actions button:text-is("关闭")');
await page.goto(globalThis.filoExportUrl ?? "http://127.0.0.1:1420");
await page.click('.main-nav button:text-is("审图")');
await page.click('.photo-session-toolbar button:text-is("导出到目录")');
await page.waitForSelector("dialog[open]");
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".photo-export-directory-choice").length,
  ),
  2,
);
assert.match(
  await page.evaluate(
    () =>
      document.querySelector(
        '.photo-export-directory-choice[aria-pressed="true"]',
      ).textContent,
  ),
  /destination\/精选照片/,
);
assert.equal(
  await page.evaluate(() => window.pickCalls),
  0,
  "restoring saved directories requires no picker",
);
await page.evaluate(() => {
  window.nextDirectory = {
    locator: { volume_id: "export", logical_path: "", version_id: null },
    path: "/destination/精选照片",
  };
});
await page.click('dialog button:text-is("添加目录")');
await page.waitForFunction(
  () => !document.querySelector("dialog fieldset").disabled,
);
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".photo-export-directory-choice").length,
  ),
  2,
  "reselecting a directory does not duplicate it",
);
await page.click('button[aria-label="移除常用目录 /destination/精选照片"]');
assert.match(
  await page.evaluate(
    () =>
      document.querySelector(
        '.photo-export-directory-choice[aria-pressed="true"]',
      ).textContent,
  ),
  /second\/精修/,
);
await page.evaluate(() =>
  localStorage.setItem(
    "filo.photo-export-directories",
    sessionStorage.getItem("filo.export-fixture-original"),
  ),
);
console.log({
  passed:
    "rating and flag form, cancel/add/switch/remove directories, persisted defaults after reload, progress, partial failures and narrow layout",
  layout,
});
if (!globalThis.filoKeepExportSpace) await task.finish({ keep: [] });
