// Run against a Vite preview with: ego-browser nodejs < scripts/test-s3-providers.mjs
// All IPC is mocked; this test never accesses real storage or credentials.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo storage provider forms",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.s3Calls=[];
window.testVolumes=[];
window.testConnections=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
      if (command === 'recent_backend_errors') return [];
  if(command==='plugin:event|listen')return 1;
  if(command==='plugin:event|unlisten')return;
  if(command==='directory_stamp')return '1';
  if(command==='manage_s3')return {object_count:0,total_size:0,complete:true};
  if(command==='list_volumes')return window.testVolumes;
  if(command==='list_connections')return window.testConnections;
  if(command==='list_transfers'||command==='list_entries')return [];
  if(command==='list_entries_page')return {entries:[],next_cursor:null};
  if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
  if(command==='test_s3_connection'){
    window.s3Calls.push(args);
    if(window.holdTest)await new Promise(resolve=>window.releaseTest=resolve);
    if(window.failTest)throw {message:'连接失败，请检查访问地址'};
    return;
  }
  if(command==='save_s3_storage'){
    window.s3Calls.push(args);
    const id=args.volumeId||'test-volume';
    const v={id,connection_id:id,name:args.input.name,root:{type:'s3',bucket:args.input.bucket,prefix:args.input.prefix},read_only:args.input.read_only,capabilities:{hierarchy:'virtual_prefix',rename:'copy_then_delete',create_directory:true,delete:true,trash:false,native_open:false,native_copy:true}};
    window.testVolumes=[v];
    window.testConnections=[{id,name:v.name,provider:'s3',config:args.input.config}];
    return v;
  }
  if(command==='create_local_storage'){window.localReadOnly=args.readOnly;return null;}
  throw new Error('Unexpected IPC: '+command);
}};`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1422");
const openChooser = async () => {
  await page.click('.sidebar button[aria-label="添加存储空间"]');
  await page.waitForSelector(".s3-provider-list");
};
await openChooser();
assert.deepEqual(
  await page.evaluate(() =>
    [...document.querySelectorAll(".storage-section h3")].map(
      (e) => e.textContent,
    ),
  ),
  ["本地文件系统", "S3 存储"],
);
assert.deepEqual(
  await page.evaluate(() =>
    [...document.querySelectorAll(".provider-choice strong")].map(
      (e) => e.textContent,
    ),
  ),
  ["通用 S3 协议", "RustFS", "火山云 TOS", "阿里云 OSS"],
);
await page.waitForFunction(() => {
  const icons = [...document.querySelectorAll(".storage-provider-icon img")];
  return (
    icons.length === 3 &&
    icons.every((image) => image.complete && image.naturalWidth > 0)
  );
});
const iconGeometry = await page.evaluate(() => {
  const choices = [...document.querySelectorAll(".provider-choice")];
  return choices.map((choice) => ({
    iconLeft: choice
      .querySelector(".storage-provider-icon")
      .getBoundingClientRect().left,
    textLeft: choice
      .querySelector(".provider-choice-copy")
      .getBoundingClientRect().left,
  }));
});
assert.ok(
  iconGeometry.every(
    (item) =>
      item.iconLeft === iconGeometry[0].iconLeft &&
      item.textLeft === iconGeometry[0].textLeft,
  ),
);
if (!globalThis.filoSkipScreenshot)
  await page.screenshot({ path: "/tmp/filo-provider-icons.png" });
await page.click(".storage-section input[type=checkbox]");
await page.click('button:text-is("选择本地目录")');
await page.waitForFunction(() => window.localReadOnly === true);
if (await page.evaluate(() => !!document.querySelector("dialog[open]")))
  await page.click('button[aria-label="关闭"]');

const field = (label) => `xpath=//label[contains(., "${label}")]//input`;
const value = (label) =>
  page.evaluate(
    (label) =>
      [...document.querySelectorAll("label")]
        .find((e) => e.textContent.includes(label) && e.querySelector("input"))
        .querySelector("input").value,
    label,
  );
