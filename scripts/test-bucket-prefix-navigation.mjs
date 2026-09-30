// Run against Vite with: ego-browser nodejs < scripts/test-bucket-prefix-navigation.mjs
// All storage IPC is mocked; no real buckets or credentials are accessed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo OSS and prefix navigation",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.listings=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
const volumes=['bucket','scoped'].map(id=>({id,connection_id:id,name:id,root:{type:'s3',bucket:'test-bucket',prefix:id==='scoped'?'ugc/character':''},read_only:false,capabilities:{hierarchy:'virtual_prefix',rename:'copy_then_delete',create_directory:true,write:true,delete:true,trash:false,native_open:false,native_copy:true}}));
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
  if(command==='plugin:event|listen')return 1;
  if(command==='plugin:event|unlisten')return;
  if(command==='directory_stamp')return '1';
  if(command==='list_volumes')return volumes;
  if(command==='list_connections')return volumes.map(v=>({id:v.id,name:v.name,provider:'s3',config:{provider:'oss',endpoint:'https://s3.oss-us-southeast-1.aliyuncs.com',region:'us-southeast-1',force_path_style:false}}));
  if(command==='list_transfers'||command==='recent_backend_errors')return [];
  if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
  if(command==='list_entries_page'){
    window.listings.push(args.parent);
    if(args.parent.logical_path==='failed')throw {message:'目录读取失败'};
    return {entries:[],total:0,next_cursor:null};
  }
  throw new Error('Unexpected IPC: '+command);
}};`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1422");
await page.waitForSelector('.volume-nav button:has-text("bucket")');
await page.click('.volume-nav button:has-text("bucket")');
const input = 'input[aria-label="桶内目录前缀"]';
await page.waitForSelector(input);
const jump = async (prefix, expected, volumeId = "bucket") => {
  await page.fill(input, prefix);
  await page.press(input, "Enter");
  await page.waitForFunction(
    ({ expected, volumeId }) =>
      window.listings.at(-1)?.logical_path === expected &&
      window.listings.at(-1)?.volume_id === volumeId,
    { expected, volumeId },
  );
};
await jump("ugc/character/20260930/", "ugc/character/20260930");
assert.equal(
  await page.evaluate(
    () => document.querySelector('input[aria-label="桶内目录前缀"]').value,
  ),
  "ugc/character/20260930/",
);
await jump("/other//folder/", "other/folder");
await page.click('button[aria-label="后退"]');
await page.waitForFunction(
  () =>
    document.querySelector('input[aria-label="桶内目录前缀"]').value ===
    "ugc/character/20260930/",
);
await page.click('button[aria-label="前进"]');
await page.waitForFunction(
  () =>
    document.querySelector('input[aria-label="桶内目录前缀"]').value ===
    "other/folder/",
);
await page.fill(input, "temporary/");
await page.press(input, "Escape");
assert.equal(
  await page.evaluate(
    () => document.querySelector('input[aria-label="桶内目录前缀"]').value,
  ),
  "other/folder/",
);
await jump("", "");
await page.fill(input, "clicked/");
await page.click(".bucket-prefix-controls button");
await page.waitForFunction(
  () => window.listings.at(-1)?.logical_path === "clicked",
);
for (const prefix of ["../escape/", "https://example.com/", "folder\\child/"]) {
  await page.fill(input, prefix);
  await page.press(input, "Enter");
  await page.waitForSelector(".bucket-prefix-error");
  assert.equal(
    await page.evaluate(() => window.listings.at(-1).logical_path),
    "clicked",
  );
}
await page.click('.volume-nav button:has-text("scoped")');
await page.waitForFunction(
  () =>
    document.querySelector('input[aria-label="桶内目录前缀"]').value ===
    "ugc/character/",
);
await jump("ugc/character/20260930/", "20260930", "scoped");
await page.fill(input, "ugc/characters/outside/");
await page.press(input, "Enter");
await page.waitForSelector(".bucket-prefix-error");
assert.equal(
  await page.evaluate(() => window.listings.at(-1).logical_path),
  "20260930",
);
await jump("ugc/character/", "", "scoped");
await jump("", "", "scoped");
assert.equal(
  await page.evaluate(
    () => document.querySelector('input[aria-label="桶内目录前缀"]').value,
  ),
  "ugc/character/",
);
// The editor recognizes previously generated S3 addresses and shows native OSS URLs.
await page.evaluate(() =>
  document
    .querySelector(".volume-nav button")
    .dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 180,
      }),
    ),
);
await page.click('[role=menuitem]:has-text("编辑连接")');
await page.waitForSelector("dialog h2");
assert.equal(
  await page.evaluate(
    () => document.querySelector(".s3-endpoint-control input").value,
  ),
  "https://oss-us-southeast-1.aliyuncs.com",
);
await page.click('button[aria-label="关闭"]');
for (const width of [1100, 760]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const geometry = await page.evaluate(() => {
    const row = document.querySelector(".pathbar-row");
    const controls = document.querySelector(".bucket-prefix-controls");
    const input = controls.querySelector("input").getBoundingClientRect();
    const button = controls.querySelector("button").getBoundingClientRect();
    return {
      overflow: row.scrollWidth > row.clientWidth,
      inputWidth: input.width,
      alignment: Math.abs(
        input.top + input.height / 2 - (button.top + button.height / 2),
      ),
    };
  });
  assert.equal(geometry.overflow, false);
  assert.ok(geometry.inputWidth > 150);
  assert.ok(geometry.alignment < 1);
}
await page.screenshot({ path: "/tmp/filo-prefix-navigation.png" });
console.log(
  "PASS: prefix jump, Enter/button, trailing slash, history, Escape, root, invalid paths, scope boundary, legacy OSS endpoint and responsive layout",
);
