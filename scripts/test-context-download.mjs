// With Vite running: ego-browser nodejs < scripts/test-context-download.mjs
// Storage and Downloads IPC are mocked; no real user files are accessed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo context download",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri = true;
window.jobs = [];
window.downloadCalls = [];
window.failNames = [];
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
const capabilities = {hierarchy:'native_directory',rename:'atomic',create_directory:true,write:true,delete:true,trash:true,native_open:true,native_copy:true};
const volumes = [
  {id:'local',name:'Local downloads',root:{type:'local',root_path:'/fixture/local'}},
  {id:'s3',name:'S3 downloads',root:{type:'s3',bucket:'fixture',prefix:''}},
  {id:'remote',name:'Remote downloads',root:{type:'remote',path:'/archive'},read_only:true}
].map(v=>({...v,connection_id:v.id,read_only:v.read_only??false,capabilities:{...capabilities,...(v.root.type!=='local'?{native_open:false}:{}),...(v.read_only?{write:false,delete:false}:{})}}));
window.__TAURI_INTERNALS__ = {
  metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
  transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
    if(command==='plugin:event|listen')return 1;
    if(command==='plugin:event|unlisten')return;
    if(command==='directory_stamp')return '1';
    if(command==='recent_backend_errors'||command==='list_connections')return [];
    if(command==='list_volumes')return volumes;
    if(command==='list_transfers')return window.jobs.map(job=>({...job}));
    if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
    if(command==='list_entries_page')return {entries:[
      {name:'DSC_6219.NEF',kind:'file'}, {name:'DSC_6225.NEF',kind:'file'},
      {name:'DSC_6219.xmp',kind:'file'}, {name:'Folder',kind:'directory'}
    ].map(e=>({...e,size:e.kind==='file'?1000:null,modified_at:null,locator:{volume_id:args.parent.volume_id,logical_path:e.name,version_id:null}})),total:4,next_cursor:null};
    if(command==='download_files'){
      window.downloadCalls.push(args.sources);
      const batch={jobs:[],failures:[]};
      for(const source of args.sources){
        if(window.failNames.includes(source.logical_path)){
          batch.failures.push(source.logical_path+'：无法读取文件');
          continue;
        }
        const id='download-'+(window.jobs.length+1);
        const job={id,kind:'copy',state:'running',source,destination:{volume_id:'native-'+id,logical_path:source.logical_path,version_id:null},bytes_total:1000,bytes_transferred:250,error_code:null,error_message:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
        window.jobs.push(job);
        batch.jobs.push({...job});
        args.onProgress.onmessage({...job});
      }
      window.finishDownloads=()=>{
        for(const job of batch.jobs){
          Object.assign(job,{state:'completed',bytes_transferred:1000,updated_at:new Date().toISOString()});
          Object.assign(window.jobs.find(existing=>existing.id===job.id),job);
          args.onProgress.onmessage({...job});
        }
      };
      if(window.holdBatch)await new Promise(resolve=>window.releaseBatch=resolve);
      return batch;
    }
    throw new Error('Unexpected IPC: '+command);
  }
};
`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
await page.waitForSelector('.volume-nav button:has-text("Local downloads")');
await page.click('.volume-nav button:has-text("Local downloads")');
const row = (name) => `[data-entry-path="${name}"]`;
await page.waitForSelector(row("DSC_6219.NEF"));
const select = async (names) => {
  await page.click(row(names[0]));
  for (const name of names.slice(1)) {
    await page.keyboard.down("ControlOrMeta");
    await page.click(row(name));
    await page.keyboard.up("ControlOrMeta");
  }
};
const openMenu = async (name = "DSC_6219.NEF") => {
  const point = await page.evaluate((name) => {
    const rect = document
      .querySelector(`[data-entry-path="${name}"]`)
      .getBoundingClientRect();
    return { x: rect.left + 70, y: rect.top + rect.height / 2 };
  }, name);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForSelector(".entry-menu");
};
const download = 'loc=role:menuitem[name="下载"]';
const files = ["DSC_6219.NEF", "DSC_6225.NEF", "DSC_6219.xmp"];
await select(files);
await openMenu();
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector('.entry-menu button[title="保存到系统下载目录"]')
        .disabled,
  ),
  false,
);
await page.click(download);
await page.waitForFunction(() => window.downloadCalls.length === 1);
assert.deepEqual(
  await page.evaluate(() =>
    window.downloadCalls[0].map((source) => source.logical_path),
  ),
  files,
);
await page.waitForSelector('[data-transfer-id="download-3"]');
assert.equal(
  await page.evaluate(() => !!document.querySelector(".file-table")),
  true,
);
assert.match(
  await page.evaluate(
    () => document.querySelector('[data-transfer-id="download-1"]').textContent,
  ),
  /下载/,
);
await page.evaluate(() => window.finishDownloads());
await page.waitForSelector(
  '[data-transfer-id="download-1"] button[aria-label="打开文件"]',
);
// A mixed selection cannot accidentally download only part of the selection.
await select(["DSC_6219.NEF", "Folder"]);
await openMenu();
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector('.entry-menu button[title="保存到系统下载目录"]')
        .disabled,
  ),
  true,
);
await page.keyboard.press("Escape");
for (const [name, id] of [
  ["S3 downloads", "s3"],
  ["Remote downloads", "remote"],
]) {
  await page.click(`.volume-nav button:has-text("${name}")`);
  await page.waitForSelector(row(files[0]));
  await select(files.slice(0, 2));
  await openMenu();
  await page.click(download);
  await page.waitForFunction(
    (id) => window.downloadCalls.at(-1)?.[0].volume_id === id,
    id,
  );
  assert.equal(
    await page.evaluate(() => window.downloadCalls.at(-1).length),
    2,
  );
}
// Submission failures keep successful jobs visible and explain what did not start.
await page.evaluate(() => {
  window.failNames = ["DSC_6225.NEF"];
});
await openMenu();
await page.click(download);
await page.waitForFunction(() =>
  document
    .querySelector("#floating-notices")
    ?.textContent.includes("已提交 1 项，1 项未开始"),
);
// Reopening the menu while the batch is being submitted cannot submit it twice.
await page.evaluate(() => {
  window.failNames = [];
  window.holdBatch = true;
});
await openMenu();
await page.click(download);
await page.waitForFunction(() => typeof window.releaseBatch === "function");
await openMenu();
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector('.entry-menu button[title="保存到系统下载目录"]')
        .disabled,
  ),
  true,
);
await page.keyboard.press("Escape");
await page.evaluate(() => window.releaseBatch());
console.log(
  "PASS: local/S3/read-only remote multi-downloads, all selected sources, existing transfer progress and file actions, folder gating, partial failure and duplicate submission guard",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
