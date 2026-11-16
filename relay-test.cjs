/* Relay test: spawn server.js, connect two WS clients, assert text
   JSON control messages and binary media frames are relayed. */
var { spawn } = require("child_process");
var http = require("http");
var path = require("path");

var PORT = 8791;
var ROOT = path.resolve(__dirname, "../.."); // unused; server uses its own ROOT
var serverPath = path.resolve(process.cwd(), "server.js");
var failures = [];
function ok(cond, label) {
  if (cond) console.log("PASS: " + label);
  else { failures.push(label); console.log("FAIL: " + label); }
}

var proc = spawn(process.execPath, [serverPath], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ["ignore", "pipe", "pipe"]
});
proc.stdout.on("data", function (d) { process.stdout.write("[srv] " + d); });
proc.stderr.on("data", function (d) { process.stderr.write("[srv-err] " + d); });

function cleanup(code) {
  try { proc.kill(); } catch (e) {}
  process.exit(code);
}

function get(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    var iv = setInterval(function () {
      if (fn()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error("timeout")); }
    }, 25);
  });
}

async function main() {
  await sleep(800); // let server start

  // --- static serving ---
  var idx = await get("http://localhost:" + PORT + "/");
  ok(idx.status === 200 && /<html/i.test(idx.body.toString()), "GET / serves index.html");
  var admin = await get("http://localhost:" + PORT + "/admin.html");
  ok(admin.status === 200 && /liveGoBtn/.test(admin.body.toString()), "GET /admin.html has live studio");
  var dash = await get("http://localhost:" + PORT + "/user-dashboard.html");
  ok(dash.status === 200 && /liveSection/.test(dash.body.toString()), "GET /user-dashboard.html has live section");
  var js = await get("http://localhost:" + PORT + "/js/script.js");
  ok(js.status === 200 && /liveBus/.test(js.body.toString()), "GET /js/script.js serves transport");
  var trav = await get("http://localhost:" + PORT + "/../secret.txt");
  ok(trav.status === 403 || trav.status === 404, "path traversal blocked (" + trav.status + ")");
  var miss = await get("http://localhost:" + PORT + "/nope.html");
  ok(miss.status === 404, "404 for missing file");
  ok(String(admin.headers["cache-control"] || "").includes("no-cache"), "no-cache on html");

  // --- WS relay ---
  var wsUrl = "ws://localhost:" + PORT + "/live";
  var aGot = [], bGot = [], bGotBin = [];
  var a = new WebSocket(wsUrl);
  a.binaryType = "arraybuffer";
  var b = new WebSocket(wsUrl);
  b.binaryType = "arraybuffer";
  a.addEventListener("message", function (ev) { aGot.push(ev.data); });
  b.addEventListener("message", function (ev) {
    if (typeof ev.data === "string") bGot.push(ev.data);
    else bGotBin.push(ev.data);
  });

  await Promise.all([
    new Promise(function (r) { a.addEventListener("open", r); }),
    new Promise(function (r) { b.addEventListener("open", r); })
  ]);
  ok(true, "both WS clients connected to /live");

  // text JSON relay: a -> b, not echoed back to a
  a.send(JSON.stringify({ t: "state", live: true, session: { id: "s1", title: "Test Live" } }));
  await waitFor(function () { return bGot.length >= 1; }, 3000);
  var msg = JSON.parse(bGot[0]);
  ok(msg.t === "state" && msg.live === true && msg.session.id === "s1", "text JSON relayed a->b");
  ok(aGot.length === 0, "text not echoed back to sender");

  // binary relay: b -> a (media chunk style)
  var payload = new Uint8Array([1, 2, 3, 4, 5, 250]);
  b.send(payload.buffer);
  await waitFor(function () { return bGotBin.length >= 0 && aGot.some(function (d) { return typeof d !== "string"; }); }, 3000);
  var bin = new Uint8Array(aGot.find(function (d) { return typeof d !== "string"; }));
  ok(bin.length === 6 && bin[0] === 1 && bin[5] === 250, "binary media frame relayed b->a");

  // large binary (>125, >65535 boundary via 64KB payload)
  var big = new Uint8Array(70000);
  for (var i = 0; i < big.length; i++) big[i] = i % 256;
  a.send(big.buffer);
  await waitFor(function () {
    return bGotBin.some(function (d) { return d.byteLength === 70000; });
  }, 3000);
  var bigGot = new Uint8Array(bGotBin.find(function (d) { return d.byteLength === 70000; }));
  ok(bigGot[69999] === 69999 % 256 && bigGot[0] === 0, "70KB binary frame relayed intact");

  a.close(); b.close();
  await sleep(300);

  console.log(failures.length === 0 ? "RELAY TEST: ALL PASS" : "RELAY TEST: " + failures.length + " FAILURES");
  cleanup(failures.length === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error("TEST ERROR: " + e.message);
  cleanup(1);
});
