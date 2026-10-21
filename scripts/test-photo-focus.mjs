// Run with ego-browser nodejs on stdin. Synthetic IPC never writes real photos.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoFocusSpace ?? "Filo NEF focus zoom QA");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.isTauri = true;
    sessionStorage.setItem('filo.review-session', 'review');
    localStorage.removeItem('filo.review-rating-delay');
    const photos = ['one','two','three','four'].map((name,i) => ({
      id:'p'+i, archive_id:'archive', original_path:(i+1)+'-'+name+'.JPG',
      capture_date:null, issues:[], files:[{id:'f'+i,kind:'jpg',path:name+'.JPG',
        verified:false,sha256:'',size:100,error:null},...(i===2?[]:[{id:'raw'+i,kind:'raw',path:name+'.NEF',verified:false,sha256:'',size:100,error:null}])],
      rating:0,flag:'none',excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null
    }));
    const session = {id:'review',archive_id:'archive',name:'两轮筛片',card_name:'',
      created_at:'2026-10-20',source:null,photo_ids:photos.map(p=>p.id),
      revision:1,synced_revision:1,nas_hash:null,sync_error:null,handed_off:false,
      position:{current:'p0',sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false,raw_only:false},
      undo:[],layout:'original',keep_hierarchy:false};
    window.reviewFixture = {photos,session,fail:false,delay:0,calls:[],focusCalls:[],hold:false,release:null};
    window.__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},
      invoke:async(command,args={}) => {
        if(['recent_backend_errors','list_volumes','list_transfers','list_connections'].includes(command)) return [];
        if(command==='plugin:event|listen') return 1;
        if(command==='review_catalog') return structuredClone({photos,sessions:[session],archives:[],preset:null});
        if(command==='review_save_position') {session.position=args.position;return;}
        if(command==='review_mark') {
          window.reviewFixture.calls.push(args);
          if(window.reviewFixture.delay) await new Promise(resolve => setTimeout(resolve, window.reviewFixture.delay));
          if(window.reviewFixture.fail) throw {message:'模拟保存失败'};
          const photo=photos.find(p=>p.id===args.photoId);
          Object.assign(photo,{rating:args.rating,flag:args.flag});
          return structuredClone(photo);
        }
        if(command==='review_focus') {
          window.reviewFixture.focusCalls.push(args.photoId);
          if(window.reviewFixture.hold && args.photoId==='p0') await new Promise(resolve => window.reviewFixture.release=resolve);
          if(args.photoId==='p3') throw {message:'模拟元数据读取失败'};
          return {x:args.photoId==='p1'?0.98:0.75,y:args.photoId==='p1'?0.02:0.25,width:0.05,height:0.05};
        }
        if(command==='review_preview') return {mime:'image/svg+xml',
          content:btoa('<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="2000"><rect width="3200" height="2000" fill="#547b8d"/><circle cx="840" cy="230" r="100" fill="#f1d6a6"/><path d="M0 800L400 290L790 800M400 800L900 400L1200 800" fill="#304e60"/></svg>'),
          width:args.original?3200:1600,height:args.original?2000:1000,embedded:false};
        return null;
      }};
  })();`,
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 850, deviceScaleFactor: 1, mobile: false,
});
await page.goto(globalThis.filoFocusUrl ?? "http://127.0.0.1:1420");
await page.click('.sidebar button[aria-label="审图"]');
await page.click('button:text-is("继续审图")');
await page.waitForSelector(".photo-stage img");

const centered = (x, y) => page.waitForFunction(({x,y}) => {
  const stage=document.querySelector('.photo-stage');
  const img=stage.querySelector('img');
  if(!stage.classList.contains('original') || img.style.width!=='3200px') return false;
  const s=stage.getBoundingClientRect(), r=img.getBoundingClientRect();
  return Math.abs(r.width-3200)<1 && Math.abs(r.height-2000)<1
    && Math.abs(r.width/r.height-img.naturalWidth/img.naturalHeight)<0.001
    && Math.abs(r.left+r.width*x-(s.left+stage.clientWidth/2))<2
    && Math.abs(r.top+r.height*y-(s.top+stage.clientHeight/2))<2;
}, {x,y});
assert.deepEqual(await page.evaluate(()=>window.reviewFixture.focusCalls),[], 'focus is lazy');
await page.keyboard.press('Space');
await centered(0.75,0.25);
assert.deepEqual(await page.evaluate(()=>window.reviewFixture.focusCalls),['p0']);
await page.keyboard.press('Space');
assert.equal(await page.evaluate(()=>document.querySelector('.photo-stage').classList.contains('original')),false);
// Re-enter zoom, then move to an edge focus without losing original-size mode.
await page.keyboard.press('Space');
await centered(0.75,0.25);
await page.keyboard.press('ArrowRight');
await centered(0.98,0.02);
// JPG-only photographs use their center and do not request NEF metadata.
await page.keyboard.press('ArrowRight');
await centered(0.5,0.5);
assert.deepEqual(await page.evaluate(()=>window.reviewFixture.focusCalls),['p0','p1']);
await page.keyboard.press('ArrowRight');
await centered(0.5,0.5);
// Resize keeps the focus at the viewport center.
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await centered(0.98,0.02);
await page.cdp('Emulation.setDeviceMetricsOverride',{width:850,height:650,deviceScaleFactor:1,mobile:false});
await centered(0.98,0.02);
await page.keyboard.press('Space');
await page.waitForFunction(()=>!document.querySelector('.photo-stage').classList.contains('original'));
const fit=await page.evaluate(()=>{
  const s=document.querySelector('.photo-stage').getBoundingClientRect();
  const img=document.querySelector('.photo-stage img'),i=img.getBoundingClientRect();
  return {width:i.width<=s.width+1,height:i.height<=s.height+1,
    ratio:Math.abs(i.width/i.height-img.naturalWidth/img.naturalHeight)<0.001,
    centered:Math.abs(i.left+i.width/2-s.left-s.width/2)<1 && Math.abs(i.top+i.height/2-s.top-s.height/2)<1};
});
assert.deepEqual(fit,{width:true,height:true,ratio:true,centered:true});
// A previous photo's slow focus result cannot move the current image.
await page.reload();
await page.click('.sidebar button[aria-label="审图"]');
await page.click('button:text-is("继续审图")');
await page.waitForSelector('.photo-stage img');
await page.evaluate(()=>window.reviewFixture.hold=true);
await page.keyboard.press('Space');
await page.waitForFunction(()=>!!window.reviewFixture.release);
await page.keyboard.press('ArrowRight');
await centered(0.98,0.02);
await page.evaluate(()=>window.reviewFixture.release());
await centered(0.98,0.02);
console.log('Focus zoom passed: Space toggle, paired NEF/JPG, edge focus, fallback, resize, late response.');
console.log(await page.snapshot());
await task.finish({keep:[]});