const lastInput = () => page.evaluate(() => window.s3Calls.at(-1).input);
const test = async () => {
  await page.click('button:text-is("测试连接")');
  await page.waitForSelector("[role=status]");
  return lastInput();
};
const fillRequired = async () => {
  await page.fill(field("连接名称"), "provider-test");
  await page.fill(field("存储桶"), "test-bucket");
  await page.fill(field("Access Key ID"), "test-access");
  await page.fill('input[autocomplete="new-password"]', "test-secret");
};
// The same modal expands, retains drafts across providers, and can collapse.
await openChooser();
await page.evaluate(() => {
  window.originalDialog = document.querySelector("dialog");
});
await page.click('button[data-provider="tos"]');
await fillRequired();
await page.fill(field("连接名称"), "TOS draft");
await page.click('button[data-provider="oss"]');
await page.fill(
  'xpath=//section[not(@hidden) and contains(@class,"storage-detail-panel")]//label[contains(.,"连接名称")]//input',
  "OSS draft",
);
await page.click('button[data-provider="tos"]');
assert.equal(await value("连接名称"), "TOS draft");
assert.equal(
  await page.evaluate(
    () =>
      document.querySelector("dialog") === window.originalDialog &&
      document.querySelectorAll("dialog[open]").length === 1,
  ),
  true,
);
await page.evaluate(() => (window.holdTest = true));
const startedTest = Date.now();
await page.click('button:text-is("测试连接")');
await page.waitForFunction(() => !!window.releaseTest);
assert.equal(
  await page.evaluate(
    () =>
      [...document.querySelectorAll(".provider-choice")].every(
        (e) => e.disabled,
      ) && document.querySelector('button[aria-label="关闭"]').disabled,
  ),
  true,
);
await page.waitForFunction(
  () =>
    document
      .querySelector('[role="alert"]')
      ?.textContent.includes("连接测试超时（2 秒）"),
  undefined,
  { timeout: 3000 },
);
assert.ok(
  Date.now() - startedTest < 3500,
  "test must stop waiting after 2 seconds",
);
assert.equal(
  await page.evaluate(
    () =>
      !document.querySelector('button[aria-label="关闭"]').disabled &&
      [...document.querySelectorAll(".provider-choice")].every(
        (e) => !e.disabled,
      ) &&
      [...document.querySelectorAll(".modal-footer button")].some(
        (e) => e.textContent === "测试连接" && !e.disabled,
      ),
  ),
  true,
);
await page.evaluate(() => {
  window.holdTest = false;
  window.releaseTest();
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
});
assert.equal(
  await page.evaluate(() => document.querySelector('[role="status"]') === null),
  true,
  "late success must not overwrite timeout",
);
await test();
await page.click('button:text-is("返回选择")');
assert.equal(
  await page.evaluate(
    () =>
      !document.querySelector("dialog").classList.contains("is-expanded") &&
      document.activeElement.dataset.provider === "tos",
  ),
  true,
);
await page.click('button[data-provider="tos"]');
assert.equal(await value("连接名称"), "TOS draft");
await page.click('button[aria-label="关闭"]');

