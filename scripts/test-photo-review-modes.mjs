// Run with ego-browser nodejs on stdin. Synthetic IPC never writes real photos.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoReviewModesSpace ?? "Filo two-pass review QA");
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
        verified:false,sha256:'',size:100,error:null}],
      rating:0,flag:'none',excluded:false,revision:0,xmp_hash:null,xmp_synced_revision:null
    }));
    const session = {id:'review',archive_id:'archive',name:'两轮筛片',card_name:'',
      created_at:'2026-10-20',source:null,photo_ids:photos.map(p=>p.id),
      revision:1,synced_revision:1,nas_hash:null,sync_error:null,handed_off:false,
      position:{current:'p0',sort:'name_asc',filter:'all',minimum_rating:0,auto_advance:false,raw_only:false},
      undo:[],layout:'original',keep_hierarchy:false};
    window.reviewFixture = {photos,session,fail:false,calls:[]};
    window.__TAURI_INTERNALS__ = {transformCallback:()=>1,unregisterCallback:()=>{},
      invoke:async(command,args={}) => {
        if(['recent_backend_errors','list_volumes','list_transfers','list_connections'].includes(command)) return [];
        if(command==='plugin:event|listen') return 1;
        if(command==='review_catalog') return structuredClone({photos,sessions:[session],archives:[],preset:null});
        if(command==='review_save_position') {session.position=args.position;return;}
        if(command==='review_mark') {
          window.reviewFixture.calls.push(args);
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
await page.goto(globalThis.filoReviewModesUrl ?? "http://127.0.0.1:1420");
await page.click('.main-nav button:text-is("审图")');
await page.click('button:text-is("继续审图")');
await page.waitForSelector(".photo-stage img");
await page.click('button:text-is("留用星级")');
assert.match(await page.evaluate(() => document.querySelector(".photo-stage").textContent), /还没有留用照片/);
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "0 / 0");
await page.click('button:text-is("旗标快筛")');
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 4");
await page.click(".photo-flags button:last-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 4");
await page.click('button[aria-label="上一张"]');
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 4");
assert.equal(await page.evaluate(() => window.reviewFixture.photos[1].flag), "pick", "backtracking corrects an excluded photo");
await page.click('button[aria-label="查看 1-one.JPG"]');
await page.click('button:text-is("留用星级")');
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "1 / 2");
assert.equal(await page.evaluate(() => document.querySelector('select[aria-label="星级等待时间"]').value), "500");
assert.equal(await page.evaluate(() => document.querySelectorAll(".photo-flags").length), 0);
// Drive two DOM clicks in one browser round; external action receipts can exceed 500 ms.
await page.evaluate(async () => {
  const increase = () => [...document.querySelectorAll("button")].find(button => button.textContent === "升一星").click();
  increase();
  await new Promise(resolve => setTimeout(resolve, 200));
  increase();
});
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 2");
assert.equal(await page.evaluate(() => window.reviewFixture.photos[0].rating), 2);
assert.equal(await page.evaluate(() => window.reviewFixture.photos[1].rating), 0);
await page.selectOption('select[aria-label="星级等待时间"]', "1500");
assert.equal(await page.evaluate(() => localStorage.getItem("filo.review-rating-delay")), "1500");
await page.click('button[aria-label="3 星"]');
await page.click('button[aria-label="上一张"]');
// Wait beyond the configured deadline to catch a stale navigation timer.
await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1600)));
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "1 / 2");
await page.evaluate(() => { window.reviewFixture.fail = true; });
await page.click('button[aria-label="4 星"]');
await page.waitForSelector(".photo-review-error");
await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1600)));
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "1 / 2");
assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="2 星"]').getAttribute("aria-pressed")), "true");
await page.evaluate(() => { window.reviewFixture.fail = false; });
await page.click('button[aria-label="关闭错误提示"]');
const measurements = [];
for (const width of [1280, 760]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width, height: 850, deviceScaleFactor: 1, mobile: false,
  });
  const metrics = await page.evaluate(() => {
    const selectors = [".photo-review", ".photo-review-toolbar", ".photo-review-controls", ".photo-filmstrip"];
    return {
      viewport: innerWidth,
      fits: document.documentElement.scrollWidth <= innerWidth,
      rows: selectors.map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
      modes: [...document.querySelectorAll('[aria-label="审图模式"] button')].map(e => e.getBoundingClientRect().top),
    };
  });
  assert.ok(metrics.fits, `viewport ${width} must not overflow`);
  assert.equal(new Set(metrics.modes).size, 1, "mode buttons share a baseline");
  assert.ok(metrics.rows.every(row => row.bottom <= 850 && row.height > 0), "review controls and filmstrip remain visible");
  measurements.push(metrics);
}
console.log({ passed: "quick flags, backtrack/correct, picked-only ratings, debounce, configurable delay, navigation cancellation, save failure, empty picks, responsive layout", measurements });
console.log(await page.snapshot({ scope: "full_page" }));
if (globalThis.filoReviewModesScreenshot)
  console.log(await page.screenshot({ path: globalThis.filoReviewModesScreenshot }));
await task.finish({ keep: [] });
