import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../apps/desktop/src/photoReviewController.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { PhotoReviewController, preparePhotoReviewExit, photoKeyAction, photoFeedbackDuration, sortPhotos, matchesPhoto } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const photo = (id, rating = 0) => ({ id, original_path: `${id}.NEF`, rating, flag: "none", revision: 0 });
function setup(photos = [photo("a"), photo("b")], save = async (id, mark) => ({ ...photos.find(p => p.id === id), ...mark, })) {
  const feedback = [], errors = [], calls = [];
  const controller = new PhotoReviewController(photos, photos[0].id, {
    save: (id, mark) => { calls.push({id,...mark}); return save(id,mark); },
    undo: async () => photo("a", 2), changed: () => {}, saved: () => {}, feedback: f => feedback.push(f), error: (message,retry,reload) => errors.push({message,retry,reload}),
  });
  return { controller, feedback, errors, calls };
}
const key = (code, key, extra = {}) => ({ code,key,repeat:false,altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,...extra });
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

test("quick flags finish their animation before advancing, including repeated marks without saving again", async (t) => {
  assert.equal(photoFeedbackDuration, 800);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  for (const flag of ["pick", "reject"]) {
    for (const repeated of [false, true]) {
      let release;
      const { controller, calls, feedback } = setup([
        { ...photo("a"), flag: repeated ? flag : "none" }, photo("b"),
      ], (id, mark) => new Promise(resolve => { release = () => resolve({ ...photo(id), ...mark }); }));
      controller.mark({ rating: 0, flag }, true, () => controller.select("b"), {
        delayMs: photoFeedbackDuration, background: true, repeatFlagFeedback: true,
      });
      await Promise.resolve();
      assert.equal(feedback.at(-1).kind, "flag");
      assert.equal(feedback.at(-1).flag, flag);
      assert.equal(calls.length, repeated ? 0 : 1);
      t.mock.timers.tick(photoFeedbackDuration - 1);
      assert.equal(controller.current, "a", "keep the photo visible until the animation finishes");
      t.mock.timers.tick(1);
      assert.equal(controller.current, "b", "advance even while the background write is unfinished");
      assert.equal(controller.photos[0].flag, flag);
      release?.();
      await controller.settle();
      controller.dispose();
    }
  }
});

test("exit saves the position only after pending marks have finished", async () => {
  let release;
  const { controller } = setup(undefined, (id, mark) => new Promise(resolve => {
    release = () => resolve({ ...photo(id), ...mark });
  }));
  controller.mark({ rating: 3, flag: "pick" }, false, () => {});
  let positionSaved = false;
  const exiting = preparePhotoReviewExit(controller, async () => { positionSaved = true; });
  await delay(0);
  assert.equal(positionSaved, false);
  release();
  assert.equal(await exiting, "saved");
  assert.equal(positionSaved, true);
  controller.dispose();
});

test("failed marks remain detectable for exit even after their error banner is dismissed", async () => {
  const { controller, errors } = setup(undefined, async () => { throw new Error("SMB disconnected"); });
  controller.mark({ rating: 3, flag: "pick" }, false, () => {});
  await controller.settle();
  errors.length = 0;
  const status = await preparePhotoReviewExit(controller, async () => { assert.fail("do not hide a failed mark behind a position save"); });
  assert.equal(status, "failed");
  controller.dispose();
});

test("exit stops waiting for a stalled mark without cancelling its eventual save", async () => {
  let release;
  const { controller } = setup(undefined, (id, mark) => new Promise(resolve => {
    release = () => resolve({ ...photo(id), ...mark });
  }));
  controller.mark({ rating: 3, flag: "pick" }, false, () => {});
  assert.equal(await preparePhotoReviewExit(controller, async () => {}, 10), "pending");
  controller.dispose();
  release();
  await controller.settle();
  assert.equal(controller.photo.rating, 3);
  assert.equal(controller.pending, 0);
});

