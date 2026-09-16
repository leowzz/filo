// IPC fixtures; no real files, buckets or credentials are changed.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo advanced browsing regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(()=>{
window.isTauri=true;window.calls=[];window.stamp='1';window.added=false;window.versioning='Enabled';window.meta={project:'demo'};window.tags={purpose:'test'};
const volume={id:'s3',connection_id:'s3',name:'RustFS',read_only:false,root:{type:'s3',bucket:'test-bucket',prefix:''},capabilities:{hierarchy:'virtual_prefix',rename:'copy_then_delete',create_directory:true,write:true,delete:true,recursive_delete:true,native_open:false}};
const entry=name=>({name,kind:'file',size:100,modified_at:'2026-09-16T00:00:00Z',etag:'original',locator:{volume_id:'s3',logical_path:name,version_id:null}});
window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
      if (command === 'recent_backend_errors') return [];
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return;
window.calls.push({command,args});
if(command==='list_volumes')return [volume];if(command==='list_transfers')return [];
if(command==='directory_stamp')return window.stamp;
if(command==='list_entries_page'){const entries=['note.txt','photo.png',...(window.added?['new.txt']:[])].map(entry);return {entries,total:entries.length,next_cursor:null};}
if(command==='preview_entry')return args.locator.logical_path==='photo.png'?{kind:'image',mime:'image/png',content:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1cAAAAASUVORK5CYII=',truncated:false}:{kind:'text',mime:'text/plain',content:'hello <script>window.bad=true</script> 中文',truncated:false};
if(command==='start_content_search')return 'search1';
if(command==='content_search_status')return {id:'search1',done:true,cancelled:args.cancel,limited:false,hits:[{entry:entry('note.txt'),line:2,snippet:'hello 中文'}],scanned:3,skipped:1,errors:[]};
if(command==='manage_s3'){const a=args.action;
if(a.action==='bucket_status')return {bucket:'test-bucket',versioning:window.versioning};
if(a.action==='properties')return {etag:'original',content_type:'text/plain',metadata:window.meta};
if(a.action==='tags')return window.tags;
if(a.action==='acl')return {owner:'test-owner',grants:[{id:'test-owner',permission:'FULL_CONTROL'}]};
if(a.action==='versions')return {versions:[{key:'note.txt',version_id:'v1',latest:true,delete_marker:false,size:100,modified:'2026-09-16'},{key:'removed.txt',version_id:'v2',latest:true,delete_marker:true,size:0,modified:'2026-09-16'}],next_key:null,next_version:null};
if(a.action==='share')return {url:'http://localhost/example?test-signed-link',expires:a.expires};
if(a.action==='set_metadata')window.meta=a.metadata;
if(a.action==='set_tags')window.tags=a.tags;
if(a.action==='set_versioning')window.versioning=a.enabled?'Enabled':'Suspended';
if(a.action==='delete_bucket')throw {message:'Bucket 仍包含对象、历史版本或删除标记，未删除'};
return null;}
throw new Error('Unexpected IPC: '+command);
}};
})();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 960,
  height: 700,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector(".volume-nav button");
await page.click('.volume-nav button:has-text("RustFS")');
await page.waitForSelector(".file-thumbnail");
await page.click('tr[data-entry-path="note.txt"] .file-name');
await page.click('button[aria-label="预览"]');
await page.waitForSelector(".text-preview");
assert.match(
  await page.evaluate(
    () => document.querySelector(".text-preview").textContent,
  ),
  /<script>/,
);
assert.equal(
  await page.evaluate(() => window.bad === true),
  false,
  "preview never executes HTML",
);
await page.click('dialog button[aria-label="关闭"]');
await page.click('button[aria-label="搜索文件内容"]');
await page.fill("#content-query", "hello");
await page.click('button:text-is("开始搜索")');
await page.waitForSelector(".content-results button");
await page.click(".content-results button");
await page.waitForSelector(".text-preview");
await page.click('dialog:has(.preview-content) button[aria-label="关闭"]');
await page.click('dialog button[aria-label="关闭"]');
await page.click('summary[aria-label="更多操作"]');
await page.click('.browser-actions-popover button:text-is("对象管理…")');
await page.waitForSelector(".version-list article");
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".version-list article").length,
  ),
  1,
  "object versions exclude other keys",
);
await page.click('[role="tab"]:text-is("分享链接")');
await page.click('button:text-is("生成下载链接")');
await page.waitForSelector(".share-link");
assert.match(
  await page.evaluate(() => document.querySelector(".share-link").value),
  /test-signed-link/,
);
await page.click('[role="tab"]:text-is("Metadata")');
await page.waitForSelector(".property-pairs");
await page.fill('input[aria-label="值 1"]', "updated");
await page.click('button:text-is("保存 Metadata")');
await page.waitForFunction(() => window.meta.project === "updated");
await page.click('[role="tab"]:text-is("标签")');
await page.waitForSelector(".property-pairs");
await page.fill('input[aria-label="值 1"]', "changed");
await page.click('button:text-is("保存标签")');
await page.waitForFunction(() => window.tags.purpose === "changed");
await page.click('[role="tab"]:text-is("访问权限")');
await page.waitForSelector(".acl-details");
assert.equal(
  await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "保存权限",
      ).disabled,
  ),
  true,
);
await page.fill("dialog input.text-input", "note.txt");
await page.click('button:text-is("保存权限")');
await page.waitForFunction(() =>
  window.calls.some((c) => c.args?.action?.action === "set_acl"),
);
await page.click('dialog button[aria-label="关闭"]');
await page.click('summary[aria-label="更多操作"]');
await page.click('.browser-actions-popover button:text-is("Bucket 管理…")');
await page.waitForSelector('button:text-is("启用版本控制")');
assert.equal(
  await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "删除空 Bucket",
      ).disabled,
  ),
  true,
);
await page.fill("dialog input.text-input >> nth=0", "test-bucket");
await page.click('button:text-is("暂停版本控制")');
await page.waitForFunction(() => window.versioning === "Suspended");
await page.fill("dialog input.text-input >> nth=0", "test-bucket");
await page.click('button:text-is("删除空 Bucket")');
await page.waitForSelector('dialog [role="alert"]');
assert.match(
  await page.evaluate(
    () => document.querySelector('dialog [role="alert"]').textContent,
  ),
  /仍包含/,
);
await page.click('[role="tab"]:text-is("历史版本")');
await page.waitForSelector(".version-list article");
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".version-list article").length,
  ),
  2,
  "bucket versions include deleted objects",
);
await page.click(
  '.version-list article:nth-child(2) button:text-is("永久删除版本")',
);
assert.equal(
  await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "确认永久删除",
      ).disabled,
  ),
  true,
);
await page.fill('input[aria-label="确认对象名称"]', "removed.txt");
await page.click('button:text-is("确认永久删除")');
await page.waitForFunction(() =>
  window.calls.some(
    (c) =>
      c.args?.action?.action === "delete_version" &&
      c.args.locator.logical_path === "removed.txt",
  ),
);
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
  "960px viewport fits",
);
await page.click('dialog button[aria-label="关闭"]');
await page.evaluate(() => {
  window.added = true;
  window.stamp = "2";
});
await page.waitForSelector('tr[data-entry-path="new.txt"]', { timeout: 20000 });
console.log(
  "PASS: safe preview, thumbnails, content search + result preview, S3 properties/tags/ACL, sharing, bucket/version confirmation, deleted keys, automatic refresh and narrow layout",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
