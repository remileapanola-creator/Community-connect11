/* Community Connect - headless end-to-end test runner (zero dependencies).
   Opens tests/e2e.html in headless Chrome, waits for the suite to finish,
   and prints the pass/fail tally. Unlike `chrome --dump-dom
   --virtual-time-budget=...`, this waits on real time, so IndexedDB and
   other real async work complete and the result is deterministic.

   Run with:  node tests/e2e-run.cjs
   Optional env vars:
     CHROME_PATH  full path to chrome.exe / Google Chrome / chromium
     PORT         DevTools port (default 9333)
     TIMEOUT_MS   give up after this many ms (default 240000) */

var child_process = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var PORT = parseInt(process.env.PORT, 10) || 9333;
var TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 240000;
var PAGE = "file:///" + path
  .resolve(__dirname, "e2e.html")
  .replace(/\\/g, "/")
  .replace(/^([A-Za-z]:)/, "$1")
  .replace(/ /g, "%20")
  .replace(/#/g, "%23");

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  var candidates = [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
    process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var CHROME = findChrome();
if (!CHROME) {
  console.error("Could not find Chrome. Set CHROME_PATH and try again.");
  process.exit(1);
}

var userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-"));
var chrome = child_process.spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + userDataDir,
  "--allow-file-access-from-files",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--mute-audio",
  PAGE
], { stdio: ["ignore", "ignore", "ignore"] });

var cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

async function getTarget() {
  for (var i = 0; i < 60; i++) {
    try {
      var res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      var list = await res.json();
      var page = list.filter(function (t) { return t.type === "page" && t.url.indexOf("e2e.html") >= 0; })[0]
        || list.filter(function (t) { return t.type === "page"; })[0];
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error("no page target found on DevTools port " + PORT);
}

(async function () {
  var target = await getTarget();
  var ws = new WebSocket(target.webSocketDebuggerUrl);
  var id = 0;
  var pending = new Map();
  ws.addEventListener("message", function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise(function (res, rej) {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  function send(method, params) {
    return new Promise(function (resolve) {
      var myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
    });
  }
  async function evaluate(expr) {
    var r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.result && r.result.result) return r.result.result.value;
    return undefined;
  }
  await send("Runtime.enable");

  var deadline = Date.now() + TIMEOUT_MS;
  var title = "";
  while (Date.now() < deadline) {
    title = await evaluate("document.title");
    if (typeof title === "string" && title.indexOf("E2E DONE") >= 0) break;
    await sleep(1000);
  }

  var summary = await evaluate(
    "(function(){var l=document.querySelectorAll('#results li');var p=0,f=0,fails=[];" +
    "l.forEach(function(x){if(x.classList.contains('pass'))p++;else{f++;fails.push(x.textContent);}});" +
    "return JSON.stringify({total:l.length,pass:p,fail:f,fails:fails});})()"
  );
  var data = summary ? JSON.parse(summary) : { total: 0, pass: 0, fail: 0, fails: [] };

  console.log("E2E DONE: " + data.pass + "/" + data.total + (data.fail ? " (" + data.fail + " FAILED)" : ""));
  data.fails.forEach(function (name) { console.log("FAIL  " + name); });

  ws.close();
  cleanup();
  process.exit(data.fail ? 1 : 0);
})().catch(function (err) {
  console.error("runner error: " + (err && err.message ? err.message : err));
  cleanup();
  process.exit(1);
});
