import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../apps/desktop/src/photoReviewController.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { PhotoReviewController, photoKeyAction } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const photo = (id, rating = 0) => ({ id, original_path: `${id}.NEF`, rating, flag: "none", reviewed: false, revision: 0 });
function setup(photos = [photo("a"), photo("b")], save = async (id, mark) => ({ ...photos.find(p => p.id === id), ...mark, reviewed: true })) {
  const feedback = [], errors = [], calls = [];
  const controller = new PhotoReviewController(photos, photos[0].id, {
    save: (id, mark) => { calls.push({id,...mark}); return save(id,mark); },
    undo: async () => photo("a", 2), changed: () => {}, saved: () => {}, feedback: f => feedback.push(f), error: (message,retry) => errors.push({message,retry}),
  });
  return { controller, feedback, errors, calls };
}
const key = (code, key, extra = {}) => ({ code,key,repeat:false,altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,...extra });
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

test("keyboard distinguishes relative adjustments, explicit advance, modifiers and repeats", () => {
  assert.deepEqual(photoKeyAction(key("BracketRight","]"),true),{type:"rating",value:1,relative:true,advance:false});
  assert.deepEqual(photoKeyAction(key("BracketLeft","{",{shiftKey:true}),false),{type:"rating",value:-1,relative:true,advance:true});
  assert.deepEqual(photoKeyAction(key("Digit3","#",{shiftKey:true}),false),{type:"rating",value:3,relative:false,advance:true});
  assert.equal(photoKeyAction(key("Digit3","3",{repeat:true}),true),null);
  assert.equal(photoKeyAction(key("KeyP","p",{metaKey:true}),false),null);
  assert.deepEqual(photoKeyAction(key("KeyZ","z",{ctrlKey:true}),false),{type:"undo"});
});

test("rapid ratings use captured identity and only latest persisted feedback", async () => {
  let resolve; const {controller,calls,feedback} = setup(undefined, (id,mark) => new Promise(r => {resolve = () => r({...photo(id),...mark,reviewed:true});}));
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
  let count=0; const {controller,errors} = setup(undefined,async (id,mark) => { if (++count === 1) throw new Error("disk full"); return {...photo(id),...mark,reviewed:true}; });
  controller.mark({rating:1,flag:"none"},false,()=>{}); controller.mark({rating:4,flag:"pick"},false,()=>{});
  await controller.settle(); assert.equal(controller.photo.rating,4); assert.equal(controller.photo.flag,"pick");
  assert.equal(errors.filter(e => e.message).length,0); controller.dispose();
});

test("latest save failure restores durable state and offers a photo-specific retry", async () => {
  let fail = true; const {controller,errors,feedback} = setup(undefined,async (id,mark) => { if (fail) throw new Error("disk full"); return {...photo(id),...mark,reviewed:true}; });
  controller.mark({rating:5,flag:"reject"},true,()=>controller.select("b")); await controller.settle();
  assert.equal(controller.photo.rating,0); assert.equal(controller.current,"a"); assert.equal(feedback.filter(Boolean).length,0);
  assert.match(errors.at(-1).message,/a.NEF.*disk full/); fail=false; errors.at(-1).retry(); await controller.settle();
  assert.equal(controller.photo.rating,5); assert.equal(controller.photo.flag,"reject"); controller.dispose();
});

test("manual navigation suppresses late feedback and automatic navigation", async () => {
  let resolve; const {controller,feedback} = setup(undefined,(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,reviewed:true});}));
  controller.mark({rating:3,flag:"none"},true,()=>controller.select("b")); await delay(0); controller.select("b"); resolve();
  await controller.settle(); await delay(210); assert.equal(controller.current,"b"); assert.equal(controller.photo.rating,0); assert.equal(feedback.filter(Boolean).length,0); controller.dispose();
});

test("automatic advance waits for persistence and motion onset; boundaries do not save", async () => {
  let resolve; const {controller,calls} = setup([photo("a",4),photo("b")],(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,reviewed:true});}));
  let advances=0; const next=()=>{advances++;controller.select("b");};
  controller.mark({rating:5,flag:"none"},true,next); await delay(0); assert.equal(advances,0);
  resolve(); await controller.settle(); await delay(100); assert.equal(advances,0); await delay(110); assert.equal(advances,1);
  controller.select("a"); controller.mark({rating:6,flag:"none"},false,next,true); await controller.settle(); assert.equal(calls.length,1);
  controller.mark({rating:6,flag:"none"},true,next,true); await controller.settle(); assert.equal(advances,2); assert.equal(calls.length,1); controller.dispose();
});

test("a Shift boundary waits for an outstanding save before advancing", async () => {
  let resolve; const {controller} = setup([photo("a",4),photo("b")],(id,mark)=>new Promise(r=>{resolve=()=>r({...photo(id),...mark,reviewed:true});}));
  let advanced=false; controller.mark({rating:5,flag:"none"},false,()=>{});
  controller.mark({rating:6,flag:"none"},true,()=>{advanced=true;},true); await delay(0); assert.equal(advanced,false);
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
