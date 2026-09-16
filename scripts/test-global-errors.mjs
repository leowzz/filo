// Run against Vite: ego-browser nodejs < scripts/test-global-errors.mjs
// All native IPC and failures are fixtures. No real storage or credentials are used.
const assert = (await import("node:assert/strict")).default;
const task = await taskSpace(globalThis.filoTestSpace ?? "Filo global errors");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
window.isTauri = true;
const callbacks = new Map();
const listeners = new Map();
let callbackId = 0;
window.failConnection = true;
window.backendError = payload => {
  const callback = callbacks.get(listeners.get('backend-error'));
  callback?.({event:'backend-error', payload});
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener:()=>{}};
window.__TAURI_INTERNALS__ = {
  metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
  transformCallback:callback=>{callbacks.set(++callbackId,callback);return callbackId;},
  unregisterCallback:id=>callbacks.delete(id),
  invoke:async(command,args)=>{
    if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
    if(command==='plugin:event|unlisten')return;
    if(command==='recent_backend_errors'){
      const report={id:'startup-report',location:'path.rs:69:5'};
      window.backendError(report);
      return [report];
    }
    if(['list_volumes','list_connections','list_transfers'].includes(command))return [];
    if(command==='get_transfer_settings')return {upload_kib_per_second:0,download_kib_per_second:0};
    if(command==='test_s3_connection'){
      if(window.failConnection){
        window.backendError({id:'command-report-1',location:'path.rs:69:5'});
        window.backendError({id:'command-report-2',location:'path.rs:69:5'});
        throw {code:'internal',message:'操作发生内部异常，无法确认是否完成。请检查结果后重试',retryable:false};
      }
      return;
    }
    throw new Error('Unexpected fixture IPC: '+command);
  }
};
`,
});
await page.goto(globalThis.filoTestUrl ?? "http://127.0.0.1:1420");
await page.waitForSelector(".global-error-dialog[open]");
assert.match(
  await page.evaluate(
    () => document.querySelector(".global-error-dialog pre").textContent,
  ),
  /startup-report\n发生次数：1/,
);
await page.click('button:text-is("知道了")');
await page.click('.sidebar button[aria-label="添加存储空间"]');
await page.click('button[data-provider="tos"]');
await page.fill('xpath=//label[contains(.,"连接名称")]//input', "error-test");
await page.fill('xpath=//label[contains(.,"存储桶")]//input', "fixture-bucket");
await page.fill('xpath=//label[contains(.,"Access Key ID")]//input', "test");
await page.fill('input[autocomplete="new-password"]', "test");
await page.click('button:text-is("测试连接")');
await page.waitForSelector(".global-error-dialog[open]");
await page.waitForFunction(() =>
  document.querySelector(".error-text")?.textContent.includes("内部异常"),
);
assert.match(
  await page.evaluate(
    () => document.querySelector(".global-error-dialog pre").textContent,
  ),
  /command-report-2\n发生次数：2/,
);
assert.equal(
  await page.evaluate(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "测试连接" && !button.disabled,
    ),
  ),
  true,
);
// The global dialog is in the top layer above the already-open connection form.
assert.equal(
  await page.evaluate(() =>
    document
      .querySelector(".global-error-dialog")
      .contains(document.activeElement),
  ),
  true,
);
await page.click('summary:text-is("查看诊断信息")');
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
assert.equal(
  await page.evaluate(() => {
    const dialog = document.querySelector(".global-error-dialog");
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
if (globalThis.filoCaptureScreenshot)
  await page.screenshot({ path: "/tmp/filo-global-error.png" });
await page.cdp("Emulation.clearDeviceMetricsOverride");
await page.click('button:text-is("知道了")');
await page.evaluate(() => {
  window.failConnection = false;
});
await page.click('button:text-is("测试连接")');
await page.waitForSelector(".s3-test-success");
await page.click('button[aria-label="关闭"]');
// Browser runtime failures retain useful context while redacting credentials.
await page.evaluate(() => {
  setTimeout(() => {
    throw new Error(
      "fixture script failure secret_access_key=fixture-secret-payload",
    );
  }, 0);
});
await page.waitForSelector(".global-error-dialog[open]");
assert.match(
  await page.evaluate(
    () => document.querySelector(".global-error-dialog pre").textContent,
  ),
  /fixture script failure secret_access_key=\[已隐藏\]/,
);
assert.equal(
  await page.evaluate(() =>
    document
      .querySelector(".global-error-dialog")
      .textContent.includes("fixture-secret-payload"),
  ),
  false,
);
await page.click('button:text-is("知道了")');
await page.evaluate(() => {
  void Promise.reject(new Error("fixture-rejection"));
});
await page.waitForSelector(".global-error-dialog[open]");
assert.match(
  await page.evaluate(
    () => document.querySelector(".global-error-dialog pre").textContent,
  ),
  /未处理的异步异常[\s\S]*Error: fixture-rejection/,
);
await page.evaluate(() => {
  void Promise.reject({
    code: "permission_denied",
    message: "fixture second rejection",
    token: "fixture-private-token",
  });
});
await page.waitForFunction(() =>
  document
    .querySelector(".global-error-dialog pre")
    .textContent.includes("fixture second rejection"),
);
const rejectionDetails = await page.evaluate(
  () => document.querySelector(".global-error-dialog pre").textContent,
);
assert.match(rejectionDetails, /fixture-rejection/);
assert.match(rejectionDetails, /permission_denied: fixture second rejection/);
assert.equal(rejectionDetails.includes("fixture-private-token"), false);
assert.equal(
  (rejectionDetails.match(/发生次数：1/g) ?? []).length,
  2,
  "Different reasons must not be merged",
);
await page.click('button:text-is("知道了")');
// Render a crashing subtree using the production boundary; no debug-only app command is needed.
await page.evaluate(async () => {
  const React = (await import("/node_modules/.vite/deps/react.js")).default;
  const ReactDOM = (
    await import("/node_modules/.vite/deps/react-dom_client.js")
  ).default;
  const { AppErrorBoundary } = await import("/src/GlobalErrors.tsx");
  const host = document.createElement("div");
  host.id = "boundary-fixture";
  document.body.append(host);
  window.boundaryFixture = ReactDOM.createRoot(host);
  const Crashing = () => {
    throw new Error("render fixture");
  };
  window.boundaryFixture.render(
    React.createElement(AppErrorBoundary, null, React.createElement(Crashing)),
  );
});
await page.waitForSelector("#boundary-fixture .app-crash");
await page.waitForSelector(".global-error-dialog[open]");
assert.match(
  await page.evaluate(
    () => document.querySelector(".global-error-dialog pre").textContent,
  ),
  /界面渲染异常/,
);
await page.click('button:text-is("知道了")');
await page.evaluate(() => {
  window.boundaryFixture.unmount();
  document.getElementById("boundary-fixture").remove();
});
console.log(
  "PASS: startup replay/deduplication, backend panic dialog above modal, busy state cleared, retry, narrow layout, runtime error, unhandled rejection, render fallback",
);
if (!globalThis.filoKeepSpace) await task.finish({ keep: [] });
