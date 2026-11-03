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
    window.reviewFixture = {photos,session,fail:false,delay:0,calls:[]};
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
await page.click('.photo-session-list button');
await page.waitForSelector(".photo-stage img");
const panelLayout = await page.evaluate(() => {
  const back = document.querySelector('.photo-review-back').getBoundingClientRect();
  const collapse = document.querySelector('[aria-label="收起照片序列"]').getBoundingClientRect();
  const handle = document.querySelector('[aria-label="收起右侧栏"]').getBoundingClientRect();
  const settings = document.querySelector('[aria-label="审图设置"]').getBoundingClientRect();
  const heading = document.querySelector('.photo-review-side-heading').getBoundingClientRect();
  return {
    backBesideCollapse: Math.abs(back.top - collapse.top) < 1 && back.right <= collapse.left,
    tools: [...document.querySelectorAll('.photo-review-tools > button')].map(button => button.getBoundingClientRect().top),
    sideButtonsAligned: Math.abs(handle.top - settings.top) < 1 && handle.right < settings.left,
    sideButtonsSymmetric: Math.abs((handle.left - heading.left) - (heading.right - settings.right)) < 1 && handle.width === settings.width,
    hasRedundantLabel: [...document.querySelectorAll('.photo-review-film-wing .photo-review-wing-label')].some(label => label.textContent === '照片序列'),
  };
});
assert.equal(panelLayout.backBesideCollapse, true);
assert.equal(panelLayout.tools.length, 4);
assert.equal(new Set(panelLayout.tools).size, 1, "all four tools share one row");
assert.ok(panelLayout.sideButtonsAligned, "right collapse and settings share the first row");
assert.ok(panelLayout.sideButtonsSymmetric, "right collapse and settings sit at opposite ends with matching widths");
assert.equal(panelLayout.hasRedundantLabel, false);
const modePositions = [];
for (const name of ["自由审图", "旗标快筛", "星级筛选", "自由审图"]) {
  await page.click(`button:text-is("${name}")`);
  modePositions.push(await page.evaluate(() => {
    const modes = document.querySelector('[aria-label="审图模式"]').getBoundingClientRect();
    const side = document.querySelector('.photo-review-side').getBoundingClientRect();
    return { top: modes.top, left: modes.left, bottom: modes.bottom, sideBottom: side.bottom };
  }));
}
assert.ok(modePositions.every(position =>
  Math.abs(position.top - modePositions[0].top) < 1 &&
  Math.abs(position.left - modePositions[0].left) < 1 &&
  position.bottom <= position.sideBottom && position.sideBottom - position.bottom <= 16
), "mode switching stays anchored at the bottom across all three modes");
await page.click('button:text-is("星级筛选")');
assert.match(await page.evaluate(() => document.querySelector(".photo-stage").textContent), /还没有留用照片/);
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "0 / 0");
await page.click('button:text-is("旗标快筛")');
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 4");
await page.click('button[aria-label="上一张"]');
const duplicatePick = await page.evaluate(async () => {
  const before = window.reviewFixture.calls.length;
  for (const key of ["c", "p", "C", "P"])
    document.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === key.toUpperCase(), bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  return { calls: window.reviewFixture.calls.length - before, flag: window.reviewFixture.photos[0].flag, counter: document.querySelector(".photo-counter").textContent };
});
assert.deepEqual(duplicatePick, { calls: 0, flag: "pick", counter: "1 / 4" });
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 4");
await page.click(".photo-flags button:last-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 4");
await page.click('button[aria-label="上一张"]');
const duplicateReject = await page.evaluate(async () => {
  const before = window.reviewFixture.calls.length;
  for (const shiftKey of [false, true])
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", shiftKey, bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  return { calls: window.reviewFixture.calls.length - before, flag: window.reviewFixture.photos[1].flag, counter: document.querySelector(".photo-counter").textContent };
});
assert.deepEqual(duplicateReject, { calls: 0, flag: "reject", counter: "2 / 4" });
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 4");
await page.click('button[aria-label="上一张"]');
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 4");
assert.equal(await page.evaluate(() => window.reviewFixture.photos[1].flag), "pick", "backtracking corrects an excluded photo");
await page.click('button[aria-label="查看 1-one.JPG"]');
await page.click('button:text-is("星级筛选")');
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "1 / 2");
assert.equal(await page.evaluate(() => document.querySelector('select[aria-label="星级等待时间"]').value), "500");
assert.equal(await page.evaluate(() => document.querySelectorAll(".photo-flags").length), 1);
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
assert.equal(await page.evaluate(() => document.querySelector(".photo-counter").textContent), "2 / 2");
await page.click('button[aria-label="上一张"]');
assert.equal(await page.evaluate(() => document.querySelector('button[aria-label="2 星"]').getAttribute("aria-pressed")), "true");
await page.evaluate(() => { window.reviewFixture.fail = false; });
await page.click('button[aria-label="关闭错误提示"]');
const animations = await page.evaluate(async () => {
  window.reviewFixture.delay = 900;
  const inspect = async (rating) => {
    document.querySelector(`button[aria-label="${rating} 星"]`).click();
    let result;
    const kind = rating === 3 ? "up" : "down";
    for (let attempt = 0; attempt < 50; attempt++) {
      result = document.querySelector(`.photo-feedback-result.${kind}`);
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!result) throw new Error(`Missing ${kind} animation before remote save`);
    const rect = result.getBoundingClientRect();
    return {
      kind: result.className,
      animations: result.getAnimations().map(animation => animation.animationName),
      width: rect.width, height: rect.height,
      savedRating: window.reviewFixture.photos[0].rating,
    };
  };
  return [await inspect(3), await inspect(1)];
});
assert.match(animations[0].kind, /\bup\b/);
assert.ok(animations[0].animations.includes("photo-result-pop"));
assert.match(animations[1].kind, /\bdown\b/);
assert.ok(animations[1].animations.includes("photo-down"));
assert.ok(animations.every(animation => animation.width > 0 && animation.height > 0 && animation.savedRating === 2), "both animations render before remote persistence");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 2");
await page.waitForFunction(() => window.reviewFixture.photos[0].rating === 1);
await page.evaluate(() => { window.reviewFixture.delay = 0; });
// The idle deadline is independent of both remote persistence and animation.
for (const delayMs of [200, 500]) {
  await page.click('button[aria-label="查看 1-one.JPG"]');
  const timing = await page.evaluate(async (delayMs) => {
    const { useAppSettings } = await import('/src/appSettings.ts');
    useAppSettings.getState().setRatingAdvanceDelay(delayMs);
    useAppSettings.getState().setReviewAnimationDuration(2000);
    await new Promise(resolve => setTimeout(resolve, 0));
    window.reviewFixture.delay = 1200;
    const before = window.reviewFixture.calls.length;
    document.querySelector('button[aria-label="2 星"]').click();
    await new Promise(resolve => setTimeout(resolve, delayMs - 50));
    document.querySelector('button[aria-label="1 星"]').click();
    await new Promise(resolve => setTimeout(resolve, delayMs - 50));
    const beforeDeadline = document.querySelector('.photo-counter').textContent;
    await new Promise(resolve => setTimeout(resolve, 150));
    return {
      beforeDeadline,
      afterDeadline: document.querySelector('.photo-counter').textContent,
      saving: document.querySelector('.photo-review-side').textContent.includes('保存中'),
      calls: window.reviewFixture.calls.length - before,
    };
  }, delayMs);
  assert.deepEqual(timing, { beforeDeadline: "1 / 2", afterDeadline: "2 / 2", saving: true, calls: 1 });
  await page.waitForFunction(() => !document.querySelector('.photo-review-side').textContent.includes('保存中'));
  assert.equal(await page.evaluate(() => window.reviewFixture.photos[0].rating), 1);
  assert.equal(await page.evaluate(() => document.querySelector('.photo-counter').textContent), "2 / 2");
}
await page.evaluate(async () => {
  window.reviewFixture.delay = 0;
  const { useAppSettings } = await import('/src/appSettings.ts');
  useAppSettings.getState().setRatingAdvanceDelay(500);
  useAppSettings.getState().setReviewAnimationDuration(500);
});
// In rating mode, C confirms an existing pick and X removes it from the picked
// list. Both advance without clearing its rating or jumping back to the start.
await page.click('button:text-is("旗标快筛")');
await page.click('button[aria-label="查看 3-three.JPG"]');
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "4 / 4");
await page.click(".photo-flags button:first-child");
await page.waitForFunction(() => window.reviewFixture.photos[3].flag === "pick");
await page.click('button[aria-label="查看 1-one.JPG"]');
await page.click('button:text-is("星级筛选")');
const beforeConfirm = await page.evaluate(() => window.reviewFixture.calls.length);
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })));
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 4");
assert.deepEqual(await page.evaluate(() => ({
  flag: window.reviewFixture.photos[0].flag,
  rating: window.reviewFixture.photos[0].rating,
  calls: window.reviewFixture.calls.length,
})), { flag: "pick", rating: 1, calls: beforeConfirm });
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })));
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 3");
assert.equal(await page.evaluate(() => document.querySelector('.photo-filmstrip button[aria-current="true"]').getAttribute("aria-label")), "查看 3-three.JPG");
assert.equal(await page.evaluate(() => window.reviewFixture.photos[1].flag), "reject");
assert.equal(await page.evaluate(() => window.reviewFixture.photos[1].rating), 3);
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "C", shiftKey: true, bubbles: true })));
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "3 / 3");
// Rejecting the last photo falls back to the previous remaining pick.
await page.click(".photo-flags button:last-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "2 / 2");
await page.click(".photo-flags button:last-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "1 / 1");
await page.click(".photo-flags button:last-child");
await page.waitForFunction(() => document.querySelector(".photo-counter").textContent === "0 / 0");
assert.match(await page.evaluate(() => document.querySelector(".photo-stage").textContent), /还没有留用照片/);
const measurements = [];
for (const width of [1280, 760]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width, height: 850, deviceScaleFactor: 1, mobile: false,
  });
  const metrics = await page.evaluate(() => {
    const selectors = [".photo-review-workspace", ".photo-review-side", ".photo-stage", ".photo-filmstrip"];
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
  assert.equal(new Set(metrics.modes).size, 1, "mode buttons share a fixed bottom row");
  assert.ok(metrics.rows.every(row => row.bottom <= 850 && row.height > 0), "both wings and the image stage fit the viewport");
  const [workspace, side, stage, film] = metrics.rows;
  assert.ok(film.right <= stage.x && stage.right <= side.x, "the photo sits between two non-overlapping wings");
  assert.equal(stage.top, workspace.top, "the photo uses the full workspace height");
  assert.equal(stage.bottom, workspace.bottom);
  measurements.push(metrics);
}
console.log({ passed: "quick flags, backtrack/correct, picked-only ratings, debounce, configurable delay, navigation cancellation, save failure, empty picks, immediate increase/decrease animations during slow saves, responsive layout", animations, measurements });
console.log(await page.snapshot({ scope: "full_page" }));
if (globalThis.filoReviewModesScreenshot)
  console.log(await page.screenshot({ path: globalThis.filoReviewModesScreenshot }));
await task.finish({ keep: [] });
