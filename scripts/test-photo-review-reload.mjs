// Synthetic IPC for conflict recovery. Rust tests protect the real progress file and XMP.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoReviewReloadSpace ?? "Filo review conflict recovery");
console.log({spaceId:task.spaceId});
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {source: `(() => {
  window.isTauri = true;
  sessionStorage.setItem('filo.review-session', 'cached');
  const root = {volume_id:'photos', logical_path:'', version_id:null};
  const makePhoto = (id, rating, flag) => ({id,archive_id:'archive',original_path:id+'.jpg',
    capture_date:null,issues:[],files:[{id:id+'-file',kind:'jpg',original_name:id+'.jpg',path:id+'.jpg',
    sha256:'',size:100,verified:false,error:null}],rating,flag,excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null});
  const makeSession = id => ({id,archive_id:'archive',name:'Photos',card_name:'',created_at:'2026-10-20',
    source:null,directory:root,photo_ids:['one','two'],revision:1,synced_revision:1,nas_hash:'stale',sync_error:null,
    handed_off:false,position:{current:window.externalCurrent,sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false},
    undo:[],layout:'original',keep_hierarchy:true});
  window.externalCurrent='one'; window.externalRating=4; window.externalFlag='pick';
  window.scanCalls=[]; window.positionCalls=[]; window.conflict=true;
  window.holdPosition=false; window.positionPending=false; window.positionReleases=[]; window.holdScan=false;
  window.catalog={sessions:[makeSession('cached')],photos:[makePhoto('one',0,'none'),makePhoto('two',0,'none')],archives:[],preset:null};
  const conflict = () => ({code:'conflict',message:'目录中的审图进度已被其他窗口或电脑更新，请重新进入审图后重试'});
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
    transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args={})=>{
      if (command==='list_volumes') return [{id:'photos',connection_id:'photos',name:'Photos',read_only:false,
        root:{type:'local',root_path:'/fixture/photos'},capabilities:{hierarchy:'directory_tree',rename:'native',create_directory:true,
        delete:true,trash:false,native_open:false,native_copy:false}}];
      if (['recent_backend_errors','list_connections','list_transfers'].includes(command)) return [];
      if (command==='get_credential_settings') return {mode:'plain',locked:false,legacy_import_available:false};
      if (command==='get_transfer_settings') return {upload_kib_per_second:0,download_kib_per_second:0};
      if (command==='photo_has_active_imports') return false;
      if (command==='plugin:event|listen') return 1;
      if (command==='review_catalog') return structuredClone(window.catalog);
      if (command==='photo_catalog') return {sessions:[],photos:[],archives:[],preset:null};
      if (command==='directory_stamp') return '1';
      if (command==='list_entries_page') return {entries:[],total:0,total_is_exact:true,next_cursor:null};
      if (command==='review_scan') {
        window.scanCalls.push(args.input);
        args.onProgress.onmessage({stage:'connecting',found:0,completed:0,total:null,path:''});
        if(window.holdScan) await new Promise(resolve=>window.releaseScan=resolve);
        window.conflict=false; window.holdPosition=false;
        const session=makeSession('review-'+window.scanCalls.length);
        window.catalog={sessions:[session],photos:['one','two'].map(id=>makePhoto(id,
          id===window.externalCurrent?window.externalRating:1,id===window.externalCurrent?window.externalFlag:'none')),archives:[],preset:null};
        return structuredClone(session);
      }
      if (command==='review_save_position') {
        window.positionCalls.push(args.position);
        if(window.holdPosition) {
          window.positionPending=true;
          window.releasePosition=()=>{window.positionPending=false;for(const release of window.positionReleases.splice(0))release();};
          await new Promise((resolve,reject)=>window.positionReleases.push(()=>reject(conflict())));
        }
        if(window.conflict) throw conflict();
        Object.assign(window.catalog.sessions[0].position,args.position); return;
      }
      if (command==='review_mark') {
        if(window.conflict) throw conflict();
        const photo=window.catalog.photos.find(p=>p.id===args.photoId);
        Object.assign(photo,{rating:args.rating,flag:args.flag});return structuredClone(photo);
      }
      if (command==='review_preview') return {mime:'image/svg+xml',content:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#56798c"/></svg>'),width:800,height:600,embedded:false};
      return null;
    }};
})();`});
await page.goto("http://127.0.0.1:1420");
await page.click('.main-nav button:text-is("审图")');
await page.click('.photo-session-toolbar button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
assert.equal(await page.evaluate(()=>window.scanCalls.length),1);
assert.equal(await page.evaluate(()=>document.querySelector('button[aria-label="4 星"]').getAttribute('aria-pressed')),"true");
await page.evaluate(()=>{window.conflict=true;window.holdPosition=true;window.externalCurrent='two';window.externalRating=5;});
await page.click('button[aria-label="查看 two.jpg"]');
await page.waitForFunction(()=>window.positionPending);
await page.keyboard.press('3');
await page.waitForSelector('.photo-review-error');
await page.click('.photo-review-error button:text-is("重新载入目录")');
assert.equal(await page.evaluate(()=>window.scanCalls.length),1,"reload must wait for the old position write");
await page.evaluate(()=>{window.holdScan=true;window.releasePosition();});
await page.waitForFunction(()=>window.scanCalls.length===2);
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-stage')),false);
await page.evaluate(()=>{window.holdScan=false;window.releaseScan();});
await page.waitForSelector('.photo-stage img');
assert.equal(await page.evaluate(()=>document.querySelector('button[aria-label="5 星"]').getAttribute('aria-pressed')),"true");
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-review-error')),false);
assert.equal(await page.evaluate(()=>window.catalog.photos.find(p=>p.id==='two').rating),5,"do not replay a failed mark over external metadata");
await page.click('.main-nav button:text-is("拷卡")');
await page.click('.main-nav button:text-is("审图")');
await page.evaluate(()=>{window.conflict=true;window.externalCurrent='one';window.externalRating=2;});
await page.click('.photo-session-toolbar button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
assert.equal(await page.evaluate(()=>window.scanCalls.length),3);
assert.equal(await page.evaluate(()=>document.querySelector('button[aria-label="2 星"]').getAttribute('aria-pressed')),"true");
await page.click('.volume-nav button:has-text("Photos")');
await page.click('.toolbar-actions button:has-text("进入审图")');
await page.waitForSelector('.photo-stage img');
assert.equal(await page.evaluate(()=>window.scanCalls.length),4);
await page.evaluate(()=>{window.conflict=true;window.externalCurrent='two';window.externalRating=5;});
await page.click('button[aria-label="查看 two.jpg"]');
await page.keyboard.press('4');
await page.waitForSelector('.photo-review-error');
await page.click('.photo-review-error button:text-is("重新载入目录")');
await page.waitForFunction(()=>window.scanCalls.length===5 && !!document.querySelector('.photo-stage img'));
assert.equal(await page.evaluate(()=>document.querySelector('button[aria-label="5 星"]').getAttribute('aria-pressed')),"true");
assert.equal(await page.evaluate(()=>!!document.querySelector('.photo-review-error')),false);
console.log({passed:'continue reloads the directory; conflict recovery waits for old saves; external marks survive; recent reviews and directory reviews handle changed session IDs'});
await task.finish({keep:[]});
