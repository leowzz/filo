// Vite + synthetic IPC only. Real encryption and persistence are tested in Rust.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo credential storage modes");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
if ((await page.url()).startsWith("http://127.0.0.1:1420")) {
  await page.evaluate(() => sessionStorage.removeItem("filo-credential-test"));
}
await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  window.isTauri = true;
  window.credentialState = JSON.parse(sessionStorage.getItem('filo-credential-test') || '{"mode":"plain","locked":false,"legacy_import_available":true}');
  if (window.credentialState.mode === 'master') window.credentialState.locked = true;
  window.unlockAttempts = 0;
  window.provided = 0;
  window.needConnection = false;
  window.testConnection = {id:'connection',name:'测试 S3',credential_ref:'test-ref',provider:'s3',config:{region:'test',endpoint:null,force_path_style:false}};
  const save = () => {sessionStorage.setItem('filo-credential-test', JSON.stringify(window.credentialState));return {...window.credentialState};};
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command,args) => {
    if (command === 'recent_backend_errors' || command === 'list_volumes' || command === 'list_transfers') return [];
    if (command === 'plugin:event|listen') return 1;
    if (command === 'plugin:event|unlisten') return;
    if (command === 'get_transfer_settings') return {upload_kib_per_second:0,download_kib_per_second:0};
    if (command === 'get_credential_settings') return {...window.credentialState};
    if (command === 'list_connections') return [window.testConnection];
    if (command === 'save_credential_settings') {
      if (window.credentialState.mode === 'master' && args.currentPassword !== 'test-password') throw {message:'当前主密码不正确'};
      window.credentialState.mode = args.mode;
      window.credentialState.locked = false;
      return save();
    }
    if (command === 'unlock_credentials') {
      window.unlockAttempts++;
      if (args.password !== 'test-password') throw {message:'主密码不正确或凭据文件已损坏'};
      window.credentialState.locked = false;
      return save();
    }
    if (command === 'import_legacy_credentials') {
      if (window.credentialState.locked) throw {code:'credentials_locked'};
      window.credentialState.legacy_import_available = false; save(); return 2;
    }
    if (command === 'provide_connection_credentials') {
      if (args.reference !== 'test-ref') throw {message:'连接不存在'};
      if (!args.s3 || !args.s3.secret_access_key) throw {message:'缺少测试密钥'};
      window.provided++; window.needConnection = false; return;
    }
    if (command === 'reset_credentials') {
      if (!args.confirmed) throw {message:'必须确认'};
      window.credentialState = {mode:'plain',locked:false,legacy_import_available:false}; return save();
    }
    if (command === 'list_entries' || command === 'test_s3_connection') {
      if (window.credentialState.locked) throw {code:'credentials_locked',message:'请解锁'};
      if (window.needConnection) throw {code:'credentials_required',credential_ref:'test-ref'};
      return command === 'list_entries' ? [] : null;
    }
    throw new Error('Unexpected IPC: ' + command);
  }};
})();` });
await page.goto("http://127.0.0.1:1420");
await page.waitForSelector(".sidebar-bottom button");
await page.click(".sidebar-bottom button");
await page.waitForSelector('.credential-settings-card input[value="plain"]');
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-card input[value="plain"]').checked), true);
await page.click('button:text-is("导入旧系统凭据")');
await page.waitForSelector(".credential-settings-saved");
assert.match(await page.evaluate(() => document.querySelector('.credential-settings-saved').textContent), /导入 2/);
await page.click('input[value="master"]');
const newFields = '.credential-settings-card input[autocomplete="new-password"]';
await page.waitForSelector(newFields);
await page.fill(`${newFields} >> nth=0`, "test-password");
await page.fill(`${newFields} >> nth=1`, "different-password");
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-actions button').disabled), true);
await page.fill(`${newFields} >> nth=1`, "test-password");
await page.click('button:text-is("保存凭据设置")');
await page.waitForSelector('.credential-settings-card input[autocomplete="current-password"]');
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-card input[value="master"]').checked), true);
await page.click('input[value="plain"]');
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-actions button').disabled), true);
await page.fill('.credential-settings-card input[autocomplete="current-password"]', "wrong-password");
await page.click('button:text-is("保存凭据设置")');
await page.waitForSelector('.credential-settings-card form [role="alert"]');
assert.match(await page.evaluate(() => document.querySelector('.credential-settings-card form [role="alert"]').textContent), /当前主密码不正确/);
assert.equal(await page.evaluate(() => window.credentialState.mode), 'master');
// Discard the pending mode change and simulate an application restart.
await page.reload();
await page.waitForSelector(".sidebar-bottom button");
await page.evaluate(() => {
  window.readsDone = false;
  import('/src/api.ts').then(({api}) => Promise.all(Array.from({length:8}, () => api.entries({volume_id:'test',logical_path:'',version_id:null}))))
    .then(() => window.readsDone = true, (error) => window.readError = error.message);
});
await page.waitForSelector('#unlock-master-password');
assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 1);
await page.fill('#unlock-master-password', 'wrong-password');
await page.click('button:text-is("解锁")');
await page.waitForSelector('dialog [role="alert"]');
assert.match(await page.evaluate(() => document.querySelector('dialog [role="alert"]').textContent), /主密码不正确/);
await page.fill('#unlock-master-password', 'test-password');
await page.click('button:text-is("解锁")');
await page.waitForFunction(() => window.readsDone || window.readError);
assert.equal(await page.evaluate(() => !!window.readError), false);
assert.equal(await page.evaluate(() => window.unlockAttempts), 2);
assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
// A test connection's 2-second network timeout must not include prompt time.
await page.evaluate(() => {
  window.credentialState.locked = true;
  window.testStarted = Date.now();
  import('/src/api.ts').then(({api}) => api.testS3(null, {}))
    .then(() => window.testDone = true, (error) => window.testError = error.message);
});
await page.waitForSelector('#unlock-master-password');
await page.waitForFunction(() => Date.now() - window.testStarted > 2200);
assert.equal(await page.evaluate(() => !!window.testError), false);
await page.fill('#unlock-master-password', 'test-password');
await page.click('button:text-is("解锁")');
await page.waitForFunction(() => window.testDone || window.testError);
assert.equal(await page.evaluate(() => window.testDone), true);
// Cancel rejects the waiting callers and clears the modal.
await page.evaluate(() => {
  window.credentialState.locked = true;
  import('/src/api.ts').then(({api}) => api.entries({volume_id:'test',logical_path:'',version_id:null}))
    .then(() => window.unexpectedSuccess = true, (error) => window.cancelled = error.message);
});
await page.waitForSelector('#unlock-master-password');
await page.click('dialog button:text-is("取消")');
await page.waitForFunction(() => !!window.cancelled);
assert.match(await page.evaluate(() => window.cancelled), /取消/);
// Missing per-connection credentials are prompted once and replay the read.
await page.evaluate(() => {
  window.credentialState.locked = false; window.needConnection = true;
  import('/src/api.ts').then(({api}) => api.entries({volume_id:'test',logical_path:'',version_id:null}))
    .then(() => window.connectionDone = true, (error) => window.connectionError = error.message);
});
await page.waitForSelector('dialog input[autocomplete="username"]');
await page.fill('dialog input[autocomplete="username"]', 'synthetic-key');
await page.fill('dialog input[autocomplete="current-password"]', 'synthetic-secret');
await page.click('dialog button:text-is("连接")');
await page.waitForFunction(() => window.connectionDone || window.connectionError);
assert.equal(await page.evaluate(() => window.connectionDone), true);
assert.equal(await page.evaluate(() => window.provided), 1);
// Reset is a concrete, explicit destructive action; connections are retained.
await page.click('.sidebar-bottom button');
await page.waitForSelector('button:text-is("重置已保存的凭据")');
await page.click('button:text-is("重置已保存的凭据")');
assert.equal(await page.evaluate(() => [...document.querySelectorAll('dialog button')].find(b=>b.textContent==='清除凭据').disabled), true);
await page.click('dialog input[type="checkbox"]');
await page.click('button:text-is("清除凭据")');
await page.waitForFunction(() => window.credentialState.mode === 'plain');
assert.equal(await page.evaluate(() => window.testConnection.id), 'connection');
await page.click('input[value="memory"]');
await page.click('button:text-is("保存凭据设置")');
await page.waitForFunction(() => window.credentialState.mode === 'memory');
await page.reload();
await page.waitForSelector('.sidebar-bottom button');
await page.click('.sidebar-bottom button');
await page.waitForSelector('.credential-settings-card input[value="memory"]');
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-card input[value="memory"]').checked), true);
await page.cdp("Emulation.setDeviceMetricsOverride", {width:1100,height:820,deviceScaleFactor:1,mobile:false});
console.log({wide:await page.screenshot({path:"/tmp/filo-credentials-wide.png"})});
await page.cdp("Emulation.setDeviceMetricsOverride", {width:760,height:820,deviceScaleFactor:1,mobile:false});
console.log({narrow:await page.screenshot({path:"/tmp/filo-credentials-narrow.png"})});
assert.equal(await page.evaluate(() => document.querySelector('.credential-settings-card').scrollWidth <= document.querySelector('.credential-settings-card').clientWidth), true);
console.log(await page.snapshot());
console.log('PASS: mode selection, validation, legacy import, failed change, restart, coalesced unlock, wrong password, timeout exclusion, cancellation, missing credentials, explicit reset');
await task.finish({keep:[]});
