// ego-browser nodejs < scripts/test-sftp-host-trust.mjs
// Synthetic IPC only: the native host-key probe and remote actions are mocked.
// This test never contacts a real SFTP server or reads the user's SSH files.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo SFTP host trust",
);
console.log({ spaceId: task.spaceId });
const page = task.page(globalThis.filoTestPage ?? "p1");

const TRUSTED_PIN =
  "sftp-trusted.invalid ssh-ed25519 SYNTHETIC_TRUSTED_HOST_KEY";
const SAVED_PIN = "saved.invalid ssh-ed25519 SYNTHETIC_SAVED_HOST_KEY";
const NEW_ENDPOINT_PIN =
  "[saved-new.invalid]:2222 ssh-ed25519 SYNTHETIC_NEW_ENDPOINT_KEY";
const UNKNOWN_PIN =
  "[sftp-unknown.invalid]:2222 ssh-ed25519 SYNTHETIC_UNKNOWN_HOST_KEY";
const UNKNOWN_CANCEL_PIN =
  "sftp-cancel.invalid ssh-ed25519 SYNTHETIC_CANCEL_HOST_KEY";
const UNKNOWN_SAVE_PIN =
  "[sftp-save-unknown.invalid]:2222 ssh-ed25519 SYNTHETIC_UNKNOWN_SAVE_KEY";
const CHANGED_PIN =
  "sftp-changed.invalid ssh-ed25519 SYNTHETIC_CHANGED_HOST_KEY";
const STALE_PIN = "sftp-stale.invalid ssh-ed25519 SYNTHETIC_STALE_HOST_KEY";

await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
const injected = await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.remoteCalls=[];
window.hostTrustCalls=[];
window.remoteVolumes=[];
window.remoteConnections=[];
window.hostTrustResponse={status:'trusted',known_hosts:'sftp-trusted.invalid ssh-ed25519 SYNTHETIC_TRUSTED_HOST_KEY',fingerprint:'SHA256:SYNTHETIC_TRUSTED',algorithm:'ssh-ed25519'};
window.hostTrustResponses={};
window.holdHostTrust=false;
window.releaseHostTrust=null;
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
  if(command==='recent_backend_errors')return [];
  if(command==='plugin:event|listen')return 1;
  if(command==='plugin:event|unlisten'||command.startsWith('plugin:menu|'))return;
  if(command==='directory_stamp')return '1';
  if(command==='list_volumes')return window.remoteVolumes;
  if(command==='list_connections')return window.remoteConnections;
  if(command==='list_transfers'||command==='list_entries')return [];
  if(command==='list_entries_page')return {entries:[],total:0,next_cursor:null};
  if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
  if(command==='inspect_sftp_host_key'){
    window.hostTrustCalls.push({command,args});
    if(window.hostTrustError){
      window.hostTrustError=false;
      throw {message:'SYNTHETIC 主机密钥检查失败'};
    }
    if(window.holdHostTrust){
      await new Promise(resolve=>window.releaseHostTrust=resolve);
      window.releaseHostTrust=null;
    }
    const key=args.host+':'+args.port;
    return window.hostTrustResponses[key]||window.hostTrustResponse;
  }
  if(command==='test_remote_connection'){
    window.remoteCalls.push({command,args});
    if(window.failRemote)throw {message:'SYNTHETIC 连接失败'};
    return;
  }
  if(command==='save_remote_storage'){
    window.remoteCalls.push({command,args});
    const input=args.input;
    const id=args.volumeId||'remote-volume-'+(window.remoteVolumes.length+1);
    const volume={id,connection_id:id,name:input.name,root:{type:'remote',path:input.path},read_only:input.read_only,capabilities:{hierarchy:'native_directory',rename:'atomic',create_directory:true,write:true,delete:true,trash:false,native_open:false,native_copy:false}};
    const existing=window.remoteVolumes.some(item=>item.id===id);
    window.remoteVolumes=existing?window.remoteVolumes.map(item=>item.id===id?volume:item):[...window.remoteVolumes,volume];
    const connection={id,name:input.name,provider:'remote',config:{protocol:input.protocol,host:input.host,port:input.port,share:input.share,known_hosts:input.known_hosts}};
    window.remoteConnections=window.remoteConnections.some(item=>item.id===id)?window.remoteConnections.map(item=>item.id===id?connection:item):[...window.remoteConnections,connection];
    return volume;
  }
  if(command==='load_default_sftp_private_key'||command==='pick_sftp_private_key')return null;
  if(command==='create_local_storage')return null;
  throw new Error('Unexpected IPC: '+command);
}};`,
});

const form = "dialog .remote-form:not([hidden] .remote-form)";
const field = (label) => {
  const specific = {
    服务器地址: ".remote-host-field input",
    端口: ".remote-port-field input",
  }[label];
  return specific
    ? `${form} ${specific}`
    : `xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "${label}")]//input`;
};
const remoteButton = (text) =>
  `${form} .modal-footer button:text-is("${text}")`;