test("exit handles rejected and stalled position writes without trapping navigation", async () => {
  const { controller } = setup();
  await assert.rejects(preparePhotoReviewExit(controller, async () => { throw new Error("SMB disconnected"); }), /SMB disconnected/);
  let reject;
  assert.equal(await preparePhotoReviewExit(controller, () => new Promise((_, r) => { reject = r; }), 10), "pending");
  reject(new Error("late position failure"));
  await delay(0);
  controller.dispose();
});

test("a failed undo also prevents reporting a fully saved exit", async () => {
  const { controller, errors } = setup();
  controller.deps.undo = async () => { throw new Error("SMB disconnected"); };
  controller.undo();
  await controller.settle();
  assert.equal(await preparePhotoReviewExit(controller, async () => {}), "failed");
  controller.deps.undo = async () => null;
  errors.at(-1).retry();
  await controller.settle();
  assert.equal(await preparePhotoReviewExit(controller, async () => {}), "saved");
  controller.dispose();
});

test("review sorts natural filenames and complete capture times with missing dates last", () => {
  const photos = [
    {...photo("ten"), original_path:"a/10.NEF", capture_time:"2026:10:19 10:00:00"},
    {...photo("two"), original_path:"z/2.NEF", capture_time:"2026:10:19 09:00:00"},
    {...photo("one"), original_path:"b/1.NEF", capture_time:"2026:10:19 10:00:00"},
    {...photo("missing"), original_path:"0.NEF", capture_date:"2026-10-18", capture_time:null},
  ];
  const ids = sort => sortPhotos(photos,sort).map(p=>p.id);
  assert.deepEqual(ids("name_asc"),["missing","one","two","ten"]);
  assert.deepEqual(ids("name_desc"),["ten","two","one","missing"]);
  assert.deepEqual(ids("capture_asc"),["two","one","ten","missing"]);
  assert.deepEqual(ids("capture_desc"),["one","ten","two","missing"]);
  assert.deepEqual(photos.map(p=>p.id),["ten","two","one","missing"]);
});

test("workflow filters distinguish unflagged photos from ratings and rated photos from flags", () => {
  const photos = [photo("unrated"),photo("unflagged-rated",5),
    {...photo("picked"),flag:"pick"},{...photo("picked-rated",4),flag:"pick"},
    {...photo("rejected-rated",3),flag:"reject"}];
  const ids = (filter,minimum) => photos.filter(p=>matchesPhoto(p,filter,minimum)).map(p=>p.id);
  assert.deepEqual(ids("none",0),["unrated","unflagged-rated"]);
  assert.deepEqual(ids("pick",0),["picked","picked-rated"]);
  assert.deepEqual(ids("all",3),["unflagged-rated","picked-rated","rejected-rated"]);
  assert.deepEqual(ids("pick",4),["picked-rated"]);
  assert.deepEqual(ids("none",4),["unflagged-rated"]);
  assert.deepEqual(ids("reject",5),[]);
});

test("keyboard distinguishes relative adjustments, explicit advance, modifiers and repeats", () => {
  assert.deepEqual(photoKeyAction(key("BracketRight","]"),true),{type:"rating",value:1,relative:true,advance:false});
  assert.deepEqual(photoKeyAction(key("BracketLeft","{",{shiftKey:true}),false),{type:"rating",value:-1,relative:true,advance:true});
  assert.deepEqual(photoKeyAction(key("Digit3","#",{shiftKey:true}),false),{type:"rating",value:3,relative:false,advance:true});
  assert.equal(photoKeyAction(key("Digit3","3",{repeat:true}),true),null);
  assert.equal(photoKeyAction(key("KeyP","p",{metaKey:true}),false),null);
  assert.deepEqual(photoKeyAction(key("Space"," "),false),{type:"zoom"});
  assert.equal(photoKeyAction(key("Space"," ",{repeat:true}),false),null);
  assert.equal(photoKeyAction(key("Space"," ",{ctrlKey:true}),false),null);
  assert.deepEqual(photoKeyAction(key("KeyZ","z",{ctrlKey:true}),false),{type:"undo"});
});

