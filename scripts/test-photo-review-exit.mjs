// Run with ego-browser nodejs on stdin. Synthetic IPC never writes real photos.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoReviewExitSpace ?? "Filo review failed-save exit QA");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    sessionStorage.setItem('filo.review-session', 'review');
    const photos = ['one','two','three','four'].map((name,i) => ({
      id:'p'+i, archive_id:'archive', original_path:(i+1)+'-'+name+'.JPG',
      capture_date:null, issues:[], files:[{id:'f'+i,kind:'jpg',path:name+'.JPG',
        verified:false,sha256:'',size:100,error:null}],
      rating:0,flag:'none',excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null
    }));
    const session = {id:'review',archive_id:'archive',name:'两轮筛片',card_name:'',
      created_at:'2026-10-20',source:null,photo_ids:photos.map(p=>p.id),
      revision:1,synced_revision:1,nas_hash:null,sync_error:null,handed_off:false,
      position:{current:'p0',sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false,raw_only:false},
      undo:[],layout:'original',keep_hierarchy:false};
    window.reviewFixture = {photos,session,fail:false,delay:0,calls:[]};
    window.__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},
      invoke:async(command,args={}) => {
        if(['recent_backend_errors','list_volumes','list_transfers','list_connections'].includes(command)) return [];
        if(command==='plugin:event|listen') return 1;
        if(command==='review_catalog') return structuredClone({photos,sessions:[session],archives:[],preset:null});
        if(command==='review_save_position') {
          if(window.reviewFixture.holdPosition) await new Promise((resolve,reject)=>window.releasePosition=()=>reject({message:'SMB 连接已断开，请检查网络后重试'}));
          if(window.reviewFixture.failPosition) throw {message:'SMB 连接已断开，请检查网络后重试'};
          session.position=args.position;return;
        }
        if(command==='review_mark') {
          window.reviewFixture.calls.push(args);
          if(window.reviewFixture.holdMark) await new Promise(resolve=>window.releaseMark=resolve);
          if(window.reviewFixture.delay) await new Promise(resolve => setTimeout(resolve, window.reviewFixture.delay));
          if(window.reviewFixture.fail) throw {message:'模拟保存失败'};
          const photo=photos.find(p=>p.id===args.photoId);
          Object.assign(photo,{rating:args.rating,flag:args.flag});
          return structuredClone(photo);
        }
        if(command==='review_preview') return {mime:'image/svg+xml',
          content:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#547b8d"/><circle cx="840" cy="230" r="100" fill="#f1d6a6"/><path d="M0 800L400 290L790 800M400 800L900 400L1200 800" fill="#304e60"/></svg>'),
          width:1200,height:800,embedded:false};
        return null;
      }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 850, deviceScaleFactor: 1, mobile: false,
});
await page.goto(globalThis.filoReviewExitUrl ?? "http://127.0.0.1:1420");
await page.click('.main-nav button:text-is("审图")');
await page.click('button:text-is("继续审图")');
await page.waitForSelector(".photo-stage img");

// A failed final position write must offer a usable exit.
await page.evaluate(()=>{window.reviewFixture.failPosition=true;});
const promptDelay = await page.evaluate(async () => {
  const start = performance.now();
  document.querySelector('.photo-review-back').click();
  await new Promise(resolve => setTimeout(resolve, 500));
  if (document.querySelector('dialog[open]')) throw new Error('exit prompt appeared before one second');
  while (!document.querySelector('dialog[open]')) await new Promise(resolve => setTimeout(resolve, 10));
  return performance.now() - start;
});
assert.ok(promptDelay >= 1000, `exit prompt must wait one second, got ${promptDelay}ms`);
await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('部分更改未能保存'));
await page.click('dialog button:text-is("返回审图")');
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-stage')),true);
await page.keyboard.press('Escape');
await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('部分更改未能保存'));
await page.click('dialog button:text-is("退出审图")');
await page.waitForFunction(()=>!document.querySelector('.photo-review'));
await page.evaluate(()=>{window.reviewFixture.failPosition=false;});
await page.click('button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
// Dismissing a failed mark's banner must not report saved or lose the exit warning.
await page.evaluate(()=>{window.reviewFixture.fail=true;});
await page.keyboard.press('3');
await page.waitForSelector('.photo-review-error');
await page.click('button[aria-label="关闭错误提示"]');
assert.match(await page.evaluate(()=>document.querySelector('.photo-save-status').textContent),/保存失败/);
await page.click('.photo-review-back');
await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('部分更改未能保存'));
await page.click('dialog button:text-is("退出审图")');
await page.waitForFunction(()=>!document.querySelector('.photo-review'));
await page.evaluate(()=>{window.reviewFixture.fail=false;window.reviewFixture.holdMark=true;});
await page.click('button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
await page.keyboard.press('4');
await page.waitForFunction(()=>!!window.releaseMark);
await page.click('.photo-review-back');
await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('保存仍未完成'));
// Cancelled exit must not navigate when the delayed write eventually finishes.
await page.click('dialog button:text-is("返回审图")');
await page.evaluate(()=>{window.reviewFixture.holdMark=false;window.releaseMark();});
await page.waitForFunction(()=>window.reviewFixture.session.position.current==='p0' && window.reviewFixture.photos[0].rating===4);
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-stage')),true);
// A stalled position write also times out; test narrow modal layout before leaving.
await page.evaluate(()=>{window.reviewFixture.holdPosition=true;});
await page.click('.photo-review-back');
await page.waitForFunction(()=>document.querySelector('dialog[open]')?.textContent.includes('保存仍未完成'));
await page.cdp('Emulation.setDeviceMetricsOverride',{width:760,height:850,deviceScaleFactor:1,mobile:false});
assert.equal(await page.evaluate(()=>{const d=document.querySelector('dialog[open]').getBoundingClientRect();return d.x>=0&&d.right<=innerWidth&&d.bottom<=innerHeight;}),true);
if (globalThis.filoReviewExitScreenshot)
  console.log(await page.screenshot({path:globalThis.filoReviewExitScreenshot}));
await page.click('dialog button:text-is("退出审图")');
await page.waitForFunction(()=>!document.querySelector('.photo-review'));
await page.evaluate(()=>{window.reviewFixture.holdPosition=false;window.releasePosition();});
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-review')),false);
// Healthy saves retain the normal direct return behavior.
await page.click('button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
await page.click('.photo-review-back');
await page.waitForFunction(()=>!document.querySelector('.photo-review'));
assert.equal(await page.evaluate(()=>!!document.querySelector('dialog[open]')),false);
console.log({passed:'failed position; failed mark after dismissed banner; Escape; stalled marks; cancelled exit with late success; stalled position; late rejection after exit; normal exit; narrow dialog'});
await task.finish({keep:[]});