const count = (name) =>
  page.evaluate((name) => {
    const calls = name === "inspect" ? window.hostTrustCalls : window.remoteCalls;
    return calls.length;
  }, name);
const lastInspection = () => page.evaluate(() => window.hostTrustCalls.at(-1));
const lastRemote = () => page.evaluate(() => window.remoteCalls.at(-1));
const hasText = (text) =>
  page.evaluate(
    (text) => document.querySelector("dialog[open]")?.textContent.includes(text),
    text,
  );
const setHostTrustResponse = (response) =>
  page.evaluate((response) => {
    window.hostTrustResponse = response;
    window.hostTrustResponses = {};
  }, response);
const setEndpointResponse = (host, port, response) =>
  page.evaluate(
    ({ host, port, response }) => {
      window.hostTrustResponses[host + ":" + port] = response;
    },
    { host, port, response },
  );

const openSftp = async () => {
  await page.click('.sidebar button[aria-label="添加存储空间"]');
  await page.waitForSelector(".remote-provider-list");
  await page.focus('button[data-provider="sftp"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(form);
  assert.equal(
    await page.evaluate(() => document.querySelector(".remote-known-hosts")),
    null,
    "SFTP has no manual known_hosts textarea",
  );
};
const fillSftp = async ({
  name,
  host,
  port = "22",
  path = "/srv/files",
  username = "fixture-user",
  password = "SYNTHETIC_PASSWORD",
}) => {
  await page.fill(field("连接名称"), name);
  await page.fill(field("服务器地址"), host);
  await page.fill(field("端口"), port);
  await page.fill(field("远程目录"), path);
  await page.fill(field("用户名"), username);
  await page.fill(field("密码"), password);
};
const clickAction = async (text) => {
  const before = await count("remote");
  await page.click(remoteButton(text));
  await page.waitForFunction(
    (before) => window.remoteCalls.length > before,
    before,
  );
};
const waitInspection = async (before) => {
  await page.waitForFunction(
    (before) => window.hostTrustCalls.length > before,
    before,
  );
};
const closeDialog = async () => {
  await page.focus('dialog[open] button[aria-label="关闭"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
};

// The UI exposes stable action selectors on the inline host-key prompt. The
// fingerprint remains part of the wait so a stale prompt cannot satisfy it.
const markHostKeyAction = async (action, fingerprint) => {
  const selector = `[data-sftp-host-key-action="${action}"]`;
  await page.waitForFunction(
    ({ selector, fingerprint }) => {
      const dialog = document.querySelector("dialog[open]");
      if (!dialog?.textContent.includes(fingerprint)) return false;
      return Boolean(dialog.querySelector(selector));
    },
    { selector, fingerprint },
  );
  return selector;
};

try {
  await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");

  // A trusted native result continues both actions automatically. The first
  // probe receives an empty pin, while the action receives only the returned
  // exact known_hosts entry.
  await setHostTrustResponse({
    status: "trusted",
    known_hosts: TRUSTED_PIN,
    fingerprint: "SHA256:SYNTHETIC_TRUSTED",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({
    name: "Trusted SFTP",
    host: "sftp-trusted.invalid",
  });
  const trustedInspectionBefore = await count("inspect");
  await clickAction("测试连接");
  assert.equal(await count("inspect"), trustedInspectionBefore + 1);
  assert.deepEqual((await lastInspection()).args, {
    host: "sftp-trusted.invalid",
    port: 22,
    knownHosts: "",
  });
  assert.equal((await lastInspection()).args.credentials, undefined);
  assert.deepEqual((await lastRemote()).args.input.credentials, {
    username: "fixture-user",
    password: "SYNTHETIC_PASSWORD",
    private_key: "",
    passphrase: "",
    domain: "",
  });
  assert.equal((await lastRemote()).args.input.known_hosts, TRUSTED_PIN);
  assert.equal(await hasText("SHA256:SYNTHETIC_TRUSTED"), false);
  await closeDialog();

  // Saving a fresh trusted endpoint also auto-continues from an empty pin.
  await setHostTrustResponse({
    status: "trusted",
    known_hosts: "sftp-save.invalid ssh-ed25519 SYNTHETIC_SAVE_HOST_KEY",
    fingerprint: "SHA256:SYNTHETIC_SAVE",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Trusted save", host: "sftp-save.invalid" });
  const saveInspectionBefore = await count("inspect");
  await clickAction("保存连接");
  assert.equal(await count("inspect"), saveInspectionBefore + 1);
  assert.equal((await lastInspection()).args.knownHosts, "");
  assert.equal(
    (await lastRemote()).command,
    "save_remote_storage",
    "trusted save resumes the intended save action",
  );
  assert.equal(
    (await lastRemote()).args.input.known_hosts,
    "sftp-save.invalid ssh-ed25519 SYNTHETIC_SAVE_HOST_KEY",
  );
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));

  // An unknown key never receives credentials and never mutates a connection
  // until the inline trust action is explicitly confirmed.
  await setHostTrustResponse({
    status: "unknown",
    known_hosts: UNKNOWN_PIN,
    fingerprint: "SHA256:SYNTHETIC_UNKNOWN",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({
    name: "Unknown SFTP",
    host: "sftp-unknown.invalid",
    port: "2222",
  });
  const unknownRemoteBefore = await count("remote");
  const unknownInspectionBefore = await count("inspect");
  await page.click(remoteButton("测试连接"));
  await waitInspection(unknownInspectionBefore);
  await page.waitForFunction(
    (fingerprint) =>
      document.querySelector("dialog[open]")?.textContent.includes(fingerprint),
    "SHA256:SYNTHETIC_UNKNOWN",
  );
  assert.equal(
    await count("remote"),
    unknownRemoteBefore,
    "unknown host waits before the test mutation",
  );
  assert.deepEqual((await lastInspection()).args, {
    host: "sftp-unknown.invalid",
    port: 2222,
    knownHosts: "",
  });
  assert.equal(
    Object.keys((await lastInspection()).args).sort().join(","),
    "host,knownHosts,port",
    "host-key inspection never receives authentication fields",
  );
  const trustAction = await markHostKeyAction(
    "trust",
    "SHA256:SYNTHETIC_UNKNOWN",
  );
  await page.click(trustAction);
  await page.waitForFunction(
    (before) => window.remoteCalls.length > before,
    unknownRemoteBefore,
  );
  assert.equal((await lastRemote()).command, "test_remote_connection");
  assert.equal((await lastRemote()).args.input.known_hosts, UNKNOWN_PIN);
  assert.equal((await lastRemote()).args.input.credentials.password, "SYNTHETIC_PASSWORD");
  assert.equal(await hasText("SHA256:SYNTHETIC_UNKNOWN"), false);
  await closeDialog();

  // The same explicit confirmation resumes a pending save action and sends
  // the newly returned pin to the save mutation.
  await setHostTrustResponse({
    status: "unknown",
    known_hosts: UNKNOWN_SAVE_PIN,
    fingerprint: "SHA256:SYNTHETIC_UNKNOWN_SAVE",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({
    name: "Unknown save SFTP",
    host: "sftp-save-unknown.invalid",
    port: "2222",
  });
  const unknownSaveRemoteBefore = await count("remote");
  const unknownSaveInspectionBefore = await count("inspect");
  await page.click(remoteButton("保存连接"));
  await waitInspection(unknownSaveInspectionBefore);
  await page.waitForSelector(
    `${form} [data-sftp-host-key-state="unknown"]`,
  );
  assert.equal(await count("remote"), unknownSaveRemoteBefore);
  const unknownSaveTrust = await markHostKeyAction(
    "trust",
    "SHA256:SYNTHETIC_UNKNOWN_SAVE",
  );
  await page.click(unknownSaveTrust);
  await page.waitForFunction(
    (before) => window.remoteCalls.length > before,
    unknownSaveRemoteBefore,
  );
  assert.equal((await lastRemote()).command, "save_remote_storage");
  assert.equal((await lastRemote()).args.input.known_hosts, UNKNOWN_SAVE_PIN);
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));

  // Cancelling an unknown-key prompt leaves both test and save untouched.
  await setHostTrustResponse({
    status: "unknown",
    known_hosts: UNKNOWN_CANCEL_PIN,
    fingerprint: "SHA256:SYNTHETIC_CANCEL",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Cancelled SFTP", host: "sftp-cancel.invalid" });
  const cancelRemoteBefore = await count("remote");
  const cancelInspectionBefore = await count("inspect");
  await page.click(remoteButton("保存连接"));
  await waitInspection(cancelInspectionBefore);
  await page.waitForFunction(
    (fingerprint) =>
      document.querySelector("dialog[open]")?.textContent.includes(fingerprint),
    "SHA256:SYNTHETIC_CANCEL",
  );
  assert.equal(await count("remote"), cancelRemoteBefore);
  const cancelAction = await markHostKeyAction(
    "cancel",
    "SHA256:SYNTHETIC_CANCEL",
  );
  await page.click(cancelAction);
  await page.waitForFunction(
    (fingerprint) =>
      !document.querySelector("dialog[open]")?.textContent.includes(fingerprint),
    "SHA256:SYNTHETIC_CANCEL",
  );
  assert.equal(await count("remote"), cancelRemoteBefore);

  // Probe failures stay inline and the retry resumes the original test
  // action only after a successful second inspection.
  await setHostTrustResponse({
    status: "trusted",
    known_hosts: "sftp-error.invalid ssh-ed25519 SYNTHETIC_ERROR_HOST_KEY",
    fingerprint: "SHA256:SYNTHETIC_ERROR_RECOVERED",
    algorithm: "ssh-ed25519",
  });
  await page.evaluate(() => (window.hostTrustError = true));
  await fillSftp({ name: "Recoverable SFTP", host: "sftp-error.invalid" });
  const errorRemoteBefore = await count("remote");
  const errorInspectionBefore = await count("inspect");
  await page.click(remoteButton("测试连接"));
  await waitInspection(errorInspectionBefore);
  await page.waitForSelector(`${form} [data-sftp-host-key-state="error"]`);
  assert.equal(await count("remote"), errorRemoteBefore);
  await page.click(`${form} [data-sftp-host-key-action="retry"]`);
  await page.waitForFunction(
    (before) => window.remoteCalls.length > before,
    errorRemoteBefore,
  );
  assert.equal((await lastRemote()).command, "test_remote_connection");
  assert.equal(
    (await lastRemote()).args.input.known_hosts,
    "sftp-error.invalid ssh-ed25519 SYNTHETIC_ERROR_HOST_KEY",
  );
  await closeDialog();

  // A changed key is a hard stop. There is no re-trust button and neither
  // intended action reaches the mocked connection service.
  await setHostTrustResponse({
    status: "changed",
    known_hosts: CHANGED_PIN,
    fingerprint: "SHA256:SYNTHETIC_CHANGED",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Changed SFTP", host: "sftp-changed.invalid" });
  const changedRemoteBefore = await count("remote");
  const changedInspectionBefore = await count("inspect");
  await page.click(remoteButton("测试连接"));
  await waitInspection(changedInspectionBefore);
  await page.waitForFunction(
    (fingerprint) =>
      document.querySelector("dialog[open]")?.textContent.includes(fingerprint),
    "SHA256:SYNTHETIC_CHANGED",
  );
  assert.equal(await count("remote"), changedRemoteBefore);
  assert.equal(
    await page.evaluate(
      () =>
        [...document.querySelectorAll("dialog[open] button")].some(
          (button) => button.textContent.trim() === "信任并继续",
        ),
    ),
    false,
    "changed host keys cannot be re-trusted inline",
  );
  await closeDialog();

  // Save a connection through the mocked UI so the current React query cache
  // and sidebar contain the exact pinned endpoint before editing it.
  await setHostTrustResponse({
    status: "trusted",
    known_hosts: SAVED_PIN,
    fingerprint: "SHA256:SYNTHETIC_SAVED",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Saved SFTP", host: "saved.invalid" });
  await clickAction("保存连接");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  await page.waitForSelector('.volume-nav button[aria-haspopup="menu"]:has-text("Saved SFTP")');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.volume-nav button[aria-haspopup="menu"]')].find(
      (item) => item.textContent.includes("Saved SFTP"),
    );
    if (!button) throw new Error("Saved SFTP volume is not visible");
    button.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 180,
      }),
    );
  });
  await page.click('[role=menuitem]:has-text("编辑连接")');
  await page.waitForSelector(form);
  assert.equal(await page.evaluate(() => document.querySelector(".remote-known-hosts")), null);
  await setHostTrustResponse({
    status: "trusted",
    known_hosts: SAVED_PIN,
    fingerprint: "SHA256:SYNTHETIC_SAVED",
    algorithm: "ssh-ed25519",
  });
  const retainedInspectionBefore = await count("inspect");
  await clickAction("测试连接");
  await waitInspection(retainedInspectionBefore);
  assert.deepEqual((await lastInspection()).args, {
    host: "saved.invalid",
    port: 22,
    knownHosts: SAVED_PIN,
  });
  assert.equal((await lastRemote()).args.input.known_hosts, SAVED_PIN);
  await page.fill(field("服务器地址"), "saved-new.invalid");
  await page.fill(field("端口"), "2222");
  await setEndpointResponse("saved-new.invalid", 2222, {
    status: "trusted",
    known_hosts: NEW_ENDPOINT_PIN,
    fingerprint: "SHA256:SYNTHETIC_NEW_ENDPOINT",
    algorithm: "ssh-ed25519",
  });
  const endpointInspectionBefore = await count("inspect");
  await clickAction("测试连接");
  await waitInspection(endpointInspectionBefore);
  assert.deepEqual((await lastInspection()).args, {
    host: "saved-new.invalid",
    port: 2222,
    knownHosts: "",
  });
  assert.equal((await lastRemote()).args.input.known_hosts, NEW_ENDPOINT_PIN);
  await closeDialog();

  // A delayed result from a cancelled inspection must not resume an action.
  // Cancel through the inspecting state first, then edit the endpoint through
  // the real enabled input before releasing the old native response.
  await setHostTrustResponse({
    status: "unknown",
    known_hosts: STALE_PIN,
    fingerprint: "SHA256:SYNTHETIC_STALE",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Stale SFTP", host: "sftp-stale.invalid" });
  await page.evaluate(() => {
    window.holdHostTrust = true;
    window.releaseHostTrust = null;
  });
  const staleRemoteBefore = await count("remote");
  const staleInspectionBefore = await count("inspect");
  await page.click(remoteButton("测试连接"));
  await page.waitForFunction(
    (before) => window.hostTrustCalls.length > before && window.releaseHostTrust,
    staleInspectionBefore,
  );
  await page.click(
    `${form} [data-sftp-host-key-state="inspecting"] [data-sftp-host-key-action="cancel"]`,
  );
  await page.fill(field("服务器地址"), "sftp-stale-new.invalid");
  await page.evaluate(() => {
    window.holdHostTrust = false;
    if (window.releaseHostTrust) window.releaseHostTrust();
  });
  await page.waitForFunction(() => window.releaseHostTrust === null);
  assert.equal(await count("remote"), staleRemoteBefore);
  assert.equal(await hasText("SHA256:SYNTHETIC_STALE"), false);
  await closeDialog();

  // Both normal and narrow viewports keep the inline trust confirmation
  // usable and free of horizontal clipping.
  await setHostTrustResponse({
    status: "unknown",
    known_hosts: UNKNOWN_CANCEL_PIN,
    fingerprint: "SHA256:SYNTHETIC_LAYOUT",
    algorithm: "ssh-ed25519",
  });
  await openSftp();
  await fillSftp({ name: "Layout SFTP", host: "sftp-layout.invalid" });
  const layoutInspectionBefore = await count("inspect");
  await page.click(remoteButton("测试连接"));
  await waitInspection(layoutInspectionBefore);
  await page.waitForFunction(
    (fingerprint) =>
      document.querySelector("dialog[open]")?.textContent.includes(fingerprint),
    "SHA256:SYNTHETIC_LAYOUT",
  );
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
    // Keyboard navigation must keep the confirmation actions reachable after resize.
    await page.focus('[data-sftp-host-key-action="cancel"]');
    await page.waitForFunction(
      ({ width }) => {
        const dialog = document.querySelector("dialog[open]");
        if (!dialog || innerWidth !== width) return false;
        const rect = dialog.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          dialog.scrollWidth <= dialog.clientWidth
        );
      },
      { width },
    );
    assert.equal(
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog[open]");
        return Boolean(
          dialog &&
            dialog.scrollWidth <= dialog.clientWidth &&
            dialog.getBoundingClientRect().left >= 0 &&
            dialog.getBoundingClientRect().right <= innerWidth,
        );
      }),
      true,
      `${width}px host-key prompt fits the viewport`,
    );
    // Keyboard navigation must keep the confirmation actions reachable after resize.
    await page.focus('[data-sftp-host-key-action="cancel"]');
    await page.waitForFunction(
      ({ width }) => {
        const dialog = document.querySelector("dialog[open]");
        if (!dialog || innerWidth !== width) return false;
        return ["trust", "cancel"].every((action) => {
          const button = dialog.querySelector(
            `[data-sftp-host-key-action="${action}"]`,
          );
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
      },
      { width },
    );
  }
  const layoutCancel = await markHostKeyAction(
    "cancel",
    "SHA256:SYNTHETIC_LAYOUT",
  );
  await page.click(layoutCancel);
  await page.waitForFunction(
    () => !document.querySelector('dialog[open] [data-sftp-host-key-state="unknown"]'),
  );
  await closeDialog();
  await page.cdp("Emulation.clearDeviceMetricsOverride");
  console.log(
    "PASS: native SFTP host inspection, trusted auto-continue, unknown confirmation/cancel, changed-key block, credential isolation, saved pin retention, endpoint invalidation, stale response guard and responsive layout",
  );
} finally {
  await page.cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: injected.identifier,
  });
}
if (!globalThis.filoKeepSpace) await task.finish({ keep: [] });