test("rapid ratings use captured identity and only latest persisted feedback", async () => {
  let resolve; const {controller,calls,feedback} = setup(undefined, (id,mark) => new Promise(r => {resolve = () => r({...photo(id),...mark,});}));
  controller.mark({rating:1,flag:"none"},false,()=>{});
  controller.mark({rating:2,flag:"none"},false,()=>{});
  controller.mark({rating:3,flag:"none"},false,()=>{});
  await delay(0); assert.equal(calls.length,1); assert.equal(controller.photo.rating,3);
  resolve(); await delay(0); assert.equal(calls.length,2); assert.equal(controller.photo.rating,3);
  resolve(); await delay(0); resolve(); await controller.settle();
  assert.deepEqual(calls.map(c => c.id),["a","a","a"]);
  assert.equal(controller.photo.rating,3); assert.equal(feedback.filter(Boolean).length,1);
  controller.dispose();
});

test("an old failed request cannot undo a newer desired mark", async () => {
  let count=0; const {controller,errors} = setup(undefined,async (id,mark) => { if (++count === 1) throw new Error("disk full"); return {...photo(id),...mark,}; });
  controller.mark({rating:1,flag:"none"},false,()=>{}); controller.mark({rating:4,flag:"pick"},false,()=>{});
  await controller.settle(); assert.equal(controller.photo.rating,4); assert.equal(controller.photo.flag,"pick");
  assert.equal(errors.filter(e => e.message).length,0); controller.dispose();
});

test("latest save failure restores durable state and offers a photo-specific retry", async () => {
  let fail = true; const {controller,errors,feedback} = setup(undefined,async (id,mark) => { if (fail) throw new Error("disk full"); return {...photo(id),...mark,}; });
  controller.mark({rating:5,flag:"reject"},true,()=>controller.select("b")); await controller.settle();
  assert.equal(controller.photo.rating,0); assert.equal(controller.current,"a"); assert.equal(feedback.filter(Boolean).length,0);
  assert.match(errors.at(-1).message,/a.NEF.*disk full/); fail=false; errors.at(-1).retry(); await controller.settle();
  assert.equal(controller.photo.rating,5); assert.equal(controller.photo.flag,"reject"); controller.dispose();
});

test("a conflicting directory mark requests reload instead of repeatedly retrying stale state", async () => {
  const {controller,calls,errors} = setup(undefined,async()=>{
    throw {code:"conflict",message:"目录中的审图进度已被其他窗口或电脑更新，请重新进入审图后重试"};
  });
  controller.mark({rating:5,flag:"pick"},true,()=>controller.select("b"));
  await controller.settle();
  assert.equal(controller.current,"a");
  assert.equal(controller.photo.rating,0);
  assert.equal(controller.photo.flag,"none");
  assert.equal(calls.length,1);
  assert.equal(errors.at(-1).reload,true);
  assert.equal(typeof errors.at(-1).retry,"function");
  controller.dispose();
});

test("manual navigation suppresses late feedback and automatic navigation", async () => {
  let resolve; const {controller,feedback} = setup(undefined,(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,});}));
  controller.mark({rating:3,flag:"none"},true,()=>controller.select("b")); await delay(0); controller.select("b"); resolve();
  await controller.settle(); await delay(210); assert.equal(controller.current,"b"); assert.equal(controller.photo.rating,0); assert.equal(feedback.filter(Boolean).length,0); controller.dispose();
});

test("automatic advance waits for persistence and motion onset; boundaries do not save", async () => {
  let resolve; const {controller,calls} = setup([photo("a",4),photo("b")],(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,});}));
  let advances=0; const next=()=>{advances++;controller.select("b");};
  controller.mark({rating:5,flag:"none"},true,next); await delay(0); assert.equal(advances,0);
  resolve(); await controller.settle(); await delay(100); assert.equal(advances,0); await delay(110); assert.equal(advances,1);
  controller.select("a"); controller.mark({rating:6,flag:"none"},false,next); await controller.settle(); assert.equal(calls.length,1);
  controller.mark({rating:6,flag:"none"},true,next); await controller.settle(); assert.equal(advances,2); assert.equal(calls.length,1); controller.dispose();
});

