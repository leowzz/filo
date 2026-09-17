// With Vite running: ego-browser nodejs < scripts/test-transfer-popover.mjs
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('Filo parallel transfer regression');
console.log({spaceId:task.spaceId});
const page = task.page('p1');
await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
window.isTauri = true;
window.openCalls = [];
const locator = {volume_id:'local',logical_path:'download.pdf',version_id:null};
const job = {id:'done',kind:'copy',state:'completed',source:locator,destination:locator,
 bytes_total:1000,bytes_transferred:1000,created_at:'2026-09-17T00:00:00Z',updated_at:'2026-09-17T00:00:01Z',error_code:null,error_message:null};
window.__TAURI_INTERNALS__ = {
 transformCallback:()=>1,unregisterCallback:()=>{},
 invoke:async(cmd,args)=>{
  if(cmd==='list_transfers')return [job];
  if(cmd==='list_volumes'||cmd==='list_connections'||cmd==='recent_backend_errors')return [];
  if(cmd==='plugin:event|listen')return 1;
  if(cmd==='plugin:event|unlisten')return;
  if(cmd==='open_transfer_file'){
    window.openCalls.push(args);
    if(window.openFailure)throw new Error('文件已不存在');
    return;
  }
  throw new Error('Unexpected IPC: '+cmd);
 }
};
`});
await page.goto('http://127.0.0.1:1420');
await page.waitForSelector('.transfer-tasks-trigger');
await page.click('.transfer-tasks-trigger');
await page.waitForSelector('[data-transfer-id="done"]');
await page.click('.transfer-tasks-header h2');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),true,'clicking internal text must not dismiss');
// Model macOS WebKit, where mouse-clicked buttons do not necessarily take focus.
await page.evaluate(()=>{
 document.querySelector('[aria-label="关闭任务列表"]').focus();
 document.querySelector('.transfer-item-actions button').addEventListener('mousedown',event=>{
  event.preventDefault();
  document.activeElement.blur();
 },{once:true});
});
await page.click('.transfer-item-actions button:text-is("打开文件")');
assert.deepEqual(await page.evaluate(()=>window.openCalls),[{jobId:'done',directory:false}]);
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),true);
await page.click('.transfer-item-actions button:text-is("所在目录")');
assert.deepEqual(await page.evaluate(()=>window.openCalls.at(-1)),{jobId:'done',directory:true});
await page.evaluate(()=>window.openFailure=true);
await page.click('.transfer-item-actions button:text-is("打开文件")');
await page.waitForSelector('.transfer-tasks-message[role="alert"]');
assert.match(await page.evaluate(()=>document.querySelector('.transfer-tasks-message[role="alert"]').textContent),/文件已不存在/);
await page.click('button:text-is("查看全部任务")');
await page.waitForSelector('.transfers-page');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),false);
await page.click('.transfer-tasks-trigger');
await page.press('button[aria-label="关闭任务列表"]','Escape');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),false,'Escape dismisses');
await page.click('.transfer-tasks-trigger');
await page.click('.transfers-page > h1');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),false,'outside click dismisses');
await page.click('.transfer-tasks-trigger');
await page.click('button[aria-label="关闭任务列表"]');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),false,'close button dismisses');
await page.click('.transfer-tasks-trigger');
await page.evaluate(()=>{
 const external=document.createElement('button');
 document.body.append(external);
 external.focus();
 external.remove();
});
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),false,'focus moving to an external control dismisses');
console.log('PASS: internal content, macOS-style button focus, file/folder actions, errors, view all, Escape, outside click, close and external focus');
await task.finish({keep:[]});
