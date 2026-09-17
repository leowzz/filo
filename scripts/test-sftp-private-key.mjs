// ego-browser nodejs < scripts/test-sftp-private-key.mjs
// Synthetic IPC only: never reads the user's SSH files.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo SFTP key sources",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
const injected = await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.keyCalls=[]; window.hostTrustCalls=[]; window.keyVolumes=[]; window.keyConnections=[];
window.hostTrustResponse={status:'trusted',known_hosts:'fixture.invalid ssh-ed25519 SYNTHETIC_HOST_KEY',fingerprint:'SHA256:SYNTHETIC_HOST',algorithm:'ssh-ed25519'};
window.defaultKey={path:'/fixture/.ssh/id_ed25519',private_key:'SYNTHETIC_DEFAULT_KEY'};
window.pickedKey=null;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
  if(command==='recent_backend_errors')return [];
  if(command==='plugin:event|listen')return 1;
  if(command==='plugin:event|unlisten'||command.startsWith('plugin:menu|'))return;
  if(command==='directory_stamp')return '1';
  if(command==='list_volumes')return window.keyVolumes;
  if(command==='list_connections')return window.keyConnections;
  if(command==='list_transfers')return [];
  if(command==='list_entries_page')return {entries:[],total:0,next_cursor:null};
  if(command==='load_default_sftp_private_key'){
    window.keyCalls.push({command});
    if(window.holdDefault)await new Promise(resolve=>window.releaseDefault=resolve);
    if(window.defaultError)throw {message:'无法读取默认私钥，请选择文件或粘贴'};
    return window.defaultKey;
  }
  if(command==='pick_sftp_private_key'){
    window.keyCalls.push({command});
    if(window.pickerError)throw {message:'所选文件不是有效的私钥'};
    return window.pickedKey;
  }
  if(command==='inspect_sftp_host_key'){
    window.hostTrustCalls.push({command,args});
    return window.hostTrustResponse;
  }
  if(command==='test_remote_connection'){window.keyCalls.push({command,args});return;}
  if(command==='save_remote_storage'){
    window.keyCalls.push({command,args});
    const input=args.input,id='key-volume';
    const volume={id,connection_id:id,name:input.name,root:{type:'remote',path:input.path},read_only:false,capabilities:{hierarchy:'native_directory',rename:'atomic',create_directory:true,write:true,delete:true,trash:false,native_open:false}};
    window.keyVolumes=[volume];window.keyConnections=[{id,name:input.name,provider:'remote',config:{protocol:'sftp',host:input.host,port:input.port,share:'',known_hosts:input.known_hosts}}];return volume;
  }
  throw new Error('Unexpected IPC: '+command);
}};`,
});
const form = "dialog .remote-form:not([hidden] .remote-form)";
const button = (text) => `${form} button:text-is("${text}")`;
const activate = async (text) => {
  await page.focus(button(text));
  await page.keyboard.press("Enter");
};
const input = (label) =>
  `xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "${label}")]//input`;
const auth =
  'xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "认证方式")]//select';
const keyArea = `${form} .remote-private-key`;
let formInspectionBaseline = 0;
const open = async () => {
  await page.click('.sidebar button[aria-label="添加存储空间"]');
  await page.focus('button[data-provider="sftp"]');
  await page.keyboard.press("Enter");
  await page.fill(input("连接名称"), "SFTP fixture");
  await page.fill(`${form} .remote-host-field input`, "fixture.invalid");
  await page.fill(input("用户名"), "fixture");
  formInspectionBaseline = await page.evaluate(
    () => window.hostTrustCalls.length,
  );
};
const calls = (command) =>
  page.evaluate(
    (command) => window.keyCalls.filter((c) => c.command === command).length,
    command,
  );