test("a Shift boundary waits for an outstanding save before advancing", async () => {
  let resolve; const {controller} = setup([photo("a",4),photo("b")],(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,});}));
  let advanced=false; controller.mark({rating:5,flag:"none"},false,()=>{});
  controller.mark({rating:6,flag:"none"},true,()=>{advanced=true;}); await delay(0); assert.equal(advanced,false);
  resolve(); await controller.settle(); assert.equal(advanced,true); controller.dispose();
});

test("undo returns to its photo and a complete batch can exceed 200 photos",async()=>{
  const photos=Array.from({length:241},(_,i)=>photo(String(i)));
  const {controller}=setup(photos); controller.step(240,photos.map(p=>p.id)); assert.equal(controller.current,"240");
  controller.undo(); await controller.settle(); assert.equal(controller.current,"a"); controller.dispose();
});

test("RAW view skips JPG-only photos and preserves shared marks when toggled", async () => {
  const photos = [
    {...photo("jpg"), files:[{kind:"jpg"}]},
    {...photo("pair"), files:[{kind:"jpg"},{kind:"raw"}]},
    {...photo("raw"), files:[{kind:"raw"}]},
  ];
  const {controller} = setup(photos);
  controller.mark({rating:4,flag:"pick"},false,()=>{});
  await controller.settle();
  controller.setRawOnly(true);
  assert.equal(controller.current,"pair");
  controller.select("jpg");
  assert.equal(controller.current,"pair");
  controller.step(1,["pair","raw"]);
  assert.equal(controller.current,"raw");
  controller.setRawOnly(false);
  controller.select("jpg");
  assert.equal(controller.photo.rating,4);
  assert.equal(controller.photo.flag,"pick");
  assert.deepEqual(controller.photos.map(p=>p.id),["jpg","pair","raw"]);
  controller.dispose();
});

test("a saved RAW view restores to a RAW photo and an empty RAW view can be cleared", () => {
  const deps = {save:async()=>{},undo:async()=>null,changed:()=>{},saved:()=>{},feedback:()=>{},error:()=>{}};
  const jpg = {...photo("jpg"),files:[{kind:"jpg"}]};
  const raw = {...photo("raw"),files:[{kind:"raw"}]};
  const restored = new PhotoReviewController([jpg,raw],jpg.id,deps,true);
  assert.equal(restored.current,raw.id);
  assert.equal(restored.rawOnly,true);
  const empty = new PhotoReviewController([jpg],jpg.id,deps,true);
  assert.equal(empty.current,null);
  assert.equal(empty.photo,undefined);
  empty.setRawOnly(false);
  assert.equal(empty.current,jpg.id);
});

test("an unchanged mark creates no reviewed state or persistence, and explicit advance still works", async () => {
  const {controller,calls} = setup();
  controller.mark({rating:0,flag:"none"},false,()=>{});
  await controller.settle();
  assert.equal(calls.length,0);
  assert.equal(Object.hasOwn(controller.photo,"reviewed"),false);
  controller.mark({rating:0,flag:"none"},true,()=>controller.select("b"));
  await controller.settle();
  assert.equal(controller.current,"b");
  assert.equal(calls.length,0);
  controller.dispose();
});

test("preview cache keeps paired JPG and RAW previews separate",async()=>{
  const calls=[];
  globalThis.__filoPreviewTestApi={preview:async(...args)=>{
    calls.push(args);
    return {mime:"image/jpeg",content:args.join(":"),width:1,height:1,embedded:args[3]};
  }};
  const cacheSource=await readFile(new URL("../apps/desktop/src/photoPreviewCache.ts",import.meta.url),"utf8");
  const compiled=ts.transpileModule(cacheSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
    .replace(/import[^;]+from "\.\/photoApi";/,"const reviewApi = globalThis.__filoPreviewTestApi;");
  const {photoPreview}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  delete globalThis.__filoPreviewTestApi;
  const jpg=await photoPreview("paired");
  const raw=await photoPreview("paired",false,false,true);
  assert.equal(jpg.embedded,false);
  assert.equal(raw.embedded,true);
  assert.notEqual(jpg.content,raw.content);
  assert.equal(await photoPreview("paired"),jpg);
  assert.equal(await photoPreview("paired",false,false,true),raw);
  assert.equal(calls.length,2);
});

test("rating mode debounces from the latest action and honors the configured delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { controller, calls } = setup();
  const next = () => controller.step(1, ["a", "b"]);
  controller.mark({ rating: 1, flag: "pick" }, true, next, { delayMs: 500 });
  await controller.settle();
  t.mock.timers.tick(400);
  assert.equal(controller.current, "a");
  controller.mark({ rating: 2, flag: "pick" }, true, next, { delayMs: 500 });
  await controller.settle();
  t.mock.timers.tick(499);
  assert.equal(controller.current, "a");
  t.mock.timers.tick(1);
  assert.equal(controller.current, "b");
  assert.deepEqual(calls.map(p => [p.id, p.rating]), [["a", 1], ["a", 2]]);
  controller.select("a");
  controller.mark({ rating: 3, flag: "pick" }, true, next, { delayMs: 1500 });
  await controller.settle();
  t.mock.timers.tick(1499);
  assert.equal(controller.current, "a");
  t.mock.timers.tick(1);
  assert.equal(controller.current, "b");
  controller.dispose();
});

