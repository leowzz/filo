// Run against a Vite preview with: ego-browser nodejs < scripts/test-remote-providers.mjs
// All IPC is mocked; this test verifies the remote connection forms and does
// not contact a real FTP, SSH or SMB server.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(
  globalThis.filoTestSpace ?? "Filo remote provider forms",
);
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri=true;
window.remoteCalls=[];
window.remoteVolumes=[];
window.remoteConnections=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command,args)=>{
  if(command==='recent_backend_errors')return [];
  if(command==='plugin:event|listen')return 1;
  if(command==='plugin:event|unlisten')return;
  if(command==='directory_stamp')return '1';
  if(command==='list_volumes')return window.remoteVolumes;
  if(command==='list_connections')return window.remoteConnections;
  if(command==='list_transfers'||command==='list_entries')return [];
  if(command==='list_entries_page')return {entries:[],total:0,next_cursor:null};
  if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
  if(command==='test_remote_connection'){
    window.remoteCalls.push({command,args});
    if(window.failRemote)throw {message:'远程连接失败，请检查服务器和认证信息'};
    if(window.holdRemote)await new Promise(resolve=>window.releaseRemote=resolve);
    return;
  }
  if(command==='save_remote_storage'){
    window.remoteCalls.push({command,args});
    const id=args.volumeId||'remote-volume';
    const input=args.input;
    const writable=!['ftp','ftps'].includes(input.protocol);
    const volume={id,connection_id:id,name:input.name,root:{type:'remote',path:input.path},read_only:input.read_only,capabilities:{hierarchy:'native_directory',rename:writable?'atomic':'unsupported',create_directory:true,write:writable,delete:true,trash:false,native_open:false,native_copy:false}};
    window.remoteVolumes=[volume];
    window.remoteConnections=[{id,name:input.name,provider:'remote',config:{protocol:input.protocol,host:input.host,port:input.port,share:input.share,known_hosts:input.known_hosts}}];
    return volume;
  }
  if(command==='create_local_storage')return null;
  throw new Error('Unexpected IPC: '+command);
}};`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");

const openChooser = async () => {
  await page.click('.sidebar button[aria-label="添加存储空间"]');
  await page.waitForSelector(".remote-provider-list");
};
const visibleForm = () => "dialog .remote-form:not([hidden] .remote-form)";
const field = (label) => {
  const specific = {
    服务器地址: ".remote-host-field input",
    端口: ".remote-port-field input",
  }[label];
  return specific
    ? `${visibleForm()} ${specific}`
    : `xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "${label}")]//input`;
};
const textarea = (label) =>
  `xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "${label}")]//textarea`;
const value = (selector) =>
  page.evaluate(
    (selector) =>
      (selector.startsWith("xpath=")
        ? document.evaluate(
            selector.slice(6),
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
          ).singleNodeValue
        : document.querySelector(selector)
      )?.value,
    selector,
  );
const remoteButton = (text) =>
  `${visibleForm()} .modal-footer button:text-is("${text}")`;
const lastInput = () =>
  page.evaluate(() => window.remoteCalls.at(-1).args.input);

await openChooser();
assert.deepEqual(
  await page.evaluate(() =>
    [...document.querySelectorAll(".storage-section h3")].map(
      (e) => e.textContent,
    ),
  ),
  ["本地文件系统", "S3 存储", "远程文件协议"],
);
assert.deepEqual(
  await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ".remote-provider-list .provider-choice strong",
      ),
    ].map((e) => e.textContent),
  ),
  ["FTP", "FTPS", "SFTP", "SMB / Samba"],
);

await page.focus('button[data-provider="smb"]');
await page.keyboard.press("Enter");
await page.waitForSelector(visibleForm());
await page.fill(field("连接名称"), "家庭 NAS");
await page.fill(field("服务器地址"), "192.168.1.20");
await page.fill(field("端口"), "445");
await page.fill(field("SMB 共享名称"), "public");
await page.fill(field("共享内目录"), "documents/projects");
await page.fill(field("用户名"), "leo");
await page.fill(field("密码"), "secret");
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=status]`);
assert.deepEqual(await lastInput(), {
  name: "家庭 NAS",
  protocol: "smb",
  host: "192.168.1.20",
  port: 445,
  path: "documents/projects",
  share: "public",
  known_hosts: "",
  read_only: false,
  credentials: {
    username: "leo",
    password: "secret",
    private_key: "",
    passphrase: "",
    domain: "",
  },
});
await page.evaluate(() => (window.failRemote = true));
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=alert]`);
assert.match(
  await page.evaluate(
    () => document.querySelector('[role="alert"]').textContent,
  ),
  /远程连接失败/,
);
await page.evaluate(() => (window.failRemote = false));
await page.evaluate(() => (window.holdRemote = true));
await page.click(remoteButton("测试连接"));
await page.waitForFunction(() => Boolean(window.releaseRemote));
await page.waitForFunction(
  () =>
    document
      .querySelector('[role="alert"]')
      ?.textContent.includes("连接测试超时"),
  undefined,
  { timeout: 7000 },
);
await page.evaluate(() => {
  window.holdRemote = false;
  window.releaseRemote();
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
});
assert.equal(
  await page.evaluate(
    () => !!document.querySelector('.remote-form [role="status"]'),
  ),
  false,
  "late connection success must not overwrite the timeout",
);
await page.click(remoteButton("保存连接"));
await page.waitForFunction(() => !document.querySelector("dialog[open]"));
assert.equal(await page.evaluate(() => window.remoteVolumes.length), 1);

