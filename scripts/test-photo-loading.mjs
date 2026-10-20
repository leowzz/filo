// Run with ego-browser nodejs on stdin. No real storage is accessed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoLoadingSpace ?? "Filo review loading QA",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    const root = {volume_id:'photos',logical_path:'trip',version_id:null};
    const photo = {id:'one',archive_id:'archive',original_path:'one.jpg',capture_date:null,
      issues:[],files:[{id:'file',kind:'jpg',path:'one.jpg',size:100,sha256:'',verified:false,error:null}],
      rating:0,flag:'none',excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null};
    const session = {id:'review',archive_id:'archive',name:'trip',card_name:'',created_at:'2026-10-20',
      source:null,directory:root,photo_ids:['one'],revision:1,synced_revision:1,nas_hash:'saved',
      sync_error:null,handed_off:false,undo:[],layout:'original',keep_hierarchy:true,
      position:{current:'one',sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false,raw_only:false}};
    window.catalog={photos:[],sessions:[],archives:[],preset:null};
    window.cancelCalls=[];
    window.progress = stage => {
      window.scan.registered=true;
      window.scan.args.onProgress.onmessage({stage,found:0,completed:0,total:null,path:'trip'});
    };
    window.complete = () => {
      window.catalog={photos:[photo],sessions:[session],archives:[],preset:null};
      window.scan.resolve(structuredClone(session));
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args={})=>{
        if (command==='list_volumes') return [{id:'photos',connection_id:'photos',name:'Photos',read_only:false,
          root:{type:'remote',path:''},capabilities:{hierarchy:'directory_tree',rename:'native',
            create_directory:true,delete:true,trash:false,native_open:false,native_copy:false}}];
        if (['recent_backend_errors','list_connections','list_transfers'].includes(command)) return [];
        if (command==='get_credential_settings') return {mode:'plain',locked:false,legacy_import_available:false};
        if (command==='get_transfer_settings') return {upload_kib_per_second:0,download_kib_per_second:0};
        if (command==='plugin:event|listen') return 1;
        if (command==='plugin:event|unlisten') return;
        if (command==='directory_stamp') return '1';
        if (command==='list_entries_page') return {total:1,total_is_exact:true,next_cursor:null,entries:[{
          name:'one.jpg',kind:'file',size:100,modified_at:null,locator:{...args.parent,logical_path:'one.jpg'}}]};
        if (command==='review_catalog') return structuredClone(window.catalog);
        if (command==='review_scan') return new Promise((resolve,reject)=>window.scan={args,resolve,reject,registered:false});
        if (command==='review_cancel_scan') {
          window.cancelCalls.push(args.requestId);
          if(window.scan.registered) window.scan.reject({code:'cancelled',message:'cancelled'});
          return;
        }
        if (command==='review_save_position') return;
        if (command==='review_preview') return {mime:'image/svg+xml',width:800,height:600,embedded:false,
          content:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#56798c"/></svg>')};
        throw new Error('Unexpected IPC: '+command);
      }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 850,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.click('.volume-nav button:has-text("Photos")');
const open = async () => {
  await page.click('.toolbar-actions button:has-text("进入审图")');
  await page.waitForSelector(".review-opening");
};
await open();
assert.deepEqual(
  await page.evaluate(() => ({
    table: !!document.querySelector(".file-table"),
    modal: !!document.querySelector("dialog[open]"),
    text: document.querySelector(".review-opening").textContent,
    canCancel: !document.querySelector(".review-scan-cancel").disabled,
  })),
  { table: true, modal: false, text: "正在打开照片…取消", canCancel: true },
);
await page.click(".review-scan-cancel");
await page.waitForFunction(() => window.cancelCalls.length === 1);
assert.equal(
  await page.evaluate(
    () => document.querySelector(".review-scan-cancel").disabled,
  ),
  true,
);
await page.evaluate(() => window.progress("connecting"));
await page.waitForFunction(() => !document.querySelector(".review-opening"));
assert.equal(
  await page.evaluate(() => window.cancelCalls.length),
  2,
  "cancellation is repeated after backend registration",
);

await open();
await page.evaluate(() => window.progress("listing"));
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".review-opening"));
assert.equal(await page.evaluate(() => window.cancelCalls.length), 3);

await open();
await page.evaluate(() => window.progress("saving"));
await page.waitForFunction(
  () => document.querySelector(".review-scan-cancel").disabled,
);
await page.keyboard.press("Escape");
assert.equal(
  await page.evaluate(() => window.cancelCalls.length),
  3,
  "publication cannot be interrupted",
);
await page.evaluate(() => window.complete());
await page.waitForSelector(".photo-stage img");
assert.equal(
  await page.evaluate(() => !!document.querySelector(".review-opening")),
  false,
);

await page.click('.photo-review-toolbar button:text-is("返回文件夹")');
await open();
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 940,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
});
assert.equal(
  await page.evaluate(() => {
    const rect = document
      .querySelector(".review-opening")
      .getBoundingClientRect();
    return (
      rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
    );
  }),
  true,
);
await page.cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
assert.equal(
  await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".review-scan-spinner"))
        .animationName,
  ),
  "none",
);
await page.evaluate(() =>
  window.scan.reject({ code: "network", message: "照片目录连接失败" }),
);
await page.waitForFunction(() => !document.querySelector(".review-opening"));
await page.waitForFunction(() =>
  document
    .querySelector(".floating-notice")
    ?.textContent.includes("照片目录连接失败"),
);
console.log({
  passed:
    "compact non-modal loading, immediate cancel, late registration, Escape, protected publication, success, failure, narrow viewport, reduced motion",
});
await task.finish({ keep: [] });