test("a slow save does not add another rating delay and interaction cancels late navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let release;
  const { controller } = setup(undefined, (id, mark) => new Promise(resolve => {
    release = () => resolve({ ...photo(id), ...mark });
  }));
  const next = () => controller.select("b");
  controller.mark({ rating: 1, flag: "pick" }, true, next, { delayMs: 500 });
  await Promise.resolve();
  t.mock.timers.tick(700);
  assert.equal(controller.current, "a", "must wait for persistence");
  release();
  await controller.settle();
  t.mock.timers.tick(0);
  assert.equal(controller.current, "b", "idle time elapsed during persistence");
  controller.select("a");
  controller.mark({ rating: 2, flag: "pick" }, true, next, { delayMs: 500 });
  await Promise.resolve();
  controller.cancelAdvance();
  release();
  await controller.settle();
  t.mock.timers.tick(2000);
  assert.equal(controller.current, "a", "cancel survives an outstanding save");
  controller.dispose();
});

test("rating mode animates each increase and decrease immediately during slow saves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let release;
  const { controller, feedback } = setup([photo("a", 2), photo("b")], (id, mark) => new Promise(resolve => {
    release = () => resolve({ ...photo(id), ...mark });
  }));
  const next = () => controller.select("b");
  const options = { delayMs: 500, immediateFeedback: true };
  controller.mark({ rating: 3, flag: "none" }, true, next, options);
  assert.equal(feedback.at(-1).kind, "up");
  assert.equal(feedback.at(-1).from, 2);
  await Promise.resolve();
  t.mock.timers.tick(700);
  assert.equal(controller.current, "a", "persistence still gates navigation");
  release();
  await controller.settle();
  assert.equal(feedback.filter(Boolean).length, 1, "save completion must not restart animation");
  t.mock.timers.tick(0);
  assert.equal(controller.current, "b");
  controller.select("a");
  controller.mark({ rating: 1, flag: "none" }, true, next, options);
  assert.equal(feedback.at(-1).kind, "down");
  assert.equal(feedback.at(-1).from, 3);
  await Promise.resolve();
  release();
  await controller.settle();
  t.mock.timers.tick(499);
  assert.equal(controller.current, "a");
  t.mock.timers.tick(1);
  assert.equal(controller.current, "b");
  controller.dispose();
});

test("quick flags advance in the background; clearing, navigation, and disposal cancel timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { controller } = setup();
  const next = () => controller.step(1, ["a", "b"]);
  controller.mark({ rating: 0, flag: "pick" }, true, next, { delayMs: 0, background: true });
  assert.equal(controller.current, "a");
  await controller.settle();
  t.mock.timers.tick(0);
  assert.equal(controller.current, "b");
  controller.select("a");
  controller.mark({ rating: 3, flag: "pick" }, true, next, { delayMs: 500 });
  await controller.settle();
  controller.mark({ rating: 0, flag: "pick" }, false, next, { delayMs: 500 });
  await controller.settle();
  t.mock.timers.tick(500);
  assert.equal(controller.current, "a", "clear rating stays on this photo");
  controller.mark({ rating: 3, flag: "pick" }, true, next, { delayMs: 500 });
  await controller.settle();
  controller.select("b");
  controller.select("a");
  t.mock.timers.tick(500);
  assert.equal(controller.current, "a", "returning must not revive the timer");
  controller.mark({ rating: 4, flag: "pick" }, true, next, { delayMs: 500 });
  await controller.settle();
  controller.dispose();
  t.mock.timers.tick(500);
  assert.equal(controller.current, "a");
});

