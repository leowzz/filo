// With Vite running: ego-browser nodejs < scripts/test-transfer-popover.mjs
const assert = (await import('node:assert/strict')).default;
const task = await taskSpace('Filo parallel transfer regression');
console.log({spaceId:task.spaceId});
const page = task.page('p1');
await page.cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
window.isTauri = true;
window.openCalls = [];
const locator = {volume_id:'local',logical_path:'download.pdf',version_id:null};
const job = {id:'done',kind:'copy',state:'completed',source:{...locator,volume_id:'remote'},destination:locator,
 bytes_total:1000,bytes_transferred:1000,created_at:'2026-09-17T00:00:00Z',updated_at:'2026-09-17T00:00:01Z',error_code:null,error_message:null};
window.__TAURI_INTERNALS__ = {
 transformCallback:()=>1,unregisterCallback:()=>{},
 invoke:async(cmd,args)=>{
  if(cmd==='list_transfers' && window.listError)throw new Error('刷新失败');
  if(cmd==='list_transfers')return [job,{...job,id:'upload',source:locator,destination:{...locator,volume_id:'remote'}},{...job,id:'copy',source:locator}];
  if(cmd==='list_volumes')return [{id:'remote',connection_id:'remote',name:'远程位置',read_only:false,root:{type:'s3',bucket:'test',prefix:''},capabilities:{hierarchy:'virtual_prefix',rename:'copy_then_delete',create_directory:true,delete:true,trash:false,native_open:false,native_copy:true}}];
  if(cmd==='list_connections'||cmd==='recent_backend_errors')return [];
  if(cmd==='plugin:event|listen')return 1;
  if(cmd==='plugin:event|unlisten')return;
  if(cmd==='open_transfer_file'){
    window.openCalls.push(args);
    if(window.openFailure)throw new Error('文件已不存在');
    return window.fileMissing ? '文件已不存在，已打开所在目录' : null;
  }
  throw new Error('Unexpected IPC: '+cmd);
 }
};
`});
await page.goto('http://127.0.0.1:1420');
await page.waitForSelector('.transfer-tasks-trigger');
await page.click('.transfer-tasks-trigger');
await page.waitForSelector('[data-transfer-id="done"]');
assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-transfer-id="upload"] button').length),0,'historical uploads have no actions');
assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-transfer-id="copy"] button').length),0,'local copies are not downloads');
assert.match(await page.evaluate(()=>document.querySelector('[data-transfer-id="upload"] .transfer-meta').textContent),/上传/);
assert.match(await page.evaluate(()=>document.querySelector('[data-transfer-id="done"] .transfer-meta').textContent),/下载/);
for (const width of [1280,960]) {
 await page.cdp('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
 const layout=await page.evaluate(()=>{
  const row=document.querySelector('[data-transfer-id="done"]');
  const actions=row.querySelector('.transfer-item-actions').getBoundingClientRect();
  const heading=row.querySelector('.transfer-heading').getBoundingClientRect();
  return {aligned:Math.abs(actions.right-heading.right)<1,overflow:row.scrollWidth>row.clientWidth,buttons:[...row.querySelectorAll('button')].map(b=>({text:b.textContent.trim(),title:b.title,label:b.getAttribute('aria-label')}))};
 });
 assert.equal(layout.aligned,true,'actions align to right edge');
 assert.equal(layout.overflow,false);
 assert.deepEqual(layout.buttons.map(b=>b.text),['','']);
 assert.deepEqual(layout.buttons.map(b=>b.title),['打开文件','所在目录']);
 console.log({width,layout});
}

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
await page.click('.transfer-item-actions button[aria-label="打开文件"]');
assert.deepEqual(await page.evaluate(()=>window.openCalls),[{jobId:'done',directory:false}]);
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),true);
await page.click('.transfer-item-actions button[aria-label="所在目录"]');
assert.deepEqual(await page.evaluate(()=>window.openCalls.at(-1)),{jobId:'done',directory:true});
const rowTop = await page.evaluate(()=>document.querySelector('[data-transfer-id="done"]').getBoundingClientRect().top);
await page.evaluate(()=>window.fileMissing=true);
await page.click('.transfer-item-actions button[aria-label="所在目录"]');
await page.waitForSelector('.floating-notice[role="status"]');
assert.match(await page.evaluate(()=>document.querySelector('.floating-notice').textContent),/文件已不存在，已打开所在目录/);
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover .error-text')),false,'no error banner at the top');
const toastLayout = await page.evaluate(()=>{
 const r=document.querySelector('.floating-notice').getBoundingClientRect();
 return {bottom:innerHeight-r.bottom,overflow:r.left<0||r.right>innerWidth};
});
assert.equal(toastLayout.bottom,28);
assert.equal(toastLayout.overflow,false);
assert.equal(await page.evaluate(()=>document.querySelector('[data-transfer-id="done"]').getBoundingClientRect().top),rowTop,'operation notice does not move rows');
await page.waitForFunction(()=>!document.querySelector('.floating-notice'));
await page.evaluate(()=>window.openFailure=true);
await page.click('.transfer-item-actions button[aria-label="打开文件"]');
await page.waitForSelector('.floating-notice[role="status"]');
assert.match(await page.evaluate(()=>document.querySelector('.floating-notice[role="status"]').textContent),/文件已不存在/);
await page.evaluate(()=>{
 window.listError=true;
 window.dispatchEvent(new Event('offline'));
 window.dispatchEvent(new Event('online'));
});
await page.waitForFunction(()=>document.querySelector('#floating-notices').textContent.includes('无法刷新任务列表'));
assert.equal(await page.evaluate(()=>document.querySelector('[data-transfer-id="done"]').getBoundingClientRect().top),rowTop,'query error does not move rows');
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover [role="alert"]')),false);
await page.evaluate(()=>window.listError=false);
await page.click('.floating-notice button:text-is("重试")');
await page.waitForFunction(()=>!document.querySelector('#floating-notices').textContent.includes('无法刷新任务列表'));
assert.equal(await page.evaluate(()=>!!document.querySelector('.transfer-tasks-popover')),true,'toast retry must not dismiss the list');
await page.waitForSelector('[data-transfer-id="done"]');
assert.equal(await page.evaluate(()=>document.querySelector('[data-transfer-id="done"]').getBoundingClientRect().top),rowTop,'retry restores the same list position');
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