// Editing keeps the old credentials out of IPC until the user explicitly
// checks the replacement box.
await page.evaluate(() => {
  document.querySelector(".volume-nav button").dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 180,
    }),
  );
});
await page.click('[role=menuitem]:has-text("编辑连接")');
await page.waitForSelector(visibleForm());
assert.equal(await value(field("服务器地址")), "192.168.1.20");
assert.equal(await value(field("SMB 共享名称")), "public");
assert.equal(await value(field("共享内目录")), "documents/projects");
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=status]`);
assert.equal((await lastInput()).credentials, null);
await page.click(
  'xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "更换登录凭据")]//input',
);
await page.fill(field("用户名"), "leo");
await page.fill(field("密码"), "new-secret");
assert.equal((await lastInput()).credentials?.password, undefined);
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=status]`);
assert.equal((await lastInput()).credentials.password, "new-secret");
await page.focus('button[aria-label="关闭"]');
await page.keyboard.press("Enter");

// SFTP requires an explicit host key and supports private-key authentication.
await openChooser();
await page.focus('button[data-provider="sftp"]');
await page.keyboard.press("Enter");
await page.waitForSelector(visibleForm());
await page.fill(field("连接名称"), "开发机");
await page.fill(field("服务器地址"), "[::1]");
await page.fill(field("端口"), "22");
await page.fill(field("远程目录"), "/srv/files");
await page.fill(textarea("SSH 主机密钥"), "[::1]:22 ssh-ed25519 AAAATEST");
await page.fill(field("用户名"), "deploy");
await page.selectOption(
  'xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "认证方式")]//select',
  "private_key",
);
await page.fill(
  textarea("SSH 私钥"),
  "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----",
);
assert.equal(
  await page.evaluate(
    (selector) => document.querySelector(selector).disabled,
    `${visibleForm()} .primary`,
  ),
  false,
);
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=status]`);
assert.equal((await lastInput()).protocol, "sftp");
assert.equal((await lastInput()).credentials.password, "");
assert.match((await lastInput()).credentials.private_key, /BEGIN OPENSSH/);
await page.selectOption(
  'xpath=//label[not(ancestor::*[@hidden]) and starts-with(normalize-space(.), "认证方式")]//select',
  "password",
);
await page.fill(field("密码"), "password-mode");
await page.click(remoteButton("测试连接"));
await page.waitForSelector(`${visibleForm()} [role=status]`);
assert.equal((await lastInput()).credentials.private_key, "");
assert.equal((await lastInput()).credentials.passphrase, "");
assert.equal((await lastInput()).credentials.password, "password-mode");
await page.focus('button[aria-label="关闭"]');
await page.keyboard.press("Enter");

await openChooser();
await page.focus('button[data-provider="ftp"]');
await page.keyboard.press("Enter");
await page.fill(field("连接名称"), "FTP archive");
await page.fill(field("服务器地址"), "files.example.com:21");
await page.fill(field("用户名"), "test");
await page.fill(field("密码"), "fixture");
assert.equal(
  await page.evaluate(
    (selector) => document.querySelector(selector).disabled,
    `${visibleForm()} .primary`,
  ),
  true,
  "host field rejects embedded ports",
);
await page.fill(field("服务器地址"), "files.example.com");
await page.click(remoteButton("保存连接"));
await page.waitForFunction(() => !document.querySelector("dialog[open]"));
assert.equal(
  await page.evaluate(
    () => document.querySelector('[aria-label="上传文件"]').disabled,
  ),
  true,
  "FTP upload respects the provider write capability",
);

// Both a normal and a narrow viewport keep the connection dialog usable.
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
  await page.focus('button[data-provider="ftps"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(visibleForm());
  assert.equal(
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog");
      const rect = dialog.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        dialog.scrollWidth <= dialog.clientWidth
      );
    }),
    true,
  );
  const controls = await page.evaluate(() => {
    const host = document
      .querySelector(
        ".storage-detail-panel:not([hidden]) .remote-host-field input",
      )
      .getBoundingClientRect();
    const port = document
      .querySelector(
        ".storage-detail-panel:not([hidden]) .remote-port-field input",
      )
      .getBoundingClientRect();
    return {
      hostTop: host.top,
      portTop: port.top,
      hostHeight: host.height,
      portHeight: port.height,
    };
  });
  assert.equal(controls.hostTop, controls.portTop);
  assert.equal(controls.hostHeight, controls.portHeight);
  if (width < 681) {
    assert.equal(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector(".storage-picker")).display,
      ),
      "none",
    );
    await page.focus(".storage-back-button");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".storage-add-modal")
          .classList.contains("is-expanded"),
    );
    await page.waitForFunction(
      () => document.activeElement.dataset.provider === "ftps",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.provider),
      "ftps",
    );
  }
  await page.focus('button[aria-label="关闭"]');
  await page.keyboard.press("Enter");
}
await page.cdp("Emulation.clearDeviceMetricsOverride");
console.log(
  "PASS: remote protocol entry, SMB fields, test/save/error states, retained and replaced credentials, SFTP host key/private-key fields, IPv6 host and responsive layout",
);
if (!globalThis.filoKeepSpace) await task.finish({ keep: [] });