test("quick flags keep advancing while remote writes are stalled and preserve write order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const photos = [photo("a"), photo("b"), photo("c")];
  const releases = [];
  const { controller, calls, feedback } = setup(photos, (id, mark) => new Promise(resolve => {
    releases.push(() => resolve({ ...photo(id), ...mark }));
  }));
  let advances = 0;
  const next = () => { advances++; controller.step(1, ["a", "b", "c"]); };
  controller.mark({ rating: 0, flag: "pick" }, true, next, { delayMs: 0, background: true });
  assert.equal(feedback.filter(Boolean).length, 1, "feedback follows the action");
  t.mock.timers.tick(0);
  assert.equal(controller.current, "b");
  controller.mark({ rating: 0, flag: "reject" }, true, next, { delayMs: 0, background: true });
  t.mock.timers.tick(0);
  assert.equal(controller.current, "c");
  assert.equal(controller.pending, 2);
  await Promise.resolve();
  assert.deepEqual(calls.map(call => call.id), ["a"]);
  releases.shift()();
  // Let the serialized queue begin the second write.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(calls.map(call => [call.id, call.flag]), [["a", "pick"], ["b", "reject"]]);
  releases.shift()();
  await controller.settle();
  t.mock.timers.tick(1000);
  assert.equal(advances, 2, "late saves never advance again");
  assert.equal(controller.current, "c");
  assert.equal(controller.pending, 0);
  assert.deepEqual(controller.photos.map(p => p.flag), ["pick", "reject", "none"]);
  controller.dispose();
});

test("a background failure rolls back its photo without navigating back or clearing another failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let reject, fail = true;
  const { controller, errors } = setup([photo("a"), photo("b"), photo("c")], async (id, mark) => {
    if (id === "a" && fail) await new Promise((_, r) => { reject = r; });
    return { ...photo(id), ...mark };
  });
  const next = () => controller.step(1, ["a", "b", "c"]);
  controller.mark({ rating: 0, flag: "reject" }, true, next, { delayMs: 0, background: true });
  t.mock.timers.tick(0);
  controller.mark({ rating: 0, flag: "pick" }, true, next, { delayMs: 0, background: true });
  t.mock.timers.tick(0);
  await Promise.resolve();
  reject(new Error("network unavailable"));
  await controller.settle();
  assert.equal(controller.current, "c");
  assert.equal(controller.photos[0].flag, "none");
  assert.equal(controller.photos[1].flag, "pick");
  assert.match(errors.at(-1).message, /a.NEF.*network unavailable/);
  fail = false;
  errors.at(-1).retry();
  await controller.settle();
  assert.equal(controller.current, "a");
  assert.equal(controller.photo.flag, "reject");
  assert.equal(errors.at(-1).message, "");
  controller.dispose();
});

test("background timers are cancelled by manual navigation and unmount while saves still finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let release;
  const { controller } = setup(undefined, (id, mark) => new Promise(resolve => {
    release = () => resolve({ ...photo(id), ...mark });
  }));
  let advances = 0;
  const next = () => { advances++; };
  controller.mark({ rating: 0, flag: "pick" }, true, next, { delayMs: 0, background: true });
  controller.select("b");
  t.mock.timers.tick(0);
  assert.equal(advances, 0);
  controller.mark({ rating: 0, flag: "reject" }, true, next, { delayMs: 0, background: true });
  controller.dispose();
  t.mock.timers.tick(0);
  assert.equal(advances, 0);
  await Promise.resolve();
  release();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  release();
  await controller.settle();
  assert.equal(controller.pending, 0);
  assert.deepEqual(controller.photos.map(p => p.flag), ["pick", "reject"]);
});
