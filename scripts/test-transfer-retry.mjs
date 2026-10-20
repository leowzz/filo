// With Vite running: ego-browser nodejs < scripts/test-transfer-retry.mjs
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo transfer retry regression",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.retryCalls=[];
const locator=(id,path)=>({volume_id:id,logical_path:path,version_id:null});
const caps={hierarchy:'native_directory',rename:'atomic',create_directory:true,delete:true,trash:true,native_open:true,native_copy:true};
window.jobs=['failed','interrupted','completed','cancelled','failed'].map((state,i)=>({
 id:String(i),kind:'copy',state,source:locator('nas',i===0?'long-filename-'.repeat(20)+'.NEF':'RAW/photo-'+i+'.NEF'),
 destination:locator(i===4?'selected-local':'local','pictures/photo-'+i+'.NEF'),
 bytes_total:1000,bytes_transferred:500,error_code:state==='failed'?'Io':null,error_message:state==='failed'?'连接中断':null,
 created_at:'2026-10-20T01:00:00Z',updated_at:'2026-10-20T01:00:01Z'
}));
let tick=2;
window.advanceRetry=(id,state)=>{
 const job=window.jobs.find(job=>job.id===id);
 Object.assign(job,{state,updated_at:new Date(Date.UTC(2026,9,20,1,0,tick++)).toISOString()});
 window.retryObservers[id]({...job});
};
window.retryObservers={};
window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(cmd,args)=>{
 if(cmd==='list_transfers')return window.jobs.map(job=>({...job}));
 if(cmd==='list_volumes')return [
  {id:'nas',connection_id:'nas',name:'NAS 照片',read_only:false,root:{type:'remote',path:'photos'},capabilities:{...caps,native_open:false}},
  {id:'local',connection_id:'local',name:'本地照片',read_only:false,root:{type:'local',root_path:'/tmp/filo-test'},capabilities:caps}
 ];
 if(cmd==='retry_transfer'){
  window.retryCalls.push({jobId:args.jobId,policy:args.conflictPolicy});
  if(window.retryError)throw new Error('找不到原文件，请重新连接来源');
  if(window.holdRetry)await new Promise(resolve=>window.releaseRetry=resolve);
  const job=window.jobs.find(job=>job.id===args.jobId);
  window.retryObservers[job.id]=args.onProgress.onmessage;
  Object.assign(job,{state:'queued',bytes_transferred:0,error_code:null,error_message:null,updated_at:new Date(Date.UTC(2026,9,20,1,0,tick++)).toISOString()});
  const queued={...job};
  window.retryObservers[job.id](queued);
  window.advanceRetry(job.id,'running');
  return queued;
 }
 if(cmd==='list_connections'||cmd==='recent_backend_errors')return [];
 if(cmd==='plugin:event|listen')return 1;
 if(cmd==='plugin:event|unlisten')return;
 throw new Error('Unexpected IPC: '+cmd);
}};
`,
});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector('button:text-is("传输任务")');
await page.click('button:text-is("传输任务")');
await page.waitForSelector('.transfers-page [data-transfer-id="0"]');
console.log(await page.snapshot());
const row = (id) => '.transfers-page [data-transfer-id="' + id + '"]';
assert.equal(
  await page.evaluate(
    () =>
      document.querySelectorAll('.transfers-page button[aria-label="重试传输"]')
        .length,
  ),
  2,
);
assert.equal(
  await page.evaluate(
    () =>
      document.querySelectorAll('.transfers-page button[aria-label="继续传输"]')
        .length,
  ),
  1,
);
for (const id of ["2", "3"])
  assert.equal(
    await page.evaluate(
      (selector) =>
        document
          .querySelector(selector)
          .querySelectorAll('[aria-label="重试传输"],[aria-label="继续传输"]')
          .length,
      row(id),
    ),
    0,
  );

await page.click(row("0") + ' button[aria-label="重试传输"]');
await page.waitForSelector("dialog");
assert.equal(
  await page.evaluate(
    () => document.querySelector("#retry-conflict-policy").value,
  ),
  "reject",
);
for (const width of [1280, 960, 720]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("dialog");
    const box = dialog.getBoundingClientRect();
    return {
      overflow: dialog.scrollWidth > dialog.clientWidth,
      outside:
        box.left < 0 || box.right > innerWidth || box.bottom > innerHeight,
    };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.outside, false);
  console.log({ width, ...layout });
}
await page.click('dialog button:text-is("取消")');
assert.equal(await page.evaluate(() => window.retryCalls.length), 0);
await page.click(row("4") + ' button[aria-label="重试传输"]');
assert.equal(
  await page.evaluate(
    () =>
      !!document.querySelector('#retry-conflict-policy option[value="rename"]'),
  ),
  false,
  "native download keeps its original path authorization",
);
await page.click('dialog button:text-is("取消")');

await page.click(row("0") + ' button[aria-label="重试传输"]');
await page.selectOption("#retry-conflict-policy", "overwrite");
assert.match(
  await page.evaluate(() => document.querySelector("dialog").textContent),
  /旧内容无法/,
);
await page.evaluate(() => (window.holdRetry = true));
await page.click('dialog button:text-is("重试")');
await page.waitForFunction(
  () => document.querySelector('dialog button[type="submit"]').disabled,
);
assert.equal(await page.evaluate(() => window.retryCalls.length), 1);
await page.evaluate(() => {
  window.holdRetry = false;
  window.releaseRetry();
});
await page.waitForFunction(
  () =>
    !document.querySelector("dialog") &&
    !!document.querySelector('[data-transfer-id="0"] .transfer-state.running'),
);
assert.deepEqual(await page.evaluate(() => window.retryCalls.at(-1)), {
  jobId: "0",
  policy: "overwrite",
});
assert.equal(
  await page.evaluate(
    () =>
      document.querySelectorAll('.transfers-page [data-transfer-id="0"]')
        .length,
  ),
  1,
);
await page.evaluate(() => {
  const stale = { ...window.jobs[0] };
  window.advanceRetry("0", "completed");
  window.retryObservers["0"](stale);
});
await page.waitForSelector('[data-transfer-id="0"] .transfer-state.completed');

await page.click(row("1") + ' button[aria-label="继续传输"]');
await page.click('dialog button:text-is("继续")');
await page.waitForSelector('[data-transfer-id="1"] .transfer-state.running');
assert.deepEqual(await page.evaluate(() => window.retryCalls.at(-1)), {
  jobId: "1",
  policy: "reject",
});
await page.evaluate(() => window.advanceRetry("1", "completed"));
await page.waitForSelector('[data-transfer-id="1"] .transfer-state.completed');

await page.evaluate(() => (window.retryError = true));
await page.click(row("4") + ' button[aria-label="重试传输"]');
await page.click('dialog button:text-is("重试")');
await page.waitForSelector('dialog [role="alert"]');
assert.match(
  await page.evaluate(
    () => document.querySelector('dialog [role="alert"]').textContent,
  ),
  /找不到原文件/,
);
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector('[data-transfer-id="4"] .transfer-state')
        .textContent,
  ),
  "失败",
);
await page.click('dialog button:text-is("取消")');
const revisions = await page.evaluate(async () => {
  const { updateTransfer } = await import("/src/transferPresentation.ts");
  const terminal = window.jobs[0];
  const newer = {
    ...terminal,
    state: "queued",
    updated_at: "2026-10-20T02:00:00Z",
  };
  return {
    restart: updateTransfer([terminal], newer)[0].state,
    equal: updateTransfer([terminal], { ...terminal, state: "running" })[0]
      .state,
    stale: updateTransfer([newer], terminal)[0].state,
  };
});
assert.deepEqual(revisions, {
  restart: "queued",
  equal: "completed",
  stale: "queued",
});
assert.equal(
  await page.evaluate(
    () => document.querySelectorAll(".transfers-page .transfer-item").length,
  ),
  5,
);
console.log(
  "PASS: failed/interrupted retry actions, conflict choices, pending guard, original IDs, late events, errors, native path scope and responsive modal",
);
if (!globalThis.filoKeepBrowser) await task.finish({ keep: [] });
