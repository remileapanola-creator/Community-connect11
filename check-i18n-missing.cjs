var fs = require("fs");
var src = fs.readFileSync("js/script.js", "utf8");
var mapStart = src.indexOf("var I18N_MAP");
var mapEnd = src.indexOf("var I18N_PH");
var mapSrc = src.slice(mapStart, mapEnd);
var keys = [
  "Camera access was denied. Please allow the camera and microphone, then try again.",
  "No camera or microphone was found on this device.",
  "Could not use the camera or microphone. It may be in use by another app.",
  "Live broadcasting is not supported in this browser. Please use Chrome or Edge.",
  "viewers", "On Air", "Offline",
  "Broadcast to the community in real time.",
  "Please enter a title for the live stream.",
  "Another broadcast is already running. End it before starting a new one.",
  "The broadcast was interrupted.", "Broadcast is live.", "Live broadcast",
  "Broadcast saved to Live Archives.", "Broadcast ended.",
  "This recording is no longer available.", "Broadcast deleted.",
  "No saved broadcasts yet.", "PLAY", "DELETE", "watching",
  "Your browser cannot play live video. Please use Chrome or Edge.",
  "Connecting to the live broadcast...",
  // HTML static strings that script translates at runtime (check below)
  "Go Live Studio",
  "Enable the camera and microphone to preview yourself before going live.",
  "Enable Camera & Microphone",
  "Live Stream Title",
  "Description", "Category",
  "Save a recording to Live Archives when I end the broadcast",
  "Start Broadcast", "End Broadcast",
  "Live Archives",
  "Saved broadcasts play back like any other video post.",
  "No Live Broadcast Right Now",
  "Broadcast camera video and audio to the community in real time.",
  "LIVE"
];
var missing = keys.filter(function (k) {
  return mapSrc.indexOf('"' + k.replace(/"/g, '\\"') + '":') < 0;
});
console.log("MISSING (" + missing.length + "):");
missing.forEach(function (k) { console.log(" - " + k); });
