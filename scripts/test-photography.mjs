// Browser QA uses synthetic IPC; Rust tests cover actual files, SQLite and sidecars.
import assert from "node:assert/strict";
const task = await taskSpace(globalThis.filoPhotoTestSpace ?? "Filo photography QA");
const page = task.page("p1");
console.log({ spaceId: task.spaceId });
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {source: `(() => {
  window.isTauri = true;
  window.photoCalls = []; window.failPhotoSave = false;
  const root = id => ({volume_id:id,logical_path:'',version_id:null});
  const empty = () => ({archives:[],sessions:[],photos:[],preset:null});
  window.copyCatalog = empty(); window.reviewCatalog = empty();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#324f6e"/><stop offset="1" stop-color="#f0b393"/></linearGradient></defs><path fill="url(#g)" d="M0 0h2400v1600H0z"/><circle cx="1760" cy="520" r="140" fill="#ffdab1"/><path fill="#3f6570" d="m0 1200 600-700 700 820 400-500 700 700v80H0z"/><path fill="#243e46" d="m0 1500 900-600 700 700H0z"/></svg>';
  const session = (id,ids) => ({id,archive_id:'archive',name:'秋日山行',card_name:'主卡',created_at:'2026-10-19T10:00:00Z',source:null,photo_ids:ids,revision:1,synced_revision:0,nas_hash:null,sync_error:null,handed_off:false,position:{current:null,filter:'all',minimum_rating:0,auto_advance:false},undo:[],layout:'date',keep_hierarchy:false});
  window.__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args={})=>{
    window.photoCalls.push(command);
    if (['recent_backend_errors','list_volumes','list_transfers','list_connections'].includes(command)) return [];
    if (command==='plugin:event|listen') return 1;
    if (command==='plugin:event|unlisten') return;
    if (command==='get_credential_settings') return {mode:'plain',locked:false,legacy_import_available:false};
    if (command==='get_transfer_settings') return {upload_kib_per_second:0,download_kib_per_second:0};
    if (command==='photo_has_active_imports') return false;
    if (command==='photo_catalog') return structuredClone(window.copyCatalog);
    if (command==='review_catalog') return structuredClone(window.reviewCatalog);
    if (command==='photo_pick_directory') return {locator:root('jpg'),path:'/Volumes/Photos/2026-10-19'};
    if (command==='review_open') {
      window.reviewCatalog.photos = Array.from({length:241},(_,i)=>({id:'p'+i,archive_id:'archive',original_path:'DSC_'+String(6166+i)+'.JPG',capture_date:'2026-10-19',issues:[],files:[{id:'f'+i,kind:'jpg',path:'DSC_'+String(6166+i)+'.JPG',verified:false,sha256:'',size:12345,error:null}],rating:0,flag:'none',reviewed:false,excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null}));
      window.reviewCatalog.sessions=[session('review',window.reviewCatalog.photos.map(p=>p.id))];
      return structuredClone(window.reviewCatalog.sessions[0]);
    }
    if (command==='review_preview') return {mime:'image/svg+xml',content:btoa(svg),width:2400,height:1600,embedded:false};
    if (command==='review_mark') {
      await new Promise(r=>setTimeout(r,35));
      if(window.failPhotoSave) throw {message:'模拟本机保存失败'};
      const p=window.reviewCatalog.photos.find(p=>p.id===args.photoId);const s=window.reviewCatalog.sessions[0];
      s.undo.push(structuredClone(p));p.rating=args.rating;p.flag=args.flag;p.reviewed=true;p.revision++;s.revision++;
      return structuredClone(p);
    }
    if (command==='review_undo') {const p=window.reviewCatalog.sessions[0].undo.pop();if(!p)return null;Object.assign(window.reviewCatalog.photos.find(x=>x.id===p.id),p);return p;}
    if (command==='review_save_position') {Object.assign(window.reviewCatalog.sessions[0].position,args.position);window.reviewCatalog.sessions[0].revision++;return;}
    if (command==='review_sync') {const s=window.reviewCatalog.sessions[0];s.synced_revision=s.revision;return;}
    if (command==='review_prepare_lrc') return {directories:['/Volumes/Photos/RAW/2026/2026-10-19'],failures:[],jpg_only:0};
    if (command==='review_open_raw_directory'||command==='review_launch_lrc')return;
    throw new Error('Unexpected IPC: '+command);
  }};
})();`});
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector(".sidebar .main-nav");
await page.click('.main-nav button:text-is("拷卡")');
await page.waitForSelector('.photo-workspace-body');
assert.match(await page.evaluate(()=>document.querySelector('.photo-workspace-body').textContent),/拷卡记录/);
assert.equal(await page.evaluate(()=>window.copyCatalog.sessions.length),0);
await page.click('.main-nav button:text-is("审图")');
await page.waitForSelector('.photo-empty');
assert.equal(await page.evaluate(()=>document.querySelector('.photo-workspace-body').textContent.includes('存储卡')),false);
await page.click('button:text-is("打开照片目录") >> nth=0');
await page.click('.photo-directory-field button >> nth=0');
await page.click('dialog button:text-is("开始审图")');
await page.waitForSelector('.photo-stage img');
assert.match(await page.evaluate(()=>document.querySelector('.photo-counter').textContent),/1 \/ 241/);
await page.keyboard.press(']');
await page.waitForFunction(()=>window.reviewCatalog.photos[0].rating===1);
assert.match(await page.evaluate(()=>document.querySelector('.photo-counter').textContent),/1 \/ 241/);
await page.keyboard.press(']'); await page.keyboard.press(']'); await page.keyboard.press(']'); await page.keyboard.press(']');
await page.waitForFunction(()=>window.reviewCatalog.photos[0].rating===5);
await page.waitForSelector('.photo-feedback-result.up');
await page.screenshot({path:'/tmp/filo-photo-review-wide.png'});
await page.keyboard.press('x');await page.waitForFunction(()=>window.reviewCatalog.photos[0].flag==='reject');
assert.equal(await page.evaluate(()=>window.reviewCatalog.photos[0].rating),5);
await page.keyboard.press('ControlOrMeta+z');await page.waitForFunction(()=>window.reviewCatalog.photos[0].flag==='none');
await page.keyboard.press('Shift+]');await page.waitForFunction(()=>document.querySelector('.photo-counter').textContent.includes('2 / 241'));
await page.evaluate(()=>{window.failPhotoSave=true;});
await page.keyboard.press('3');await page.waitForSelector('.photo-review-error');
assert.equal(await page.evaluate(()=>window.reviewCatalog.photos[1].rating),0);
await page.evaluate(()=>{window.failPhotoSave=false;});await page.click('button:text-is("重试保存")');
await page.waitForFunction(()=>window.reviewCatalog.photos[1].rating===3);
await page.focus('select[aria-label="审图筛选"]');await page.keyboard.press('5');
assert.equal(await page.evaluate(()=>window.reviewCatalog.photos[1].rating),3);
await page.click('.photo-stage');
await page.cdp('Emulation.setDeviceMetricsOverride',{width:940,height:760,deviceScaleFactor:1,mobile:false});
await page.screenshot({path:'/tmp/filo-photo-review-narrow.png'});
const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,stage:document.querySelector('.photo-stage').getBoundingClientRect().height}));
assert.equal(layout.scroll,layout.width);assert.ok(layout.stage>150);
await page.cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
await page.keyboard.press('p');await page.waitForFunction(()=>window.reviewCatalog.photos[1].flag==='pick');
assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.photo-feedback canvas')).display),'none');
await page.click('button:text-is("审图记录")');await page.waitForSelector('.photo-review-summary');
await page.click('button:text-is("准备 LRC 导入")');await page.waitForSelector('.photo-handoff');
assert.match(await page.evaluate(()=>document.querySelector('.photo-handoff').textContent),/Add/);
await page.click('.main-nav button:text-is("拷卡")');await page.waitForSelector('.photo-empty');
assert.equal(await page.evaluate(()=>window.copyCatalog.sessions.length),0);
console.log({passed:'independent review, 241 photos, keyboard, saved feedback, undo, boundary advance, save failure/retry, input focus, reduced motion, handoff, viewport',layout});
console.log(await page.snapshot());