const testKey = async (expected) => {
  const previous = await calls("test_remote_connection");
  const previousInspections = await page.evaluate(
    () => window.hostTrustCalls.length,
  );
  await page.click(button("测试连接"));
  await page.waitForFunction(
    (previous) =>
      window.keyCalls.filter((c) => c.command === "test_remote_connection")
        .length > previous,
    previous,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.keyCalls
          .filter((c) => c.command === "test_remote_connection")
          .at(-1).args.input.credentials.private_key,
    ),
    expected,
  );
  const inspection = await page.evaluate(() => window.hostTrustCalls.at(-1));
  assert.equal(inspection.args.host, "fixture.invalid");
  assert.equal(inspection.args.port, 22);
  assert.equal(
    inspection.args.knownHosts,
    previousInspections === formInspectionBaseline
      ? ""
      : "fixture.invalid ssh-ed25519 SYNTHETIC_HOST_KEY",
    "native inspection receives the empty first pin or the retained saved pin",
  );
  assert.equal(
    await page.evaluate(
      () => window.keyCalls.filter((c) => c.command === "test_remote_connection").at(-1).args.input.known_hosts,
    ),
    "fixture.invalid ssh-ed25519 SYNTHETIC_HOST_KEY",
    "trusted host inspection supplies the saved pin to the connection action",
  );
};
const close = async () => {
  await page.focus('dialog button[aria-label="关闭"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
};
try {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
  await open();
  assert.equal(
    await page.evaluate(() => document.querySelector(".remote-known-hosts")),
    null,
    "SFTP host trust is native and has no manual known_hosts textarea",
  );
  assert.equal(
    await calls("load_default_sftp_private_key"),
    0,
    "password mode must not read SSH files",
  );
  await page.selectOption(auth, "private_key");
  await page.waitForFunction(() =>
    document
      .querySelector("dialog")
      .textContent.includes("/fixture/.ssh/id_ed25519"),
  );
  assert.equal(
    await page.evaluate(
      (selector) => document.querySelector(selector),
      keyArea,
    ),
    null,
    "file key content remains hidden",
  );
  await testKey("SYNTHETIC_DEFAULT_KEY");

  // Cancelling the native file picker leaves the loaded key usable.
  await activate("选择私钥文件");
  await page.waitForFunction(() =>
    window.keyCalls.some((c) => c.command === "pick_sftp_private_key"),
  );
  await testKey("SYNTHETIC_DEFAULT_KEY");
  await page.evaluate(
    () =>
      (window.pickedKey = {
        path: "/fixture/keys/" + "nested-directory/".repeat(12) + "deploy.pem",
        private_key: "SYNTHETIC_PICKED_KEY",
      }),
  );
  await activate("选择私钥文件");
  await page.waitForFunction(() =>
    document
      .querySelector("dialog")
      .textContent.includes("/fixture/keys/nested-directory/"),
  );
  assert.equal(
    await page.evaluate(() => document.querySelector(".remote-test-success")),
    null,
    "new file clears the previous connection-test result",
  );
  await testKey("SYNTHETIC_PICKED_KEY");
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForFunction(() => {
    const d = document.querySelector("dialog");
    return innerWidth === 390 && d.scrollWidth <= d.clientWidth;
  });
  assert.equal(
    await page.evaluate(() => {
      const d = document.querySelector("dialog");
      return d.scrollWidth <= d.clientWidth;
    }),
    true,
    "long key-file paths wrap in a narrow window",
  );
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.evaluate(() => {
    window.pickerError = true;
  });
  await activate("选择私钥文件");
  await page.waitForFunction(() =>
    document
      .querySelector("dialog")
      .textContent.includes("所选文件不是有效的私钥"),
  );
  await page.evaluate(() => {
    window.pickerError = false;
  });
  await activate("粘贴私钥");
  await page.waitForSelector(keyArea);
  assert.equal(
    await page.evaluate(
      (selector) => document.querySelector(selector).value,
      keyArea,
    ),
    "",
    "switching to paste must not reveal the loaded file content",
  );
  await page.fill(keyArea, "SYNTHETIC_PASTED_KEY");
  await testKey("SYNTHETIC_PASTED_KEY");
  await activate("使用默认私钥");
  await page.waitForFunction(() =>
    document
      .querySelector("dialog")
      .textContent.includes("/fixture/.ssh/id_ed25519"),
  );
  await testKey("SYNTHETIC_DEFAULT_KEY");
  await page.click(button("保存连接"));
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));

  const beforeEdit = await calls("load_default_sftp_private_key");
  await page.evaluate(() =>
    document
      .querySelector(".volume-nav button")
      .dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 100,
          clientY: 180,
        }),
      ),
  );
  await page.click('[role=menuitem]:has-text("编辑连接")');
  await page.waitForSelector(form);
  await page.click(button("测试连接"));
  await page.waitForFunction(
    () =>
      window.keyCalls
        .filter((c) => c.command === "test_remote_connection")
        .at(-1)?.args.input.credentials === null,
  );
  assert.equal(
    await calls("load_default_sftp_private_key"),
    beforeEdit,
    "editing retained credentials never reads a key",
  );
  await close();

  // A delayed default load cannot overwrite a manual paste.
  await page.evaluate(() => {
    window.holdDefault = true;
    window.releaseDefault = null;
  });
  await open();
  await page.selectOption(auth, "private_key");
  await page.waitForFunction(() => typeof window.releaseDefault === "function");
  assert.equal(
    await page.evaluate(
      (selector) => document.querySelector(selector).disabled,
      `${form} .primary`,
    ),
    true,
  );
  await activate("粘贴私钥");
  await page.fill(keyArea, "SYNTHETIC_MANUAL_DURING_LOAD");
  await page.evaluate(() => {
    window.holdDefault = false;
    window.releaseDefault();
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await testKey("SYNTHETIC_MANUAL_DURING_LOAD");
  await close();

  // Missing and unreadable defaults offer recoverable manual input.
  await page.evaluate(() => {
    window.defaultKey = null;
  });
  await open();
  await page.selectOption(auth, "private_key");
  await page.waitForFunction(() =>
    document.querySelector("dialog").textContent.includes("未找到"),
  );
  assert.equal(
    await page.evaluate(
      (selector) => document.querySelector(selector).disabled,
      `${form} .primary`,
    ),
    true,
  );
  await page.evaluate(() => {
    window.defaultError = true;
  });
  await activate("使用默认私钥");
  await page.waitForFunction(() =>
    document.querySelector("dialog").textContent.includes("无法读取默认私钥"),
  );
  await activate("粘贴私钥");
  await page.fill(keyArea, "SYNTHETIC_RECOVERY_KEY");
  await testKey("SYNTHETIC_RECOVERY_KEY");
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
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.evaluate(() => {
        const d = document.querySelector("dialog"),
          r = d.getBoundingClientRect();
        return (
          r.left >= 0 &&
          r.right <= innerWidth &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          d.scrollWidth <= d.clientWidth
        );
      }),
      true,
      "key inputs fit the viewport",
    );
  }
  await close();
  console.log(
    "PASS: automatic key, file picker/cancel, paste, no secret display, credential retention, late results, missing/error recovery and responsive layout",
  );
} finally {
  await page.cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: injected.identifier,
  });
}
if (!globalThis.filoKeepSpace) await task.finish({ keep: [] });
