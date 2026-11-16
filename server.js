/* Community Connect - zero-dependency Node server
   Serves the site over http and relays the Go Live stream over a
   hand-rolled WebSocket at /live, so the admin and viewers can be on
   different computers on the same network. Run with:  node server.js
   Open http://localhost:8787/admin.html to go live (camera needs a
   secure context; localhost counts). Viewers open
   http://<your-ip>:8787/user-dashboard.html. */

var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");

var PORT = parseInt(process.env.PORT, 10) || 8787;
var ROOT = __dirname;
var WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var RELAY_PATH = "/live";

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json"
};

var relay = { clients: [] };

function log(msg) {
  console.log("[server] " + msg);
}

function lanAddresses() {
  var out = [];
  var nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    nets[name].forEach(function (net) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    });
  });
  return out;
}

/* ---------------- static files ---------------- */

function sendFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": data.length
    });
    res.end(data);
  });
}

function handleStatic(req, res) {
  var urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 Bad Request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  var full = path.normalize(path.join(ROOT, urlPath));
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }
  fs.stat(full, function (err, st) {
    if (err || st.isDirectory()) {
      if (!err && st.isDirectory()) full = path.join(full, "index.html");
      else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
    }
    sendFile(res, full);
  });
}

/* ---------------- WebSocket /live relay ---------------- */

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(payload, opcode) {
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode || 1); // FIN + opcode (1 text, 2 binary)
  return Buffer.concat([header, payload]);
}

function frameBytes(payloadLen) {
  if (payloadLen < 126) return 2;
  if (payloadLen < 65536) return 4;
  return 10;
}

function handleUpgrade(req, socket) {
  var urlPath = (req.url || "").split("?")[0];
  if (urlPath !== RELAY_PATH) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  var key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + wsAccept(String(key)) + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  var client = {
    socket: socket,
    buffer: Buffer.alloc(0),
    alive: true
  };
  relay.clients.push(client);
  log("relay client connected (" + relay.clients.length + " total)");

  var pingTimer = setInterval(function () {
    if (!client.alive) return;
    client.alive = false;
    try { socket.write(encodeFrame(Buffer.alloc(0), 9)); } catch (e) {}
  }, 15000);

  function dropClient() {
    clearInterval(pingTimer);
    var idx = relay.clients.indexOf(client);
    if (idx >= 0) relay.clients.splice(idx, 1);
    log("relay client dropped (" + relay.clients.length + " total)");
  }

  socket.on("data", function (chunk) {
    client.alive = true;
    client.buffer = Buffer.concat([client.buffer, chunk]);
    parseFrames(client, function (data, opcode) {
      if (opcode === 8) { // close
        try { socket.end(); } catch (e) {}
        return;
      }
      if (opcode === 9) { // ping -> pong
        try { socket.write(encodeFrame(data, 10)); } catch (e) {}
        return;
      }
      if (opcode === 10) return; // pong
      relayBroadcast(client, data, opcode);
    });
  });
  socket.on("close", dropClient);
  socket.on("error", dropClient);
  socket.on("end", dropClient);
}

function parseFrames(client, onFrame) {
  var buf = client.buffer;
  while (buf.length >= 2) {
    var b0 = buf[0];
    var b1 = buf[1];
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) === 0x80;
    var len = b1 & 0x7f;
    var offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = buf.readUInt32BE(6); // payloads < 4GB
      offset = 10;
    }
    var maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    var payload;
    if (masked) {
      var mask = buf.slice(offset, offset + 4);
      payload = Buffer.from(buf.slice(offset + 4, offset + 4 + len));
      for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    } else {
      payload = Buffer.from(buf.slice(offset, offset + len));
    }
    buf = buf.slice(offset + maskLen + len);
    client.buffer = buf;
    onFrame(payload, opcode);
    buf = client.buffer;
  }
}

function relayBroadcast(from, data, opcode) {
  // Relay text (JSON control) and binary (media payload) frames to
  // every other client; media stays opaque bytes so this scales.
  var frame = encodeFrame(data, opcode === 2 ? 2 : 1);
  relay.clients.forEach(function (c) {
    if (c === from) return;
    try { c.socket.write(frame); } catch (e) {}
  });
}

/* ---------------- server ---------------- */

var server = http.createServer(handleStatic);
server.on("upgrade", handleUpgrade);
server.on("listening", function () {
  log("listening on http://localhost:" + PORT);
  lanAddresses().forEach(function (ip) {
    log("LAN viewers: http://" + ip + ":" + PORT + "/user-dashboard.html");
  });
  log("admin: http://localhost:" + PORT + "/admin.html (click Go Live)");
});
server.listen(PORT);