for (const [provider, label] of [
  ["generic", "通用 S3 协议"],
  ["rustfs", "RustFS"],
  ["tos", "火山云 TOS"],
  ["oss", "阿里云 OSS"],
]) {
  await openChooser();
  await page.click(`button.provider-choice:has-text("${label}")`);
  await fillRequired();
  if (provider === "generic") {
    assert.equal(await value("访问地址"), "");
    assert.equal((await test()).config.endpoint, null);
    await page.fill(field("访问地址"), "https://example.com/bucket");
    assert.equal(
      await page.evaluate(
        () => document.querySelector(".modal-footer .primary").disabled,
      ),
      true,
    );
    await page.fill(field("访问地址"), "https://s3.example.com");
  }
  if (provider === "rustfs") {
    assert.equal(await value("访问地址"), "http://127.0.0.1:9000");
    assert.equal(
      await page.evaluate(() => document.querySelector("details").open),
      false,
    );
    const input = await test();
    assert.equal(input.config.region, "us-east-1");
    assert.equal(input.config.force_path_style, true);
    await page.click("summary");
    await page.fill(field("地域（Region）"), "custom-region");
    assert.equal((await test()).config.region, "custom-region");
  }
  if (provider === "tos" || provider === "oss") {
    assert.equal(
      await page.evaluate(() => !!document.querySelector("details")),
      false,
    );
    await page.selectOption(
      'xpath=//label[contains(., "地域")]//select',
      "cn-shanghai",
    );
    const publicUrl =
      provider === "tos"
        ? "https://tos-s3-cn-shanghai.volces.com"
        : "https://s3.oss-cn-shanghai.aliyuncs.com";
    assert.equal(await value("访问地址"), publicUrl);
    await page.selectOption(
      'xpath=//label[contains(., "访问方式")]//select',
      "internal",
    );
    const internalUrl =
      provider === "tos"
        ? "https://tos-s3-cn-shanghai.ivolces.com"
        : "https://s3.oss-cn-shanghai-internal.aliyuncs.com";
    assert.equal(await value("访问地址"), internalUrl);
    assert.equal((await test()).config.force_path_style, false);
    await page.selectOption(
      'xpath=//label[contains(., "访问方式")]//select',
      "custom",
    );
    await page.fill(field("访问地址"), "https://s3.private.example.com");
    await page.selectOption(
      'xpath=//label[contains(., "地域")]//select',
      "custom",
    );
    await page.fill(field("地域 ID"), "private-region");
    const input = await test();
    assert.equal(input.config.endpoint, "https://s3.private.example.com");
    assert.equal(input.config.region, "private-region");
  }
  const input = await test();
  assert.equal(input.config.provider, provider);
  await page.fill(field("目录前缀"), "photos");
  assert.equal(
    await page.evaluate(() => !!document.querySelector("[role=status]")),
    false,
  );
  if (provider === "oss") {
    await page.focus(field("Security Token"));
    await page.fill(field("Security Token"), "test-session");
    await page.evaluate(() => (window.failTest = true));
    await page.click('button:text-is("测试连接")');
    await page.waitForSelector("[role=alert]");
    assert.match(
      await page.evaluate(
        () => document.querySelector("[role=alert]").textContent,
      ),
      /连接失败/,
    );
    await page.evaluate(() => (window.failTest = false));
    await page.click('button:text-is("保存连接")');
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    assert.equal((await lastInput()).credentials.session_token, "test-session");
    await page.evaluate(() =>
      document.querySelector(".volume-nav button").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 100,
          clientY: 180,
        }),
      ),
    );
    await page.click('[role=menuitem]:has-text("编辑连接")');
    await page.waitForSelector("dialog h2");
    assert.equal(
      await page.evaluate(
        () => document.querySelector("dialog h2").textContent,
      ),
      "编辑 阿里云 OSS",
    );
    assert.equal(await value("地域 ID"), "private-region");
    assert.equal(await value("访问地址"), "https://s3.private.example.com");
    assert.equal((await test()).credentials, null);
  }
  await page.click('button[aria-label="关闭"]');
}
// Saved connection metadata supplies the same label on all three surfaces.
for (const [provider, label] of [
  [null, "通用"],
  ["rustfs", "RustFS"],
  ["tos", "火山云 TOS"],
  ["oss", "阿里云 OSS"],
]) {
  await page.evaluate((provider) => {
    window.testConnections[0].config.provider = provider;
  }, provider);
  await page.click('button[aria-label="切换详情面板"]');
  await page.waitForFunction(
    (label) =>
      document.querySelector(".details-panel > .pill")?.textContent === label,
    label,
  );
  assert.match(
    await page.evaluate(() => document.querySelector(".statusbar").textContent),
    new RegExp(label),
  );
  await page.click('.main-nav button:has-text("概览")');
  await page.waitForFunction(
    (label) =>
      document.querySelector(".volume-card .pill")?.textContent.includes(label),
    label,
  );
  await page.click(".volume-card");
  await page.click('button[aria-label="切换详情面板"]');
}
console.log(
  "PASS: local read-only, provider defaults, region/address changes, custom endpoints, validation, test failure, 2-second timeout, late response ignored, retry, save/edit, retained credentials, animated expansion, provider switching, draft retention and busy state",
);
// Verify the rendered dialog stays within both a regular and a narrow viewport.
for (const [width, height] of [
  [1100, 800],
  [390, 640],
]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openChooser();
  assert.equal(
    await page.evaluate(() => {
      const d = document.querySelector("dialog");
      const r = d.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        d.scrollWidth <= d.clientWidth
      );
    }),
    true,
  );
  await page.click('button.provider-choice:has-text("火山云 TOS")');
  await page.waitForFunction(
    () =>
      !document
        .querySelector("dialog")
        .getAnimations({ subtree: true })
        .some((a) => a.playState === "running"),
  );
  assert.equal(
    await page.evaluate(() => {
      const d = document.querySelector("dialog");
      return (
        d.scrollWidth <= d.clientWidth &&
        d.getBoundingClientRect().bottom <= innerHeight
      );
    }),
    true,
  );
  await page.click('button[aria-label="关闭"]');
}
await page.cdp("Emulation.clearDeviceMetricsOverride");
if (!globalThis.filoKeepSpace) await task.finish({ keep: [] });
