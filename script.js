/* ============================================================
   COMMUNITY CONNECT - Main JavaScript
   WS101 Mini Capstone - Community News & Announcements
   Plain JavaScript + LocalStorage only.
   ============================================================ */

/* ------------------------------------------------------------
   1. BASIC HELPERS
   ------------------------------------------------------------ */

// ---- Pagination state for the public news / announcements lists ----
var PAGE_SIZE = 6;
var newsVisible = PAGE_SIZE;
var annVisible = PAGE_SIZE;
var annQuery = "";
var lastFocused = null; // element focused before a modal opened (for focus restore)

// Short text limits for feed card previews (kept named so they are easy to find)
var NEWS_PREVIEW_LIMIT = 100;
var ANNOUNCEMENT_PREVIEW_LIMIT = 140;
var EVENT_PREVIEW_LIMIT = 90;
var ACTIVITY_PREVIEW_LIMIT = 90;

// Read data from LocalStorage (returns fallback if nothing saved)
function getData(key, fallback) {
  var raw = localStorage.getItem(key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// Save data to LocalStorage. Returns true on success, false when the write
// fails (usually a full quota). The caller decides how to recover.
function setData(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

// Friendly "storage is full" message used wherever a save can fail.
function showStorageFullToast() {
  showToast("Sorry, this browser's storage is full. Try removing old items or using a smaller image.", "error");
}

/* ------------------------------------------------------------
   1b. VIDEO STORE (IndexedDB)
   Videos are too big for LocalStorage (a few MB quota), so the raw
   file is stored in IndexedDB under a tiny key. The news record only
   holds a short reference ("idb:<key>"), which keeps localStorage
   small and means there is no practical video-size limit.
   ------------------------------------------------------------ */

var VIDEO_IDB_NAME = "communityConnect";
var VIDEO_IDB_STORE = "videos";
var VIDEO_IDB_VERSION = 1;
var pendingVideoFiles = [];   // Files staged by the picker until the post is saved
var pendingVideoPosters = []; // Thumbnail frames captured from the staged videos

// Resolve which videos a form submission should save.
//  - Newly staged files are written to IndexedDB (no size limit).
//  - If the field was not touched since the form was filled, every video the
//    post already had is kept (so multi-video posts survive edits).
//  - Otherwise a typed path/link becomes the single video (or none if blank).
// Returns a Promise of { videos, posters, unchanged }.
function resolveVideoSelection(inputEl, prevVideos) {
  prevVideos = prevVideos || [];
  var wasPending = inputEl && inputEl.getAttribute("data-pending-video") === "1";
  if (pendingVideoFiles.length && wasPending) {
    return Promise.all(pendingVideoFiles.map(function (f) {
      return saveVideoBlob(f).catch(function () { return ""; });
    })).then(function (refs) {
      return { videos: refs.filter(Boolean), posters: pendingVideoPosters.slice(), unchanged: false };
    });
  }
  var original = inputEl ? inputEl.getAttribute("data-original-video") : null;
  var typed = inputEl ? inputEl.value.trim() : "";
  if (original !== null && typed === original) {
    // Untouched since the form was filled: keep everything the post had.
    return Promise.resolve({ videos: prevVideos, posters: [], unchanged: true });
  }
  if (typed.indexOf("idb:") === 0) {
    return Promise.resolve({ videos: [typed], posters: [], unchanged: false });
  }
  return Promise.resolve({ videos: typed ? [typed] : [], posters: [], unchanged: false });
}

// Grab a single frame from a video URL as a small JPEG data URL. Used as the
// feed poster so video posts show a picture instead of a black box.
function captureVideoPoster(url) {
  return new Promise(function (resolve) {
    var v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    var done = false;
    var finish = function (value) {
      if (done) return;
      done = true;
      v.removeAttribute("src");
      v.load();
      resolve(value || "");
    };
    v.onloadeddata = function () {
      try {
        // Seek a little in so the frame is not a blank lead-in.
        v.currentTime = Math.min(1, (v.duration || 2) / 3);
      } catch (e) { finish(""); }
    };
    v.onseeked = function () {
      try {
        var c = document.createElement("canvas");
        var w = 640;
        var scale = w / (v.videoWidth || w);
        c.width = w;
        c.height = Math.round((v.videoHeight || 360) * scale);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL("image/jpeg", 0.72));
      } catch (e) { finish(""); }
    };
    v.onerror = function () { finish(""); };
    setTimeout(function () { finish(""); }, 8000);
    v.src = url;
  });
}

function openVideoDb() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
    var req = indexedDB.open(VIDEO_IDB_NAME, VIDEO_IDB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(VIDEO_IDB_STORE)) {
        db.createObjectStore(VIDEO_IDB_STORE);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error("Cannot open video store")); };
  });
}

// Store a File/Blob and return a short reference string for the news record.
function saveVideoBlob(blob) {
  return new Promise(function (resolve, reject) {
    openVideoDb().then(function (db) {
      var key = "v" + Date.now() + Math.floor(Math.random() * 100000);
      var tx = db.transaction(VIDEO_IDB_STORE, "readwrite");
      var req = tx.objectStore(VIDEO_IDB_STORE).put(blob, key);
      req.onsuccess = function () { resolve("idb:" + key); };
      tx.onerror = function () { reject(tx.error || new Error("Cannot save video")); };
      tx.onabort = function () { reject(tx.error || new Error("Video save aborted")); };
    }).catch(reject);
  });
}

// Turn an "idb:<key>" reference into a playable object URL.
// Returns null when the ref is missing, or a normal path/URL/data URL as-is.
function videoSrcFromRef(ref) {
  var v = String(ref || "").trim();
  if (!v) return "";
  if (v.indexOf("idb:") !== 0) return v; // path, link, or legacy data URL
  var key = v.slice(4);
  return openVideoDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(VIDEO_IDB_STORE, "readonly");
      var req = tx.objectStore(VIDEO_IDB_STORE).get(key);
      req.onsuccess = function () {
        var blob = req.result;
        resolve(blob ? URL.createObjectURL(blob) : "");
      };
      req.onerror = function () { resolve(""); };
    });
  }).catch(function () { return ""; });
}

// Delete a stored video (used when a post or its video is removed).
function deleteVideoRef(ref) {
  var v = String(ref || "").trim();
  if (v.indexOf("idb:") !== 0) return Promise.resolve();
  var key = v.slice(4);
  return openVideoDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(VIDEO_IDB_STORE, "readwrite");
      tx.objectStore(VIDEO_IDB_STORE).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
      tx.onabort = function () { resolve(); };
    });
  }).catch(function () {});
}

// Generate a simple unique ID
function generateId() {
  return Date.now().toString() + Math.floor(Math.random() * 1000).toString();
}

// Format a date string (yyyy-mm-dd) into a readable format
function formatDate(dateString) {
  if (!dateString) return "";
  var options = { year: "numeric", month: "long", day: "numeric" };
  var d = new Date(dateString + "T00:00:00");
  if (isNaN(d.getTime())) return dateString;
  var locale = (typeof currentLang !== "undefined" && currentLang === "fil") ? "fil-PH" : "en-US";
  return d.toLocaleDateString(locale, options);
}

// Return a date string N days from today (used by sample events
// so the countdown demo always works)
function daysFromNow(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + month + "-" + day;
}

// Format a timestamp (ISO) into a readable clock time (e.g. 3:45 PM)
function formatTime(isoString) {
  if (!isoString) return "";
  var d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  var locale = (typeof currentLang !== "undefined" && currentLang === "fil") ? "fil-PH" : "en-US";
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

// Current date + time in Philippine time (Asia/Manila), regardless of the
// viewer's own timezone. Used by the weather card's "Updated" line and the
// AI chat's date answer so they always show the real Philippine date.
function formatPhilippineNow(withDate) {
  var now = new Date();
  var locale = (typeof currentLang !== "undefined" && currentLang === "fil") ? "fil-PH" : "en-US";
  var opts = { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" };
  if (withDate !== false) {
    opts.year = "numeric";
    opts.month = "long";
    opts.day = "numeric";
  }
  try {
    return now.toLocaleString(locale, opts);
  } catch (e) {
    return now.toLocaleString(locale, { hour: "numeric", minute: "2-digit" });
  }
}

/* ------------------------------------------------------------
   1b. PROFILE PICTURES + DISPLAY NAMES
   Members and the admin can set a display name and upload a
   profile photo. Both are stored locally (small 256px JPEG) and
   shown beside their posts, comments, and on the dashboards.
   ------------------------------------------------------------ */

function loadAdminProfile() {
  var p = getData("communityAdminProfile", null);
  if (!p || typeof p !== "object") {
    p = { name: "", title: "", phone: "", email: "", avatar: "" };
  }
  return p;
}

function saveAdminProfile(profile) {
  return setData("communityAdminProfile", profile || {});
}

// The name shown as the author of a post. Admin-created posts record the
// signed-in admin; older/sample items fall back to the community office.
function getPosterName() {
  var profile = loadAdminProfile();
  if (profile.name && profile.name.trim()) return profile.name.trim();
  var name = localStorage.getItem("adminName");
  if (!name) return "Community Office";
  if (name.toLowerCase() === "admin") return "Administrator";
  return name;
}

// The stored avatar (data URL) for a username / display name, if any
function avatarFor(name) {
  var key = String(name || "").trim().toLowerCase();
  if (!key) return "";
  // Officials interact under an "official:<username>" actor id
  if (key.indexOf("official:") === 0) key = key.slice(9);
  var profile = loadAdminProfile();
  var adminName = String(profile.name || "").trim().toLowerCase();
  if (key === "administrator" || key === "admin" || (adminName && key === adminName)) {
    return profile.avatar || "";
  }
  var users = loadUsers();
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var uname = String(u.username || "").toLowerCase();
    var dname = String(u.name || "").toLowerCase();
    if (key === uname || (dname && key === dname)) return u.avatar || "";
  }
  // Barangay officials can set a profile photo too
  var officials = loadOfficials();
  for (var j = 0; j < officials.length; j++) {
    var o = officials[j];
    var oname = String(o.username || "").toLowerCase();
    var odname = String(o.name || "").toLowerCase();
    if (key === oname || (odname && key === odname)) return o.avatar || "";
  }
  return "";
}

// The display name for a username (falls back to the username itself)
function displayNameFor(username) {
  var key = String(username || "").trim().toLowerCase();
  if (!key) return "";
  var users = loadUsers();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username || "").toLowerCase() === key) {
      return users[i].name && String(users[i].name).trim()
        ? String(users[i].name).trim() : users[i].username;
    }
  }
  var profile = loadAdminProfile();
  var adminName = String(profile.name || "").trim();
  if (key === "admin" || key === "administrator" || (adminName && key === adminName.toLowerCase())) {
    return adminName || username;
  }
  if (key.indexOf("official:") === 0) {
    var uname = key.slice(9);
    var offs = loadOfficials();
    for (var k = 0; k < offs.length; k++) {
      if (String(offs[k].username || "").toLowerCase() === uname) {
        return (offs[k].name || offs[k].username) + " (" + t("Barangay Official") + ")";
      }
    }
  }
  return username;
}

// Inside markup for an avatar: the photo when set, initials otherwise
function avatarInner(name) {
  var src = avatarFor(name);
  if (src) return '<img class="avatar-photo" src="' + escapeHtml(src) + '" alt="">';
  return escapeHtml(String(name || "?").trim().charAt(0).toUpperCase() || "?");
}

// Square, compressed avatar (max 256px JPEG) so localStorage stays small
function compressAvatar(dataUrl, callback) {
  var img = new Image();
  img.onload = function () {
    var side = Math.min(img.width, img.height) || 1;
    var size = Math.min(256, side);
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    try {
      callback(canvas.toDataURL("image/jpeg", 0.82));
    } catch (e) {
      callback(dataUrl);
    }
  };
  img.onerror = function () { callback(dataUrl); };
  img.src = dataUrl;
}

// Compress an incident photo to a data URL (max 900px long edge, JPEG) so it
// fits comfortably in localStorage.
function compressIncidentPhoto(dataUrl, callback) {
  var img = new Image();
  img.onload = function () {
    var maxSide = 900;
    var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width * scale));
    var h = Math.max(1, Math.round(img.height * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    try { callback(canvas.toDataURL("image/jpeg", 0.72)); }
    catch (e) { callback(dataUrl); }
  };
  img.onerror = function () { callback(dataUrl); };
  img.src = dataUrl;
}

// Wire an avatar picker: file input previews a square crop, REMOVE clears it.
// `getCurrent` reads the avatar that should be saved, `onPick` receives new ones.
function initAvatarPicker(fileId, previewId, removeId, getCurrent, onPick) {
  var fileInput = document.getElementById(fileId);
  var preview = document.getElementById(previewId);
  var removeBtn = document.getElementById(removeId);

  function paint(name, avatar) {
    if (!preview) return;
    preview.innerHTML = avatar
      ? '<img class="avatar-photo" src="' + escapeHtml(avatar) + '" alt="">'
      : escapeHtml(String(name || "?").trim().charAt(0).toUpperCase() || "?");
  }
  paint(getCurrent().name, getCurrent().avatar);

  if (fileInput) {
    fileInput.addEventListener("change", function () {
      var file = this.files && this.files[0];
      this.value = "";
      if (!file) return;
      if (!/^image\//i.test(file.type)) {
        showToast("Please choose an image file (JPG, PNG, GIF, or WEBP).", "error");
        return;
      }
      var reader = new FileReader();
      reader.onload = function (e) {
        compressAvatar(e.target.result, function (dataUrl) {
          onPick(dataUrl);
          paint(getCurrent().name, dataUrl);
          showToast("Profile photo updated. Remember to save.", "success");
        });
      };
      reader.readAsDataURL(file);
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", function () {
      onPick("");
      paint(getCurrent().name, "");
      showToast("Profile photo removed. Remember to save.", "success");
    });
  }
}

// Refresh the avatar + name shown in a dashboard header / sidebar
function refreshIdentityUi(refs, name, avatar) {
  refs.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (id.indexOf("Name") >= 0) {
      el.textContent = name;
    } else {
      el.innerHTML = avatar
        ? '<img class="avatar-photo" src="' + escapeHtml(avatar) + '" alt="">'
        : escapeHtml(String(name || "?").trim().charAt(0).toUpperCase() || "?");
    }
  });
}

/* ---- Admin profile (photo + personal information) ---- */
function refreshAdminIdentity() {
  var profile = loadAdminProfile();
  var display = profile.name && profile.name.trim() ? profile.name.trim() : getPosterName();
  var mark = profile.avatar
    ? '<img class="avatar-photo" src="' + escapeHtml(profile.avatar) + '" alt="">'
    : escapeHtml(display.charAt(0).toUpperCase() || "A");

  var headerAvatar = document.getElementById("adminHeaderAvatar");
  if (headerAvatar) headerAvatar.innerHTML = mark;
  var headerName = document.getElementById("adminHeaderName");
  if (headerName) headerName.textContent = display;

  var sideAvatar = document.getElementById("adminSidebarAvatar");
  if (sideAvatar) sideAvatar.innerHTML = mark;
  var sideName = document.getElementById("adminSidebarName");
  if (sideName) sideName.textContent = display;
  var sideMeta = document.getElementById("adminSidebarMeta");
  if (sideMeta && profile.title) sideMeta.textContent = profile.title;
}

// Show the "profile saved" banner, auto-hide it after 2 seconds, then
// refresh the page automatically so the dashboard reflects the new data.
function showProfileSaved(alertEl) {
  if (!alertEl) return;
  alertEl.textContent = t("Your profile has been saved successfully.");
  alertEl.classList.add("show");
  setTimeout(function () {
    alertEl.classList.remove("show");
    setTimeout(function () {
      try { window.location.reload(); } catch (e) {}
    }, 120);
  }, 2000);
}

function initAdminProfileForm() {
  var form = document.getElementById("adminProfileForm");
  if (!form) return;

  var profile = loadAdminProfile();
  var nameEl = document.getElementById("adminProfileName");
  var titleEl = document.getElementById("adminProfileTitle");
  var phoneEl = document.getElementById("adminProfilePhone");
  var emailEl = document.getElementById("adminProfileEmail");

  if (nameEl) nameEl.value = profile.name || "";
  if (titleEl) titleEl.value = profile.title || "";
  if (phoneEl) phoneEl.value = profile.phone || "";
  if (emailEl) emailEl.value = profile.email || "";

  var pendingAvatar = profile.avatar || "";
  initAvatarPicker(
    "adminAvatarFile", "adminAvatarPreview", "adminAvatarRemove",
    function () {
      return {
        name: (nameEl && nameEl.value.trim()) || getPosterName(),
        avatar: pendingAvatar
      };
    },
    function (dataUrl) { pendingAvatar = dataUrl; }
  );

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var next = {
      name: nameEl ? nameEl.value.trim().slice(0, 40) : "",
      title: titleEl ? titleEl.value.trim().slice(0, 60) : "",
      phone: phoneEl ? phoneEl.value.trim() : "",
      email: emailEl ? emailEl.value.trim() : "",
      avatar: pendingAvatar
    };
    saveAdminProfile(next);
    refreshAdminIdentity();
    var ok = document.getElementById("adminProfileSuccess");
    showProfileSaved(ok);
    logAudit("updated admin profile", next.name || "Administrator");
    showToast("Profile saved.", "success");
  });

  // Circular close button on the profile card returns to the dashboard
  var adminClose = document.getElementById("adminProfileCloseBtn");
  if (adminClose) {
    adminClose.addEventListener("click", function () { showAdminSection("dashboard"); });
  }
}

// Shorten long text
function shortText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

// Simple HTML escape so user input is shown safely
function escapeHtml(text) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(text || ""));
  return div.innerHTML;
}

/* ------------------------------------------------------------
   1c. NOTIFICATION CENTRE - constants + real-time bus
   Declared here (before any page init runs) because the admin
   dashboard wires its notification centre during startup.
   Every notification later comes from a real user action.
   ------------------------------------------------------------ */

var NOTIFICATIONS_KEY = "communityNotifications";
var NOTIFICATION_PREFS_KEY = "communityNotificationPrefs";
var NOTIFY_BUS_NAME = "cc-notify-v1";
var NOTIFICATION_MAX = 300;

// The kinds of activity the admin can be told about
var NOTIF_TYPES = [
  { key: "like", label: "Likes", verb: "liked" },
  { key: "comment", label: "Comments", verb: "commented on" },
  { key: "share", label: "Shares", verb: "shared" },
  { key: "save", label: "Saves", verb: "saved" },
  { key: "rsvp", label: "Event RSVPs", verb: "is going to" },
  { key: "register", label: "New members", verb: "joined the community" },
  { key: "post", label: "Community Posts", verb: "posted" },
  { key: "live", label: "Go Live", verb: "started a live broadcast" }
];

// Barangay officials + certificate services storage keys
var OFFICIALS_KEY = "barangayOfficials";
var CERT_REQUESTS_KEY = "certificateRequests";
var OFFICIAL_NOTIFICATIONS_KEY = "communityOfficialNotifications";

// Cross-tab real-time: BroadcastChannel with a storage-event fallback
var notifyBus = (function () {
  var bc = null;
  var handlers = [];
  try { bc = new BroadcastChannel(NOTIFY_BUS_NAME); } catch (e) { bc = null; }
  function fire() {
    handlers.forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  if (bc) bc.onmessage = fire;
  window.addEventListener("storage", function (e) {
    if (e.key === NOTIFICATIONS_KEY || e.key === NOTIFICATION_PREFS_KEY ||
        e.key === OFFICIAL_NOTIFICATIONS_KEY || e.key === CERT_REQUESTS_KEY ||
        e.key === INCIDENTS_KEY || e.key === EMERGENCY_KEY ||
        e.key === POSTS_KEY || e.key === USER_ALERTS_KEY) fire();
  });
  return {
    onMessage: function (fn) { handlers.push(fn); },
    post: function () { if (bc) { try { bc.postMessage({ t: "notif" }); } catch (e) {} } }
  };
})();

/* ------------------------------------------------------------
   2. SAMPLE DATA (shown when LocalStorage is empty)
   ------------------------------------------------------------ */

function sampleNews() {
  return [
    {
      id: generateId(),
      title: "Barangay Clean-Up Drive Draws Record Volunteers",
      category: "Community",
      date: daysFromNow(-10),
      description: "Over 200 residents joined the monthly clean-up drive last weekend.",
      details: "More than 200 residents, students, and local officials joined the monthly community clean-up drive held last weekend. The activity covered the plaza, the market area, and the riverside. The community office thanked all volunteers and reminded everyone that the next clean-up drive will be held again next month.",
      image: "././Cleanup-drive-1024x682.webp"
    },
    {
      id: generateId(),
      title: "New Health Center Now Open for Residents",
      category: "Health",
      date: daysFromNow(-7),
      description: "The new health center is now accepting patients every weekday.",
      details: "The community health center is now open every Monday to Friday, from 8:00 AM to 4:00 PM. Residents can avail of free check-ups, medicines, and senior citizen consultations. Bring a valid ID when visiting the health center.",
      image: "././New Health Center Now Open for Residents.jfif"
    },
    {
      id: generateId(),
      title: "Youth Sports League Kicks Off This Month",
      category: "Events",
      date: daysFromNow(-5),
      description: "Teams from different puroks will compete in basketball and volleyball.",
      details: "The annual youth sports league officially opens this month. Teams from different puroks will compete in basketball and volleyball at the covered court. Schedules and team brackets are posted at the community office bulletin board.",
      image: "././Youth Sports League Kicks Off This Month.jfif"
    },
    {
      id: generateId(),
      title: "Scholarship Applications Now Open",
      category: "Education",
      date: daysFromNow(-3),
      description: "Elementary and high school students may now submit scholarship forms.",
      details: "The community scholarship program is now accepting applications for elementary and high school students. Interested students may download or pick up forms at the community office. Deadline of submission is on the last Friday of this month.",
      image: "././Scholarship Applications Now Open.jpg"
    },
    {
      id: generateId(),
      title: "Road Repair Schedule Announced",
      category: "Public Notice",
      date: daysFromNow(-1),
      description: "Portions of the main road will undergo repair starting next week.",
      details: "The public works office will begin road repair along the main road starting next week. One lane will be closed during working hours from 8:00 AM to 5:00 PM. Residents are advised to use alternate routes and to follow traffic personnel.",
      image: "././Road Repair.jfif"
    },
    {
      id: generateId(),
      title: "Community Garden Harvests First Crops",
      category: "Community",
      date: daysFromNow(0),
      description: "The community garden project harvested its first vegetables this week.",
      details: "The shared community garden project harvested its first batch of vegetables this week. The harvested produce was distributed to participating families. The community office encourages more residents to join the gardening group.",
      image: "././Community-Garden.webp"
    }
  ];
}

function sampleAnnouncements() {
  return [
    {
      id: generateId(),
      title: "Water Service Interruption on Saturday",
      category: "Public Notice",
      date: daysFromNow(2),
      status: "Important",
      description: "Water service will be paused from 8:00 AM to 2:00 PM for pipe maintenance."
    },
    {
      id: generateId(),
      title: "Barangay Assembly Meeting",
      category: "Community",
      date: daysFromNow(5),
      status: "Upcoming",
      description: "All residents are invited to the quarterly assembly at the community hall."
    },
    {
      id: generateId(),
      title: "Free Medical Mission",
      category: "Health",
      date: daysFromNow(8),
      status: "Active",
      description: "Free check-ups, blood pressure screening, and medicines for all residents."
    },
    {
      id: generateId(),
      title: "School Supplies Distribution",
      category: "Education",
      date: daysFromNow(10),
      status: "Upcoming",
      description: "Elementary students may claim free school supplies at the community office."
    },
    {
      id: generateId(),
      title: "Basketball Tournament Registration",
      category: "Events",
      date: daysFromNow(3),
      status: "Active",
      description: "Team registration for the inter-purok basketball tournament is now open."
    },
    {
      id: generateId(),
      title: "Fire Safety Inspection Schedule",
      category: "Public Notice",
      date: daysFromNow(6),
      status: "Notice",
      description: "Households in Purok 1 to 3 will be visited for fire safety inspection."
    },
    {
      id: generateId(),
      title: "Senior Citizens Monthly Meeting",
      category: "Community",
      date: daysFromNow(12),
      status: "Upcoming",
      description: "Monthly gathering and pension assistance concerns at the senior center."
    },
    {
      id: generateId(),
      title: "Reading Program for Kids",
      category: "Education",
      date: daysFromNow(4),
      status: "Active",
      description: "Free weekend reading sessions for children aged 6 to 10 years old."
    }
  ];
}

function sampleEvents() {
  return [
    {
      id: generateId(),
      name: "Community Clean-Up Drive",
      date: daysFromNow(7),
      time: "7:00 AM",
      location: "Community Plaza",
      description: "Join the monthly clean-up drive. Bring gloves, hats, and reusable water bottles."
    },
    {
      id: generateId(),
      name: "Barangay Sports Fest",
      date: daysFromNow(14),
      time: "3:00 PM",
      location: "Covered Court",
      description: "Basketball, volleyball, and running events for residents of all ages."
    },
    {
      id: generateId(),
      name: "Health and Wellness Fair",
      date: daysFromNow(21),
      time: "8:00 AM",
      location: "Health Center",
      description: "Free medical check-ups, dental missions, and health talks for the community."
    },
    {
      id: generateId(),
      name: "Youth Leadership Workshop",
      date: daysFromNow(28),
      time: "9:00 AM",
      location: "Youth Center",
      description: "A one-day workshop on leadership, teamwork, and community service."
    },
    {
      id: generateId(),
      name: "Community Christmas Party",
      date: daysFromNow(73),
      time: "5:00 PM",
      location: "Community Hall",
      description: "Year-end celebration with games, food, and gifts for children."
    }
  ];
}

function sampleActivities() {
  return [
    {
      id: generateId(),
      name: "Community Clean-Up Drive",
      date: daysFromNow(-10),
      location: "Community Plaza",
      description: "Residents worked together to clean the plaza and surrounding streets.",
      image: "././Cleanup-drive-1024x682.webp"
    },
    {
      id: generateId(),
      name: "Youth Leadership Activity",
      date: daysFromNow(-8),
      location: "Youth Center",
      description: "Young leaders joined team-building games and community planning talks.",
      image: "././Youth Leadership Activity.jfif"
    },
    {
      id: generateId(),
      name: "Inter-Purok Sports Activity",
      date: daysFromNow(-6),
      location: "Covered Court",
      description: "Friendly basketball matches among teams from different puroks.",
      image: "././Inter-Purok Sports Activity.jfif"
    },
    {
      id: generateId(),
      name: "Educational Tutorial Program",
      date: daysFromNow(-4),
      location: "Elementary School",
      description: "Volunteer teachers gave free reading and math tutorials for kids.",
      image: "././Educational Tutorial Program.jpg"
    },
    {
      id: generateId(),
      name: "Volunteer Tree Planting",
      date: daysFromNow(-2),
      location: "Riverside Area",
      description: "Volunteers planted 150 seedlings along the riverbank.",
      image: "././Volunteer Tree Planting.webp"
    },
    {
      id: generateId(),
      name: "Environmental Recycling Drive",
      date: daysFromNow(0),
      location: "Community Hall",
      description: "Residents turned over recyclable waste for the segregation program.",
      image: "././Environmental Recycling Drive.webp"
    }
  ];
}

function sampleGallery() {
  return [
    { id: generateId(), image: "././community-01.jpg", caption: "Community Plaza", date: daysFromNow(-12) },
    { id: generateId(), image: "././community-02.jpg", caption: "Residents Assembly", date: daysFromNow(-10) },
    { id: generateId(), image: "././Cleanup-drive-1024x682.webp", caption: "Clean-Up Drive", date: daysFromNow(-8) },
    { id: generateId(), image: "././Cleanup-drive-1024x682.webp", caption: "Volunteers at Work", date: daysFromNow(-6) },
    { id: generateId(), image: "././New Health Center Now Open for Residents.jfif", caption: "Health Center Visit", date: daysFromNow(-4) },
    { id: generateId(), image: "././Youth Sports League Kicks Off This Month.jfif", caption: "Youth Sports Activity", date: daysFromNow(-2) }
  ];
}

/* ------------------------------------------------------------
   3. LOAD DATA (seed sample data the first time)
   ------------------------------------------------------------ */

// Load a list from LocalStorage. If nothing is saved yet,
// save the sample data so the Admin can also see and edit it.
function loadList(key, sampleFunction) {
  var stored = localStorage.getItem(key);
  if (stored === null) {
    var sample = sampleFunction();
    setData(key, sample);
    return sample;
  }
  var list = getData(key, []);
  return list;
}

// Sort key for "latest first": prefer createdAt, fall back to date.
function postTime(item) {
  var t = Date.parse(item && item.createdAt ? item.createdAt : "");
  if (!isNaN(t)) return t;
  var d = Date.parse(item && item.date ? item.date + "T00:00:00" : "");
  return isNaN(d) ? 0 : d;
}

// Featured (pinned) news always appears first everywhere on the site,
// and within each group the newest posts come first.
function loadNewsList() {
  var list = loadList("communityNews", sampleNews);
  list.sort(function (a, b) {
    var pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return pin !== 0 ? pin : postTime(b) - postTime(a);
  });
  return list;
}
function loadAnnouncementsList() {
  var list = loadList("communityAnnouncements", sampleAnnouncements);
  list.sort(function (a, b) { return postTime(b) - postTime(a); });
  return list;
}
function loadEventsList() { return loadList("communityEvents", sampleEvents); }
function loadActivitiesList() {
  var list = loadList("communityActivities", sampleActivities);
  list.sort(function (a, b) { return postTime(b) - postTime(a); });
  return list;
}
function loadGalleryList() { return loadList("communityGallery", sampleGallery); }

/* ------------------------------------------------------------
   4. MOBILE NAVIGATION
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   5b. MOBILE VIEW (public bottom tab bar + dashboard drawers)
   ------------------------------------------------------------ */

// The header hamburger and the bottom-bar MENU button share this.
function togglePublicNav(open) {  var nav = document.getElementById("mainNav");
  if (!nav) return;
  var next = typeof open === "boolean" ? open : !nav.classList.contains("open");
  nav.classList.toggle("open", next);
  ["navToggle", "bottomNavMenu"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute("aria-expanded", next ? "true" : "false");
  });
}

(function initMobileNav() {
  var toggle = document.getElementById("navToggle");
  var nav = document.getElementById("mainNav");
  if (toggle && nav) {
    toggle.setAttribute("aria-controls", "mainNav");
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () { togglePublicNav(); });
    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) togglePublicNav(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("open")) {
        togglePublicNav(false);
        toggle.focus();
      }
    });
  }
})();

// Inline SVG icons for the bottom tab bar
function bottomNavIcon(name) {
  var icons = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    news: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    (icons[name] || "") + "</svg>";
}

// Main destinations reachable with one thumb on a phone
var BOTTOM_NAV_ITEMS = [
  { href: "index.html", label: "HOME", icon: "home",
    pages: ["", "index.html", "about.html", "contact.html", "search.html", "news-ai.html", "hotlines.html"] },
  { href: "news.html", label: "NEWS", icon: "news", pages: ["news.html"] },
  { href: "announcements.html", label: "ALERTS", icon: "bell", pages: ["announcements.html"] },
  { href: "events.html", label: "EVENTS", icon: "calendar",
    pages: ["events.html", "activities.html", "gallery.html"] }
];

// Build (or rebuild) the bottom tab bar on public pages only
function renderBottomNav() {
  if (!document.querySelector(".site-header")) return;
  var nav = document.getElementById("bottomNav");
  if (!nav) {
    nav = document.createElement("nav");
    nav.id = "bottomNav";
    nav.className = "bottom-nav";
    nav.setAttribute("aria-label", "Quick navigation");
    document.body.appendChild(nav);
    document.body.classList.add("has-bottom-nav");
  }
  var page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (!page) page = "index.html";
  var html = BOTTOM_NAV_ITEMS.map(function (item) {
    var active = item.pages.indexOf(page) >= 0;
    return '<a class="bottom-nav-item' + (active ? " active" : "") + '" href="' + item.href + '"' +
      (active ? ' aria-current="page"' : "") + ">" + bottomNavIcon(item.icon) +
      "<span>" + t(item.label) + "</span></a>";
  }).join("");
  html += '<button class="bottom-nav-item" id="bottomNavMenu" type="button" ' +
    'aria-controls="mainNav" aria-expanded="false">' + bottomNavIcon("menu") +
    "<span>" + t("MENU") + "</span></button>";
  nav.innerHTML = html;
  var menuBtn = document.getElementById("bottomNavMenu");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () { togglePublicNav(); });
  }
}

/* ---- Dashboard slide-in drawer (shared by admin + member) ---- */
function setSidebarDrawerOpen(open) {
  var sidebar = document.getElementById("adminSidebar") || document.getElementById("userSidebar");
  if (!sidebar) return;
  var toggle = document.getElementById("adminNavToggle") || document.getElementById("userNavToggle");
  var backdrop = document.getElementById("sidebarBackdrop");
  sidebar.classList.toggle("open", !!open);
  if (backdrop) backdrop.classList.toggle("show", !!open);
  document.body.classList.toggle("drawer-open", !!open);
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeSidebarDrawer() { setSidebarDrawerOpen(false); }

function initMobileDrawer() {
  var sidebar = document.getElementById("adminSidebar") || document.getElementById("userSidebar");
  var toggle = document.getElementById("adminNavToggle") || document.getElementById("userNavToggle");
  if (!sidebar || !toggle || sidebar.dataset.drawerReady === "1") return;
  sidebar.dataset.drawerReady = "1";

  toggle.setAttribute("aria-controls", sidebar.id);
  toggle.setAttribute("aria-expanded", "false");

  var backdrop = document.getElementById("sidebarBackdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    backdrop.id = "sidebarBackdrop";
    document.body.appendChild(backdrop);
  }

  toggle.addEventListener("click", function () {
    setSidebarDrawerOpen(!sidebar.classList.contains("open"));
  });

  backdrop.addEventListener("click", closeSidebarDrawer);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && sidebar.classList.contains("open")) {
      closeSidebarDrawer();
      toggle.focus();
    }
  });

  // Choosing a section closes the drawer (the section handler runs separately)
  sidebar.addEventListener("click", function (event) {
    if (event.target.closest("a")) closeSidebarDrawer();
  });

  // Swipe the drawer left to dismiss it
  var startX = null;
  sidebar.addEventListener("touchstart", function (event) {
    startX = event.touches.length === 1 ? event.touches[0].clientX : null;
  }, { passive: true });
  sidebar.addEventListener("touchend", function (event) {
    if (startX === null) return;
    var endX = event.changedTouches && event.changedTouches[0]
      ? event.changedTouches[0].clientX : startX;
    if (endX - startX < -45) closeSidebarDrawer();
    startX = null;
  }, { passive: true });

  // Never leave it open when the viewport grows back to desktop
  window.addEventListener("resize", function () {
    if (window.innerWidth > 768 && sidebar.classList.contains("open")) closeSidebarDrawer();
  });
}

// Keep keyboard focus inside an open modal (detail, confirm, lightbox)
document.addEventListener("keydown", function (event) {
  if (event.key !== "Tab") return;
  var modalEl = null;
  ["detailModal", "confirmModal", "lightbox"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.classList.contains("open")) modalEl = el;
  });
  if (!modalEl) return;
  var container = modalEl.querySelector(".modal") || modalEl;
  var focusables = container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])');
  if (!focusables.length) return;
  var first = focusables[0];
  var last = focusables[focusables.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

/* ------------------------------------------------------------
   5. HOME PAGE - RENDER LATEST CONTENT
   ------------------------------------------------------------ */

// News card used on the home page
function renderNewsCard(item) {
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
  var featured = item.pinned ? '<span class="badge badge-featured">' + t("FEATURED") + '</span>' : '';
  return '<article class="card">' +
    media +
    '<div class="card-body">' +
    '<p class="meta"><span class="badge">' + t(item.category) + '</span> ' + formatDate(item.date) +
    (item.pinned ? ' ' + featured : '') + '</p>' +
    '<h3>' + escapeHtml(item.title) + '</h3>' +
    '<p>' + escapeHtml(shortText(item.description, NEWS_PREVIEW_LIMIT)) + '</p>' +
    '<a href="news.html" class="btn btn-small">READ MORE</a>' +
    '</div>' +
    '</article>';
}

// Announcement row used on the home page
function renderAnnouncementRow(item) {
  var statusClass = "badge";
  if (item.status === "Important" || item.status === "Emergency") statusClass = "badge-red";
  else if (item.status === "Active") statusClass = "badge-green";
  else if (item.status === "Upcoming") statusClass = "badge-orange";
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });

  return '<div class="list-item">' +
    '<div class="item-content">' +
    '<p class="meta"><span class="badge">' + t(item.category) + '</span> ' +
    formatDate(item.date) + ' &nbsp; <span class="' + statusClass + '">' + t(item.status) + '</span></p>' +
    '<h3>' + escapeHtml(item.title) + '</h3>' +
    '<p class="item-desc">' + escapeHtml(shortText(item.description, ANNOUNCEMENT_PREVIEW_LIMIT)) + '</p>' +
    media +
    '<div class="item-actions">' +
    '<a href="announcements.html" class="btn btn-small">' + t("VIEW DETAILS") + '</a>' +
    '</div>' +
    '</div>' +
    '</div>';
}

// Event card used on the home page
function renderEventCard(item) {
  return '<article class="card">' +
    '<div class="card-body">' +
    '<p class="meta"><span class="badge">EVENT</span> ' + formatDate(item.date) + '</p>' +
    '<h3>' + escapeHtml(item.name) + '</h3>' +
    '<p class="detail-row"><strong>' + t("Time:") + '</strong> ' + escapeHtml(item.time) + '</p>' +
    '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
    '<p>' + escapeHtml(shortText(item.description, EVENT_PREVIEW_LIMIT)) + '</p>' +
    '<a href="events.html" class="btn btn-small">' + t("VIEW DETAILS") + '</a>' +
    '</div>' +
    '</article>';
}

// Activity card used on the home page
function renderActivityCard(item) {
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
  return '<article class="card">' +
    media +
    '<div class="card-body">' +
    '<p class="meta">' + formatDate(item.date) + '</p>' +
    '<h3>' + escapeHtml(item.name) + '</h3>' +
    '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
    '<p>' + escapeHtml(shortText(item.description, ACTIVITY_PREVIEW_LIMIT)) + '</p>' +
    '</div>' +
    '</article>';
}

// Fill the home page sections (only if the elements exist)
function renderHomePage() {
  var newsBox = document.getElementById("homeLatestNews");
  if (newsBox) {
    var news = loadNewsList().slice(0, 3);
    newsBox.innerHTML = news.map(renderNewsCard).join("");
    resolveVideoRefs(newsBox);
  }

  var annBox = document.getElementById("homeAnnouncements");
  if (annBox) {
    var anns = loadAnnouncementsList()
      .filter(function (a) { return a.status === "Important" || a.status === "Active" || a.status === "Emergency"; })
      .slice(0, 4);
    if (anns.length === 0) anns = loadAnnouncementsList().slice(0, 4);
    annBox.innerHTML = anns.map(renderAnnouncementRow).join("");
    resolveVideoRefs(annBox);
  }

  var eventBox = document.getElementById("homeEvents");
  if (eventBox) {
    eventBox.innerHTML = loadEventsList().slice(0, 3).map(renderEventCard).join("");
  }

  var actBox = document.getElementById("homeActivities");
  if (actBox) {
    actBox.innerHTML = loadActivitiesList().slice(0, 3).map(renderActivityCard).join("");
    resolveVideoRefs(actBox);
  }
}

renderHomePage();

/* ------------------------------------------------------------
   6. DETAIL MODAL (shared pop-up for viewing full details)
   ------------------------------------------------------------ */

// Create the modal once and reuse it on every page
function getDetailModal() {
  var modal = document.getElementById("detailModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "detailModal";
    modal.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="detailModalTitle">' +
        '<div class="modal-header">' +
          '<h3 id="detailModalTitle">Details</h3>' +
          '<button class="modal-close" id="detailModalClose" type="button" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="modal-body" id="detailModalBody"></div>' +
        '<div class="modal-footer">' +
          '<button class="btn" id="detailModalOk" type="button">CLOSE</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    refreshDetailModalLabels();

    // Close when clicking X, CLOSE button, or the dark background
    document.getElementById("detailModalClose").addEventListener("click", closeDetailModal);
    document.getElementById("detailModalOk").addEventListener("click", closeDetailModal);
    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeDetailModal();
    });
  }
  return modal;
}

// Keep the detail modal's button labels in the current language
function refreshDetailModalLabels() {
  var btn = document.getElementById("detailModalOk");
  if (btn) btn.textContent = t("CLOSE");
}

// Show a detail modal with a title, meta line, and full body text
function openDetailModal(title, metaHtml, bodyHtml) {
  var modal = getDetailModal();
  refreshDetailModalLabels();
  document.getElementById("detailModalTitle").textContent = title;
  document.getElementById("detailModalBody").innerHTML =
    '<p class="meta">' + metaHtml + '</p>' +
    '<div class="detail-modal-body">' + bodyHtml + '</div>';
  resolveVideoRefs(document.getElementById("detailModalBody"));
  modal.classList.add("open");
  lastFocused = document.activeElement;
  var closeBtn = document.getElementById("detailModalClose");
  if (closeBtn) closeBtn.focus();
}

function closeDetailModal() {
  var modal = document.getElementById("detailModal");
  if (modal && modal.classList.contains("open")) {
    modal.classList.remove("open");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }
}

// Close any open modal with the ESC key
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    closeDetailModal();
    if (typeof closeConfirmModal === "function") closeConfirmModal();
  }
});

/* ------------------------------------------------------------
   7. NEWS PAGE - LIST AND SEARCH
   ------------------------------------------------------------ */

// Wrap search matches in <mark> so results visibly highlight
function highlightText(text, query) {
  var safe = escapeHtml(String(text == null ? "" : text));
  if (!query) return safe;
  var q = escapeHtml(query);
  if (!q) return safe;
  var re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return safe.replace(re, '<mark class="hl">$1</mark>');
}

var newsQuery = "";

// Save the news search/filter state into the URL hash so it can be shared
function syncNewsUrl() {
  var params = new URLSearchParams();
  var qEl = document.getElementById("newsSearch");
  var catEl = document.getElementById("newsCatFilter");
  var dateEl = document.getElementById("newsDateFilter");
  var q = qEl ? (qEl.value || "").trim() : "";
  var cat = catEl ? catEl.value : "All";
  var date = dateEl ? dateEl.value : "all";
  if (q) params.set("q", q);
  if (cat && cat !== "All") params.set("cat", cat);
  if (date && date !== "all") params.set("date", date);
  var s = params.toString();
  try {
    history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : "#"));
  } catch (e) {
    location.hash = s;
  }
}

// Load filter state from the URL hash (or ?q=... query string)
function readNewsUrl() {
  var raw = "";
  if (location.hash.length > 1) raw = location.hash.slice(1);
  else if (location.search.length > 1) raw = location.search.slice(1);
  if (!raw) return;
  var params = new URLSearchParams(raw);
  var q = params.get("q") || "";
  var cat = params.get("cat") || "";
  var date = params.get("date") || "";
  var qEl = document.getElementById("newsSearch");
  var catEl = document.getElementById("newsCatFilter");
  var dateEl = document.getElementById("newsDateFilter");
  if (q && qEl) qEl.value = q;
  if (cat && catEl) catEl.value = cat;
  if (date && dateEl) dateEl.value = date;
}

// Show the full details of one news item
function showNewsDetails(id) {
  var news = loadNewsList();
  var item = news.find(function (n) { return n.id === id; });
  if (!item) return;
  recordNewsView(id);
  var meta = '<span class="badge">' + escapeHtml(item.category) + '</span> ' + formatDate(item.date) +
             ' &nbsp;<span class="meta-stat">' + getViewCount(id) + ' ' + t("views") + '</span>';
  var media = newsMediaHtml(item, {
    wrapClass: "detail-media",
    imgClass: "detail-media-img",
    vidClass: "detail-media-video"
  });
  var body =
    (media ? media : '') +
    '<p>' + escapeHtml(item.details || item.description) + '</p>' +
    renderCommentsHtml(item.id);
  openDetailModal(item.title, meta, body);
}

// ---- Load more pagination (news + announcements) ----
// Insert a LOAD MORE button right after the given list
function attachLoadMore(listBox, total, visibleCount, onMore) {
  var old = listBox.parentNode.querySelector(".btn-load-more");
  if (old) old.remove();
  if (total <= visibleCount) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-load-more";
  btn.textContent = t("LOAD MORE") + " (" + (total - visibleCount) + " " + t("left") + ")";
  btn.addEventListener("click", onMore);
  listBox.parentNode.insertBefore(btn, listBox.nextSibling);
}

// Show/hide a page's empty-state box and pick the right message:
// a search that matched nothing vs a list with nothing in it yet.
function setEmptyState(emptyBox, hasItems, filtered, filteredMsg, emptyMsg) {
  if (!emptyBox) return;
  emptyBox.style.display = hasItems ? "none" : "block";
  if (hasItems) return;
  var p = emptyBox.querySelector("p");
  if (!p) return;
  var key = filtered ? filteredMsg : emptyMsg;
  p.dataset.en = key; // keep the language walker in sync with the new English original
  p.textContent = currentLang === "fil" ? (I18N_MAP[key] || key) : key;
}

// Draw the news list (used on first load and while searching)
function drawNewsList(items, filtered) {
  var listBox = document.getElementById("newsList");
  var emptyBox = document.getElementById("newsEmpty");
  var countBox = document.getElementById("newsCount");
  if (!listBox) return;

  listBox.innerHTML = items.slice(0, newsVisible).map(function (n) {
    return renderNewsFeedCard(n, { query: newsQuery });
  }).join("");
  resolveVideoRefs(listBox);
  setEmptyState(emptyBox, items.length > 0, !!filtered,
    "No news found. Please try another search.", "No community news posted yet.");
  if (countBox) countBox.textContent = items.length + " " + t("news found");
  attachLoadMore(listBox, items.length, newsVisible, function () {
    newsVisible += PAGE_SIZE;
    drawNewsList(items, filtered);
  });
}

// Search news by title, category, or description + category/date filters.
// Returns the filtered list (does not touch the DOM).
function filterNewsItems() {
  var qEl = document.getElementById("newsSearch");
  var catEl = document.getElementById("newsCatFilter");
  var dateEl = document.getElementById("newsDateFilter");
  var keyword = (qEl && qEl.value ? qEl.value : "").toLowerCase().trim();
  var cat = catEl ? catEl.value : "All";
  var dateRange = dateEl ? dateEl.value : "all";
  newsQuery = keyword;

  var cutoff = "";
  if (dateRange === "7" || dateRange === "30") {
    var d = new Date();
    d.setDate(d.getDate() - Number(dateRange));
    cutoff = d.toISOString().slice(0, 10);
  }
  var yearPrefix = new Date().getFullYear() + "-";

  var items = loadNewsList().filter(function (n) {
    var hay = (n.title + " " + n.category + " " + (n.description || "")).toLowerCase();
    if (keyword && hay.indexOf(keyword) === -1) return false;
    if (cat && cat !== "All" && n.category !== cat) return false;
    if (cutoff && (n.date || "") < cutoff) return false;
    if (dateRange === "year" && (n.date || "").indexOf(yearPrefix) !== 0) return false;
    return true;
  });
  return items;
}

// Apply the filtered news list to the page (DOM only).
function drawFilteredNews(items, filtered) {
  syncNewsUrl();
  drawNewsList(items, filtered);
}

// Search news: filter then draw. Kept as one entry point for event handlers.
function filterNews() {
  newsVisible = PAGE_SIZE;
  var items = filterNewsItems();
  var qEl = document.getElementById("newsSearch");
  var catEl = document.getElementById("newsCatFilter");
  var dateEl = document.getElementById("newsDateFilter");
  var keyword = (qEl && qEl.value ? qEl.value : "").toLowerCase().trim();
  var cat = catEl ? catEl.value : "All";
  var dateRange = dateEl ? dateEl.value : "all";
  var filtered = !!keyword || (cat && cat !== "All") || dateRange !== "all";
  drawFilteredNews(items, filtered);
}

function initNewsPage() {
  var listBox = document.getElementById("newsList");
  if (!listBox) return;
  readNewsUrl();
  var search = document.getElementById("newsSearch");
  if (search) search.addEventListener("input", filterNews);
  var catEl = document.getElementById("newsCatFilter");
  if (catEl) catEl.addEventListener("change", filterNews);
  var dateEl = document.getElementById("newsDateFilter");
  if (dateEl) dateEl.addEventListener("change", filterNews);
  filterNews();
}

initNewsPage();

/* ------------------------------------------------------------
   8. ANNOUNCEMENTS PAGE - LIST AND CATEGORY FILTER
   ------------------------------------------------------------ */

// Return the CSS class for a status badge color
function statusBadgeClass(status) {
  if (status === "Important") return "badge-red";
  if (status === "Active") return "badge-green";
  if (status === "Upcoming") return "badge-orange";
  if (status === "Emergency") return "badge-emergency";
  return "badge";
}

// One announcement row for the announcements page
function renderAnnouncementPageRow(item) {
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
  return '' +
    '<div class="list-item">' +
      '<div class="item-content">' +
        '<p class="meta"><span class="badge">' + highlightText(t(item.category), annQuery) + '</span> ' +
          formatDate(item.date) + ' &nbsp; <span class="' + statusBadgeClass(item.status) + '">' +
          t(item.status) + '</span></p>' +
        '<h3>' + highlightText(item.title, annQuery) + '</h3>' +
        '<p class="item-desc">' + highlightText(shortText(item.description, 180), annQuery) + '</p>' +
        media +
        '<div class="item-actions">' +
          '<button class="btn btn-small btn-like' + (hasLikedNews(item.id) ? " liked" : "") + '" type="button" data-like-news="' + item.id + '" aria-pressed="' + (hasLikedNews(item.id) ? "true" : "false") + '" onclick="toggleNewsLike(\'' + item.id + '\')">' +
            '<span data-like-count="' + item.id + '">' + getNewsLikeCount(item.id) + ' ' + t("likes") + '</span></button>' +
          '<button class="btn btn-small btn-details" type="button" onclick="showAnnouncementDetails(\'' + item.id + '\')">' + t("VIEW DETAILS") + '</button>' +
          '<button class="btn btn-small btn-save' + (isCurrentSaved("announcement", item.id) ? " saved" : "") + '" type="button" data-save-ann="' + item.id + '" onclick="toggleBookmark(\'announcement\',\'' + item.id + '\', this)">' +
            t(bookmarkBtnLabel("announcement", item.id)) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

// Show full announcement details in the modal
function showAnnouncementDetails(id) {
  var list = loadAnnouncementsList();
  var item = list.find(function (a) { return a.id === id; });
  if (!item) return;
  var meta = '<span class="badge">' + escapeHtml(item.category) + '</span> ' +
             formatDate(item.date) + ' &nbsp; <span class="' + statusBadgeClass(item.status) + '">' +
             escapeHtml(item.status) + '</span>';
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
  openDetailModal(item.title, meta, media + '<p>' + escapeHtml(item.description) + '</p>' +
    renderCommentsHtml(item.id, "announcement"));
}

// Draw the announcements list
function drawAnnouncementsList(items, filtered) {
  var listBox = document.getElementById("announcementsList");
  var emptyBox = document.getElementById("announcementsEmpty");
  if (!listBox) return;
  listBox.innerHTML = items.slice(0, annVisible).map(renderAnnouncementPageRow).join("");
  resolveVideoRefs(listBox);
  setEmptyState(emptyBox, items.length > 0, !!filtered,
    "No announcements found. Please try another search.", "No community announcements posted yet.");
  attachLoadMore(listBox, items.length, annVisible, function () {
    annVisible += PAGE_SIZE;
    drawAnnouncementsList(items, filtered);
  });
}

// Filter announcements by selected category and keyword. Returns the list (no DOM).
function filterAnnouncementsItems(category) {
  var items = loadAnnouncementsList();
  if (category && category !== "All") {
    items = items.filter(function (a) { return a.category === category; });
  }
  var qEl = document.getElementById("annSearch");
  var keyword = (qEl && qEl.value ? qEl.value : "").toLowerCase().trim();
  annQuery = keyword;
  if (keyword) {
    items = items.filter(function (a) {
      var hay = (a.title + " " + a.category + " " + (a.description || "") + " " + (a.status || "")).toLowerCase();
      return hay.indexOf(keyword) !== -1;
    });
  }
  return { items: items, keyword: keyword, category: category };
}

// Apply the filtered announcements list to the page (DOM only).
function drawFilteredAnnouncements(result) {
  var countBox = document.getElementById("annCount");
  if (countBox) countBox.textContent = result.items.length + " " + t("announcements found");
  syncAnnUrl();
  var annFiltered = (!!result.keyword) || (result.category && result.category !== "All");
  drawAnnouncementsList(result.items, annFiltered);
}

// Filter announcements by selected category. Entry point for UI events.
function filterAnnouncements(category) {
  annVisible = PAGE_SIZE;
  var result = filterAnnouncementsItems(category);
  drawFilteredAnnouncements(result);
}

// Save the announcement search into the URL hash so it can be shared
function syncAnnUrl() {
  var params = new URLSearchParams();
  var qEl = document.getElementById("annSearch");
  var q = qEl ? (qEl.value || "").trim() : "";
  var active = document.querySelector("#annFilters .filter-btn.active");
  var cat = active ? active.getAttribute("data-category") : "All";
  if (q) params.set("q", q);
  if (cat && cat !== "All") params.set("cat", cat);
  var s = params.toString();
  try {
    history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : "#"));
  } catch (e) {
    location.hash = s;
  }
}

// Load the announcement search state from the URL
function readAnnUrl() {
  var raw = "";
  if (location.hash.length > 1) raw = location.hash.slice(1);
  else if (location.search.length > 1) raw = location.search.slice(1);
  if (!raw) return;
  var params = new URLSearchParams(raw);
  var q = params.get("q") || "";
  var cat = params.get("cat") || "";
  var qEl = document.getElementById("annSearch");
  if (q && qEl) qEl.value = q;
  if (cat) {
    var button = document.querySelector('#annFilters .filter-btn[data-category="' + cat.replace(/"/g, "") + '"]');
    if (button) {
      document.querySelectorAll("#annFilters .filter-btn").forEach(function (b) { b.classList.remove("active"); });
      button.classList.add("active");
    }
  }
}

function initAnnouncementsPage() {
  var listBox = document.getElementById("announcementsList");
  if (!listBox) return;
  readAnnUrl();
  filterAnnouncements(
    (document.querySelector("#annFilters .filter-btn.active") || {}).getAttribute
      ? document.querySelector("#annFilters .filter-btn.active").getAttribute("data-category") : "All");

  var search = document.getElementById("annSearch");
  if (search) search.addEventListener("input", function () {
    filterAnnouncements(
      (document.querySelector("#annFilters .filter-btn.active") || {}).getAttribute
        ? document.querySelector("#annFilters .filter-btn.active").getAttribute("data-category") : "All");
  });

  var filterBox = document.getElementById("annFilters");
  if (filterBox) {
    filterBox.addEventListener("click", function (event) {
      var button = event.target.closest(".filter-btn");
      if (!button) return;
      var buttons = filterBox.querySelectorAll(".filter-btn");
      buttons.forEach(function (b) { b.classList.remove("active"); });
      button.classList.add("active");
      filterAnnouncements(button.getAttribute("data-category"));
    });
  }
}

initAnnouncementsPage();

/* ------------------------------------------------------------
   9. EVENTS PAGE - LIST AND COUNTDOWN
   ------------------------------------------------------------ */

// One event card with a live countdown
function renderEventPageCard(item) {
  var going = rsvpCount(item.id);
  var mine = isGoing(item.id);
  return '' +
    '<article class="card">' +
      '<div class="card-body">' +
        '<p class="meta"><span class="badge">EVENT</span> ' + formatDate(item.date) +
          ' &nbsp;<span class="meta-stat">' + going + ' ' + t("going") + '</span></p>' +
        '<h3>' + escapeHtml(item.name) + '</h3>' +
        '<p class="detail-row"><strong>' + t("Time:") + '</strong> ' + escapeHtml(item.time) + '</p>' +
        '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
        '<p>' + escapeHtml(shortText(item.description, 110)) + '</p>' +
        '<div class="countdown" data-event-date="' + escapeHtml(item.date) + '">' +
          '<div class="countdown-box"><span class="number" data-unit="days">--</span><span class="label">Days</span></div>' +
          '<div class="countdown-box"><span class="number" data-unit="hours">--</span><span class="label">Hours</span></div>' +
          '<div class="countdown-box"><span class="number" data-unit="minutes">--</span><span class="label">Mins</span></div>' +
          '<div class="countdown-box"><span class="number" data-unit="seconds">--</span><span class="label">Secs</span></div>' +
        '</div>' +
        '<div class="item-actions">' +
          '<button class="btn btn-small" type="button" onclick="showEventDetails(\'' + item.id + '\')">' + t("VIEW DETAILS") + '</button>' +
          '<button class="btn btn-small btn-going' + (mine ? " active" : "") + '" type="button" data-rsvp="' + item.id + '" onclick="toggleRsvp(\'' + item.id + '\', this)">' +
            (mine ? t("YOU'RE GOING") : t("I'M GOING")) + ' (' + going + ')</button>' +
        '</div>' +
      '</div>' +
    '</article>';
}

// Show full event details in the modal
function showEventDetails(id) {
  var list = loadEventsList();
  var item = list.find(function (e) { return e.id === id; });
  if (!item) return;
  var meta = '<span class="badge">' + t("EVENT") + '</span> ' + formatDate(item.date);
  var body =
    '<p class="detail-row"><strong>' + t("Time:") + '</strong> ' + escapeHtml(item.time) + '</p>' +
    '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
    '<p class="mt-20">' + escapeHtml(item.description) + '</p>';
  openDetailModal(item.name, meta, body);
}

// Update every countdown box on the page
function updateCountdowns() {
  var boxes = document.querySelectorAll(".countdown[data-event-date]");
  boxes.forEach(function (box) {
    var dateStr = box.getAttribute("data-event-date");
    var target = new Date(dateStr + "T00:00:00").getTime();
    var now = new Date().getTime();
    var gap = target - now;

if (gap <= 0) {
box.innerHTML = '<span class="countdown-done">' + t("This event has started or already passed.") + '</span>';
return;
}

    var days = Math.floor(gap / (1000 * 60 * 60 * 24));
    var hours = Math.floor((gap % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    var minutes = Math.floor((gap % (1000 * 60 * 60)) / (1000 * 60));
    var seconds = Math.floor((gap % (1000 * 60)) / 1000);

    var values = { days: days, hours: hours, minutes: minutes, seconds: seconds };
    Object.keys(values).forEach(function (unit) {
      var el = box.querySelector('[data-unit="' + unit + '"]');
      if (el) el.textContent = values[unit];
    });
  });
}

/* ------------------------------------------------------------
   9b. EVENTS PAGE - LIST / CALENDAR VIEW SWITCH
   ------------------------------------------------------------ */

var eventsCalState = null;

function initEventsCalendar() {
  var calBox = document.getElementById("eventsCalendar");
  if (!calBox) return;

  var now = new Date();
  if (!eventsCalState) {
    eventsCalState = { view: "list", year: now.getFullYear(), month: now.getMonth() };
  }

  var toggle = document.getElementById("eventsViewToggle");
  if (toggle) {
    toggle.addEventListener("click", function (event) {
      var btn = event.target.closest(".filter-btn");
      if (!btn) return;
      setEventsView(btn.getAttribute("data-view"));
    });
  }

  var prev = document.getElementById("calPrev");
  var next = document.getElementById("calNext");
  var today = document.getElementById("calToday");
  if (prev) {
    prev.setAttribute("aria-label", t("Previous month"));
    prev.addEventListener("click", function () { shiftEventsMonth(-1); });
  }
  if (next) {
    next.setAttribute("aria-label", t("Next month"));
    next.addEventListener("click", function () { shiftEventsMonth(1); });
  }
  if (today) {
    today.addEventListener("click", function () {
      var d = new Date();
      eventsCalState.year = d.getFullYear();
      eventsCalState.month = d.getMonth();
      renderEventsCalendar();
    });
  }

  var grid = document.getElementById("calGrid");
  if (grid) {
    grid.addEventListener("click", function (event) {
      var chip = event.target.closest(".cal-chip");
      if (chip) showEventDetails(chip.getAttribute("data-id"));
    });
  }

  setEventsView(eventsCalState.view);
}

function setEventsView(view) {
  if (!eventsCalState) return;
  eventsCalState.view = view === "calendar" ? "calendar" : "list";
  var isCal = eventsCalState.view === "calendar";

  var listBox = document.getElementById("eventsList");
  var calBox = document.getElementById("eventsCalendar");
  var emptyBox = document.getElementById("eventsEmpty");
  if (listBox) listBox.classList.toggle("hidden", isCal);
  if (calBox) calBox.classList.toggle("hidden", !isCal);
  if (emptyBox) {
    emptyBox.style.display = isCal ? "none" : (loadEventsList().length === 0 ? "block" : "none");
  }

  document.querySelectorAll("#eventsViewToggle .filter-btn").forEach(function (btn) {
    var active = btn.getAttribute("data-view") === eventsCalState.view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });

  if (isCal) renderEventsCalendar();
}

function shiftEventsMonth(delta) {
  if (!eventsCalState) return;
  var m = eventsCalState.month + delta;
  eventsCalState.year += Math.floor(m / 12);
  eventsCalState.month = ((m % 12) + 12) % 12;
  renderEventsCalendar();
}

// Month grid: weekday header, day cells, up to two event chips per day
function renderEventsCalendar() {
  if (!eventsCalState) return;
  var titleEl = document.getElementById("calTitle");
  var weekEl = document.getElementById("calWeek");
  var gridEl = document.getElementById("calGrid");
  if (!titleEl || !weekEl || !gridEl) return;

  var monthsEn = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var monthsFil = ["Enero", "Pebrero", "Marso", "Abril", "Mayo", "Hunyo",
    "Hulyo", "Agosto", "Setyembre", "Oktubre", "Nobyembre", "Disyembre"];
  var daysEn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var daysFil = ["Lin", "Lun", "Mar", "Miy", "Huw", "Biy", "Sab"];
  var fil = currentLang === "fil";

  titleEl.textContent = (fil ? monthsFil : monthsEn)[eventsCalState.month] + " " + eventsCalState.year;
  weekEl.innerHTML = (fil ? daysFil : daysEn).map(function (d) {
    return "<span>" + d + "</span>";
  }).join("");

  var byDate = {};
  loadEventsList().forEach(function (e) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });

  var y = eventsCalState.year;
  var m = eventsCalState.month;
  var firstDow = new Date(y, m, 1).getDay();
  var daysInMonth = new Date(y, m + 1, 0).getDate();
  var now = new Date();
  var monthStr = ("0" + (m + 1)).slice(-2);

  var html = "";
  var i;
  for (i = 0; i < firstDow; i++) {
    html += '<div class="cal-cell cal-blank" aria-hidden="true"></div>';
  }
  for (var day = 1; day <= daysInMonth; day++) {
    var dayStr = ("0" + day).slice(-2);
    var dateStr = y + "-" + monthStr + "-" + dayStr;
    var evts = byDate[dateStr] || [];
    var isToday = now.getFullYear() === y && now.getMonth() === m && now.getDate() === day;
    html += '<div class="cal-cell' + (isToday ? " cal-today" : "") + '">' +
      '<span class="cal-daynum">' + day + "</span>" +
      evts.slice(0, 2).map(function (e) {
        return '<button type="button" class="cal-chip" data-id="' + escapeHtml(e.id) + '" title="' +
          escapeHtml(e.name) + '">' + escapeHtml(shortText(e.name, 18)) + "</button>";
      }).join("") +
      (evts.length > 2 ? '<span class="cal-more">+' + (evts.length - 2) + "</span>" : "") +
      "</div>";
  }
  var tail = (7 - ((firstDow + daysInMonth) % 7)) % 7;
  for (i = 0; i < tail; i++) {
    html += '<div class="cal-cell cal-blank" aria-hidden="true"></div>';
  }
  gridEl.innerHTML = html;
}

function initEventsPage() {
  var listBox = document.getElementById("eventsList");
  if (!listBox) return;
  var items = loadEventsList();
  listBox.innerHTML = items.map(renderEventPageCard).join("");
  var emptyBox = document.getElementById("eventsEmpty");
  if (emptyBox) emptyBox.style.display = items.length === 0 ? "block" : "none";
  updateCountdowns();
  setInterval(updateCountdowns, 1000);
  initEventsCalendar();
}

initEventsPage();

/* ------------------------------------------------------------
   10. ACTIVITIES PAGE
   ------------------------------------------------------------ */

// One activity card
function renderActivityPageCard(item) {
  var media = newsMediaHtml(item, { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
  return '' +
    '<article class="card">' +
      media +
      '<div class="card-body">' +
        '<p class="meta"><span class="badge">ACTIVITY</span> ' + formatDate(item.date) + '</p>' +
        '<h3>' + escapeHtml(item.name) + '</h3>' +
        '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
        '<p>' + escapeHtml(shortText(item.description, 110)) + '</p>' +
        '<div class="item-actions">' +
          '<button class="btn btn-small" type="button" onclick="showActivityDetails(\'' + item.id + '\')">' + t("VIEW DETAILS") + '</button>' +
        '</div>' +
      '</div>' +
    '</article>';
}

// Show full activity details in the modal
function showActivityDetails(id) {
  var list = loadActivitiesList();
  var item = list.find(function (a) { return a.id === id; });
  if (!item) return;
  var meta = '<span class="badge">' + t("ACTIVITY") + '</span> ' + formatDate(item.date);
  var media = newsMediaHtml(item, {
    wrapClass: "detail-media-wrap",
    imgClass: "detail-media",
    vidClass: "detail-media-video"
  });
  var body =
    (media ? '<div style="margin-bottom:12px;border-radius:4px;overflow:hidden;">' + media + '</div>' : '') +
    '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(item.location) + '</p>' +
    '<p class="mt-20">' + escapeHtml(item.description) + '</p>' +
    renderCommentsHtml(item.id, "activity");
  openDetailModal(item.name, meta, body);
}

function initActivitiesPage() {
  var listBox = document.getElementById("activitiesList");
  if (!listBox) return;
  var items = loadActivitiesList();
  listBox.innerHTML = items.map(renderActivityPageCard).join("");
  resolveVideoRefs(listBox);
  var emptyBox = document.getElementById("activitiesEmpty");
  if (emptyBox) emptyBox.style.display = items.length === 0 ? "block" : "none";
}

initActivitiesPage();

/* ------------------------------------------------------------
   11. GALLERY PAGE AND IMAGE LIGHTBOX
   ------------------------------------------------------------ */

var galleryItems = [];   // list currently shown on the page
var lightboxIndex = 0;   // which photo is open

// One gallery thumbnail
function renderGalleryItem(item, index) {
  return '' +
    '<figure class="gallery-item" data-index="' + index + '">' +
      '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.caption) + '">' +
      '<figcaption class="caption">' + escapeHtml(item.caption) + '<br>' +
        '<small>' + formatDate(item.date) + '</small></figcaption>' +
    '</figure>';
}

// Show one photo inside the lightbox
function openLightbox(index) {
  if (galleryItems.length === 0) return;
  lightboxIndex = index;
  var item = galleryItems[index];
  document.getElementById("lightboxImage").src = item.image;
  document.getElementById("lightboxCaption").textContent =
    item.caption + " - " + formatDate(item.date);
  document.getElementById("lightbox").classList.add("open");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("open");
}

function showNextPhoto() {
  lightboxIndex = (lightboxIndex + 1) % galleryItems.length;
  openLightbox(lightboxIndex);
}

function showPrevPhoto() {
  lightboxIndex = (lightboxIndex - 1 + galleryItems.length) % galleryItems.length;
  openLightbox(lightboxIndex);
}

function initGalleryPage() {
  var grid = document.getElementById("galleryGrid");
  if (!grid) return;

  galleryItems = loadGalleryList();
  grid.innerHTML = galleryItems.map(renderGalleryItem).join("");

  var emptyBox = document.getElementById("galleryEmpty");
  if (emptyBox) emptyBox.style.display = galleryItems.length === 0 ? "block" : "none";

  // Open the lightbox when a photo is clicked
  grid.addEventListener("click", function (event) {
    var figure = event.target.closest(".gallery-item");
    if (!figure) return;
    openLightbox(parseInt(figure.getAttribute("data-index"), 10));
  });

  // Lightbox buttons
  document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
  document.getElementById("lightboxNext").addEventListener("click", showNextPhoto);
  document.getElementById("lightboxPrev").addEventListener("click", showPrevPhoto);

  // Click the dark background to close
  document.getElementById("lightbox").addEventListener("click", function (event) {
    if (event.target === this) closeLightbox();
  });

  // Keyboard support: ESC closes, arrows move
  document.addEventListener("keydown", function (event) {
    if (!document.getElementById("lightbox").classList.contains("open")) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowRight") showNextPhoto();
    if (event.key === "ArrowLeft") showPrevPhoto();
  });
}

initGalleryPage();

/* ------------------------------------------------------------
   12. CONTACT FORM VALIDATION
   ------------------------------------------------------------ */

function initContactPage() {
  var form = document.getElementById("contactForm");
  if (!form) return;

  var successBox = document.getElementById("contactSuccess");
  var errorBox = document.getElementById("contactError");
  var originalErrorText = errorBox ? errorBox.textContent : "";

  // Mark one field as wrong or right
  function setFieldState(groupId, isValid) {
    var group = document.getElementById(groupId);
    if (isValid) group.classList.remove("invalid");
    else group.classList.add("invalid");
    return isValid;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault(); // stop the page from reloading

    // Simple cooldown so the demo form cannot be spammed
    var lastSent = Number(localStorage.getItem("ccContactLastSent") || 0);
    if (Date.now() - lastSent < 60000) {
      successBox.classList.remove("show");
      errorBox.textContent = "Please wait a moment before sending another message.";
      errorBox.classList.add("show");
      return;
    }

    var fullName = document.getElementById("fullName").value.trim();
    var email = document.getElementById("email").value.trim();
    var subject = document.getElementById("subject").value.trim();
    var message = document.getElementById("message").value.trim();

    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    var okName = setFieldState("groupFullName", fullName.length >= 2);
    var okEmail = setFieldState("groupEmail", emailPattern.test(email));
    var okSubject = setFieldState("groupSubject", subject.length >= 2);
    var okMessage = setFieldState("groupMessage", message.length >= 10);

    if (okName && okEmail && okSubject && okMessage) {
      // Frontend-only project: we do NOT send any email.
      localStorage.setItem("ccContactLastSent", String(Date.now()));
      form.reset();
      errorBox.classList.remove("show");
      successBox.classList.add("show");
      showToast("Your message has been sent. Thank you!", "success");
    } else {
      errorBox.textContent = originalErrorText;
      successBox.classList.remove("show");
      errorBox.classList.add("show");
    }
  });

  // Remove the error state while the user is typing
  ["fullName", "email", "subject", "message"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", function () {
      this.closest(".form-group").classList.remove("invalid");
    });
  });
}

initContactPage();

/* ------------------------------------------------------------
   13. ADMIN LOGIN AND LOGOUT
   Demo only - username: admin  password: admin123
   ------------------------------------------------------------ */

function initAdminLoginPage() {
  var form = document.getElementById("adminLoginForm");
  if (!form) return;

  // Already logged in? Go straight to the dashboard.
  if (localStorage.getItem("adminLoggedIn") === "true") {
    window.location.href = "admin.html";
    return;
  }

  setupLoginLimiter(form, "admin");

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    if (isLoginLocked("admin")) return;

    var username = document.getElementById("adminUsername").value.trim();
    var password = document.getElementById("adminPassword").value.trim();
    var errorBox = document.getElementById("loginError");

    var adminHash = (typeof loadAdminSettings === "function" && loadAdminSettings().adminPasswordHash) ||
      hashPassword("admin123");
    if (username === "admin" && verifyPassword(password, adminHash)) {
      clearLoginAttempts("admin");
      localStorage.setItem("adminLoggedIn", "true");
      localStorage.setItem("adminName", username);
      window.location.href = "admin.html";
    } else {
      registerLoginFailure("admin", form, errorBox);
    }
  });
}

// Logout: set adminLoggedIn = false and go back to the login page
function adminLogout() {
  localStorage.setItem("adminLoggedIn", "false");
  window.location.href = "admin-login.html";
}

// Protect admin.html: if not logged in, redirect to admin-login.html
function requireAdminLogin() {
  if (!document.body.classList.contains("admin-body")) return;
  if (localStorage.getItem("adminLoggedIn") !== "true") {
    window.location.href = "admin-login.html";
  }
}

initAdminLoginPage();
requireAdminLogin();

/* ------------------------------------------------------------
   14. ADMIN DASHBOARD - NAVIGATION AND SUMMARY CARDS
   ------------------------------------------------------------ */

// Show only the selected admin section
function showAdminSection(name) {
  var sections = {
    dashboard: "sectionDashboard",
    news: "sectionNews",
    announcements: "sectionAnnouncements",
    events: "sectionEvents",
    activities: "sectionActivities",
    gallery: "sectionGallery",
    users: "sectionUsers",
    comments: "sectionComments",
    posts: "sectionPosts",
    profile: "sectionProfile",
    notifications: "sectionNotifications",
    audit: "sectionAuditLog"
  };

  // Barangay Official accounts are managed inside the Manage Users section
  if (name === "officials") name = "users";

  // Unknown section names (e.g. old links) fall back to the dashboard
  if (!sections[name] || !document.getElementById(sections[name])) name = "dashboard";

  Object.keys(sections).forEach(function (key) {
    var section = document.getElementById(sections[key]);
    if (section) section.classList.toggle("hidden", key !== name);
  });

var links = document.querySelectorAll(".admin-sidebar a[data-section]");
links.forEach(function (link) {
  var isActive = link.getAttribute("data-section") === name;
  link.classList.toggle("active", isActive);
  if (isActive) link.setAttribute("aria-current", "page");
  else link.removeAttribute("aria-current");
});

  // Close the mobile slide-in drawer after choosing
  var sidebar = document.getElementById("adminSidebar");
  if (sidebar) sidebar.classList.remove("open");
  if (typeof closeSidebarDrawer === "function") closeSidebarDrawer();

  // Keep the URL hash in sync so sections are deep-linkable
  try {
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  } catch (e) {}

  // Refresh numbers whenever a section is opened
  updateDashboardStats();
  renderAdminCharts();
}

// Count items from LocalStorage for the summary cards
function updateDashboardStats() {
  var newsBox = document.getElementById("statNews");
  if (!newsBox) return;
  document.getElementById("statNews").textContent = loadNewsList().length;
  document.getElementById("statAnnouncements").textContent = loadAnnouncementsList().length;
  document.getElementById("statEvents").textContent = loadEventsList().length;
  document.getElementById("statActivities").textContent = loadActivitiesList().length;
  var usersBox = document.getElementById("statUsers");
  if (usersBox) usersBox.textContent = loadUsers().length;
  renderAuditLog();
}

/* ------------------------------------------------------------
   14b. ADMIN AUDIT LOG - "Recent Admin Activity" on the dashboard
   ------------------------------------------------------------ */

// Append an admin action to the audit trail (newest first, capped at 200)
function logAudit(action, target) {
  var list = getData("communityAuditLog", []);
  list.unshift({
    id: generateId(),
    at: new Date().toISOString(),
    action: action,
    target: target || ""
  });
  if (list.length > 200) list.length = 200;
  setData("communityAuditLog", list);
  renderAuditLog();
}

// Render the latest 15 audit entries into the dashboard box
function renderAuditLog() {
  var box = document.getElementById("auditLogList");
  if (!box) return;
  var list = getData("communityAuditLog", []).slice(0, 15);
  if (!list.length) {
    box.innerHTML = '<p class="meta">' + t("No activity recorded yet.") + '</p>';
    return;
  }
  box.innerHTML = list.map(function (entry) {
    var when = formatDate((entry.at || "").slice(0, 10)) + " \u00b7 " + (entry.at || "").slice(11, 16);
    return '<div class="audit-item">' +
      '<span class="audit-time meta">' + escapeHtml(when) + '</span>' +
      '<span class="audit-text">' + escapeHtml(t(entry.action)) +
        (entry.target ? ' <strong>' + escapeHtml(entry.target) + '</strong>' : '') +
      '</span>' +
    '</div>';
  }).join("");
}

function initAdminDashboard() {
  if (!document.body.classList.contains("admin-body")) return;

  // Sidebar links switch sections
  var sidebar = document.getElementById("adminSidebar");
  if (sidebar) {
    sidebar.addEventListener("click", function (event) {
      var link = event.target.closest("a[data-section]");
      if (!link) return;
      event.preventDefault();
      showAdminSection(link.getAttribute("data-section"));
    });
  }

  // Mobile hamburger for the admin sidebar (drawer + backdrop + scroll lock)
  initMobileDrawer();

  // Admin profile picture + personal information
  initAdminProfileForm();
  refreshAdminIdentity();

  // Notification history + settings section
  initNotificationHistory();

  // Backup / restore / reset buttons
  wireDataBackupButtons();

  // Header notification bell dropdown
  initNotifBells();

  // Header name/avatar click -> Log out menu
  initHeaderAccountMenus();

  // Deep link (admin.html#users) + browser hash edits
  showAdminSection(location.hash.slice(1) || "dashboard");
  window.addEventListener("hashchange", function () {
    var name = location.hash.slice(1);
    if (name) showAdminSection(name);
  });

  updateDashboardStats();
  renderAdminCharts();
}

initAdminDashboard();

/* ------------------------------------------------------------
   15. CONFIRM MODAL (shared "Are you sure?" dialog)
   ------------------------------------------------------------ */

function getConfirmModal() {
  var modal = document.getElementById("confirmModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "confirmModal";
    modal.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmModalHead">' +
        '<div class="modal-header">' +
          '<h3 id="confirmModalHead">' + t("Confirm") + '</h3>' +
          '<button class="modal-close" id="confirmModalClose" type="button" aria-label="' + t("Close") + '">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="confirm-text" id="confirmModalText">Are you sure?</p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn" id="confirmCancelBtn" type="button">' + t("CANCEL") + '</button>' +
          '<button class="btn btn-danger" id="confirmOkBtn" type="button">' + t("DELETE") + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    document.getElementById("confirmModalClose").addEventListener("click", closeConfirmModal);
    document.getElementById("confirmCancelBtn").addEventListener("click", closeConfirmModal);
    modal.addEventListener("click", function (event) {
      if (event.target === modal) closeConfirmModal();
    });
  }
  return modal;
}

var confirmAction = null; // the function to run when DELETE is pressed

// Ask the admin to confirm an action
function openConfirmModal(message, okLabel, onConfirm) {
  var modal = getConfirmModal();
  document.getElementById("confirmModalHead").textContent = t("Confirm");
  document.getElementById("confirmCancelBtn").textContent = t("CANCEL");
  document.getElementById("confirmModalText").textContent = t(message);
  document.getElementById("confirmOkBtn").textContent = t(okLabel || "DELETE");
  confirmAction = onConfirm;
  document.getElementById("confirmOkBtn").onclick = function () {
    if (typeof confirmAction === "function") confirmAction();
    closeConfirmModal();
  };
  modal.classList.add("open");
  lastFocused = document.activeElement;
  document.getElementById("confirmOkBtn").focus();
}

function closeConfirmModal() {
  var modal = document.getElementById("confirmModal");
  if (modal && modal.classList.contains("open")) {
    modal.classList.remove("open");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }
}

/* ------------------------------------------------------------
   16. ADMIN NEWS MANAGEMENT (Add / Edit / Delete)
   ------------------------------------------------------------ */

var newsEditingId = null;

// Refresh the news table
/* ------------------------------------------------------------
   Admin table helpers: live search, item counts, date order
   ------------------------------------------------------------ */
function getTableQuery(inputId) {
  var el = document.getElementById(inputId);
  return el ? el.value.trim().toLowerCase() : "";
}

function updateTableCount(countId, shown, total) {
  var el = document.getElementById(countId);
  if (!el) return;
  el.textContent = shown === total
    ? total + " " + t("items")
    : shown + "/" + total + " " + t("items");
}

function matchesQuery(query, fields) {
  if (!query) return true;
  for (var i = 0; i < fields.length; i++) {
    if (fields[i] && String(fields[i]).toLowerCase().indexOf(query) >= 0) return true;
  }
  return false;
}

function sortByDateDesc(items, key) {
  return items.slice().sort(function (a, b) {
    return String(b[key] || "").localeCompare(String(a[key] || ""));
  });
}

function sortByDateAsc(items, key) {
  return items.slice().sort(function (a, b) {
    return String(a[key] || "").localeCompare(String(b[key] || ""));
  });
}

function bindTableSearch(inputId, renderFn) {
  var el = document.getElementById(inputId);
  if (el) el.addEventListener("input", renderFn);
}

function tableThumb(src) {
  if (!src) return "";
  return '<img class="table-thumb" src="' + escapeHtml(src) + '" alt="">';
}

function wirePathPreview(pathId, previewId) {
  var input = document.getElementById(pathId);
  var preview = document.getElementById(previewId);
  if (!input || !preview) return;
  input.addEventListener("input", function () {
    var v = input.value.trim();
    if (!v) {
      preview.classList.remove("show");
      preview.removeAttribute("src");
      return;
    }
    preview.onload = function () { preview.classList.add("show"); };
    preview.onerror = function () { preview.classList.remove("show"); };
    preview.src = v;
  });
}

function refreshPathPreview(pathId, previewId) {
  var input = document.getElementById(pathId);
  if (input) input.dispatchEvent(new Event("input"));
}

function clearImgPreview(previewId) {
  var preview = document.getElementById(previewId);
  if (!preview) return;
  preview.classList.remove("show");
  preview.removeAttribute("src");
}

function renderNewsTable() {
  var body = document.getElementById("newsTableBody");
  if (!body) return;
  var all = loadNewsList();
  var q = getTableQuery("newsTableSearch");

  var filtered = all.filter(function (item) {
    return matchesQuery(q, [item.title, item.category, item.date, item.description]);
  });
  var pinned = sortByDateDesc(filtered.filter(function (item) { return item.pinned; }), "date");
  var rest = sortByDateDesc(filtered.filter(function (item) { return !item.pinned; }), "date");
  var items = pinned.concat(rest);

  updateTableCount("newsTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty-row">' +
      (q ? t("No matching results.") : t("No news yet. Add your first news above.")) + '</td></tr>';
    return;
  }

  body.innerHTML = items.map(function (item) {
    var commentCount = getCommentCount(item.id);
    return '' +
      '<tr>' +
        '<td data-label=""><div class="cell-with-thumb">' + tableThumb(item.image) +
          '<span>' + escapeHtml(item.title) +
          (item.pinned ? ' <span class="badge badge-featured">' + t("FEATURED") + '</span>' : '') +
          (commentCount ? ' <button class="badge comment-count-badge" type="button" onclick="gotoCommentsFor(\'' + item.id + '\')" title="' + t("See comments") + '">' +
            t("comments") + ': ' + commentCount + '</button>' : '') +
          '</span></div></td>' +
        '<td data-label="' + t("Category") + '"><span class="badge">' + escapeHtml(item.category) + '</span></td>' +
        '<td data-label="' + t("Date") + '">' + formatDate(item.date) + '</td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="togglePinNews(\'' + item.id + '\')">' +
              t(item.pinned ? "UNPIN" : "PIN") + '</button>' +
            '<button class="btn btn-small" type="button" onclick="editNews(\'' + item.id + '\')">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
            '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteNews(\'' + item.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");
}

// Pin / unpin a news article so it shows as FEATURED on the website
function togglePinNews(id) {
  var pinnedNow = false;
  var items = loadNewsList().map(function (n) {
    if (n.id === id) {
      n.pinned = !n.pinned;
      pinnedNow = n.pinned;
    }
    return n;
  });
  setData("communityNews", items);
  renderNewsTable();
  var changed = items.find(function (n) { return n.id === id; });
  logAudit(pinnedNow ? "pinned news" : "unpinned news", changed ? changed.title : "");
  showToast(pinnedNow ? "News pinned as FEATURED." : "News unpinned.", "success");
}

// Fill the form with an existing news item (edit mode)
function editNews(id) {
  var item = loadNewsList().find(function (n) { return n.id === id; });
  if (!item) return;

  newsEditingId = id;
  document.getElementById("newsFormTitle").textContent = t("Edit News");
  document.getElementById("newsSubmitBtn").textContent = t("UPDATE NEWS");
  document.getElementById("newsCancelBtn").classList.remove("hidden");

  document.getElementById("newsTitle").value = item.title;
  document.getElementById("newsCategory").value = item.category;
  document.getElementById("newsDate").value = item.date;
  document.getElementById("newsDescription").value = item.description;
  setNewsImagesField(getNewsImages(item));
  var newsVideoInput = document.getElementById("newsVideo");
  if (newsVideoInput) {
    var vids = getMediaVideos(item);
    var firstVideo = vids.length ? vids[0] : "";
    newsVideoInput.value = firstVideo;
    // Remember what the field was filled with so an untouched edit keeps
    // every video the post already had (see resolveVideoSelection).
    newsVideoInput.setAttribute("data-original-video", firstVideo);
    newsVideoInput.removeAttribute("data-pending-video");
    pendingVideoFiles = [];
    pendingVideoPosters = [];
    var hint = document.getElementById("newsVideoHint");
    if (firstVideo && firstVideo.indexOf("idb:") === 0) {
      newsVideoInput.setAttribute("data-video-label", "Uploaded video (stored in browser)");
      if (hint) hint.textContent = vids.length > 1
        ? vids.length + " videos attached. Pick new files to replace them."
        : "Uploaded video attached. Pick a new file to replace it.";
      videoSrcFromRef(firstVideo).then(function (src) {
        if (!src) return;
        var preview = document.getElementById("newsVideoPreview");
        if (preview) { preview.src = src; preview.classList.add("show"); }
      });
    } else {
      newsVideoInput.removeAttribute("data-video-label");
      if (hint && vids.length > 1) {
        hint.textContent = vids.length + " videos attached.";
      }
      refreshVideoPreview("newsVideo", "newsVideoPreview");
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Reset the form back to "Add" mode
function resetNewsForm() {
  newsEditingId = null;
  document.getElementById("newsFormTitle").textContent = t("Add News");
  document.getElementById("newsSubmitBtn").textContent = t("ADD NEWS");
  document.getElementById("newsCancelBtn").classList.add("hidden");
  document.getElementById("newsForm").reset();
  clearImgPreview("newsImagePreview");
  setNewsImagesField([]);
  clearVideoPreview("newsVideoPreview");
  pendingVideoFiles = [];
  pendingVideoPosters = [];
  var vEl = document.getElementById("newsVideo");
  if (vEl) {
    vEl.removeAttribute("data-pending-video");
    vEl.removeAttribute("data-original-video");
  }
  var vHint = document.getElementById("newsVideoHint");
  if (vHint) vHint.textContent = "Pick one or more short videos from your device (MP4, WEBM, or OGG) - they are saved in the browser.";
}

// Ask for confirmation, then delete the news
function deleteNews(id) {
  var removed = loadNewsList().find(function (n) { return n.id === id; });
  openConfirmModal("Are you sure you want to delete this news?", "DELETE", function () {
    var items = loadNewsList().filter(function (n) { return n.id !== id; });
    setData("communityNews", items);
    // Comments belong to a deleted post, so they go away with it
    setData("communityComments", loadComments().filter(function (c) { return c.newsId !== id; }));
    if (removed && removed.video) deleteVideoRef(removed.video);
    if (newsEditingId === id) resetNewsForm();
    renderNewsTable();
    updateDashboardStats();
    logAudit("deleted news", removed ? removed.title : "");
    showToast("News deleted.", "success");
  });
}

function initNewsAdmin() {
  var form = document.getElementById("newsForm");
  if (!form) return;

  bindTableSearch("newsTableSearch", renderNewsTable);
  wirePathPreview("newsImage", "newsImagePreview");
  wireNewsImagePathField();

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var title = document.getElementById("newsTitle").value.trim();
    var category = document.getElementById("newsCategory").value;
    var date = document.getElementById("newsDate").value;
    var description = document.getElementById("newsDescription").value.trim();
    var images = readNewsImagesField();
    if (!images.length) images = ["community-01.jpg"];
    var image = images[0];
    var videoEl = document.getElementById("newsVideo");

    if (!title || !date || !description) {
      showToast("Please fill in the title, date, and description.", "error");
      return;
    }

    var items = loadNewsList();
    var prevItem = newsEditingId
      ? (items.find(function (n) { return n.id === newsEditingId; }) || {})
      : {};
    var prevVideos = getMediaVideos(prevItem);

    // Resolve the video field into small references before saving. Freshly
    // picked files are written to IndexedDB (no size limit); an untouched
    // field keeps every video the post already had; a typed path/link becomes
    // the single video. This keeps localStorage tiny.
    resolveVideoSelection(videoEl, prevVideos).then(function (sel) {
      var videosToSave = sel.videos;
      // A freshly picked video carries a captured thumbnail; an unchanged
      // video keeps the poster it already had.
      var posterToSave = sel.posters.length
        ? sel.posters[0]
        : (sel.unchanged ? (prevItem.videoPoster || "") : "");

      if (newsEditingId) {
        // Update the existing news
        var editingId = newsEditingId;
        items = items.map(function (n) {
          if (n.id === editingId) {
            var updated = { id: n.id, title: title, category: category, date: date,
                     description: description, details: description, image: image,
                     images: images, videos: videosToSave, video: videosToSave[0] || "",
                     pinned: !!n.pinned,
                     postedBy: n.postedBy || getPosterName(),
                     createdAt: n.createdAt || (date ? date + "T12:00:00" : new Date().toISOString()) };
            if (posterToSave) updated.videoPoster = posterToSave;
            return updated;
          }
          return n;
        });
        if (!setData("communityNews", items)) {
          showStorageFullToast();
          return;
        }
        // Stored videos no longer referenced are freed from IndexedDB.
        prevVideos.forEach(function (v) {
          if (videosToSave.indexOf(v) < 0) deleteVideoRef(v);
        });
        showToast("News updated successfully.", "success");
      } else {
        // Add new news
        var newNews = {
          id: generateId(),
          title: title,
          category: category,
          date: date,
          description: description,
          details: description,
          image: image,
          images: images,
          videos: videosToSave,
          video: videosToSave[0] || "",
          postedBy: getPosterName(),
          createdAt: new Date().toISOString()
        };
        if (posterToSave) newNews.videoPoster = posterToSave;
        items.push(newNews);
        if (!setData("communityNews", items)) {
          showStorageFullToast();
          videosToSave.forEach(deleteVideoRef);
          return;
        }
        showToast("News added successfully.", "success");
      }

      logAudit(newsEditingId ? "updated news" : "created news", title);
      resetNewsForm();
      renderNewsTable();
      updateDashboardStats();
    });
  });

  document.getElementById("newsCancelBtn").addEventListener("click", resetNewsForm);
  renderNewsTable();
}

initNewsAdmin();

/* ------------------------------------------------------------
   17. ADMIN ANNOUNCEMENT MANAGEMENT (Add / Edit / Delete)
   ------------------------------------------------------------ */

var annEditingId = null;

function renderAnnTable() {
  var body = document.getElementById("annTableBody");
  if (!body) return;
  var all = loadAnnouncementsList();
  var q = getTableQuery("annTableSearch");

  var items = sortByDateDesc(all.filter(function (item) {
    return matchesQuery(q, [item.title, item.category, item.status, item.date, item.description]);
  }), "date");

  updateTableCount("annTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">' +
      (q ? t("No matching results.") : t("No announcements yet.")) + '</td></tr>';
    return;
  }

  body.innerHTML = items.map(function (item) {
    return '' +
      '<tr>' +
        '<td data-label="">' + escapeHtml(item.title) +
          (getCommentCount(item.id) ? ' <button class="badge comment-count-badge" type="button" onclick="gotoCommentsFor(\'' + item.id + '\')" title="' + t("See comments") + '">' +
            t("comments") + ': ' + getCommentCount(item.id) + '</button>' : '') +
          '</td>' +
        '<td data-label="' + t("Category") + '"><span class="badge">' + escapeHtml(item.category) + '</span></td>' +
        '<td data-label="' + t("Date") + '">' + formatDate(item.date) + '</td>' +
        '<td data-label="' + t("Status") + '"><span class="' + statusBadgeClass(item.status) + '">' + escapeHtml(item.status) + '</span></td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="editAnnouncement(\'' + item.id + '\')">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
            '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteAnnouncement(\'' + item.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");
}

function editAnnouncement(id) {
  var item = loadAnnouncementsList().find(function (a) { return a.id === id; });
  if (!item) return;

  annEditingId = id;
  document.getElementById("annFormTitle").textContent = t("Edit Announcement");
  document.getElementById("annSubmitBtn").textContent = t("UPDATE ANNOUNCEMENT");
  document.getElementById("annCancelBtn").classList.remove("hidden");

  document.getElementById("annTitle").value = item.title;
  document.getElementById("annCategory").value = item.category;
  document.getElementById("annDate").value = item.date;
  document.getElementById("annStatus").value = item.status;
  document.getElementById("annDescription").value = item.description;
  setAnnImagesField(getMediaImages(item));
  var annVideoInput = document.getElementById("annVideo");
  if (annVideoInput) {
    var vids = getMediaVideos(item);
    var firstVideo = vids.length ? vids[0] : "";
    annVideoInput.value = firstVideo;
    // Remember what the field was filled with so an untouched edit keeps
    // every video the announcement already had (see resolveVideoSelection).
    annVideoInput.setAttribute("data-original-video", firstVideo);
    annVideoInput.removeAttribute("data-pending-video");
    pendingVideoFiles = [];
    pendingVideoPosters = [];
    var hint = document.getElementById("annVideoHint");
    if (firstVideo && firstVideo.indexOf("idb:") === 0) {
      annVideoInput.setAttribute("data-video-label", "Uploaded video (stored in browser)");
      if (hint) hint.textContent = vids.length > 1
        ? vids.length + " videos attached. Pick new files to replace them."
        : "Uploaded video attached. Pick a new file to replace it.";
      videoSrcFromRef(firstVideo).then(function (src) {
        if (!src) return;
        var preview = document.getElementById("annVideoPreview");
        if (preview) { preview.src = src; preview.classList.add("show"); }
      });
    } else {
      annVideoInput.removeAttribute("data-video-label");
      if (hint && vids.length > 1) {
        hint.textContent = vids.length + " videos attached.";
      }
      refreshVideoPreview("annVideo", "annVideoPreview");
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetAnnForm() {
  annEditingId = null;
  document.getElementById("annFormTitle").textContent = t("Add Announcement");
  document.getElementById("annSubmitBtn").textContent = t("ADD ANNOUNCEMENT");
  document.getElementById("annCancelBtn").classList.add("hidden");
  document.getElementById("annForm").reset();
  clearImgPreview("annImagePreview");
  setAnnImagesField([]);
  clearVideoPreview("annVideoPreview");
  pendingVideoFiles = [];
  pendingVideoPosters = [];
  var vEl = document.getElementById("annVideo");
  if (vEl) {
    vEl.removeAttribute("data-pending-video");
    vEl.removeAttribute("data-original-video");
  }
  var vHint = document.getElementById("annVideoHint");
  if (vHint) vHint.textContent = t("Pick one or more short videos from your device (MP4, WEBM, or OGG) - they are saved in the browser.");
}

function deleteAnnouncement(id) {
  var removed = loadAnnouncementsList().find(function (a) { return a.id === id; });
  openConfirmModal("Are you sure you want to delete this announcement?", "DELETE", function () {
    var items = loadAnnouncementsList().filter(function (a) { return a.id !== id; });
    setData("communityAnnouncements", items);
    // Uploaded videos are stored in IndexedDB; free any this post owned.
    if (removed) getMediaVideos(removed).forEach(deleteVideoRef);
    if (annEditingId === id) resetAnnForm();
    renderAnnTable();
    updateDashboardStats();
    logAudit("deleted announcement", removed ? removed.title : "");
    showToast("Announcement deleted.", "success");
  });
}

function initAnnAdmin() {
  var form = document.getElementById("annForm");
  if (!form) return;

  bindTableSearch("annTableSearch", renderAnnTable);
  wirePathPreview("annImage", "annImagePreview");
  wireAnnImagePathField();

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var title = document.getElementById("annTitle").value.trim();
    var category = document.getElementById("annCategory").value;
    var date = document.getElementById("annDate").value;
    var status = document.getElementById("annStatus").value;
    var description = document.getElementById("annDescription").value.trim();
    var images = readAnnImagesField();
    var image = images[0] || "";
    var videoEl = document.getElementById("annVideo");

    if (!title || !date || !description) {
      showToast("Please fill in the title, date, and description.", "error");
      return;
    }

    var items = loadAnnouncementsList();
    var prevItem = annEditingId
      ? (items.find(function (a) { return a.id === annEditingId; }) || {})
      : {};
    var prevVideos = getMediaVideos(prevItem);

    // Resolve the video field into small references before saving. Freshly
    // picked files go to IndexedDB (no size limit); an untouched field keeps
    // every video the post already had; a typed path/link becomes the single
    // video. This keeps localStorage tiny.
    resolveVideoSelection(videoEl, prevVideos).then(function (sel) {
      var videosToSave = sel.videos;
      var posterToSave = sel.posters.length
        ? sel.posters[0]
        : (sel.unchanged ? (prevItem.videoPoster || "") : "");

      if (annEditingId) {
        var editingId = annEditingId;
        items = items.map(function (a) {
          if (a.id === editingId) {
            var updated = { id: a.id, title: title, category: category, date: date,
                     status: status, description: description, image: image,
                     images: images, videos: videosToSave, video: videosToSave[0] || "",
                     postedBy: a.postedBy || getPosterName(),
                     createdAt: a.createdAt || (date ? date + "T12:00:00" : new Date().toISOString()) };
            if (posterToSave) updated.videoPoster = posterToSave;
            return updated;
          }
          return a;
        });
        if (!setData("communityAnnouncements", items)) {
          showStorageFullToast();
          return;
        }
        // Stored videos no longer referenced are freed from IndexedDB.
        prevVideos.forEach(function (v) {
          if (videosToSave.indexOf(v) < 0) deleteVideoRef(v);
        });
      } else {
        var newAnn = {
          id: generateId(),
          title: title,
          category: category,
          date: date,
          status: status,
          description: description,
          image: image,
          images: images,
          videos: videosToSave,
          video: videosToSave[0] || "",
          postedBy: getPosterName(),
          createdAt: new Date().toISOString()
        };
        if (posterToSave) newAnn.videoPoster = posterToSave;
        items.push(newAnn);
        if (!setData("communityAnnouncements", items)) {
          showStorageFullToast();
          videosToSave.forEach(deleteVideoRef);
          return;
        }
      }

      logAudit(annEditingId ? "updated announcement" : "created announcement", title);
      resetAnnForm();
      renderAnnTable();
      updateDashboardStats();
      showToast("Announcement saved successfully.", "success");
    });
  });

  document.getElementById("annCancelBtn").addEventListener("click", resetAnnForm);
  renderAnnTable();
}

initAnnAdmin();

/* ------------------------------------------------------------
   18. ADMIN EVENT MANAGEMENT (Add / Edit / Delete)
   ------------------------------------------------------------ */

var eventEditingId = null;

function renderEventTable() {
  var body = document.getElementById("eventTableBody");
  if (!body) return;
  var all = loadEventsList();
  var q = getTableQuery("eventTableSearch");

  // Soonest events first so admins see what is coming up next
  var items = sortByDateAsc(all.filter(function (item) {
    return matchesQuery(q, [item.name, item.date, item.time, item.location, item.description]);
  }), "date");

  updateTableCount("eventTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-row">' +
      (q ? t("No matching results.") : t("No events yet.")) + '</td></tr>';
    return;
  }

  body.innerHTML = items.map(function (item) {
    return '' +
      '<tr>' +
        '<td data-label="">' + escapeHtml(item.name) + '</td>' +
        '<td data-label="' + t("Date") + '">' + formatDate(item.date) + '</td>' +
        '<td data-label="' + t("Time") + '">' + escapeHtml(item.time) + '</td>' +
        '<td data-label="' + t("Location") + '">' + escapeHtml(item.location) + '</td>' +
        '<td data-label="' + t("Going") + '">' +
          '<button class="badge badge-going" type="button" onclick="showEventAttendees(\'' + item.id + '\')" title="' + t("View attendees") + '">' +
            rsvpCount(item.id) + ' ' + t("going") + '</button></td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="editEvent(\'' + item.id + '\')">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
            '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteEvent(\'' + item.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");

  renderRsvpSummary();
}

// Attendance list for one event (opens in the shared detail modal)
function showEventAttendees(eventId) {
  var ev = loadEventsList().find(function (e) { return e.id === eventId; });
  if (!ev) return;
  var names = loadRsvps()
    .filter(function (r) { return r.eventId === eventId; })
    .map(function (r) { return r.username; })
    .sort();
  var body;
  if (!names.length) {
    body = '<p class="meta">' + t("No RSVPs yet for this event.") + '</p>';
  } else {
    body = '<ul class="attendee-list">' + names.map(function (n) {
      return '<li><span class="comment-avatar ' + commentAvatarClass(n) + '" aria-hidden="true">' +
        avatarInner(n) + '</span>' + escapeHtml(displayNameFor(n)) + '</li>';
    }).join("") + '</ul>';
  }
  var meta = '<span class="badge">' + t("EVENT") + '</span> ' + formatDate(ev.date) +
    ' &nbsp;<span class="meta-stat">' + names.length + ' ' + t("going") + '</span>';
  openDetailModal(ev.name, meta, body);
}

// Headcount estimate strip above the events table
function renderRsvpSummary() {
  var bodyEl = document.getElementById("rsvpSummaryBody");
  if (!bodyEl) return;
  var today = new Date().toISOString().split("T")[0];
  var events = loadEventsList().filter(function (e) { return (e.date || "") >= today; });
  var total = 0, top = null, topCount = 0;
  events.forEach(function (e) {
    var n = rsvpCount(e.id);
    total += n;
    if (n > topCount) { topCount = n; top = e; }
  });
  var text = t("Upcoming events:") + " " + events.length + " · " + t("Total RSVPs:") + " " + total;
  if (top && topCount > 0) {
    text += " · " + t("Biggest gathering:") + " " + top.name + " (" + topCount + ")";
  }
  bodyEl.textContent = text;
}

function editEvent(id) {
  var item = loadEventsList().find(function (e) { return e.id === id; });
  if (!item) return;

  eventEditingId = id;
  document.getElementById("eventFormTitle").textContent = t("Edit Event");
  document.getElementById("eventSubmitBtn").textContent = t("UPDATE EVENT");
  document.getElementById("eventCancelBtn").classList.remove("hidden");

  document.getElementById("eventName").value = item.name;
  document.getElementById("eventDate").value = item.date;
  document.getElementById("eventTime").value = item.time;
  document.getElementById("eventLocation").value = item.location;
  document.getElementById("eventDescription").value = item.description;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetEventForm() {
  eventEditingId = null;
  document.getElementById("eventFormTitle").textContent = t("Add Event");
  document.getElementById("eventSubmitBtn").textContent = t("ADD EVENT");
  document.getElementById("eventCancelBtn").classList.add("hidden");
  document.getElementById("eventForm").reset();
}

function deleteEvent(id) {
  var removed = loadEventsList().find(function (e) { return e.id === id; });
  openConfirmModal("Are you sure you want to delete this event?", "DELETE", function () {
    var items = loadEventsList().filter(function (e) { return e.id !== id; });
    setData("communityEvents", items);
    if (eventEditingId === id) resetEventForm();
    renderEventTable();
    updateDashboardStats();
    logAudit("deleted event", removed ? removed.name : "");
    showToast("Event deleted.", "success");
  });
}

function initEventAdmin() {
  var form = document.getElementById("eventForm");
  if (!form) return;

  bindTableSearch("eventTableSearch", renderEventTable);

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var name = document.getElementById("eventName").value.trim();
    var date = document.getElementById("eventDate").value;
    var time = document.getElementById("eventTime").value.trim();
    var location = document.getElementById("eventLocation").value.trim();
    var description = document.getElementById("eventDescription").value.trim();

    if (!name || !date || !time || !location || !description) {
      showToast("Please fill in all event fields.", "error");
      return;
    }

    var items = loadEventsList();

    if (eventEditingId) {
      items = items.map(function (e) {
        if (e.id === eventEditingId) {
          return { id: e.id, name: name, date: date, time: time,
                   location: location, description: description };
        }
        return e;
      });
      setData("communityEvents", items);
    } else {
      items.push({
        id: generateId(),
        name: name,
        date: date,
        time: time,
        location: location,
        description: description
      });
      setData("communityEvents", items);
    }

    logAudit(eventEditingId ? "updated event" : "created event", name);
    resetEventForm();
    renderEventTable();
    updateDashboardStats();
    showToast("Event saved successfully.", "success");
  });

  document.getElementById("eventCancelBtn").addEventListener("click", resetEventForm);
  renderEventTable();
}

initEventAdmin();

/* ------------------------------------------------------------
   19. ADMIN ACTIVITY MANAGEMENT (Add / Edit / Delete)
   ------------------------------------------------------------ */

var activityEditingId = null;

function renderActivityTable() {
  var body = document.getElementById("activityTableBody");
  if (!body) return;
  var all = loadActivitiesList();
  var q = getTableQuery("activityTableSearch");

  var items = sortByDateDesc(all.filter(function (item) {
    return matchesQuery(q, [item.name, item.date, item.location, item.description]);
  }), "date");

  updateTableCount("activityTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty-row">' +
      (q ? t("No matching results.") : t("No activities yet.")) + '</td></tr>';
    return;
  }

  body.innerHTML = items.map(function (item) {
    return '' +
      '<tr>' +
        '<td data-label=""><div class="cell-with-thumb">' + tableThumb(item.image) +
          '<span>' + escapeHtml(item.name) +
          (getCommentCount(item.id) ? ' <button class="badge comment-count-badge" type="button" onclick="gotoCommentsFor(\'' + item.id + '\')" title="' + t("See comments") + '">' +
            t("comments") + ': ' + getCommentCount(item.id) + '</button>' : '') +
          '</span></div></td>' +
        '<td data-label="' + t("Date") + '">' + formatDate(item.date) + '</td>' +
        '<td data-label="' + t("Location") + '">' + escapeHtml(item.location) + '</td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="editActivity(\'' + item.id + '\')">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
            '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteActivity(\'' + item.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");
}

function editActivity(id) {
  var item = loadActivitiesList().find(function (a) { return a.id === id; });
  if (!item) return;

  activityEditingId = id;
  document.getElementById("activityFormTitle").textContent = t("Edit Activity");
  document.getElementById("activitySubmitBtn").textContent = t("UPDATE ACTIVITY");
  document.getElementById("activityCancelBtn").classList.remove("hidden");

  document.getElementById("activityName").value = item.name;
  document.getElementById("activityDate").value = item.date;
  document.getElementById("activityLocation").value = item.location;
  document.getElementById("activityDescription").value = item.description;
  setActivityImagesField(getMediaImages(item));
  var actVideoInput = document.getElementById("activityVideo");
  if (actVideoInput) {
    var vids = getMediaVideos(item);
    var firstVid = vids.length ? vids[0] : "";
    actVideoInput.value = firstVid;
    // Remember what the field was filled with so an untouched edit keeps
    // every video the post already had (see resolveVideoSelection).
    actVideoInput.setAttribute("data-original-video", firstVid);
    actVideoInput.removeAttribute("data-pending-video");
    pendingVideoFiles = [];
    pendingVideoPosters = [];
    var avHint = document.getElementById("activityVideoHint");
    if (firstVid && firstVid.indexOf("idb:") === 0) {
      if (avHint) avHint.textContent = vids.length > 1
        ? vids.length + " videos attached. Pick new files to replace them."
        : "Uploaded video attached. Pick a new file to replace it.";
      videoSrcFromRef(firstVid).then(function (src) {
        if (!src) return;
        var preview = document.getElementById("activityVideoPreview");
        if (preview) { preview.src = src; preview.classList.add("show"); }
      });
    } else {
      if (avHint && vids.length > 1) {
        avHint.textContent = vids.length + " videos attached.";
      }
      refreshVideoPreview("activityVideo", "activityVideoPreview");
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetActivityForm() {
  activityEditingId = null;
  document.getElementById("activityFormTitle").textContent = t("Add Activity");
  document.getElementById("activitySubmitBtn").textContent = t("ADD ACTIVITY");
  document.getElementById("activityCancelBtn").classList.add("hidden");
  document.getElementById("activityForm").reset();
  clearImgPreview("activityImagePreview");
  setActivityImagesField([]);
  clearVideoPreview("activityVideoPreview");
  pendingVideoFiles = [];
  pendingVideoPosters = [];
  var avEl = document.getElementById("activityVideo");
  if (avEl) {
    avEl.removeAttribute("data-pending-video");
    avEl.removeAttribute("data-original-video");
  }
  var avHint2 = document.getElementById("activityVideoHint");
  if (avHint2) avHint2.textContent = "Pick one or more short videos from your device (MP4, WEBM, or OGG) - they are saved in the browser.";
}

function deleteActivity(id) {
  var removed = loadActivitiesList().find(function (a) { return a.id === id; });
  openConfirmModal("Are you sure you want to delete this activity?", "DELETE", function () {
    var items = loadActivitiesList().filter(function (a) { return a.id !== id; });
    setData("communityActivities", items);
    if (removed) getMediaVideos(removed).forEach(deleteVideoRef);
    if (activityEditingId === id) resetActivityForm();
    renderActivityTable();
    updateDashboardStats();
    logAudit("deleted activity", removed ? removed.name : "");
    showToast("Activity deleted.", "success");
  });
}

function initActivityAdmin() {
  var form = document.getElementById("activityForm");
  if (!form) return;

  bindTableSearch("activityTableSearch", renderActivityTable);
  wirePathPreview("activityImage", "activityImagePreview");
  wireActivityImagePathField();

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var name = document.getElementById("activityName").value.trim();
    var date = document.getElementById("activityDate").value;
    var location = document.getElementById("activityLocation").value.trim();
    var description = document.getElementById("activityDescription").value.trim();
    var images = readActivityImagesField();
    if (!images.length) images = ["activity-01.jpg"];
    var image = images[0];
    var videoEl = document.getElementById("activityVideo");

    if (!name || !date || !location || !description) {
      showToast("Please fill in all activity fields.", "error");
      return;
    }

    var items = loadActivitiesList();
    var prevItem = activityEditingId
      ? (items.find(function (a) { return a.id === activityEditingId; }) || {})
      : {};
    var prevVideos = getMediaVideos(prevItem);

    // Resolve the video field into small references before saving. Freshly
    // picked files are written to IndexedDB (no size limit); an untouched
    // field keeps every video the post already had; a typed path/link becomes
    // the single video. This keeps localStorage tiny.
    resolveVideoSelection(videoEl, prevVideos).then(function (sel) {
      var videosToSave = sel.videos;
      // A freshly picked video carries a captured thumbnail; an unchanged
      // video keeps the poster it already had.
      var posterToSave = sel.posters.length
        ? sel.posters[0]
        : (sel.unchanged ? (prevItem.videoPoster || "") : "");

      if (activityEditingId) {
        var editingId = activityEditingId;
        items = items.map(function (a) {
          if (a.id === editingId) {
            var updated = { id: a.id, name: name, date: date, location: location,
                     description: description, image: image, images: images,
                     videos: videosToSave,
                     postedBy: a.postedBy || getPosterName(),
                     createdAt: a.createdAt || (date ? date + "T12:00:00" : new Date().toISOString()) };
            if (posterToSave) updated.videoPoster = posterToSave;
            return updated;
          }
          return a;
        });
        if (!setData("communityActivities", items)) {
          showStorageFullToast();
          return;
        }
        // Stored videos no longer referenced are freed from IndexedDB.
        prevVideos.forEach(function (v) {
          if (videosToSave.indexOf(v) < 0) deleteVideoRef(v);
        });
        showToast("Activity updated successfully.", "success");
      } else {
        var newAct = {
          id: generateId(),
          name: name,
          date: date,
          location: location,
          description: description,
          image: image,
          images: images,
          postedBy: getPosterName(),
          createdAt: new Date().toISOString()
        };
        if (videosToSave.length) newAct.videos = videosToSave;
        if (posterToSave) newAct.videoPoster = posterToSave;
        items.push(newAct);
        if (!setData("communityActivities", items)) {
          showStorageFullToast();
          videosToSave.forEach(deleteVideoRef);
          return;
        }
        showToast("Activity added successfully.", "success");
      }

      logAudit(activityEditingId ? "updated activity" : "created activity", name);
      resetActivityForm();
      renderActivityTable();
      updateDashboardStats();
    });
  });

  document.getElementById("activityCancelBtn").addEventListener("click", resetActivityForm);
  renderActivityTable();
}

initActivityAdmin();

/* ------------------------------------------------------------
   20. ADMIN GALLERY MANAGEMENT (Add / Edit / Delete)
   ------------------------------------------------------------ */

var galleryEditingId = null;

function renderGalleryTable() {
  var body = document.getElementById("galleryTableBody");
  if (!body) return;
  var all = loadGalleryList();
  var q = getTableQuery("galleryTableSearch");

  var items = sortByDateDesc(all.filter(function (item) {
    return matchesQuery(q, [item.caption, item.image, item.date]);
  }), "date");

  updateTableCount("galleryTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty-row">' +
      (q ? t("No matching results.") : t("No photos yet.")) + '</td></tr>';
    return;
  }

  body.innerHTML = items.map(function (item) {
    return '' +
      '<tr>' +
        '<td data-label=""><img class="table-thumb" src="' + escapeHtml(item.image) + '" alt=""></td>' +
        '<td data-label="' + t("Caption") + '">' + escapeHtml(item.caption) + '</td>' +
        '<td data-label="' + t("Date") + '">' + formatDate(item.date) + '</td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="editGalleryItem(\'' + item.id + '\')">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
            '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteGalleryItem(\'' + item.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");
}

function editGalleryItem(id) {
  var item = loadGalleryList().find(function (g) { return g.id === id; });
  if (!item) return;

  galleryEditingId = id;
  document.getElementById("galleryFormTitle").textContent = t("Edit Photo");
  document.getElementById("gallerySubmitBtn").textContent = t("UPDATE PHOTO");
  document.getElementById("galleryCancelBtn").classList.remove("hidden");

  document.getElementById("galleryImage").value = item.image;
  refreshPathPreview("galleryImage", "galleryImagePreview");
  document.getElementById("galleryCaption").value = item.caption;
  document.getElementById("galleryDate").value = item.date;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetGalleryForm() {
  galleryEditingId = null;
  document.getElementById("galleryFormTitle").textContent = t("Add Photo");
  document.getElementById("gallerySubmitBtn").textContent = t("ADD PHOTO");
  document.getElementById("galleryCancelBtn").classList.add("hidden");
  document.getElementById("galleryForm").reset();
  clearImgPreview("galleryImagePreview");
}

function deleteGalleryItem(id) {
  var removed = loadGalleryList().find(function (g) { return g.id === id; });
  openConfirmModal("Are you sure you want to delete this photo?", "DELETE", function () {
    var items = loadGalleryList().filter(function (g) { return g.id !== id; });
    setData("communityGallery", items);
    if (galleryEditingId === id) resetGalleryForm();
    renderGalleryTable();
    logAudit("deleted photo", removed ? removed.caption : "");
    showToast("Photo deleted.", "success");
  });
}

function initGalleryAdmin() {
  var form = document.getElementById("galleryForm");
  if (!form) return;

  bindTableSearch("galleryTableSearch", renderGalleryTable);
  wirePathPreview("galleryImage", "galleryImagePreview");

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var image = document.getElementById("galleryImage").value.trim();
    var caption = document.getElementById("galleryCaption").value.trim();
    var date = document.getElementById("galleryDate").value;

    if (!image || !caption || !date) {
      showToast("Please fill in the image, caption, and date.", "error");
      return;
    }

    var items = loadGalleryList();

    if (galleryEditingId) {
      items = items.map(function (g) {
        if (g.id === galleryEditingId) {
          return { id: g.id, image: image, caption: caption, date: date };
        }
        return g;
      });
      setData("communityGallery", items);
    } else {
      items.push({
        id: generateId(),
        image: image,
        caption: caption,
        date: date
      });
      setData("communityGallery", items);
    }

    logAudit(galleryEditingId ? "updated photo" : "created photo", caption);
    resetGalleryForm();
    renderGalleryTable();
    showToast("Photo saved successfully.", "success");
  });

  document.getElementById("galleryCancelBtn").addEventListener("click", resetGalleryForm);
  renderGalleryTable();
}

initGalleryAdmin();
initImageUploads();

/* ------------------------------------------------------------
   20b. ADMIN - REGISTERED USERS (view / search / inspect / delete)
   ------------------------------------------------------------ */

function renderUserTable() {
  var body = document.getElementById("usersTableBody");
  if (!body) return;
  var all = loadUsers();
  var q = getTableQuery("usersTableSearch");

  var items = sortByDateDesc(all.filter(function (u) {
    return matchesQuery(q, [u.username, u.phone, u.address, u.joined]);
  }), "joined");

  updateTableCount("usersTableCount", items.length, all.length);

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">' +
      (q ? t("No matching results.") : t("No registered users yet.")) + '</td></tr>';
    return;
  }

  var signedInName = localStorage.getItem("userLoggedIn") === "true"
    ? localStorage.getItem("currentUsername") : null;

  body.innerHTML = items.map(function (u) {
    var signedIn = signedInName && u.username === signedInName;
    return '' +
      '<tr>' +
        '<td data-label=""><div class="cell-with-thumb">' +
          '<span class="comment-avatar ' + commentAvatarClass(u.username) + '" aria-hidden="true">' + avatarInner(u.username) + '</span>' +
          '<span><strong>' + escapeHtml(u.name || u.username) + '</strong>' +
          (u.name ? ' <span class="meta">@' + escapeHtml(u.username) + '</span>' : '') +
          (signedIn ? ' <span class="badge badge-green">' + t("SIGNED IN") + '</span>' : '') +
          '</span></div></td>' +
        '<td data-label="' + t("Phone") + '">' + escapeHtml(u.phone || "-") + '</td>' +
        '<td data-label="' + t("Address") + '">' + escapeHtml(u.address || "-") + '</td>' +
        '<td data-label="' + t("Joined") + '">' + formatDate(u.joined || "") + '</td>' +
        '<td data-label="' + t("Actions") + '">' +
          '<div class="action-buttons">' +
            '<button class="btn btn-small" type="button" onclick="viewUser(\'' + u.id + '\')">' + t("VIEW") + '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="deleteUser(\'' + u.id + '\')">' + t("DELETE") + '</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
  }).join("");
}

// Open the shared detail modal with the profile + activity summary
function viewUser(id) {
  var u = loadUsers().find(function (x) { return x.id === id; });
  if (!u) return;

  var bookmarks = loadBookmarks().filter(function (b) { return b.username === u.username; }).length;
  var comments = loadComments().filter(function (c) { return c.username === u.username; }).length;
  var rsvps = loadRsvps().filter(function (r) { return r.username === u.username; }).length;
  var signedIn = localStorage.getItem("userLoggedIn") === "true" &&
    localStorage.getItem("currentUsername") === u.username;

  var rows = [
    [t("Display Name"), escapeHtml(u.name || "-")],
    [t("Username"), escapeHtml(u.username)],
    [t("Phone"), escapeHtml(u.phone || "-")],
    [t("Address"), escapeHtml(u.address || "-")],
    [t("Joined"), formatDate(u.joined || "")],
    [t("Status"), signedIn ? t("Currently signed in") : t("Not signed in")],
    [t("Saved items"), bookmarks],
    [t("Comments"), comments],
    [t("Event RSVPs"), rsvps]
  ].map(function (pair) {
    return '<p class="detail-row"><strong>' + pair[0] + ':</strong> ' + pair[1] + '</p>';
  }).join("");

  openDetailModal(u.username, t("Registered community member"), rows);
}

// Remove the account and everything tied to it
function deleteUser(id) {
  var u = loadUsers().find(function (x) { return x.id === id; });
  if (!u) return;

  openConfirmModal("Are you sure you want to delete this user?", "DELETE", function () {
    saveUsers(loadUsers().filter(function (x) { return x.id !== id; }));
    setData("communityBookmarks", loadBookmarks().filter(function (b) { return b.username !== u.username; }));
    setData("communityComments", loadComments().filter(function (c) { return c.username !== u.username; }));
    setData("communityRsvps", loadRsvps().filter(function (r) { return r.username !== u.username; }));
    renderUserTable();
    updateDashboardStats();
    logAudit("deleted user", u.username);
    showToast(t("User deleted."), "success");
  });
}

function initUsersAdmin() {
  bindTableSearch("usersTableSearch", renderUserTable);
  renderUserTable();
}

initUsersAdmin();

/* ------------------------------------------------------------
   21a. BARANGAY OFFICIALS + CERTIFICATE SERVICES
   The admin creates and manages Barangay Official accounts here.
   Officials sign in through the same login form as residents but
   land on official-dashboard.html. Residents file certificate
   requests from their dashboard; every request notifies the
   officials and can be reviewed and printed from their dashboard.
   Official accounts are stored with the same one-way h$ password
   fingerprint as resident accounts (school project - not real auth).
   ------------------------------------------------------------ */

// Only Barangay Officials can be added; the admin types their barangay name
var OFFICIAL_ROLE = "Barangay Official";

// The certificate services residents can request
var CERT_TYPES = [
  { key: "indigency", label: "Barangay Certificate of Indigency" },
  { key: "clearance", label: "Barangay Clearance" },
  { key: "residency", label: "Certificate of Residency" },
  { key: "goodmoral", label: "Certificate of Good Moral Character" },
  { key: "business", label: "Barangay Business Clearance" }
];

var CERT_STATUSES = {
  pending: "Pending",
  ready: "Ready for Pickup",
  released: "Released",
  rejected: "Rejected"
};

function certTypeLabel(key) {
  var found = CERT_TYPES.filter(function (c) { return c.key === key; })[0];
  return found ? found.label : key;
}

// The barangays a resident can pick from: only the ones the admin has
// created (i.e. the distinct barangays that official accounts belong to).
function normalizeBarangay(value) {
  return String(value || "").trim().toLowerCase();
}

function barangayOptions() {
  var set = {};
  loadOfficials().forEach(function (o) {
    var b = String(o.barangay || "").trim();
    if (b) set[b] = true;
  });
  return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
}

// The barangay the signed-in official serves (normalized), or ""
function officialBarangay() {
  var off = getSessionOfficial();
  return normalizeBarangay(off ? off.barangay : "");
}

function loadOfficials() { return getData(OFFICIALS_KEY, []); }
function saveOfficials(list) { return setData(OFFICIALS_KEY, list); }

function loadCertRequests() { return getData(CERT_REQUESTS_KEY, []); }
function saveCertRequests(list) { return setData(CERT_REQUESTS_KEY, list); }

// The official account currently signed in (or null)
function getSessionOfficial() {
  var username = localStorage.getItem("currentOfficial");
  if (!username) return null;
  var list = loadOfficials();
  for (var i = 0; i < list.length; i++) {
    if (list[i].username === username) return list[i];
  }
  return null;
}

// A short human-friendly reference number, e.g. CC-2026-48213
function makeCertRef() {
  return "CC-" + new Date().getFullYear() + "-" + String(Date.now()).slice(-5);
}

/* ---- Incident reporting (Barangay Services) ----
   Residents report accidents and other emergencies in their area. Each report
   is routed to the officials of the barangay the resident selects and shows up
   on that official's dashboard and notification bell right away. */

var INCIDENTS_KEY = "incidentReports";

var INCIDENT_TYPES = [
  { key: "accident", label: "Vehicular Accident" },
  { key: "fire", label: "Fire" },
  { key: "flood", label: "Flood / Typhoon" },
  { key: "crime", label: "Crime / Theft" },
  { key: "medical", label: "Medical Emergency" },
  { key: "utility", label: "Utility / Power Problem" },
  { key: "other", label: "Other Emergency" }
];

var INCIDENT_STATUSES = {
  reported: "Reported",
  responding: "Responding",
  resolved: "Resolved"
};

function incidentTypeLabel(key) {
  var found = INCIDENT_TYPES.filter(function (c) { return c.key === key; })[0];
  return found ? found.label : key;
}

function loadIncidents() { return getData(INCIDENTS_KEY, []); }
function saveIncidents(list) { return setData(INCIDENTS_KEY, list); }

// A short human-friendly incident reference, e.g. INC-2026-48213
function makeIncidentRef() {
  return "INC-" + new Date().getFullYear() + "-" + String(Date.now()).slice(-5);
}

/* ---- Admin: manage Barangay Officials ---- */

var officialEditingId = null;

function officialStatusPill(o) {
  var active = o.active !== false;
  return '<span class="status-pill ' + (active ? "status-released" : "status-pending") + '">' +
    t(active ? "Active" : "Inactive") + "</span>";
}

function renderOfficialsTable() {
  var body = document.getElementById("officialsTableBody");
  if (!body) return;
  var q = getTableQuery("officialsTableSearch");
  var list = loadOfficials().slice().sort(function (a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  var shown = list.filter(function (o) {
    if (!q) return true;
    return [o.name, o.username, o.barangay, o.email, o.phone, o.joined]
      .join(" ").toLowerCase().indexOf(q) !== -1;
  });
  updateTableCount("officialsTableCount", shown.length, list.length);

  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">' +
      t("No barangay officials yet. Add one using the form above.") + "</td></tr>";
    return;
  }

  body.innerHTML = shown.map(function (o) {
    var active = o.active !== false;
    return "<tr>" +
      "<td><strong>" + escapeHtml(o.name || "-") + "</strong></td>" +
      "<td>" + escapeHtml(o.barangay || "-") + "</td>" +
      "<td>" + escapeHtml(o.username || "-") + "</td>" +
      "<td>" + officialStatusPill(o) + "</td>" +
      "<td>" + formatDate(o.joined || "") + "</td>" +
      "<td class=\"table-actions\">" +
        '<button type="button" class="btn btn-small" onclick="editOfficial(\'' + o.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 12c-4.8-3.4-11.9-3.4-16.7 0L4 12V20L22 4l-1.4-1.4L10.4 18l-2.3 1.1l-1.1-2.3z"/></svg>' +
        "</button> " +
        '<button type="button" class="btn btn-small" onclick="toggleOfficialActive(\'' + o.id + '\')">' +
          t(active ? "DEACTIVATE" : "ACTIVATE") + "</button> " +
        '<button type="button" class="btn btn-small btn-danger" onclick="deleteOfficial(\'' + o.id + '\')">' + t("DELETE") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

// Show/hide the "Add Barangay Official" form behind its button
function setOfficialFormOpen(open) {
  var box = document.getElementById("officialFormBox");
  if (box) box.classList.toggle("hidden", !open);
  var toggle = document.getElementById("officialToggleBtn");
  if (toggle) {
    toggle.classList.toggle("hidden", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (open) {
    var first = document.getElementById("officialName");
    if (first && first.focus) first.focus({ preventScroll: true });
  }
}

function resetOfficialForm() {
  var form = document.getElementById("officialForm");
  if (!form) return;
  officialEditingId = null;
  form.reset();
  var title = document.getElementById("officialFormTitle");
  var btn = document.getElementById("officialSubmitBtn");
  if (title) title.textContent = t("Add Barangay Official");
  if (btn) btn.textContent = t("ADD OFFICIAL");
  var cancel = document.getElementById("officialCancelBtn");
  if (cancel) cancel.classList.add("hidden");
  var pass = document.getElementById("officialPassword");
  if (pass) pass.required = true;
  setOfficialFormOpen(false);
}

function editOfficial(id) {
  var o = loadOfficials().filter(function (x) { return x.id === id; })[0];
  if (!o) return;
  officialEditingId = id;
  document.getElementById("officialName").value = o.name || "";
  document.getElementById("officialBarangay").value = o.barangay || "";
  document.getElementById("officialUsername").value = o.username || "";
  document.getElementById("officialPassword").value = "";
  document.getElementById("officialEmail").value = o.email || "";
  document.getElementById("officialPhone").value = o.phone || "";
  var title = document.getElementById("officialFormTitle");
  var btn = document.getElementById("officialSubmitBtn");
  if (title) title.textContent = t("Edit Barangay Official");
  if (btn) btn.textContent = t("SAVE CHANGES");
  var cancel = document.getElementById("officialCancelBtn");
  if (cancel) cancel.classList.remove("hidden");
  var pass = document.getElementById("officialPassword");
  if (pass) pass.required = false;
  showAdminSection("users");
  setOfficialFormOpen(true);
  var box = document.getElementById("officialFormBox");
  if (box && box.scrollIntoView) box.scrollIntoView({ block: "start", behavior: "smooth" });
}

function toggleOfficialActive(id) {
  var list = loadOfficials();
  var o = list.filter(function (x) { return x.id === id; })[0];
  if (!o) return;
  o.active = o.active === false;
  saveOfficials(list);
  renderOfficialsTable();
  logAudit(o.active ? "activated official" : "deactivated official", o.username);
  showToast(t(o.active ? "Official account activated." : "Official account deactivated."), "success");
}

function deleteOfficial(id) {
  var o = loadOfficials().filter(function (x) { return x.id === id; })[0];
  if (!o) return;
  openConfirmModal("Are you sure you want to delete this Barangay Official account?", "DELETE", function () {
    saveOfficials(loadOfficials().filter(function (x) { return x.id !== id; }));
    // If that official is currently signed in, end the session too
    if (localStorage.getItem("currentOfficial") === o.username) {
      localStorage.setItem("officialLoggedIn", "false");
      localStorage.removeItem("currentOfficial");
    }
    renderOfficialsTable();
    logAudit("deleted official", o.username);
    showToast(t("Barangay Official deleted."), "success");
  });
}

function initOfficialsAdmin() {
  var form = document.getElementById("officialForm");
  if (!form) return;
  bindTableSearch("officialsTableSearch", renderOfficialsTable);
  renderOfficialsTable();

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var name = document.getElementById("officialName").value.trim();
    var barangay = document.getElementById("officialBarangay").value.trim();
    var username = document.getElementById("officialUsername").value.trim();
    var password = document.getElementById("officialPassword").value;
    var email = document.getElementById("officialEmail").value.trim();
    var phone = document.getElementById("officialPhone").value.trim();

    if (name.length < 3) { showToast(t("Please enter the official's full name."), "error"); return; }
    if (barangay.length < 2) { showToast(t("Please enter the barangay."), "error"); return; }
    if (username.length < 3) { showToast(t("Username must be at least 3 characters."), "error"); return; }

    var list = loadOfficials();
    var duplicate = list.some(function (o) {
      return o.username.toLowerCase() === username.toLowerCase() && o.id !== officialEditingId;
    });
    // Also keep official usernames from clashing with resident usernames
    var residentClash = loadUsers().some(function (u) {
      return String(u.username).toLowerCase() === username.toLowerCase();
    });
    if (duplicate || residentClash) {
      showToast(t("That username is already taken."), "error");
      return;
    }

    if (officialEditingId) {
      list = list.map(function (o) {
        if (o.id !== officialEditingId) return o;
        o.name = name;
        o.barangay = barangay;
        o.position = OFFICIAL_ROLE;
        o.username = username;
        o.email = email;
        o.phone = phone;
        if (password) {
          if (password.length < 6) return o;
          o.password = hashPassword(password);
        }
        return o;
      });
      saveOfficials(list);
      logAudit("updated official", username);
      showToast(t("Barangay Official updated."), "success");
    } else {
      if (password.length < 6) { showToast(t("Password must be at least 6 characters."), "error"); return; }
      list.push({
        id: generateId(),
        username: username,
        name: name,
        position: OFFICIAL_ROLE,
        barangay: barangay,
        email: email,
        phone: phone,
        password: hashPassword(password),
        joined: new Date().toISOString().slice(0, 10),
        active: true
      });
      saveOfficials(list);
      logAudit("added official", username);
      showToast(t("Barangay Official added. They can now sign in on the login page."), "success");
    }

    resetOfficialForm();
    renderOfficialsTable();
  });

  var cancel = document.getElementById("officialCancelBtn");
  if (cancel) cancel.addEventListener("click", resetOfficialForm);

  var toggle = document.getElementById("officialToggleBtn");
  if (toggle) toggle.addEventListener("click", function () { setOfficialFormOpen(true); });

  var back = document.getElementById("officialBackBtn");
  if (back) back.addEventListener("click", resetOfficialForm);
}

initOfficialsAdmin();

/* ---- Certificate request helpers (shared by dashboards) ---- */

// Open one request in the shared detail modal.
// `withActions` adds the official's review buttons (ready / print).
function openCertRequestDetail(id, withActions) {
  var req = loadCertRequests().filter(function (r) { return r.id === id; })[0];
  if (!req) return;
  var d = req.details || {};
  var status = CERT_STATUSES[req.status] ? req.status : "pending";

  var rows = [
    [t("Reference No."), escapeHtml(req.ref || "-")],
    [t("Barangay"), escapeHtml(req.barangay || "-")],
    [t("Certificate"), escapeHtml(t(certTypeLabel(req.type)))],
    [t("Resident"), escapeHtml(req.name || req.username || "-")],
    [t("Username"), escapeHtml(req.username || "-")],
    [t("Age"), escapeHtml(d.age || "-")],
    [t("Civil Status"), escapeHtml(t(d.civilStatus || "-"))],
    [t("Address"), escapeHtml(d.address || req.address || "-")],
    [t("Contact Number"), escapeHtml(req.contact || "-")],
    [t("Years of Residency"), escapeHtml(d.yearsResident || "-")],
    [t("Business Name"), escapeHtml(d.businessName || "-")],
    [t("Purpose"), escapeHtml(req.purpose || "-")],
    [t("Date Requested"), formatDate(req.date || "")],
    [t("Status"), certStatusPill(status)],
    [t("Remarks"), escapeHtml(req.remarks || "-")],
    [t("Released To"), escapeHtml(req.claimedBy || "-")],
    [t("ID / Reference"), escapeHtml(req.claimantId || "-")],
    [t("Printed By"), escapeHtml(req.printedBy || "-")],
    [t("Date Printed"), req.printedDate ? formatDate(req.printedDate) : "-"]
  ].filter(function (pair) {
    // Hide inapplicable optional rows
    if (pair[0] === t("Years of Residency") && !d.yearsResident) return false;
    if (pair[0] === t("Business Name") && !d.businessName) return false;
    if (pair[0] === t("Age") && !d.age) return false;
    if (pair[0] === t("Remarks") && !req.remarks) return false;
    if (pair[0] === t("Released To") && !req.claimedBy) return false;
    if (pair[0] === t("ID / Reference") && !req.claimantId) return false;
    if (pair[0] === t("Printed By") && !req.printedBy) return false;
    if (pair[0] === t("Date Printed") && !req.printedDate) return false;
    return true;
  }).map(function (pair) {
    return '<p class="detail-row"><strong>' + pair[0] + ":</strong> " + pair[1] + "</p>";
  }).join("");

  var actions = "";
  if (withActions) {
    var releaseBox = (status === "ready")
      ? '<div class="cert-release-box">' +
          '<label for="certClaimant">' + t("Released To (name)") + "</label>" +
          '<input type="text" id="certClaimant" maxlength="80" placeholder="' + t("Name of person claiming") + '">' +
          '<label for="certClaimantId">' + t("ID / Reference") + "</label>" +
          '<input type="text" id="certClaimantId" maxlength="60" placeholder="' + t("Valid ID or reference no.") + '">' +
        "</div>"
      : "";
    var rejectBox = (status !== "released" && status !== "rejected")
      ? '<details class="cert-reject-box"><summary>' + t("Reject with remarks") + "</summary>" +
          '<textarea id="certRemarks" rows="2" maxlength="300" placeholder="' + t("Reason (shown to the resident)") + '"></textarea>' +
          '<button type="button" class="btn btn-small btn-danger" id="certRejectBtn">' + t("REJECT REQUEST") + "</button>" +
        "</details>"
      : "";
    actions = releaseBox + rejectBox +
      '<div class="modal-actions-row">' +
        (status === "pending"
          ? '<button type="button" class="btn btn-success" id="certReadyBtn">' + t("MARK AS READY") + "</button>"
          : "") +
        (status !== "rejected"
          ? '<button type="button" class="btn" id="certPrintBtn">' + t("PRINT CERTIFICATE") + "</button>"
          : "") +
      "</div>";
  }

  openDetailModal(t("Certificate Request"), escapeHtml(req.ref || ""), rows + actions);

  if (withActions) {
    var readyBtn = document.getElementById("certReadyBtn");
    if (readyBtn) {
      readyBtn.addEventListener("click", function () { markCertRequestReady(id); });
    }
    var printBtn = document.getElementById("certPrintBtn");
    if (printBtn) {
      printBtn.addEventListener("click", function () {
        var c = document.getElementById("certClaimant");
        var ci = document.getElementById("certClaimantId");
        printCertificate(id, c ? c.value.trim() : "", ci ? ci.value.trim() : "");
      });
    }
    var rejectBtn = document.getElementById("certRejectBtn");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", function () {
        var r = document.getElementById("certRemarks");
        rejectCertRequest(id, r ? r.value.trim() : "");
      });
    }
  }
}

function rejectCertRequest(id, remarks) {
  if (!remarks) { showToast(t("Please add a reason for rejecting."), "error"); return; }
  var list = loadCertRequests();
  var rec = list.filter(function (r) { return r.id === id; })[0];
  if (!rec) return;
  rec.status = "rejected";
  rec.remarks = remarks;
  rec.updated = new Date().toISOString();
  saveCertRequests(list);
  closeDetailModal();
  renderOfficialRequests();
  renderOfficialDashboardStats();
  if (typeof renderMyRequests === "function") renderMyRequests();
  notifyBus.post();
  showToast(t("Request rejected and the resident was informed."), "success");
  logAudit("rejected certificate", (rec.ref || id) + " - " + remarks);
}

function certStatusPill(status) {
  var cls = status === "released" ? "status-released"
    : status === "ready" ? "status-ready"
    : status === "rejected" ? "status-rejected"
    : "status-pending";
  return '<span class="status-pill ' + cls + '">' + t(CERT_STATUSES[status] || "Pending") + "</span>";
}

function markCertRequestReady(id) {
  var list = loadCertRequests();
  var req = list.filter(function (r) { return r.id === id; })[0];
  if (!req) return;
  req.status = "ready";
  req.updated = new Date().toISOString();
  saveCertRequests(list);
  closeDetailModal();
  if (typeof renderOfficialRequests === "function") renderOfficialRequests();
  if (typeof renderOfficialDashboardStats === "function") renderOfficialDashboardStats();
  showToast(t("Request marked as ready for pickup."), "success");
}

/* ---- Certificate printing ----
   Builds a clean printable document in a hidden iframe and opens
   the browser's print dialog. Printing marks the request released. */
function printCertificate(id, claimantName, claimantId) {
  var list = loadCertRequests();
  var req = list.filter(function (r) { return r.id === id; })[0];
  if (!req) return;
  var official = getSessionOfficial();
  var printBarangay = req.barangay || (official && official.barangay) || "";
  var printedBy = official
    ? (official.name + " - " + t(OFFICIAL_ROLE) + (printBarangay ? " (" + printBarangay + ")" : ""))
    : t(OFFICIAL_ROLE);

  var frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);

  var doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(certificateDocumentHtml(req, official));
  doc.close();

  var done = false;
  function cleanup() {
    if (done) return;
    done = true;
    // Mark released + record who printed it
    list = loadCertRequests();
    var rec = list.filter(function (r) { return r.id === id; })[0];
    if (rec) {
      rec.status = "released";
      rec.printedBy = printedBy;
      rec.printedDate = new Date().toISOString().slice(0, 10);
      if (claimantName) rec.claimedBy = claimantName;
      if (claimantId) rec.claimantId = claimantId;
      rec.updated = new Date().toISOString();
      saveCertRequests(list);
    }
    setTimeout(function () {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }, 500);
    closeDetailModal();
    if (typeof renderOfficialRequests === "function") renderOfficialRequests();
    if (typeof renderOfficialDashboardStats === "function") renderOfficialDashboardStats();
    if (typeof renderMyRequests === "function") renderMyRequests();
    notifyBus.post();
    showToast(t("Certificate printed and marked as released."), "success");
  }

  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (e) {}
  // afterprint fires when the dialog closes; fall back to a timer
  try {
    frame.contentWindow.addEventListener("afterprint", cleanup);
  } catch (e) {}
  setTimeout(cleanup, 1500);

  function certificateDocumentHtml(r, off) {
    var d = r.details || {};
    var typeLabel = certTypeLabel(r.type).toUpperCase();
    var today = formatDate(new Date().toISOString().slice(0, 10));
    var name = r.name || r.username || "";
    var address = d.address || r.address || "";
    var purpose = r.purpose || "whatever legal purpose it may serve";
    var barangayName = r.barangay || (off && off.barangay) || "Barangay Central";

    var body = "";
    if (r.type === "indigency") {
      body = "This is to certify that <strong>" + escapeHtml(name) + "</strong>, " +
        (d.age ? escapeHtml(d.age) + " years old, " : "") +
        (d.civilStatus ? escapeHtml(t(d.civilStatus)).toLowerCase() + ", " : "") +
        "and a bona fide resident of " + escapeHtml(address) + ", is one of the indigent residents of this Barangay.";
    } else if (r.type === "clearance") {
      body = "This is to certify that <strong>" + escapeHtml(name) + "</strong>, " +
        (d.age ? escapeHtml(d.age) + " years old, " : "") +
        "a resident of " + escapeHtml(address) + ", has no derogatory record filed in this Barangay as of this date.";
    } else if (r.type === "residency") {
      body = "This is to certify that <strong>" + escapeHtml(name) + "</strong>, " +
        (d.age ? escapeHtml(d.age) + " years old, " : "") +
        "is a bona fide resident of " + escapeHtml(address) + ", Barangay Central" +
        (d.yearsResident ? ", and has been residing in this Barangay for " + escapeHtml(d.yearsResident) + " year(s)" : "") + ".";
    } else if (r.type === "goodmoral") {
      body = "This is to certify that <strong>" + escapeHtml(name) + "</strong>, " +
        (d.age ? escapeHtml(d.age) + " years old, " : "") +
        "a resident of " + escapeHtml(address) + ", is known to be of good moral character and reputation in this community, " +
        "with no pending complaint or case filed before this Barangay.";
    } else if (r.type === "business") {
      body = "This is to certify that the business establishment <strong>" + escapeHtml(d.businessName || "-") + "</strong>, " +
        "owned and operated by <strong>" + escapeHtml(name) + "</strong>, located at " + escapeHtml(address) + ", " +
        "has no pending complaint or violation filed before this Barangay as of this date.";
    }

    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>" + escapeHtml(typeLabel) + "</title>" +
      "<style>" +
      "@page { size: A4; margin: 18mm 16mm; }" +
      "body { font-family: 'Times New Roman', Georgia, serif; color: #111; margin: 0; }" +
      ".cert-head { text-align: center; line-height: 1.4; }" +
      ".cert-head .republic { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }" +
      ".cert-head .province { font-size: 12px; }" +
      ".cert-head h1 { font-size: 17px; letter-spacing: .12em; margin: 10px 0 2px; }" +
      ".cert-head .office { font-size: 12.5px; font-style: italic; }" +
      ".rule { border: none; border-top: 2px solid #111; margin: 14px 0 6px; }" +
      ".rule-thin { border: none; border-top: 1px solid #111; margin: 2px 0 26px; }" +
      "h2.cert-title { text-align: center; font-size: 20px; letter-spacing: .1em; margin: 0 0 4px; }" +
      ".to-whom { text-align: center; font-size: 12px; letter-spacing: .18em; margin: 0 0 26px; }" +
      ".cert-body { font-size: 14px; line-height: 2; text-align: justify; text-indent: 40px; }" +
      ".cert-issued { font-size: 13.5px; line-height: 1.9; margin-top: 22px; }" +
      ".cert-ref { font-size: 11.5px; color: #333; margin-top: 30px; }" +
      ".sign-block { margin-top: 54px; text-align: right; }" +
      ".sign-name { font-size: 14px; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #111; display: inline-block; padding: 0 22px 3px; }" +
      ".sign-pos { font-size: 12.5px; margin-top: 4px; }" +
      ".sign-office { font-size: 11.5px; color: #333; margin-top: 2px; }" +
      "</style></head><body>" +
      '<div class="cert-head">' +
        '<div class="republic">Republic of the Philippines</div>' +
        '<div class="province">Province of Isabela &middot; Municipality of San Mateo</div>' +
        '<h1>' + escapeHtml(barangayName.toUpperCase()) + '</h1>' +
        '<div class="office">Office of the Punong Barangay</div>' +
      "</div>" +
      '<hr class="rule"><hr class="rule-thin">' +
      '<h2 class="cert-title">' + escapeHtml(typeLabel) + "</h2>" +
      '<p class="to-whom">TO WHOM IT MAY CONCERN</p>' +
      '<p class="cert-body">' + body + "</p>" +
      '<p class="cert-issued">Issued this ' + escapeHtml(today) + " at " + escapeHtml(barangayName) + ", upon the request of the above-named person for " +
        escapeHtml(purpose) + ".</p>" +
      '<p class="cert-ref">Reference No.: ' + escapeHtml(r.ref || "-") + "</p>" +
      '<div class="sign-block">' +
        '<span class="sign-name">' + escapeHtml(off ? off.name : "Barangay Official") + "</span>" +
        '<div class="sign-pos">' + escapeHtml(t(OFFICIAL_ROLE)) + '</div>' +
        '<div class="sign-office">' + escapeHtml(barangayName) + ', San Mateo, Isabela</div>' +
      "</div>" +
      "</body></html>";
  }
}

/* ------------------------------------------------------------
   21. USER ACCOUNTS - REGISTER / LOGIN / LOGOUT (demo only)
   Passwords are stored as a one-way "h$" fingerprint in LocalStorage
   (legacy plain-text values are still accepted on login) because
   this is a frontend school project, not real authentication.
   ------------------------------------------------------------ */

function loadUsers() {
  return getData("communityUsers", []);
}

function saveUsers(list) {
  setData("communityUsers", list);
}

// The username of the person currently logged in
function getSessionUser() {
  var username = localStorage.getItem("currentUsername");
  if (!username) return null;
  var users = loadUsers();
  for (var i = 0; i < users.length; i++) {
    if (users[i].username === username) return users[i];
  }
  return null;
}

// The identity used for community interactions (like / comment / save / RSVP).
// A signed-in resident uses their username; a signed-in Barangay Official uses
// a prefixed id so officials can interact on their dashboard without clashing
// with resident accounts.
function getActor() {
  var official = typeof getSessionOfficial === "function" ? getSessionOfficial() : null;
  var user = getSessionUser();
  // The dashboard you are on decides which identity acts, so a lingering
  // resident session never posts as the official (and vice versa).
  if (document.body.classList.contains("official-body") && official) {
    return { username: "official:" + official.username, name: official.name || official.username, official: true };
  }
  if (user) return { username: user.username, name: user.name || user.username, resident: true };
  if (official) {
    return {
      username: "official:" + official.username,
      name: official.name || official.username,
      official: true
    };
  }
  return null;
}

// Update the "User Login | Register" link on the public pages
function updateTopbarUser() {
  var area = document.getElementById("userAuthArea");
  if (!area) return;
  if (localStorage.getItem("officialLoggedIn") === "true") {
    area.innerHTML = '<a href="official-dashboard.html">Official Dashboard</a>';
    return;
  }
  if (localStorage.getItem("userLoggedIn") === "true") {
    area.innerHTML = '<a href="user-dashboard.html">My Dashboard</a>';
  }
}

function initRegisterPage() {
  var form = document.getElementById("registerForm");
  if (!form) return;

  // Already logged in? Go to the dashboard. (Skipped on the combined VERSO
  // auth card, which must stay usable while a session is active.)
  var combinedAuthCard = !!document.getElementById("versoCard");
  if (!combinedAuthCard && localStorage.getItem("userLoggedIn") === "true") {
    window.location.href = "user-dashboard.html";
    return;
  }

  function setFieldState(groupId, isValid) {
    var group = document.getElementById(groupId);
    group.classList.toggle("invalid", !isValid);
    return isValid;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var username = document.getElementById("regUsername").value.trim();
    var password = document.getElementById("regPassword").value;
    var confirm = document.getElementById("regConfirm").value;

    var okUser = setFieldState("regGroupUsername", username.length >= 3);
    var okPass = setFieldState("regGroupPassword", password.length >= 6);
    var okConfirm = setFieldState("regGroupConfirm", confirm === password && confirm.length >= 6);

    var errorBox = document.getElementById("registerError");
    var successBox = document.getElementById("registerSuccess");
    errorBox.classList.remove("show");
    successBox.classList.remove("show");

    if (!okUser || !okPass || !okConfirm) {
      errorBox.textContent = "Please fix the errors below and try again.";
      errorBox.classList.add("show");
      return;
    }

    // Check if the username is already used (ignore letter case)
    var users = loadUsers();
    var exists = users.some(function (u) {
      return u.username.toLowerCase() === username.toLowerCase();
    });
    // Official usernames are reserved too - one shared login serves both roles
    if (!exists) {
      exists = loadOfficials().some(function (o) {
        return String(o.username).toLowerCase() === username.toLowerCase();
      });
    }
    if (exists) {
      errorBox.textContent = "This username is already taken.";
      errorBox.classList.add("show");
      return;
    }

    // Optional profile details (only present on the VERSO combined card)
    var nameEl = document.getElementById("regFullName");
    var emailEl = document.getElementById("regEmail");
    var fullName = nameEl ? nameEl.value.trim() : "";
    var email = emailEl ? emailEl.value.trim() : "";
    var joined = new Date().toISOString().split("T")[0];

    // Create the account (password stored as a one-way hash)
    var newUserId = generateId();
    var passwordHash = hashPassword(password);
    users.push({
      id: newUserId,
      username: username,
      name: fullName,
      email: email,
      password: passwordHash,
      phone: "",
      address: "",
      joined: joined
    });
    saveUsers(users);

    // Mirror into the registeredUsers directory requested by the VERSO
    // sign-up flow (same hashed password, never plaintext).
    var registered = getData("registeredUsers", []);
    if (!registered.some(function (r) {
      return String(r.username || "").toLowerCase() === username.toLowerCase();
    })) {
      registered.push({
        id: newUserId,
        username: username,
        name: fullName,
        email: email,
        password: passwordHash,
        joined: joined
      });
      setData("registeredUsers", registered);
    }

    // Tell the admin a new member joined
    notifyAdmin("register", username, {
      targetType: "user",
      targetId: newUserId,
      targetTitle: username
    });

    // Go to the login page after a short delay
    successBox.classList.add("show");
    form.reset();
    setTimeout(function () {
      window.location.href = "user-login.html";
    }, 900);
  });

  // Clear error state while typing
  ["regUsername", "regPassword", "regConfirm"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", function () {
      this.closest(".form-group").classList.remove("invalid");
    });
  });
}

function initUserLoginPage() {
  var form = document.getElementById("userLoginForm");
  if (!form) return;

  // Password visibility is handled by initVersoAuthCard() when the VERSO
  // card is present; this keeps the plain page working too.

  // Session status: resident and official sessions are independent, so an
  // official may be signed in elsewhere while a resident signs in here (and
  // vice versa). Show who is active but keep the form usable so the other role
  // can sign in too - no silent disable/redirect loop.
  var activeOfficial = localStorage.getItem("officialLoggedIn") === "true";
  var activeResident = localStorage.getItem("userLoggedIn") === "true";
  if (activeOfficial || activeResident) {
    // Info box hidden - user can sign in below as another account
  }

  setupLoginLimiter(form, "user");

  // Demo password recovery: type username, pick a new password
  var forgotLink = document.getElementById("forgotPasswordLink");
  if (forgotLink) {
    forgotLink.addEventListener("click", function (e) {
      e.preventDefault();
      var name = prompt("Enter your username to reset the password:");
      if (!name) return;
      name = name.trim();
      var list = loadUsers();
      var target = list.find(function (u) {
        return u.username.toLowerCase() === name.toLowerCase();
      });
      if (!target) {
        alert("No account found with that username.");
        return;
      }
      var pass = prompt("Enter a new password (at least 6 characters):");
      if (pass === null) return;
      if (pass.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
      }
      var pass2 = prompt("Type the new password again:");
      if (pass2 !== pass) {
        alert("Passwords do not match.");
        return;
      }
      target.password = hashPassword(pass);
      saveUsers(list);
      clearLoginAttempts("user");
      alert("Password updated. You can sign in now.");
      var uField = document.getElementById("userUsername");
      var pField = document.getElementById("userPassword");
      if (uField) uField.value = target.username;
      if (pField) pField.focus();
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    if (isLoginLocked("user")) return;

    var username = document.getElementById("userUsername").value.trim();
    var password = document.getElementById("userPassword").value;
    var errorBox = document.getElementById("userLoginError");

    var users = loadUsers();
    var found = users.find(function (u) {
      return u.username.toLowerCase() === username.toLowerCase() &&
        verifyPassword(password, u.password);
    });

    if (found) {
      // Upgrade an old plain-text account to the hashed format
      if (!isHashedPassword(found.password)) {
        found.password = hashPassword(password);
        saveUsers(users);
      }
      clearLoginAttempts("user");
      // Resident and official sessions live under separate keys, so signing in
      // as one role must not sign the other out. This lets a resident report an
      // incident while the barangay official views their dashboard in another
      // tab (the report still needs the resident session to be attributed).
      localStorage.setItem("userLoggedIn", "true");
      localStorage.setItem("currentUsername", found.username);
      // VERSO sign-in mirror: the portal session key the auth card writes
      setData("userLogin", {
        username: found.username,
        loggedIn: true,
        time: new Date().toISOString()
      });
      window.location.href = "user-dashboard.html";
      return;
    }

    // Not a resident account? Check Barangay Officials. The same login
    // form serves both roles - the account's role decides which
    // dashboard opens next.
    var officials = loadOfficials();
    var official = officials.find(function (o) {
      return o.username.toLowerCase() === username.toLowerCase() &&
        verifyPassword(password, o.password);
    });

    if (official) {
      if (official.active === false) {
        errorBox.textContent = "This official account has been deactivated.";
        errorBox.classList.remove("alert-info");
        errorBox.classList.add("alert-error", "show");
        return;
      }
      if (!isHashedPassword(official.password)) {
        official.password = hashPassword(password);
        saveOfficials(officials);
      }
      clearLoginAttempts("user");
      // Keep any active resident session: the two roles coexist so an official
      // can watch their dashboard while a resident reports incidents.
      localStorage.setItem("officialLoggedIn", "true");
      localStorage.setItem("currentOfficial", official.username);
      window.location.href = "official-dashboard.html";
      return;
    }

    registerLoginFailure("user", form, errorBox);
  });
}

// Logout: clear the session and go back to the login page
function userLogout() {
  localStorage.setItem("userLoggedIn", "false");
  localStorage.removeItem("currentUsername");
  setData("userLogin", { username: "", loggedIn: false, time: new Date().toISOString() });
  window.location.href = "user-login.html";
}

// Protect user-dashboard.html: if not logged in, redirect
function requireUserLogin() {
  if (!document.body.classList.contains("user-body")) return;
  if (localStorage.getItem("userLoggedIn") !== "true") {
    window.location.href = "user-login.html";
  }
}

initRegisterPage();
initUserLoginPage();
initVersoAuthCard();
requireUserLogin();
requireOfficialLogin();
updateTopbarUser();

/* ------------------------------------------------------------
   22. USER DASHBOARD (Home, News, Announcements, Events,
   Activities, Gallery, Notifications, Profile)
   ------------------------------------------------------------ */

// Expand/collapse the "Barangay Services" group in the member sidebar
function setBarangayServicesOpen(open) {
  var menu = document.getElementById("barangayServicesMenu");
  if (menu) menu.classList.toggle("hidden", !open);
  var toggle = document.getElementById("barangayServicesToggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleBarangayServices() {
  var menu = document.getElementById("barangayServicesMenu");
  setBarangayServicesOpen(menu ? menu.classList.contains("hidden") : true);
}

// Show only the selected dashboard section
function showUserSection(name) {
  var sections = {
    home: "sectionDashHome",
    news: "sectionDashNews",
    announcements: "sectionDashAnnouncements",
    events: "sectionDashEvents",
    activities: "sectionDashActivities",
    gallery: "sectionDashGallery",
    certificates: "sectionDashCertificates",
    incidents: "sectionDashIncidents",
    feed: "sectionDashFeed",
    saved: "sectionDashSaved",
    notifications: "sectionDashNotifications",
    profile: "sectionDashProfile"
  };

  Object.keys(sections).forEach(function (key) {
    var section = document.getElementById(sections[key]);
    if (section) section.classList.toggle("hidden", key !== name);
  });

  // Keep the Barangay Services group open whenever its section is shown
  if (name === "certificates" || name === "incidents") setBarangayServicesOpen(true);

  var links = document.querySelectorAll("#userSidebar a[data-usection]");
  links.forEach(function (link) {
    var isActive = link.getAttribute("data-usection") === name;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  var sidebar = document.getElementById("userSidebar");
  if (sidebar) sidebar.classList.remove("open");
  if (typeof closeSidebarDrawer === "function") closeSidebarDrawer();

  // Keep the URL hash in sync so sections are deep-linkable
  try {
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  } catch (e) {}
}

// Build the notification list from important announcements
// and upcoming events (shown to the logged-in user)
function buildNotifications() {
  var list = [];
  var today = new Date().toISOString().split("T")[0];

  loadAnnouncementsList().forEach(function (a) {
    if (a.status === "Important" || a.status === "Notice" || a.status === "Active" || a.status === "Emergency") {
      list.push({
        type: "Announcement",
        title: a.title,
        date: a.date,
        text: a.description,
        category: a.category
      });
    }
  });

  loadEventsList().forEach(function (e) {
    if (e.date >= today) {
      list.push({
        type: "Event",
        title: e.name,
        date: e.date,
        text: e.time + " at " + e.location + " - " + e.description,
        category: "Events"
      });
    }
  });

  // Newest first, show at most 12
  list.sort(function (a, b) { return b.date.localeCompare(a.date); });
  return list.slice(0, 12);
}

// A notification is "NEW" when it was posted in the last 5 days
// or starts within the next 7 days
function isFreshNotification(dateString) {
  var notifDate = new Date(dateString + "T00:00:00").getTime();
  var now = new Date().getTime();
  var oneDay = 24 * 60 * 60 * 1000;
  var postedRecently = (now - notifDate) <= 5 * oneDay;
  var startingSoon = (notifDate - now) <= 7 * oneDay;
  return postedRecently && startingSoon;
}

function renderUserNotifications() {
  var box = document.getElementById("dashNotifications");
  if (!box) return;

  var items = buildNotifications();
  if (items.length === 0) {
    box.innerHTML = '<div class="empty-state"><p>' + t("No notifications right now.") + '</p></div>';
  } else {
    box.innerHTML = items.map(function (n) {
      var fresh = isFreshNotification(n.date);
      var kind = n.type === "Event" ? "event" : "announcement";
      return '' +
        '<div class="list-item">' +
          '<div class="item-content">' +
            '<p class="meta">' +
              '<span class="notif-label notif-label--' + kind + '">' + t(n.type.toUpperCase()) + '</span> ' +
              '<span class="badge">' + t(n.category) + '</span> ' +
              formatDate(n.date) +
              (fresh ? '<span class="notif-new">' + t("NEW") + '</span>' : '') +
            '</p>' +
            '<h3>' + escapeHtml(n.title) + '</h3>' +
            '<p class="item-desc">' + escapeHtml(shortText(n.text, 160)) + '</p>' +
          '</div>' +
        '</div>';
    }).join("");
  }

  // Sidebar badge + header bell dot (unread count, shared logic)
  updateNotifBell("user");
}

var notifHistoryFilter = "all";

function renderNotificationHistory() {
  var listBox = document.getElementById("notifHistoryList");
  if (!listBox) return;
  var prefs = loadNotifPrefs();
  var all = loadNotifications().filter(function (n) { return notifEnabled(n.type, prefs); });
  var items = notifHistoryFilter === "unread"
    ? all.filter(function (n) { return !n.read; })
    : all;

  var countEl = document.getElementById("notifHistoryCount");
  if (countEl) countEl.textContent = items.length + " " + t("notifications");

  if (!items.length) {
    listBox.innerHTML = '<div class="empty-state"><p>' +
      t(notifHistoryFilter === "unread" ? "No unread notifications." : "No notifications yet.") +
      "</p></div>";
  } else {
    listBox.innerHTML = items.map(notifItemHtml).join("");
  }
  renderNotificationSettings();
}

function renderNotificationSettings() {
  var box = document.getElementById("notifSettings");
  if (!box) return;
  var note = document.getElementById("notifSettingsNote");
  if (note) {
    note.textContent = t("Choose which resident activity should alert you. Turning a type off keeps its history but hides it from the bell and the count.");
  }
  var prefs = loadNotifPrefs();
  box.innerHTML = NOTIF_TYPES.map(function (tp) {
    return '<label class="notif-setting">' +
      '<input type="checkbox" data-notif-type="' + tp.key + '"' +
      (prefs[tp.key] !== false ? " checked" : "") + ">" +
      "<span>" + t(tp.label) + "</span>" +
      "</label>";
  }).join("");
}

function initNotificationHistory() {
  var section = document.getElementById("sectionNotifications");
  if (!section) return;

  renderNotificationHistory();

  var filters = document.getElementById("notifFilters");
  if (filters) {
    filters.addEventListener("click", function (event) {
      var btn = event.target.closest(".filter-btn");
      if (!btn) return;
      filters.querySelectorAll(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      notifHistoryFilter = btn.getAttribute("data-filter") || "all";
      renderNotificationHistory();
    });
  }

  var list = document.getElementById("notifHistoryList");
  if (list) {
    list.addEventListener("click", function (event) {
      var item = event.target.closest(".notif-item");
      if (item && item.getAttribute("data-notif-id")) {
        openNotification(item.getAttribute("data-notif-id"));
      }
    });
  }

  var markAll = document.getElementById("notifMarkAllBtn");
  if (markAll) {
    markAll.addEventListener("click", function () {
      markAllNotificationsRead();
      showToast(t("All notifications marked as read."), "success");
    });
  }

  var clearBtn = document.getElementById("notifClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      openConfirmModal("Clear the whole notification history?", "CLEAR", function () {
        saveNotifications([]);
        notifyBus.post();
        refreshAdminNotifications();
        logAudit("cleared notifications", "");
        showToast(t("Notification history cleared."), "success");
      });
    });
  }

  var settings = document.getElementById("notifSettings");
  if (settings) {
    settings.addEventListener("change", function (event) {
      var input = event.target.closest("[data-notif-type]");
      if (!input) return;
      var prefs = loadNotifPrefs();
      prefs[input.getAttribute("data-notif-type")] = input.checked;
      saveNotifPrefs(prefs);
      notifyBus.post();
      updateNotifBell("admin");
      renderNotificationHistory();
    });
  }
}

/* ------------------------------------------------------------
   VERSO AUTH CARD (user-login.html)
   The skewed forest blade sweeps between the Sign In panel and
   the Create Account panel, swapping the ivory brand copy with it.
   ------------------------------------------------------------ */
function initVersoAuthCard() {
  var frame = document.getElementById("versoCard");
  if (!frame) return;

  var signinPanel = document.getElementById("versoSigninPane");
  var signupPanel = document.getElementById("versoSignupPane");
  var brandUp = document.getElementById("brandCopySignup");
  var brandIn = document.getElementById("brandCopySignin");

  function swapBrand(mode) {
    if (brandUp) brandUp.classList.toggle("hidden", mode !== "signup");
    if (brandIn) brandIn.classList.toggle("hidden", mode !== "signin");
  }

  function applyMode(mode, instant) {
    if (mode !== "signup" && mode !== "signin") mode = "signin";
    frame.dataset.mode = mode;

    // The panel under the blade must not be reachable by keyboard or AT
    var coveredIsSignup = mode === "signin";
    if (signupPanel) {
      signupPanel.inert = coveredIsSignup;
      signupPanel.setAttribute("aria-hidden", coveredIsSignup ? "true" : "false");
    }
    if (signinPanel) {
      signinPanel.inert = !coveredIsSignup;
      signinPanel.setAttribute("aria-hidden", coveredIsSignup ? "false" : "true");
    }

    if (instant) swapBrand(mode);
    else setTimeout(function () { swapBrand(mode); }, 280);
  }

  document.querySelectorAll("[data-verso-mode]").forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      applyMode(btn.getAttribute("data-verso-mode"));
      var target = btn.getAttribute("data-verso-mode") === "signup" ? "regUsername" : "userUsername";
      var field = document.getElementById(target);
      if (field) field.focus({ preventScroll: true });
    });
  });

  applyMode(frame.dataset.mode || "signin", true);

  // Security-grade meter for the create-account password
  var bar = document.getElementById("versoStrengthBar");
  var grade = document.getElementById("versoStrengthText");
  var pwField = document.getElementById("regPassword");
  if (bar && grade && pwField) {
    pwField.addEventListener("input", function () {
      var val = pwField.value || "";
      if (!val) {
        bar.style.width = "0%";
        bar.className = "verso-meter-bar";
        grade.textContent = "Weak";
        grade.className = "verso-grade";
        return;
      }
      var score = 0;
      if (val.length >= 8) score++;
      if (/[A-Z]/.test(val)) score++;
      if (/[0-9]/.test(val)) score++;
      if (/[^A-Za-z0-9]/.test(val)) score++;
      if (score <= 1) {
        bar.style.width = "28%";
        bar.className = "verso-meter-bar";
        grade.textContent = "Weak";
        grade.className = "verso-grade weak";
      } else if (score <= 3) {
        bar.style.width = "66%";
        bar.className = "verso-meter-bar fair";
        grade.textContent = "Moderate";
        grade.className = "verso-grade fair";
      } else {
        bar.style.width = "100%";
        bar.className = "verso-meter-bar strong";
        grade.textContent = "Strong";
        grade.className = "verso-grade strong";
      }
    });
  }

  // Show / hide both password fields
  document.querySelectorAll("[data-verso-eye]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-verso-eye"));
      if (!input) return;
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.classList.toggle("revealed", show);
      btn.setAttribute("aria-label", t(show ? "Hide password" : "Show password"));
    });
  });
}

/* ------------------------------------------------------------
   22b. HEADER NOTIFICATION BELLS (admin + member dropdowns)
   ------------------------------------------------------------ */

function notifPanelIds(kind) {
  if (kind === "admin") {
    return { btn: "adminNotifBtn", panel: "adminNotifPanel", list: "adminNotifList", dot: "adminNotifDot" };
  }
  if (kind === "official") {
    return { btn: "officialNotifBtn", panel: "officialNotifPanel", list: "officialNotifList", dot: "officialNotifDot" };
  }
  return { btn: "userNotifBtn", panel: "userNotifPanel", list: "userNotifList", dot: "userNotifDot" };
}

function notifSeenKey(kind) {
  if (kind === "admin") return "ccAdminNotifSeen";
  if (kind === "official") return "ccOfficialNotifSeen";
  return "ccUserNotifSeen";
}

/* ------------------------------------------------------------
   22a. ADMIN NOTIFICATION CENTRE (real user actions only)
   Every record comes from an actual action - a like, comment,
   share, save, RSVP, sign-up, or broadcast. Nothing is faked
   and nothing is seeded. Stored in localStorage so it survives
   refreshes and re-logins, and broadcast to other tabs so the
   bell updates in real time.
   ------------------------------------------------------------ */

// NOTE: the notification constants, NOTIF_TYPES and notifyBus are declared
// near the top of the file (section 1c) because initAdminDashboard() runs
// before this point in the script.

function notifTypeMeta(type) {
  return NOTIF_TYPES.filter(function (tp) { return tp.key === type; })[0] || { label: type, verb: "did" };
}

function loadNotifications() { return getData(NOTIFICATIONS_KEY, []); }

function saveNotifications(list) {
  var trimmed = (list || []).slice(0, NOTIFICATION_MAX);
  return setData(NOTIFICATIONS_KEY, trimmed);
}

function loadNotifPrefs() {
  var raw = getData(NOTIFICATION_PREFS_KEY, null);
  if (!raw || typeof raw !== "object") raw = {};
  var out = {};
  NOTIF_TYPES.forEach(function (tp) { out[tp.key] = raw[tp.key] !== false; });
  return out;
}

function saveNotifPrefs(prefs) { return setData(NOTIFICATION_PREFS_KEY, prefs || {}); }

function notifEnabled(type, prefs) {
  return (prefs || loadNotifPrefs())[type] !== false;
}

// Record ONE real action for the admin dashboard.
// `actor` is the username (empty/Guest for anonymous visitors).
function notifyAdmin(type, actor, opts) {
  opts = opts || {};
  var actorKey = actor || "";
  var record = {
    id: generateId(),
    type: type,
    actor: actorKey,
    actorName: actorKey ? (displayNameFor(actorKey) || actorKey) : t("Guest"),
    guest: !actorKey,
    targetType: opts.targetType || "",
    targetId: opts.targetId || "",
    targetTitle: opts.targetTitle || "",
    text: opts.text ? String(opts.text).slice(0, 140) : "",
    date: new Date().toISOString(),
    read: false
  };
  var list = loadNotifications();
  list.unshift(record);
  saveNotifications(list);
  notifyBus.post();
  refreshAdminNotifications();
  return record;
}

function notifUnreadCount(prefs) {
  prefs = prefs || loadNotifPrefs();
  return loadNotifications().filter(function (n) {
    return !n.read && notifEnabled(n.type, prefs);
  }).length;
}

// { type, title } for a post id (news / announcement / activity), or null
function notifyTarget(postId) {
  var found = findCommentedPost(postId);
  return found ? { type: found.type, title: found.title } : null;
}

// "2m" / "3h" / "4d" / "October 13, 2026"
function notifRelativeTime(iso) {
  var ts = new Date(iso || "").getTime();
  if (isNaN(ts)) return "";
  var diff = Math.max(0, Date.now() - ts);
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return t("Just now");
  if (mins < 60) return mins + "m";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h";
  var days = Math.floor(hrs / 24);
  if (days < 7) return days + "d";
  return formatDate(String(iso).slice(0, 10));
}

function notifTargetLabel(n) {
  if (n.targetTitle) return '"' + n.targetTitle + '"';
  var names = {
    news: "a news post", announcement: "an announcement",
    activity: "an activity", event: "an event", user: "a profile"
  };
  return t(names[n.targetType] || "a post");
}

// The one-line sentence shown in the bell and history
function notifSentence(n) {
  var who = n.actorName || n.actor || t("Guest");
  var verb = t(notifTypeMeta(n.type).verb);
  var hasTarget = n.type !== "register" && n.type !== "live";
  return "<strong>" + escapeHtml(who) + "</strong> " + verb +
    (hasTarget ? " " + escapeHtml(notifTargetLabel(n)) : "");
}

// Where clicking a notification should take the admin
function notificationSection(n) {
  if (n.type === "comment") return "comments";
  if (n.type === "register") return "users";
  if (n.type === "post") return "posts";
  if (n.type === "rsvp") return "events";
  if (n.type === "like" || n.type === "share" || n.type === "save") {
    return n.targetType === "activity" ? "activities"
      : n.targetType === "announcement" ? "announcements" : "news";
  }
  return "dashboard";
}

// One Facebook-style row, shared by the dropdown and the history page
function notifItemHtml(n) {
  var avatar = avatarFor(n.actor);
  var typeMeta = notifTypeMeta(n.type);
  return "" +
    '<button type="button" class="notif-item' + (n.read ? "" : " notif-unread") + '" data-notif-id="' + n.id + '">' +
      '<span class="notif-avatar' + (avatar ? " has-photo" : "") + '" aria-hidden="true">' + avatarInner(n.actor || n.actorName) + "</span>" +
      '<span class="notif-body">' +
        '<span class="notif-line">' + notifSentence(n) + "</span>" +
        (n.text ? '<span class="notif-quote">“' + escapeHtml(n.text) + '”</span>' : "") +
        '<span class="notif-meta">' +
          '<span class="notif-chip">' + t(typeMeta.label) + "</span>" +
          '<span class="notif-time">' + notifRelativeTime(n.date) + "</span>" +
          (n.guest ? '<span class="notif-chip">' + t("GUEST") + "</span>" : "") +
        "</span>" +
      "</span>" +
      (n.read ? "" : '<span class="notif-unread-dot" aria-hidden="true"></span>') +
    "</button>";
}

// The admin's alerts for the bell: real actions, newest first (max 12)
function buildAdminNotifications() {
  var prefs = loadNotifPrefs();
  return loadNotifications()
    .filter(function (n) { return notifEnabled(n.type, prefs); })
    .slice(0, 12);
}

// Mark one notification (or every visible one) as read
function markNotificationRead(id) {
  var changed = false;
  var list = loadNotifications().map(function (n) {
    if (n.id === id && !n.read) { n.read = true; changed = true; }
    return n;
  });
  if (changed) {
    saveNotifications(list);
    notifyBus.post();
    refreshAdminNotifications();
  }
}

function markAllNotificationsRead() {
  var prefs = loadNotifPrefs();
  var list = loadNotifications().map(function (n) {
    if (notifEnabled(n.type, prefs)) n.read = true;
    return n;
  });
  saveNotifications(list);
  notifyBus.post();
  refreshAdminNotifications();
}

// Every admin surface that shows notifications, refreshed together
function refreshAdminNotifications() {
  if (!document.body.classList.contains("admin-body")) return;
  updateNotifBell("admin");
  var panel = document.getElementById("adminNotifPanel");
  if (panel && !panel.classList.contains("hidden")) renderNotifPanel("admin");
  renderNotificationHistory();
}

// Click a notification -> open the post / comment / event / member
function openNotification(id) {
  var record = loadNotifications().filter(function (n) { return n.id === id; })[0];
  if (!record) return;
  markNotificationRead(id);
  closeNotifPanels();
  showAdminSection(notificationSection(record));

  var post = (record.targetType === "news" || record.targetType === "announcement" || record.targetType === "activity")
    ? findCommentedPost(record.targetId) : null;

  if (post) {
    if (record.targetType === "news") showNewsDetails(record.targetId);
    else if (record.targetType === "announcement") showAnnouncementDetails(record.targetId);
    else showActivityDetails(record.targetId);
    return;
  }
  if (record.targetType === "event" && loadEventsList().some(function (e) { return e.id === record.targetId; })) {
    showEventAttendees(record.targetId);
    return;
  }
  if (record.type === "register") {
    var u = loadUsers().filter(function (x) { return x.id === record.targetId; })[0];
    if (u) viewUser(u.id);
    return;
  }
  if (record.targetType && !post && record.type !== "register") {
    showToast(t("This post is no longer available."), "info");
  }
}

// Same feed as the member's Notifications section, shaped for the bell panel
function buildUserPanelNotifications() {
  var base = buildNotifications().map(function (n) {
    return {
      at: (n.date || "") + "T00:00:00",
      type: n.type, date: n.date,
      title: n.title, text: n.text,
      section: n.type === "Event" ? "events" : "announcements"
    };
  });
  // Community alerts (lost & found) targeted at this member's barangay
  var alerts = [];
  if (typeof activeUserAlerts === "function") {
    var u = getSessionUser();
    var barangay = u ? (u.barangay || "") : "";
    alerts = activeUserAlerts()
      .filter(function (a) { return userAlertMatches(a, barangay); })
      .map(function (a) {
        return {
          at: a.createdAt, type: "Lost & Found", date: a.createdAt,
          title: a.title, text: a.message, section: "feed"
        };
      });
  }
  return alerts.concat(base);
}

function getNotifItems(kind) {
  if (kind === "admin") return buildAdminNotifications();
  if (kind === "official") return buildOfficialNotifications();
  return buildUserPanelNotifications();
}

function getNotifUnseen(kind) {
  // The admin bell counts real unread notifications from the store
  if (kind === "admin") return notifUnreadCount();
  // Officials count unread certificate notifications from their own store
  if (kind === "official") return officialNotifUnreadCount();
  var seen = "";
  try { seen = localStorage.getItem(notifSeenKey(kind)) || ""; } catch (e) {}
  var seenTime = seen ? new Date(seen).getTime() : 0;
  if (isNaN(seenTime)) seenTime = 0;
  var nowTs = Date.now();
  return getNotifItems(kind).filter(function (n) {
    var t0 = new Date(n.at).getTime();
    if (isNaN(t0)) return false;
    // Future-dated items (upcoming events) count as arriving "now" on the
    // first load, then stop re-flagging once the panel has been opened.
    if (t0 > nowTs) t0 = seenTime ? Math.min(seenTime, nowTs) : nowTs;
    return t0 > seenTime;
  }).length;
}

function setNotifSeen(kind) {
  if (kind === "admin") { markAllNotificationsRead(); return; }
  if (kind === "official") { markAllOfficialNotificationsRead(); return; }
  try { localStorage.setItem(notifSeenKey(kind), new Date().toISOString()); } catch (e) {}
}

// Header dot count (+ member sidebar badge) from the unseen total
function updateNotifBell(kind) {
  var ids = notifPanelIds(kind);
  var count = getNotifUnseen(kind);
  var dot = document.getElementById(ids.dot);
  if (dot) {
    dot.textContent = count > 99 ? "99+" : String(count);
    dot.hidden = count === 0;
  }
  if (kind === "user") {
    var badge = document.getElementById("notifCountBadge");
    if (badge) {
      badge.textContent = count > 0 ? String(count) : "";
      badge.style.display = count > 0 ? "inline-block" : "none";
    }
  }
}

// One resident bell row: icon tile + coloured category label + title + snippet
function residentNotifHtml(n) {
  var isEvent = n.type === "Event";
  var kind = isEvent ? "event" : "announcement";
  var icon = isEvent
    ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
    : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
  var text = shortText(n.text || "", 110);
  return "" +
    '<button type="button" class="notif-item notif-item-resident" data-goto="' + escapeHtml(n.section) + '">' +
      '<span class="notif-resident-icon notif-resident-icon--' + kind + '" aria-hidden="true">' + icon + "</span>" +
      '<span class="notif-resident-body">' +
        '<span class="notif-resident-top">' +
          '<span class="notif-label notif-label--' + kind + '">' + t((n.type || "").toUpperCase()) + "</span>" +
          '<span class="notif-resident-date">' + formatDate(n.date || (n.at || "").slice(0, 10)) + "</span>" +
        "</span>" +
        '<strong class="notif-resident-title">' + escapeHtml(n.title) + "</strong>" +
        (text ? '<span class="notif-resident-text">' + escapeHtml(text) + "</span>" : "") +
      "</span>" +
    "</button>";
}

function renderNotifPanel(kind) {
  var ids = notifPanelIds(kind);
  var list = document.getElementById(ids.list);
  if (!list) return;
  var items = getNotifItems(kind);
  if (!items.length) {
    list.innerHTML = '<p class="notif-empty">' + t("No notifications right now.") + "</p>";
    return;
  }
  if (kind === "admin") {
    list.innerHTML = items.map(notifItemHtml).join("");
    return;
  }
  if (kind === "official") {
    list.innerHTML = items.map(officialNotifItemHtml).join("");
    return;
  }
  list.innerHTML = items.map(residentNotifHtml).join("");
}

function closeNotifPanels() {
  ["admin", "user", "official"].forEach(function (kind) {
    var ids = notifPanelIds(kind);
    var panel = document.getElementById(ids.panel);
    var btn = document.getElementById(ids.btn);
    if (panel) panel.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

function toggleNotifPanel(kind) {
  var ids = notifPanelIds(kind);
  var panel = document.getElementById(ids.panel);
  var btn = document.getElementById(ids.btn);
  if (!panel || !btn) return;
  var willOpen = panel.classList.contains("hidden");
  closeNotifPanels();
  if (willOpen) {
    renderNotifPanel(kind);
    setNotifSeen(kind);
    updateNotifBell(kind);
    panel.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  }
}

function notifGoto(kind, section) {
  closeNotifPanels();
  if (kind === "admin") showAdminSection(section);
  else if (kind === "official") showOfficialSection(section);
  else showUserSection(section);
}

function initNotifBells() {
  ["admin", "user", "official"].forEach(function (kind) {
    var ids = notifPanelIds(kind);
    var btn = document.getElementById(ids.btn);
    var panel = document.getElementById(ids.panel);
    if (!btn || !panel) return;

    btn.setAttribute("aria-label", t("Notifications"));
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");

    btn.addEventListener("click", function (event) {
      event.stopPropagation();
      closeHeaderAccountMenus();
      toggleNotifPanel(kind);
    });

    panel.addEventListener("click", function (event) {
      event.stopPropagation();
      var item = event.target.closest(".notif-item");
      if (item) {
        var notifId = item.getAttribute("data-notif-id");
        if (notifId) {
          if (kind === "official") openOfficialNotification(notifId);
          else openNotification(notifId);
          return;
        }
        notifGoto(kind, item.getAttribute("data-goto"));
        return;
      }
      if (kind === "official") {
        var tab = event.target.closest(".notif-filter");
        if (tab) { setOfficialNotifFilter(tab.getAttribute("data-filter")); return; }
        if (event.target.closest("#officialSoundToggle")) {
          var muted = localStorage.getItem("ccOfficialIncidentSound") === "off";
          localStorage.setItem("ccOfficialIncidentSound", muted ? "on" : "off");
          updateOfficialSoundBtn();
          return;
        }
      }
      if (event.target.closest(".notif-mark-all")) {
        if (kind === "official") markAllOfficialNotificationsRead();
        else markAllNotificationsRead();
        return;
      }
      if (event.target.closest(".notif-view-all")) {
        notifGoto(kind, kind === "official" ? "requests" : "notifications");
      }
    });

    renderNotifPanel(kind);
    updateNotifBell(kind);
  });

  // Real-time: another tab recorded activity -> refresh the bell here
  notifyBus.onMessage(function () {
    refreshAdminNotifications();
    refreshOfficialNotifications();
    if (document.body.classList.contains("official-body")) {
      if (typeof renderOfficialDashboardStats === "function") renderOfficialDashboardStats();
      if (typeof renderOfficialRequests === "function") renderOfficialRequests();
      if (typeof renderOfficialIncidents === "function") renderOfficialIncidents();
      if (typeof renderOfficialIncidentAnalytics === "function") renderOfficialIncidentAnalytics();
      if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
    }
    if (document.body.classList.contains("admin-body")) {
      if (typeof renderAdminPosts === "function") renderAdminPosts();
      if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
    }
  });

  document.addEventListener("click", closeNotifPanels);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeNotifPanels();
  });
}

/* Header account menu: click the name/avatar -> show Log out */
function closeHeaderAccountMenus() {
  ["adminAccountMenu", "userAccountMenu", "officialAccountMenu"].forEach(function (id) {
    var menu = document.getElementById(id);
    if (menu) menu.classList.add("hidden");
  });
  ["adminAccountBtn", "userAccountBtn", "officialAccountBtn"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

// Fill the account dropdown head with the signed-in identity
function fillAccountMenu(kind) {
  var name = "", email = "", avatarKey = "";
  if (kind === "admin") {
    var p = loadAdminProfile();
    name = (p.name && p.name.trim()) || getPosterName();
    email = p.email || "admin@community.ph";
    avatarKey = name;
  } else if (kind === "official") {
    var o = getSessionOfficial();
    if (o) { name = o.name || o.username; email = o.email || "official@community.ph"; avatarKey = o.username; }
  } else {
    var u = getSessionUser();
    if (u) { name = u.name || u.username; email = u.email || "resident@community.ph"; avatarKey = u.username; }
  }
  var nameEl = document.getElementById(kind + "MenuName");
  if (nameEl) nameEl.textContent = name || "-";
  var emailEl = document.getElementById(kind + "MenuEmail");
  if (emailEl) emailEl.textContent = email || "-";
  var avEl = document.getElementById(kind + "MenuAvatar");
  if (avEl) avEl.innerHTML = avatarInner(avatarKey || name || "?");
}

// Open the quick settings dropdown (member / official); admin uses the modal
function openQuickSettings() {
  var panel = document.getElementById("dashSettingsPanel");
  if (!panel) return;
  if (typeof updateSettingsLabels === "function") updateSettingsLabels();
  closeNotifPanels();
  panel.classList.remove("hidden");
}

function initHeaderAccountMenus() {
  [
    { btn: "adminAccountBtn", menu: "adminAccountMenu", logout: "adminAccountLogout", profile: "adminAccountProfile", settings: "adminAccountSettings", kind: "admin" },
    { btn: "userAccountBtn", menu: "userAccountMenu", logout: "userAccountLogout", profile: "userAccountProfile", settings: "userAccountSettings", kind: "user" },
    { btn: "officialAccountBtn", menu: "officialAccountMenu", logout: "officialAccountLogout", profile: "officialAccountProfile", settings: "officialAccountSettings", kind: "official" }
  ].forEach(function (cfg) {
    var btn = document.getElementById(cfg.btn);
    var menu = document.getElementById(cfg.menu);
    var logout = document.getElementById(cfg.logout);
    if (!btn || !menu) return;

    fillAccountMenu(cfg.kind);

    btn.addEventListener("click", function (event) {
      event.stopPropagation();
      var willOpen = menu.classList.contains("hidden");
      closeHeaderAccountMenus();
      closeNotifPanels();
      if (willOpen) {
        fillAccountMenu(cfg.kind);
        menu.classList.remove("hidden");
        btn.setAttribute("aria-expanded", "true");
      }
    });

    menu.addEventListener("click", function (event) {
      event.stopPropagation();
    });

    var profileItem = document.getElementById(cfg.profile);
    if (profileItem) profileItem.addEventListener("click", function () {
      closeHeaderAccountMenus();
      if (cfg.kind === "official") showOfficialSection("profile");
      else if (cfg.kind === "admin") showAdminSection("profile");
      else showUserSection("profile");
    });

    var settingsItem = document.getElementById(cfg.settings);
    if (settingsItem) settingsItem.addEventListener("click", function () {
      closeHeaderAccountMenus();
      if (cfg.kind === "admin" && typeof openAdminSettingsModal === "function") openAdminSettingsModal();
      else openQuickSettings();
    });

    if (logout) {
      logout.addEventListener("click", function () {
        closeHeaderAccountMenus();
        if (cfg.kind === "admin") adminLogout();
        else if (cfg.kind === "official") officialLogout();
        else userLogout();
      });
    }
  });

  document.addEventListener("click", closeHeaderAccountMenus);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeHeaderAccountMenus();
  });
}

// Dashboard gallery photo opens in the detail modal
function showUserGalleryPhoto(index) {
  var item = galleryItems[index];
  if (!item) return;
  openDetailModal(item.caption, formatDate(item.date),
    '<img src="' + escapeHtml(item.image) + '" alt="" style="border-radius:4px;">');
}

// Fill the "My Profile" form and save changes
function initProfileForm() {
  var form = document.getElementById("profileForm");
  if (!form) return;

  var user = getSessionUser();
  if (!user) return;

  document.getElementById("profileUsername").value = user.username || user.name || "";
  document.getElementById("profilePhone").value = user.phone || "";
  document.getElementById("profileAddress").value = user.address || "";
  var brgyInput = document.getElementById("profileBarangay");
  if (brgyInput) brgyInput.value = user.barangay || "";
  var nameInput = document.getElementById("profileDisplayName");
  if (nameInput) nameInput.value = user.name || "";

  // Pending avatar chosen in this session (saved with the form)
  var pendingAvatar = user.avatar || "";
  initAvatarPicker(
    "profileAvatarFile", "profileAvatarPreview", "profileAvatarRemove",
    function () { return { name: (nameInput && nameInput.value.trim()) || user.username, avatar: pendingAvatar }; },
    function (dataUrl) { pendingAvatar = dataUrl; }
  );

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var displayName = nameInput ? nameInput.value.trim().slice(0, 40) : "";
    var phone = document.getElementById("profilePhone").value.trim();
    var address = document.getElementById("profileAddress").value.trim();
    var barangay = brgyInput ? brgyInput.value.trim().slice(0, 80) : "";
    var newPassword = document.getElementById("profileNewPassword").value;
    var confirmPassword = document.getElementById("profileConfirmPassword").value;

    var successBox = document.getElementById("profileSuccess");
    var errorBox = document.getElementById("profileError");
    successBox.classList.remove("show");
    errorBox.classList.remove("show");

    if (newPassword || confirmPassword) {
      if (newPassword.length < 6 || newPassword !== confirmPassword) {
        errorBox.textContent = "New password must be at least 6 characters and both fields must match.";
        errorBox.classList.add("show");
        return;
      }
    }

    // Save the updated profile + profile picture
    var users = loadUsers();
    users = users.map(function (u) {
      if (u.username === user.username) {
        u.name = displayName;
        u.avatar = pendingAvatar;
        u.phone = phone;
        u.address = address;
        u.barangay = barangay;
        if (newPassword) u.password = hashPassword(newPassword);
      }
      return u;
    });
    saveUsers(users);

    document.getElementById("profileNewPassword").value = "";
    document.getElementById("profileConfirmPassword").value = "";
    showProfileSaved(successBox);

    // Reflect the new identity right away
    var shown = displayName || user.username;
    refreshIdentityUi(["dashHeaderAvatar", "sidebarAvatar"], shown, pendingAvatar);
    refreshIdentityUi(["dashHeaderName", "sidebarName", "dashWelcome"], shown, pendingAvatar);
    var sidebarMeta = document.getElementById("sidebarMeta");
    if (sidebarMeta && address) sidebarMeta.textContent = address;
    renderUserDashboardContent();
    if (typeof renderEmergency === "function") renderEmergency();
  });
}

// Render everything inside the dashboard sections (called on load
// and again whenever the language changes)
function renderUserDashboardContent() {
  // Summary cards (same ids as the admin dashboard numbers)
  updateDashboardStats();

  // Latest announcement + next event on the overview
  var anns = loadAnnouncementsList().slice().sort(function (a, b) {
    return b.date.localeCompare(a.date);
  });
  var annBox = document.getElementById("dashLatestAnnouncement");
  if (annBox) {
    if (anns.length > 0) {
      annBox.innerHTML =
        '<p class="meta"><span class="badge">' + t(anns[0].category) + '</span> ' +
          formatDate(anns[0].date) + '</p>' +
        '<h3>' + escapeHtml(anns[0].title) + '</h3>' +
        '<p>' + escapeHtml(shortText(anns[0].description, 150)) + '</p>' +
        newsMediaHtml(anns[0], { wrapClass: "card-media", imgClass: "card-image", vidClass: "card-video" });
      resolveVideoRefs(annBox);
    } else {
      annBox.innerHTML = "<p>" + t("No announcements yet.") + "</p>";
    }
  }

  var today = new Date().toISOString().split("T")[0];
  var upcoming = loadEventsList()
    .filter(function (e) { return e.date >= today; })
    .sort(function (a, b) { return a.date.localeCompare(b.date); });
  var eventBox = document.getElementById("dashNextEvent");
  if (eventBox) {
    if (upcoming.length > 0) {
      eventBox.innerHTML =
        '<p class="meta"><span class="badge">' + t("EVENT") + '</span> ' + formatDate(upcoming[0].date) + '</p>' +
        '<h3>' + escapeHtml(upcoming[0].name) + '</h3>' +
        '<p class="detail-row"><strong>' + t("Time:") + '</strong> ' + escapeHtml(upcoming[0].time) + '</p>' +
        '<p class="detail-row"><strong>' + t("Location:") + '</strong> ' + escapeHtml(upcoming[0].location) + '</p>';
    } else {
      eventBox.innerHTML = "<p>" + t("No upcoming events.") + "</p>";
    }
  }

  // Section content
  var newsBox = document.getElementById("dashNewsList");
  if (newsBox) renderDashNewsFeed();

  var dashAnnBox = document.getElementById("dashAnnouncementsList");
  if (dashAnnBox) renderDashAnnouncementsFeed();

  var dashEventBox = document.getElementById("dashEventsList");
  if (dashEventBox) {
    dashEventBox.innerHTML = loadEventsList().map(renderEventPageCard).join("");
    updateCountdowns();
  }

  var dashActBox = document.getElementById("dashActivitiesList");
  if (dashActBox) renderDashActivitiesFeed();

  var dashGalleryBox = document.getElementById("dashGalleryGrid");
  if (dashGalleryBox) {
    galleryItems = loadGalleryList();
    dashGalleryBox.innerHTML = galleryItems.map(function (item, index) {
      return '' +
        '<figure class="gallery-item" onclick="showUserGalleryPhoto(' + index + ')">' +
          '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.caption) + '">' +
          '<figcaption class="caption">' + escapeHtml(item.caption) + '<br>' +
            '<small>' + formatDate(item.date) + '</small></figcaption>' +
        '</figure>';
    }).join("");
  }

  renderUserNotifications();
  renderSavedSection();
  renderMyRequests();
}

function initUserDashboard() {
  if (!document.body.classList.contains("user-body")) return;

  // Welcome message with the member's display name
  var user = getSessionUser();
  if (user) {
    var displayName = user.name || user.username || "Member";
    var welcome = document.getElementById("dashWelcome");
    if (welcome) welcome.textContent = "Welcome, " + displayName + "!";
    var headerName = document.getElementById("dashHeaderName");
    if (headerName) headerName.textContent = displayName;
    var sidebarName = document.getElementById("sidebarName");
    if (sidebarName) sidebarName.textContent = displayName;

    // Profile photo (or initials) in the header and sidebar
    var avatarMarkup = avatarInner(user.username);
    var headerAvatar = document.getElementById("dashHeaderAvatar");
    if (headerAvatar) headerAvatar.innerHTML = avatarMarkup;
    var sideAvatar = document.getElementById("sidebarAvatar");
    if (sideAvatar) sideAvatar.innerHTML = avatarMarkup;
    var sideMeta = document.getElementById("sidebarMeta");
    if (sideMeta && user.address) sideMeta.textContent = user.address;
  }

  renderUserDashboardContent();
  setInterval(updateCountdowns, 1000);
  initProfileForm();
  initUserCertificates();
  initUserIncidents();

  // Sidebar navigation
  var sidebar = document.getElementById("userSidebar");
  if (sidebar) {
    sidebar.addEventListener("click", function (event) {
      var link = event.target.closest("a[data-usection]");
      if (!link) return;
      event.preventDefault();
      showUserSection(link.getAttribute("data-usection"));
    });
  }

  // Barangay Services group: hidden until its label is clicked
  var barangayToggle = document.getElementById("barangayServicesToggle");
  if (barangayToggle) {
    barangayToggle.addEventListener("click", function (event) {
      event.preventDefault();
      toggleBarangayServices();
    });
  }

  // Circular close button on the profile card returns to the overview
  var profileClose = document.getElementById("profileCloseBtn");
  if (profileClose) {
    profileClose.addEventListener("click", function () { showUserSection("home"); });
  }

  // Mobile hamburger for the sidebar (drawer + backdrop + scroll lock)
  initMobileDrawer();

  // Header notification bell dropdown
  initNotifBells();

  // Header name/avatar click -> Log out menu
  initHeaderAccountMenus();

  // Deep link (user-dashboard.html#notifications) + browser hash edits
  showUserSection(location.hash.slice(1) || "home");
  window.addEventListener("hashchange", function () {
    var name = location.hash.slice(1);
    if (name) showUserSection(name);
  });
}

initUserDashboard();

/* ------------------------------------------------------------
   22a. RESIDENT CERTIFICATE REQUESTS
   Residents file barangay certificate requests from their
   dashboard. Every submission automatically notifies the
   Barangay Officials on their dashboard.
   ------------------------------------------------------------ */

// Searchable barangay picker (used on the certificate + incident forms).
// Residents type to filter the list and pick the barangay they belong to.
function initBarangayPicker(cfg) {
  cfg = cfg || {};
  var search = document.getElementById(cfg.search || "certBarangaySearch");
  var hidden = document.getElementById(cfg.hidden || "certBarangay");
  var list = document.getElementById(cfg.list || "certBarangayList");
  var root = cfg.root || "certBarangayCombo";
  if (!search || !hidden || !list) return null;

  var activeIndex = -1;

  function close() {
    list.classList.add("hidden");
    search.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  }
  function matches(q) {
    var options = barangayOptions();
    q = String(q || "").trim().toLowerCase();
    var out = !q ? options : options.filter(function (b) {
      return b.toLowerCase().indexOf(q) !== -1;
    });
    return out.slice(0, 40);
  }
  function render(items) {
    if (!items.length) {
      list.innerHTML = '<li class="combo-empty">' + escapeHtml(t("No barangay found.")) + "</li>";
    } else {
      list.innerHTML = items.map(function (b) {
        return '<li class="combo-option" role="option" data-value="' + escapeHtml(b) + '">' + escapeHtml(b) + "</li>";
      }).join("");
    }
    list.classList.remove("hidden");
    search.setAttribute("aria-expanded", "true");
    activeIndex = -1;
  }
  function choose(value) {
    hidden.value = value;
    search.value = value;
    close();
  }

  search.addEventListener("input", function () {
    hidden.value = "";
    render(matches(search.value));
  });
  search.addEventListener("focus", function () {
    render(matches(search.value));
  });
  list.addEventListener("mousedown", function (event) {
    var opt = event.target.closest(".combo-option");
    if (!opt) return;
    event.preventDefault();
    choose(opt.getAttribute("data-value"));
  });
  search.addEventListener("keydown", function (event) {
    var items = Array.prototype.slice.call(list.querySelectorAll(".combo-option"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.classList.contains("hidden")) { render(matches(search.value)); return; }
      if (!items.length) return;
      activeIndex = event.key === "ArrowDown"
        ? (activeIndex + 1) % items.length
        : (activeIndex - 1 + items.length) % items.length;
      items.forEach(function (it, i) { it.classList.toggle("active", i === activeIndex); });
      if (items[activeIndex] && items[activeIndex].scrollIntoView) {
        items[activeIndex].scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) {
        event.preventDefault();
        choose(items[activeIndex].getAttribute("data-value"));
      }
    } else if (event.key === "Escape") {
      close();
    }
  });
  document.addEventListener("click", function (event) {
    if (!event.target.closest("#" + root)) close();
  });

  return {
    getValue: function () { return hidden.value || ""; },
    reset: function () { hidden.value = ""; search.value = ""; close(); }
  };
}

// Certificate form picker (backwards-compatible wrapper)
function initBarangayCombo() {
  return initBarangayPicker({ search: "certBarangaySearch", hidden: "certBarangay", list: "certBarangayList", root: "certBarangayCombo" });
}

// Hide the type-specific fields that do not apply to the chosen certificate
function syncCertFormFields() {
  var typeEl = document.getElementById("certType");
  if (!typeEl) return;
  var type = typeEl.value;
  document.querySelectorAll("#certificateForm [data-cert-field]").forEach(function (wrap) {
    wrap.classList.toggle("hidden", wrap.getAttribute("data-cert-field") !== type);
  });
}

function initUserCertificates() {
  var form = document.getElementById("certificateForm");
  if (!form) return;

  // Prefill contact details from the resident's profile
  var user = getSessionUser();
  if (user) {
    var addr = document.getElementById("certAddress");
    var contact = document.getElementById("certContact");
    if (addr && !addr.value) addr.value = user.address || "";
    if (contact && !contact.value) contact.value = user.phone || "";
  }

  var typeEl = document.getElementById("certType");
  if (typeEl) typeEl.addEventListener("change", syncCertFormFields);
  syncCertFormFields();
  var combo = initBarangayCombo();
  renderMyRequests();

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var sessionUser = getSessionUser();
    if (!sessionUser) return;

    var type = document.getElementById("certType").value;
    var barangay = combo ? combo.getValue() : (document.getElementById("certBarangay").value || "");
    var purpose = document.getElementById("certPurpose").value.trim();
    var age = document.getElementById("certAge").value.trim();
    var civilStatus = document.getElementById("certCivilStatus").value;
    var address = document.getElementById("certAddress").value.trim();
    var contact = document.getElementById("certContact").value.trim();
    var yearsResident = document.getElementById("certYearsResident").value.trim();
    var businessName = document.getElementById("certBusinessName").value.trim();

    if (!barangay) { showToast(t("Please search and select your barangay."), "error"); return; }
    if (!purpose) { showToast(t("Please describe the purpose of your request."), "error"); return; }
    if (!address) { showToast(t("Please enter your complete address."), "error"); return; }
    if (type === "business" && !businessName) { showToast(t("Please enter the business name."), "error"); return; }

    var details = { age: age, civilStatus: civilStatus, address: address };
    if (type === "residency" && yearsResident) details.yearsResident = yearsResident;
    if (type === "business") details.businessName = businessName;

    var record = {
      id: generateId(),
      ref: makeCertRef(),
      username: sessionUser.username,
      name: sessionUser.name || sessionUser.username,
      contact: contact,
      address: address,
      barangay: barangay,
      type: type,
      purpose: purpose,
      details: details,
      status: "pending",
      date: new Date().toISOString(),
      updated: new Date().toISOString(),
      printedBy: "",
      printedDate: ""
    };

    var list = loadCertRequests();
    list.unshift(record);
    saveCertRequests(list);

    // Automatic notification on the Barangay Official dashboard
    addOfficialNotification(record);

    form.reset();
    if (combo) combo.reset();
    initUserCertificates.prefill();
    syncCertFormFields();
    renderMyRequests();
    showToast(t("Certificate request submitted. The Barangay Officials have been notified."), "success");
    logAudit("requested certificate", record.ref + " " + record.username + " (" + barangay + ")");
  });

  // Reusable prefill (also used right after a successful submit)
  initUserCertificates.prefill = function () {
    var u = getSessionUser();
    if (!u) return;
    var addr2 = document.getElementById("certAddress");
    var contact2 = document.getElementById("certContact");
    if (addr2) addr2.value = u.address || "";
    if (contact2) contact2.value = u.phone || "";
  };
  initUserCertificates.prefill();
}

function renderMyRequests() {
  var body = document.getElementById("myRequestsTableBody");
  if (!body) return;
  var user = getSessionUser();
  var list = user ? loadCertRequests().filter(function (r) { return r.username === user.username; }) : [];
  var countBox = document.getElementById("myRequestsCount");
  if (countBox) countBox.textContent = list.length + " " + t("requests");

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">' +
      t("You have not requested any certificates yet.") + "</td></tr>";
    return;
  }

  body.innerHTML = list.map(function (r) {
    var status = CERT_STATUSES[r.status] ? r.status : "pending";
    return "<tr>" +
      "<td><strong>" + escapeHtml(r.ref || "-") + "</strong></td>" +
      "<td>" + escapeHtml(t(certTypeLabel(r.type))) + "</td>" +
      "<td>" + formatDate((r.date || "").slice(0, 10)) + "</td>" +
      "<td>" + certStatusPill(status) + "</td>" +
      '<td class="table-actions">' +
        '<button type="button" class="btn btn-small" onclick="openCertRequestDetail(\'' + r.id + '\', false)">' + t("VIEW") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

/* ------------------------------------------------------------
   22a-bis. RESIDENT INCIDENT REPORTS
   Residents report accidents and other emergencies in their area.
   Every report is routed to the officials of the selected barangay
   and shows up on that official's dashboard + notification bell.
   ------------------------------------------------------------ */

function incidentSeverityLabel(key) {
  var map = { low: "Low", medium: "Medium", high: "High" };
  return map[key] ? map[key] : "Medium";
}

function incidentStatusPill(status) {
  var cls = status === "resolved" ? "status-released" : status === "responding" ? "status-ready" : "status-pending";
  return '<span class="status-pill ' + cls + '">' + t(INCIDENT_STATUSES[status] || "Reported") + "</span>";
}

function initUserIncidents() {
  var form = document.getElementById("incidentForm");
  if (!form) return;

  // Prefill contact details from the resident's profile
  var user = getSessionUser();
  if (user) {
    var contact = document.getElementById("incidentContact");
    var addr = document.getElementById("incidentAddress");
    if (contact && !contact.value) contact.value = user.phone || "";
    if (addr && !addr.value) addr.value = user.address || "";
  }

  var combo = initBarangayPicker({
    search: "incidentBarangaySearch", hidden: "incidentBarangay",
    list: "incidentBarangayList", root: "incidentBarangayCombo"
  });
  renderMyIncidents();

  // Optional photo attachment (compressed so it fits in localStorage)
  initUserIncidents.photo = "";
  var photoInput = document.getElementById("incidentPhoto");
  if (photoInput) {
    photoInput.addEventListener("change", function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        compressIncidentPhoto(reader.result, function (dataUrl) {
          initUserIncidents.photo = dataUrl;
          var prev = document.getElementById("incidentPhotoPreview");
          if (prev) { prev.src = dataUrl; prev.classList.remove("hidden"); }
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // Optional GPS capture ("use my location")
  var locBtn = document.getElementById("incidentUseLocation");
  if (locBtn) {
    locBtn.addEventListener("click", function () {
      if (!navigator.geolocation) { showToast(t("Location is not available in this browser."), "error"); return; }
      locBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        var coords = pos.coords.latitude.toFixed(5) + "," + pos.coords.longitude.toFixed(5);
        var c = document.getElementById("incidentCoords");
        if (c) c.value = coords;
        var note = document.getElementById("incidentLocationNote");
        if (note) note.textContent = t("Location captured") + ": " + coords;
        locBtn.disabled = false;
      }, function () {
        showToast(t("Could not get your location."), "error");
        locBtn.disabled = false;
      }, { enableHighAccuracy: true, timeout: 8000 });
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var sessionUser = getSessionUser();
    if (!sessionUser) return;

    var type = document.getElementById("incidentType").value;
    var severity = document.getElementById("incidentSeverity").value;
    var barangay = combo ? combo.getValue() : (document.getElementById("incidentBarangay").value || "");
    var location = document.getElementById("incidentLocation").value.trim();
    var description = document.getElementById("incidentDescription").value.trim();
    var contact = document.getElementById("incidentContact").value.trim();
    var address = document.getElementById("incidentAddress").value.trim();
    var landmarkEl = document.getElementById("incidentLandmark");
    var coordsEl = document.getElementById("incidentCoords");
    var landmark = landmarkEl ? landmarkEl.value.trim() : "";
    var coords = coordsEl ? coordsEl.value.trim() : "";
    var photoData = initUserIncidents.photo || "";
    var nowIso = new Date().toISOString();

    if (!barangay) { showToast(t("Please search and select your barangay."), "error"); return; }
    if (!location) { showToast(t("Please enter the location of the incident."), "error"); return; }
    if (!description) { showToast(t("Please describe what happened."), "error"); return; }

    var record = {
      id: generateId(),
      ref: makeIncidentRef(),
      username: sessionUser.username,
      name: sessionUser.name || sessionUser.username,
      contact: contact,
      address: address,
      barangay: barangay,
      type: type,
      severity: severity,
      location: location,
      landmark: landmark,
      coords: coords,
      photo: photoData,
      description: description,
      status: "reported",
      assignedTo: "",
      assignedId: "",
      response: "",
      respondedBy: "",
      respondedDate: "",
      timeline: [{ at: nowIso, by: sessionUser.name || sessionUser.username, status: "reported", note: "", visible: true }],
      date: nowIso,
      updated: nowIso
    };

    var list = loadIncidents();
    list.unshift(record);
    saveIncidents(list);

    // Immediate notification on the matching Barangay Official dashboard
    addIncidentNotification(record);

    form.reset();
    if (combo) combo.reset();
    initUserIncidents.photo = "";
    var prev = document.getElementById("incidentPhotoPreview");
    if (prev) { prev.classList.add("hidden"); prev.removeAttribute("src"); }
    var pinput = document.getElementById("incidentPhoto");
    if (pinput) pinput.value = "";
    var cinput = document.getElementById("incidentCoords");
    if (cinput) cinput.value = "";
    var cnote = document.getElementById("incidentLocationNote");
    if (cnote) cnote.textContent = "";
    initUserIncidents.prefill();
    renderMyIncidents();
    showToast(t("Incident report submitted. The Barangay Officials have been notified."), "success");
    logAudit("reported incident", record.ref + " " + record.username + " (" + barangay + ")");
  });

  // Reusable prefill (also used right after a successful submit)
  initUserIncidents.prefill = function () {
    var u = getSessionUser();
    if (!u) return;
    var contact2 = document.getElementById("incidentContact");
    var addr2 = document.getElementById("incidentAddress");
    if (contact2) contact2.value = u.phone || "";
    if (addr2) addr2.value = u.address || "";
  };
  initUserIncidents.prefill();
}

function renderMyIncidents() {
  var body = document.getElementById("myIncidentsTableBody");
  if (!body) return;
  var user = getSessionUser();
  var list = user ? loadIncidents().filter(function (r) { return r.username === user.username; }) : [];
  var countBox = document.getElementById("myIncidentsCount");
  if (countBox) countBox.textContent = list.length + " " + t("reports");

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">' +
      t("You have not reported any incidents yet.") + "</td></tr>";
    return;
  }

  body.innerHTML = list.map(function (r) {
    var status = INCIDENT_STATUSES[r.status] ? r.status : "reported";
    return "<tr>" +
      "<td><strong>" + escapeHtml(r.ref || "-") + "</strong></td>" +
      "<td>" + escapeHtml(t(incidentTypeLabel(r.type))) + "</td>" +
      "<td>" + formatDate((r.date || "").slice(0, 10)) + "</td>" +
      "<td>" + incidentStatusPill(status) + "</td>" +
      '<td class="table-actions">' +
        '<button type="button" class="btn btn-small" onclick="openIncidentDetail(\'' + r.id + '\', false)">' + t("VIEW") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

/* ------------------------------------------------------------
   22b. BARANGAY OFFICIAL DASHBOARD
   Officials review and print certificate requests and read the
   news and announcements posted by the admin. Certificate
   requests arrive as live notifications in the header bell.
   ------------------------------------------------------------ */

function requireOfficialLogin() {
  if (!document.body.classList.contains("official-body")) return;
  if (localStorage.getItem("officialLoggedIn") !== "true") {
    window.location.href = "user-login.html";
  }
}

function officialLogout() {
  localStorage.setItem("officialLoggedIn", "false");
  localStorage.removeItem("currentOfficial");
  window.location.href = "user-login.html";
}

function showOfficialSection(name) {
  var sections = {
    dashboard: "sectionOffDashboard",
    requests: "sectionOffRequests",
    incidents: "sectionOffIncidents",
    feed: "sectionOffFeed",
    news: "sectionOffNews",
    announcements: "sectionOffAnnouncements",
    events: "sectionOffEvents",
    activities: "sectionOffActivities",
    gallery: "sectionOffGallery",
    profile: "sectionOffProfile"
  };

  if (!sections[name] || !document.getElementById(sections[name])) name = "dashboard";

  Object.keys(sections).forEach(function (key) {
    var section = document.getElementById(sections[key]);
    if (section) section.classList.toggle("hidden", key !== name);
  });

  var links = document.querySelectorAll("#officialSidebar a[data-osection]");
  links.forEach(function (link) {
    var isActive = link.getAttribute("data-osection") === name;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  var sidebar = document.getElementById("officialSidebar");
  if (sidebar) sidebar.classList.remove("open");
  if (typeof closeSidebarDrawer === "function") closeSidebarDrawer();

  try {
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  } catch (e) {}

  renderOfficialDashboardStats();
}

function certIconSvg() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>';
}

function officialRequestStatus(r) {
  return CERT_STATUSES[r.status] ? r.status : "pending";
}

function renderOfficialDashboardStats() {
  var brgy = officialBarangay();
  var list = loadCertRequests().filter(function (r) {
    return normalizeBarangay(r.barangay) === brgy;
  });
  var counts = {
    statOffPending: list.filter(function (r) { return officialRequestStatus(r) === "pending"; }).length,
    statOffReady: list.filter(function (r) { return officialRequestStatus(r) === "ready"; }).length,
    statOffReleased: list.filter(function (r) { return officialRequestStatus(r) === "released"; }).length,
    statOffTotal: list.length
  };
  Object.keys(counts).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = counts[id];
  });

  var box = document.getElementById("offRecentRequests");
  if (box) {
    var recent = list.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    }).slice(0, 5);
    if (!recent.length) {
      box.innerHTML = '<p class="meta">' + t("No certificate requests yet.") + "</p>";
    } else {
      box.innerHTML = recent.map(function (r) {
        var status = officialRequestStatus(r);
        return '<button type="button" class="notif-item notif-item-resident" onclick="openCertRequestDetail(\'' + r.id + '\', true)">' +
          '<span class="notif-resident-icon notif-resident-icon--announcement" aria-hidden="true">' + certIconSvg() + "</span>" +
          '<span class="notif-resident-body">' +
            '<span class="notif-resident-top">' +
              '<span class="notif-label notif-label--announcement">' + escapeHtml(r.ref || "") + "</span>" +
              '<span class="notif-resident-date">' + formatDate((r.date || "").slice(0, 10)) + "</span>" +
            "</span>" +
            '<strong class="notif-resident-title">' + escapeHtml(r.name || r.username || "") + "</strong>" +
            '<span class="notif-resident-text">' + escapeHtml(t(certTypeLabel(r.type))) + " &middot; " +
              escapeHtml(t(CERT_STATUSES[status] || "Pending")) + "</span>" +
          "</span>" +
        "</button>";
      }).join("");
    }
  }

  // Active incidents (reported + responding) - emergencies reach all officials
  var incBox = document.getElementById("offRecentIncidents");
  if (incBox || document.getElementById("statOffIncidents")) {
    var incList = loadIncidents().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    var activeIncidents = incList.filter(function (r) {
      return officialIncidentStatus(r) !== "resolved";
    }).length;
    var incStat = document.getElementById("statOffIncidents");
    if (incStat) incStat.textContent = activeIncidents;
  }
  if (incBox) {
    var recentInc = incList.slice(0, 5);
    if (!recentInc.length) {
      incBox.innerHTML = '<p class="meta">' + t("No incident reports yet.") + "</p>";
    } else {
      incBox.innerHTML = recentInc.map(function (r) {
        var status = officialIncidentStatus(r);
        return '<button type="button" class="notif-item notif-item-resident" onclick="openIncidentDetail(\'' + r.id + '\', true)">' +
          '<span class="notif-resident-icon notif-resident-icon--event" aria-hidden="true">' + incidentIconSvg() + "</span>" +
          '<span class="notif-resident-body">' +
            '<span class="notif-resident-top">' +
              '<span class="notif-label notif-label--event">' + escapeHtml(r.ref || "") + "</span>" +
              '<span class="notif-resident-date">' + formatDate((r.date || "").slice(0, 10)) + "</span>" +
            "</span>" +
            '<strong class="notif-resident-title">' + escapeHtml(t(incidentTypeLabel(r.type))) + "</strong>" +
            '<span class="notif-resident-text">' + escapeHtml(r.location || "") + " &middot; " +
              escapeHtml(t(INCIDENT_STATUSES[status] || "Reported")) + "</span>" +
          "</span>" +
        "</button>";
      }).join("");
    }
  }
}

function renderOfficialRequests() {
  var body = document.getElementById("requestsTableBody");
  if (!body) return;
  var q = getTableQuery("requestsSearch");
  var statusEl = document.getElementById("requestsStatusFilter");
  var filter = statusEl ? statusEl.value : "all";
  var typeEl = document.getElementById("requestsTypeFilter");
  var typeFilter = typeEl ? typeEl.value : "all";
  var fromEl = document.getElementById("requestsFrom");
  var toEl = document.getElementById("requestsTo");
  var from = fromEl ? fromEl.value : "";
  var to = toEl ? toEl.value : "";
  var brgy = officialBarangay();

  var list = loadCertRequests().filter(function (r) {
    return normalizeBarangay(r.barangay) === brgy;
  }).sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date));
  });
  var shown = list.filter(function (r) {
    if (filter !== "all" && officialRequestStatus(r) !== filter) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    var d = (r.date || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    return [r.ref, r.name, r.username, r.purpose, certTypeLabel(r.type), r.status]
      .join(" ").toLowerCase().indexOf(q) !== -1;
  });
  updateTableCount("requestsTableCount", shown.length, list.length);

  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="7" class="table-empty">' +
      t("No certificate requests match your filter.") + "</td></tr>";
    return;
  }

  body.innerHTML = shown.map(function (r) {
    var status = officialRequestStatus(r);
    var selectable = status === "pending";
    return "<tr>" +
      '<td class="table-check"><input type="checkbox" class="req-check" value="' + escapeHtml(r.id) + '"' +
        (selectable ? "" : " disabled") + ' aria-label="' + escapeHtml(t("Select request")) + '"></td>' +
      "<td><strong>" + escapeHtml(r.ref || "-") + "</strong></td>" +
      "<td>" + escapeHtml(r.name || r.username || "-") + "</td>" +
      "<td>" + escapeHtml(t(certTypeLabel(r.type))) + "</td>" +
      "<td>" + formatDate((r.date || "").slice(0, 10)) + "</td>" +
      "<td>" + certStatusPill(status) + "</td>" +
      '<td class="table-actions">' +
        '<button type="button" class="btn btn-small" onclick="openCertRequestDetail(\'' + r.id + '\', true)">' + t("REVIEW") + "</button> " +
        '<button type="button" class="btn btn-small btn-success" onclick="printCertificate(\'' + r.id + '\')">' + t("PRINT") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

function markSelectedRequestsReady() {
  var boxes = document.querySelectorAll("#requestsTableBody .req-check:checked");
  if (!boxes.length) { showToast(t("Select at least one pending request first."), "error"); return; }
  var ids = Array.prototype.map.call(boxes, function (b) { return b.value; });
  var list = loadCertRequests();
  var n = 0;
  list.forEach(function (r) {
    if (ids.indexOf(r.id) !== -1 && officialRequestStatus(r) === "pending") {
      r.status = "ready";
      r.updated = new Date().toISOString();
      n++;
    }
  });
  saveCertRequests(list);
  renderOfficialRequests();
  renderOfficialDashboardStats();
  if (typeof renderMyRequests === "function") renderMyRequests();
  notifyBus.post();
  showToast(n + " " + t("requests marked as ready."), "success");
  logAudit("marked certificates ready", n + " requests");
}

function exportReleasedCsv() {
  var rows = [["Reference", "Certificate", "Resident", "Barangay", "Date Requested", "Status",
               "Released To", "ID / Reference", "Printed By", "Date Printed"]];
  loadCertRequests().filter(function (r) {
    return normalizeBarangay(r.barangay) === officialBarangay();
  }).forEach(function (r) {
    rows.push([
      r.ref, certTypeLabel(r.type), r.name || r.username, r.barangay, (r.date || "").slice(0, 10),
      CERT_STATUSES[officialRequestStatus(r)] || "Pending",
      r.claimedBy || "", r.claimantId || "", r.printedBy || "", r.printedDate || ""
    ]);
  });
  downloadCsvRows(rows, "certificate-log-" + new Date().toISOString().slice(0, 10) + ".csv", "Certificate log CSV downloaded.");
}

/* ---- Official: incident reports (accidents + emergencies) ---- */

function incidentIconSvg() {
  return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
}

function officialIncidentStatus(r) {
  return INCIDENT_STATUSES[r.status] ? r.status : "reported";
}

/* ---- Incident response toolkit: severity, escalation, timeline, duty ---- */

var INCIDENT_SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
var INCIDENT_ESCALATE_MS = 15 * 60 * 1000;   // still "Reported" after 15 min = escalated
var DUTY_KEY = "communityOfficialDuty";
var lastHighIncidentCount = null;

function incidentSeverityRank(key) { return INCIDENT_SEVERITY_RANK[key] || 0; }

function incidentEscalated(r) {
  return officialIncidentStatus(r) === "reported" &&
    (Date.now() - new Date(r.date).getTime()) > INCIDENT_ESCALATE_MS;
}

// Every report keeps a timestamped history. Older records are backfilled from
// their fields the first time they are read.
function incidentTimeline(r) {
  if (!Array.isArray(r.timeline)) {
    r.timeline = [{
      at: r.date, by: r.name || r.username || "", status: "reported", note: "", visible: true
    }];
    if (r.respondedDate) {
      r.timeline.push({
        at: r.respondedDate, by: r.respondedBy || "", status: officialIncidentStatus(r),
        note: r.response || "", visible: true
      });
    }
  }
  return r.timeline;
}

function currentOfficialName() {
  var o = getSessionOfficial();
  return o ? (o.name || o.username) + (o.barangay ? " (" + o.barangay + ")" : "") : t(OFFICIAL_ROLE);
}

function pushIncidentTimeline(rec, status, note, visible) {
  incidentTimeline(rec);
  rec.timeline.push({
    at: new Date().toISOString(), by: currentOfficialName(),
    status: status, note: note || "", visible: visible !== false
  });
}

function dutyMap() { return getData(DUTY_KEY, {}); }
function isOnDuty(username) {
  var who = username || (getSessionOfficial() || {}).username;
  if (!who) return false;
  return !!dutyMap()[who];
}
function applyOfficialDuty(on) {
  var o = getSessionOfficial();
  if (!o) return;
  var m = dutyMap();
  m[o.username] = !!on;
  setData(DUTY_KEY, m);
  renderOfficialDutyUi();
  notifyBus.post();
}

function incidentMapUrl(r) {
  if (r.coords) return "https://www.google.com/maps?q=" + encodeURIComponent(r.coords);
  var q = [r.location, r.barangay].filter(Boolean).join(", ");
  return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : "";
}

function incidentTimelineHtml(r, forOfficial) {
  incidentTimeline(r);
  var items = r.timeline.filter(function (e) { return forOfficial || e.visible !== false; });
  if (!items.length) return '<p class="meta">' + t("No updates yet.") + "</p>";
  return '<ul class="incident-timeline">' + items.map(function (e) {
    var label = t(INCIDENT_STATUSES[e.status] || "Reported");
    return '<li class="tl-item tl-' + escapeHtml(e.status || "reported") + '">' +
      '<span class="tl-dot" aria-hidden="true"></span>' +
      '<div class="tl-body">' +
        '<div class="tl-top"><span class="tl-status">' + escapeHtml(label) + '</span>' +
          '<span class="tl-time">' + notifRelativeTime(e.at) + '</span></div>' +
        (e.note ? '<p class="tl-note">' + escapeHtml(e.note) + '</p>' : "") +
        '<span class="tl-by">' + escapeHtml(e.by || "") +
          (forOfficial && e.visible === false ? " · " + t("internal note") : "") + '</span>' +
      '</div>' +
    '</li>';
  }).join("") + "</ul>";
}

// A short alert tone for high-severity incidents (best effort; may be blocked
// by the browser's autoplay policy until the official interacts with the page).
function playIncidentAlert() {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx = window.__ccAudioCtx || (window.__ccAudioCtx = new Ctx());
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = "sine";
    o.connect(g);
    g.connect(ctx.destination);
    var now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    o.frequency.setValueAtTime(880, now);
    o.frequency.setValueAtTime(660, now + 0.25);
    o.start(now);
    o.stop(now + 0.5);
  } catch (e) {}
}

function maybePlayIncidentAlert() {
  if (!document.body.classList.contains("official-body")) return;
  if (localStorage.getItem("ccOfficialIncidentSound") === "off") return;
  var n = loadOfficialNotifications().filter(function (x) {
    return x.type === "incident" && !x.read && (x.severity || "") === "high";
  }).length;
  if (lastHighIncidentCount !== null && n > lastHighIncidentCount) playIncidentAlert();
  lastHighIncidentCount = n;
}

function renderOfficialDutyUi() {
  var btn = document.getElementById("officialDutyToggle");
  if (!btn) return;
  var on = isOnDuty();
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  var label = btn.querySelector(".duty-label");
  if (label) label.textContent = on ? t("On Duty") : t("Off Duty");
}

// Open one incident report in the shared detail modal.
// `withActions` adds the official's claim / note / respond / resolve controls.
function openIncidentDetail(id, withActions) {
  var rec = loadIncidents().filter(function (r) { return r.id === id; })[0];
  if (!rec) return;
  var status = officialIncidentStatus(rec);
  var escalated = incidentEscalated(rec);
  var mapUrl = incidentMapUrl(rec);

  var sev = escapeHtml(rec.severity || "medium");
  var rows = [
    [t("Reference No."), escapeHtml(rec.ref || "-")],
    [t("Barangay"), escapeHtml(rec.barangay || "-")],
    [t("Incident Type"), escapeHtml(t(incidentTypeLabel(rec.type)))],
    [t("Severity"), '<span class="sev-chip sev-' + sev + '">' + escapeHtml(t(incidentSeverityLabel(rec.severity))) + "</span>" +
      (escalated ? ' <span class="sev-chip sev-escalated">' + t("ESCALATED") + "</span>" : "")],
    [t("Reported By"), escapeHtml(rec.name || rec.username || "-")],
    [t("Contact Number"), escapeHtml(rec.contact || "-")],
    [t("Location"), escapeHtml(rec.location || "-") + (rec.landmark ? " (" + escapeHtml(rec.landmark) + ")" : "") +
      (mapUrl ? ' <a class="map-link" href="' + mapUrl + '" target="_blank" rel="noopener">' + t("View on map") + "</a>" : "")],
    [t("Assigned To"), escapeHtml(rec.assignedTo || t("Unassigned"))],
    [t("Details"), escapeHtml(rec.description || "-")],
    [t("Date Reported"), formatDate(rec.date || "")]
  ].map(function (pair) {
    return '<p class="detail-row"><strong>' + pair[0] + ":</strong> " + pair[1] + "</p>";
  }).join("");

  var photo = rec.photo
    ? '<img class="incident-photo" src="' + escapeHtml(rec.photo) + '" alt="' + escapeHtml(t("Incident photo")) + '">'
    : "";
  var timeline = '<h4 class="detail-subhead">' + t("Response Timeline") + "</h4>" + incidentTimelineHtml(rec, withActions);

  var actions = "";
  if (withActions) {
    var claimBtn = !rec.assignedTo
      ? '<button type="button" class="btn" id="incidentClaimBtn">' + t("CLAIM REPORT") + "</button>"
      : "";
    actions =
      '<div class="incident-note-box">' +
        '<label for="incidentNote">' + t("Add an update") + "</label>" +
        '<textarea id="incidentNote" rows="2" maxlength="400" placeholder="' + t("e.g. Team dispatched, ETA 10 minutes") + '"></textarea>' +
        '<label class="incident-note-visible"><input type="checkbox" id="incidentNoteVisible" checked> ' + t("Show this update to the resident") + "</label>" +
        '<div class="modal-actions-row">' +
          '<button type="button" class="btn btn-small" id="incidentAddNoteBtn">' + t("ADD UPDATE") + "</button>" +
        "</div>" +
      "</div>" +
      '<div class="modal-actions-row">' + claimBtn +
        (status === "reported"
          ? '<button type="button" class="btn" id="incidentRespondBtn">' + t("MARK AS RESPONDING") + "</button>"
          : "") +
        (status !== "resolved"
          ? '<button type="button" class="btn btn-success" id="incidentResolveBtn">' + t("MARK AS RESOLVED") + "</button>"
          : "") +
      "</div>";
  }

  openDetailModal(t("Incident Report"), escapeHtml(rec.ref || "") + " &middot; " + incidentStatusPill(status), rows + photo + timeline + actions);

  if (withActions) {
    var addNote = document.getElementById("incidentAddNoteBtn");
    if (addNote) addNote.addEventListener("click", function () {
      var box = document.getElementById("incidentNote");
      var vis = document.getElementById("incidentNoteVisible");
      addIncidentNote(id, box ? box.value.trim() : "", vis ? vis.checked : true);
    });
    var claim = document.getElementById("incidentClaimBtn");
    if (claim) claim.addEventListener("click", function () { claimIncident(id); });
    var respondBtn = document.getElementById("incidentRespondBtn");
    if (respondBtn) respondBtn.addEventListener("click", function () { setIncidentStatus(id, "responding"); });
    var resolveBtn = document.getElementById("incidentResolveBtn");
    if (resolveBtn) resolveBtn.addEventListener("click", function () { setIncidentStatus(id, "resolved"); });
  }
}

function claimIncident(id) {
  var list = loadIncidents();
  var rec = list.filter(function (r) { return r.id === id; })[0];
  if (!rec) return;
  rec.assignedTo = currentOfficialName();
  rec.assignedId = (getSessionOfficial() || {}).username || "";
  rec.updated = new Date().toISOString();
  pushIncidentTimeline(rec, officialIncidentStatus(rec), t("Report claimed") + " - " + rec.assignedTo, true);
  saveIncidents(list);
  notifyBus.post();
  renderOfficialIncidents();
  renderOfficialDashboardStats();
  openIncidentDetail(id, true);
  showToast(t("You are now handling this report."), "success");
  logAudit("claimed incident", rec.ref || id);
}

function addIncidentNote(id, note, visible) {
  if (!note) { showToast(t("Please type an update first."), "error"); return; }
  var list = loadIncidents();
  var rec = list.filter(function (r) { return r.id === id; })[0];
  if (!rec) return;
  pushIncidentTimeline(rec, officialIncidentStatus(rec), note, visible);
  if (visible) rec.response = note;
  rec.updated = new Date().toISOString();
  saveIncidents(list);
  notifyBus.post();
  renderOfficialIncidents();
  renderMyIncidents();
  openIncidentDetail(id, true);
  showToast(t("Update added."), "success");
}

function setIncidentStatus(id, status) {
  var list = loadIncidents();
  var rec = list.filter(function (r) { return r.id === id; })[0];
  if (!rec) return;
  rec.status = status;
  rec.updated = new Date().toISOString();
  rec.respondedBy = currentOfficialName();
  rec.respondedDate = new Date().toISOString();
  if (!rec.assignedTo) {
    rec.assignedTo = currentOfficialName();
    rec.assignedId = (getSessionOfficial() || {}).username || "";
  }
  if (status === "responding" && !rec.response) rec.response = "Officials are responding to this report.";
  if (status === "resolved") rec.response = rec.response || "Incident resolved by the barangay office.";
  pushIncidentTimeline(rec, status, status === "resolved" ? (rec.response || "") : "", true);
  saveIncidents(list);
  notifyBus.post();
  closeDetailModal();
  if (typeof renderOfficialIncidents === "function") renderOfficialIncidents();
  if (typeof renderOfficialDashboardStats === "function") renderOfficialDashboardStats();
  if (typeof renderMyIncidents === "function") renderMyIncidents();
  showToast(t("Incident report updated."), "success");
}

function renderOfficialIncidents() {
  var body = document.getElementById("incidentsTableBody");
  if (!body) return;
  var q = getTableQuery("incidentsSearch");
  var statusEl = document.getElementById("incidentsStatusFilter");
  var filter = statusEl ? statusEl.value : "all";
  var sevEl = document.getElementById("incidentsSeverityFilter");
  var sevFilter = sevEl ? sevEl.value : "all";
  var fromEl = document.getElementById("incidentsFrom");
  var toEl = document.getElementById("incidentsTo");
  var from = fromEl ? fromEl.value : "";
  var to = toEl ? toEl.value : "";

  // Priority queue: escalated first, then by severity, then newest.
  var list = loadIncidents().sort(function (a, b) {
    var ea = incidentEscalated(a) ? 1 : 0, eb = incidentEscalated(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    var ra = incidentSeverityRank(a.severity), rb = incidentSeverityRank(b.severity);
    if (ra !== rb) return rb - ra;
    return String(b.date).localeCompare(String(a.date));
  });
  var shown = list.filter(function (r) {
    if (filter !== "all" && officialIncidentStatus(r) !== filter) return false;
    if (sevFilter !== "all" && (r.severity || "medium") !== sevFilter) return false;
    var d = (r.date || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (!q) return true;
    return [r.ref, r.name, r.username, r.location, r.description, incidentTypeLabel(r.type), r.status]
      .join(" ").toLowerCase().indexOf(q) !== -1;
  });
  updateTableCount("incidentsTableCount", shown.length, list.length);

  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="7" class="table-empty">' +
      t("No incident reports match your filter.") + "</td></tr>";
    return;
  }

  body.innerHTML = shown.map(function (r) {
    var status = officialIncidentStatus(r);
    var escalated = incidentEscalated(r);
    var sev = escapeHtml(r.severity || "medium");
    return '<tr class="' + (escalated ? "row-escalated" : "") + '">' +
      "<td><strong>" + escapeHtml(r.ref || "-") + "</strong>" +
        (escalated ? ' <span class="sev-chip sev-escalated">' + t("ESCALATED") + "</span>" : "") + "</td>" +
      "<td>" + escapeHtml(r.name || r.username || "-") + "</td>" +
      "<td>" + escapeHtml(t(incidentTypeLabel(r.type))) + "</td>" +
      '<td><span class="sev-chip sev-' + sev + '">' + escapeHtml(t(incidentSeverityLabel(r.severity))) + "</span></td>" +
      "<td>" + escapeHtml(r.location || "-") + "</td>" +
      "<td>" + incidentStatusPill(status) + "</td>" +
      '<td class="table-actions">' +
        '<button type="button" class="btn btn-small" onclick="openIncidentDetail(\'' + r.id + '\', true)">' + t("REVIEW") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

// ---- CSV helper shared by the exports on this page ----
function downloadCsvRows(rows, filename, toastMsg) {
  var csv = rows.map(function (row) {
    return row.map(function (cell) {
      return '"' + String(cell == null ? "" : cell).replace(/"/g, '""') + '"';
    }).join(",");
  }).join("\r\n");
  var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  if (toastMsg) showToast(t(toastMsg), "success");
  setTimeout(function () {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 500);
}

function exportIncidentsCsv() {
  var rows = [["Reference", "Type", "Severity", "Barangay", "Location", "Reported By",
               "Date Reported", "Status", "Assigned To", "Response"]];
  loadIncidents().forEach(function (r) {
    rows.push([
      r.ref, incidentTypeLabel(r.type), incidentSeverityLabel(r.severity), r.barangay, r.location,
      r.name || r.username, (r.date || "").slice(0, 10),
      INCIDENT_STATUSES[officialIncidentStatus(r)] || "Reported",
      r.assignedTo || "", (r.response || "").replace(/\s+/g, " ")
    ]);
  });
  downloadCsvRows(rows, "community-incidents-" + new Date().toISOString().slice(0, 10) + ".csv", "Incidents CSV downloaded.");
}

// Incident analytics: reports by type + a response-time KPI.
function renderOfficialIncidentAnalytics() {
  var box = document.getElementById("chartIncidentTypes");
  if (box) {
    var counts = {};
    INCIDENT_TYPES.forEach(function (tp) { counts[tp.key] = 0; });
    loadIncidents().forEach(function (r) { counts[r.type] = (counts[r.type] || 0) + 1; });
    var data = INCIDENT_TYPES.map(function (tp, i) {
      return [tp.label, counts[tp.key], i % 2 ? "bar-red" : "bar-orange"];
    });
    var max = Math.max.apply(null, data.map(function (d) { return d[1]; })) || 1;
    box.innerHTML = data.map(function (d) {
      return '<div class="bar-row">' +
        '<span class="bar-label">' + escapeHtml(t(d[0])) + '</span>' +
        '<div class="bar-track"><div class="bar-fill ' + d[2] + '" style="width:' +
          Math.max(2, Math.round(d[1] / max * 100)) + '%"></div></div>' +
        '<span class="bar-value">' + d[1] + '</span>' +
      '</div>';
    }).join("");
  }

  var kpiResp = document.getElementById("kpiIncidentResponse");
  if (kpiResp) {
    var resolved = loadIncidents().filter(function (r) {
      return officialIncidentStatus(r) === "resolved" && r.respondedDate;
    });
    if (resolved.length) {
      var total = resolved.reduce(function (s, r) {
        return s + Math.max(0, (new Date(r.respondedDate).getTime() - new Date(r.date).getTime()) / 60000);
      }, 0);
      kpiResp.textContent = Math.round(total / resolved.length) + " " + t("min");
    } else {
      kpiResp.textContent = "—";
    }
  }
  var kpiOpen = document.getElementById("kpiIncidentOpen");
  if (kpiOpen) {
    kpiOpen.textContent = loadIncidents().filter(function (r) {
      return officialIncidentStatus(r) !== "resolved";
    }).length;
  }
  var kpiEsc = document.getElementById("kpiIncidentEscalated");
  if (kpiEsc) kpiEsc.textContent = loadIncidents().filter(incidentEscalated).length;
}

// Called when a resident submits an incident report. Unlike certificates,
// incident notifications are not barangay-filtered: every Barangay Official
// sees them so whoever is on duty can respond to the emergency.
function addIncidentNotification(report) {
  var record = {
    id: generateId(),
    type: "incident",
    incidentId: report.id,
    actor: report.username,
    actorName: report.name || report.username,
    ref: report.ref || "",
    incidentType: report.type || "",
    severity: report.severity || "medium",
    barangay: report.barangay || "",
    location: report.location || "",
    text: report.description || "",
    date: new Date().toISOString(),
    read: false
  };
  var list = loadOfficialNotifications();
  list.unshift(record);
  saveOfficialNotifications(list);
  notifyBus.post();
  refreshOfficialNotifications();
  return record;
}

// The official dashboard shows the same Facebook-style community content
// residents see: news + announcements + activities feeds, the events grid,
// and the photo gallery. The shared renderers are reused so every post card,
// Like / Comment / Share / Save action, RSVP button, and lightbox works here.
function renderOfficialCommunity() {
  if (document.getElementById("dashNewsList")) renderDashNewsFeed();
  if (document.getElementById("dashAnnouncementsList")) renderDashAnnouncementsFeed();
  if (document.getElementById("dashActivitiesList")) renderDashActivitiesFeed();

  var eventBox = document.getElementById("dashEventsList");
  if (eventBox) {
    eventBox.innerHTML = loadEventsList().map(renderEventPageCard).join("");
    updateCountdowns();
  }

  var galleryBox = document.getElementById("dashGalleryGrid");
  if (galleryBox) {
    galleryItems = loadGalleryList();
    galleryBox.innerHTML = galleryItems.map(function (item, index) {
      return '' +
        '<figure class="gallery-item" onclick="showUserGalleryPhoto(' + index + ')">' +
          '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.caption) + '">' +
          '<figcaption class="caption">' + escapeHtml(item.caption) + '<br>' +
            '<small>' + formatDate(item.date) + '</small></figcaption>' +
        '</figure>';
    }).join("");
  }
}

/* ---- Official notifications (certificate requests) ---- */

function loadOfficialNotifications() { return getData(OFFICIAL_NOTIFICATIONS_KEY, []); }

function saveOfficialNotifications(list) {
  return setData(OFFICIAL_NOTIFICATIONS_KEY, (list || []).slice(0, NOTIFICATION_MAX));
}

// Called when a resident submits a certificate request
function addOfficialNotification(request) {
  var record = {
    id: generateId(),
    type: "certificate",
    requestId: request.id,
    actor: request.username,
    actorName: request.name || request.username,
    ref: request.ref || "",
    certType: request.type || "",
    barangay: request.barangay || "",
    text: request.purpose || "",
    date: new Date().toISOString(),
    read: false
  };
  var list = loadOfficialNotifications();
  list.unshift(record);
  saveOfficialNotifications(list);
  notifyBus.post();
  refreshOfficialNotifications();
  return record;
}

// Which official notifications the signed-in official can see. Certificate
// requests are strictly per-barangay, but incident/emergency reports go to
// every Barangay Official so whoever is on duty can respond.
function officialNotifVisible(n) {
  if (n.type === "incident") return true;
  return normalizeBarangay(n.barangay) === officialBarangay();
}

function officialNotifUnreadCount() {
  return loadOfficialNotifications().filter(function (n) {
    return !n.read && officialNotifVisible(n);
  }).length;
}

var officialNotifFilter = "all";

function setOfficialNotifFilter(filter) {
  officialNotifFilter = filter || "all";
  var tabs = document.querySelectorAll("#officialNotifPanel .notif-filter");
  tabs.forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-filter") === officialNotifFilter);
  });
  renderNotifPanel("official");
}

function updateOfficialSoundBtn() {
  var b = document.getElementById("officialSoundToggle");
  if (!b) return;
  var muted = localStorage.getItem("ccOfficialIncidentSound") === "off";
  b.classList.toggle("muted", muted);
  b.setAttribute("aria-pressed", muted ? "false" : "true");
  b.title = muted ? t("Alert sound off") : t("Alert sound on");
}

function buildOfficialNotifications() {
  return loadOfficialNotifications().filter(officialNotifVisible).filter(function (n) {
    if (officialNotifFilter === "incident") return n.type === "incident";
    if (officialNotifFilter === "certificate") return n.type !== "incident";
    return true;
  }).slice(0, 12);
}

function officialNotifItemHtml(n) {
  var isIncident = n.type === "incident";
  var iconClass = isIncident ? "notif-resident-icon--event" : "notif-resident-icon--announcement";
  var line = isIncident
    ? t("reported an incident") + " - " + escapeHtml(t(incidentTypeLabel(n.incidentType)))
    : t("requested a certificate") + " - " + escapeHtml(t(certTypeLabel(n.certType)));
  var quote = isIncident ? (n.location || n.text || "") : (n.text || "");
  var priority = (isIncident && (n.severity || "") === "high") ? " notif-priority-high" : "";
  return "" +
    '<button type="button" class="notif-item' + (n.read ? "" : " notif-unread") + priority + '" data-notif-id="' + n.id + '">' +
      '<span class="notif-resident-icon ' + iconClass + '" aria-hidden="true">' + (isIncident ? incidentIconSvg() : certIconSvg()) + "</span>" +
      '<span class="notif-body">' +
        '<span class="notif-line"><strong>' + escapeHtml(n.actorName || n.actor || t("Guest")) + "</strong> " +
          line + "</span>" +
        (quote ? '<span class="notif-quote">“' + escapeHtml(quote) + '”</span>' : "") +
        '<span class="notif-meta">' +
          '<span class="notif-chip">' + escapeHtml(n.ref || "") + "</span>" +
          '<span class="notif-time">' + notifRelativeTime(n.date) + "</span>" +
        "</span>" +
      "</span>" +
      (n.read ? "" : '<span class="notif-unread-dot" aria-hidden="true"></span>') +
    "</button>";
}

function markOfficialNotificationRead(id) {
  var changed = false;
  var list = loadOfficialNotifications().map(function (n) {
    // Only the signed-in official's own barangay can be marked
    if (n.id === id && !n.read && officialNotifVisible(n)) { n.read = true; changed = true; }
    return n;
  });
  if (changed) {
    saveOfficialNotifications(list);
    notifyBus.post();
    refreshOfficialNotifications();
  }
}

function markAllOfficialNotificationsRead() {
  var changed = false;
  var list = loadOfficialNotifications().map(function (n) {
    // Scope "mark all read" to this official's barangay only, so other
    // barangays keep their own unread alerts.
    if (!n.read && officialNotifVisible(n)) { n.read = true; changed = true; }
    return n;
  });
  if (!changed) return;
  saveOfficialNotifications(list);
  notifyBus.post();
  refreshOfficialNotifications();
}

// Click a certificate notification: open the request itself
function openOfficialNotification(id) {
  var record = loadOfficialNotifications().filter(function (n) { return n.id === id; })[0];
  if (!record || !officialNotifVisible(record)) return;
  markOfficialNotificationRead(id);
  closeNotifPanels();
  if (record.type === "incident") {
    showOfficialSection("incidents");
    if (record.incidentId) openIncidentDetail(record.incidentId, true);
  } else {
    showOfficialSection("requests");
    if (record.requestId) openCertRequestDetail(record.requestId, true);
  }
}

function refreshOfficialNotifications() {
  if (!document.body.classList.contains("official-body")) return;
  updateNotifBell("official");
  var panel = document.getElementById("officialNotifPanel");
  if (panel && !panel.classList.contains("hidden")) renderNotifPanel("official");
  maybePlayIncidentAlert();
}

// Let a signed-in official update their own name, photo, contact, password
function initOfficialProfile() {
  var form = document.getElementById("officialProfileForm");
  if (!form) return;
  var official = getSessionOfficial();
  if (!official) return;

  var nameInput = document.getElementById("offProfileName");
  document.getElementById("offProfileUsername").value = official.username || "";
  document.getElementById("offProfileBarangay").value = official.barangay || "-";
  document.getElementById("offProfileEmail").value = official.email || "";
  document.getElementById("offProfilePhone").value = official.phone || "";
  if (nameInput) nameInput.value = official.name || "";

  // Pending avatar chosen in this session (saved with the form)
  var pendingAvatar = official.avatar || "";
  initAvatarPicker(
    "offProfileAvatarFile", "offProfileAvatarPreview", "offProfileAvatarRemove",
    function () { return { name: (nameInput && nameInput.value.trim()) || official.username, avatar: pendingAvatar }; },
    function (dataUrl) { pendingAvatar = dataUrl; }
  );

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var name = nameInput ? nameInput.value.trim().slice(0, 60) : "";
    var email = document.getElementById("offProfileEmail").value.trim();
    var phone = document.getElementById("offProfilePhone").value.trim();
    var newPassword = document.getElementById("offProfileNewPassword").value;
    var confirmPassword = document.getElementById("offProfileConfirmPassword").value;

    var successBox = document.getElementById("offProfileSuccess");
    var errorBox = document.getElementById("offProfileError");
    successBox.classList.remove("show");
    errorBox.classList.remove("show");

    if (name.length < 3) {
      errorBox.textContent = "Please enter your full name.";
      errorBox.classList.add("show");
      return;
    }
    if (newPassword || confirmPassword) {
      if (newPassword.length < 6 || newPassword !== confirmPassword) {
        errorBox.textContent = "New password must be at least 6 characters and both fields must match.";
        errorBox.classList.add("show");
        return;
      }
    }

    var list = loadOfficials().map(function (o) {
      if (o.username !== official.username) return o;
      o.name = name;
      o.avatar = pendingAvatar;
      o.email = email;
      o.phone = phone;
      if (newPassword) o.password = hashPassword(newPassword);
      return o;
    });
    saveOfficials(list);

    document.getElementById("offProfileNewPassword").value = "";
    document.getElementById("offProfileConfirmPassword").value = "";
    showProfileSaved(successBox);

    // Reflect the new identity right away in the header
    var shown = name || official.username;
    refreshIdentityUi(["officialHeaderAvatar"], shown, pendingAvatar);
    refreshIdentityUi(["officialHeaderName"], shown, pendingAvatar);
    var welcome = document.getElementById("offWelcome");
    if (welcome) welcome.textContent = "Welcome, " + shown + "!";
    logAudit("updated official profile", official.username);
    showToast(t("Profile saved."), "success");
  });
}

function initOfficialDashboard() {
  if (!document.body.classList.contains("official-body")) return;

  // Welcome the signed-in official
  var official = getSessionOfficial();
  if (official) {
    var headerName = document.getElementById("officialHeaderName");
    if (headerName) headerName.textContent = official.name || official.username;
    var headerAvatar = document.getElementById("officialHeaderAvatar");
    if (headerAvatar) headerAvatar.innerHTML = avatarInner(official.username);
    var welcome = document.getElementById("offWelcome");
    if (welcome) {
      welcome.textContent = "Welcome, " + (official.name || official.username) + "!";
    }
    var role = document.getElementById("offRole");
    if (role) {
      role.textContent = official.barangay
        ? t(OFFICIAL_ROLE) + " · " + official.barangay
        : t(OFFICIAL_ROLE);
    }
  }

  renderOfficialDashboardStats();
  renderOfficialRequests();
  renderOfficialIncidents();
  renderOfficialIncidentAnalytics();
  renderOfficialDutyUi();
  updateOfficialSoundBtn();
  renderOfficialCommunity();
  initOfficialProfile();

  // Sidebar navigation
  var sidebar = document.getElementById("officialSidebar");
  if (sidebar) {
    sidebar.addEventListener("click", function (event) {
      var link = event.target.closest("a[data-osection]");
      if (!link) return;
      event.preventDefault();
      showOfficialSection(link.getAttribute("data-osection"));
    });
  }

  initMobileDrawer();
  initNotifBells();
  initHeaderAccountMenus();

  // Toolbar wiring - certificate requests
  var search = document.getElementById("requestsSearch");
  if (search) search.addEventListener("input", renderOfficialRequests);
  var filter = document.getElementById("requestsStatusFilter");
  if (filter) filter.addEventListener("change", renderOfficialRequests);
  ["requestsTypeFilter", "requestsFrom", "requestsTo"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", renderOfficialRequests);
  });
  var bulkReady = document.getElementById("requestsBulkReady");
  if (bulkReady) bulkReady.addEventListener("click", markSelectedRequestsReady);
  var exportRel = document.getElementById("exportReleasedBtn");
  if (exportRel) exportRel.addEventListener("click", exportReleasedCsv);

  // Toolbar wiring - incident reports
  var incSearch = document.getElementById("incidentsSearch");
  if (incSearch) incSearch.addEventListener("input", renderOfficialIncidents);
  ["incidentsStatusFilter", "incidentsSeverityFilter", "incidentsFrom", "incidentsTo"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", renderOfficialIncidents);
  });
  var exportInc = document.getElementById("exportIncidentsBtn");
  if (exportInc) exportInc.addEventListener("click", exportIncidentsCsv);

  // On-duty toggle
  var dutyBtn = document.getElementById("officialDutyToggle");
  if (dutyBtn) dutyBtn.addEventListener("click", function () { applyOfficialDuty(!isOnDuty()); });

  // Circular close button on the profile card returns to the dashboard
  var offClose = document.getElementById("offProfileCloseBtn");
  if (offClose) {
    offClose.addEventListener("click", function () { showOfficialSection("dashboard"); });
  }

  showOfficialSection(location.hash.slice(1) || "dashboard");
  window.addEventListener("hashchange", function () {
    var name = location.hash.slice(1);
    if (name) showOfficialSection(name);
  });
}

initOfficialDashboard();

/* ------------------------------------------------------------
   23. NEWS AI ASSISTANT
   A beginner-friendly rule-based assistant. It answers news,
   weather, public information, and emergency questions using
   the website's LocalStorage data plus built-in demo knowledge.
   ------------------------------------------------------------ */

// ---- 23.1 Demo weather (sample data - no internet API here) ----
function getWeatherData() {
  var today = new Date();
  var day = today.getDay(); // 0 = Sunday, changes the sample each day
  var baseTemp = 29 + (day % 4); // 29 to 32
  var conditions = ["Partly Cloudy", "Sunny", "Rain Showers", "Cloudy"];
  var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  var forecast = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(today.getTime());
    d.setDate(today.getDate() + i);
    forecast.push({
      day: i === 0 ? "Today" : dayNames[d.getDay()],
      high: baseTemp + ((i + day) % 3),
      low: baseTemp - 5 + (i % 2),
      condition: conditions[(day + i) % conditions.length]
    });
  }

  return {
    temp: baseTemp,
    condition: conditions[day % conditions.length],
    humidity: 68 + (day % 5) * 3,
    wind: 12 + (day % 4) * 3,
    heatIndex: baseTemp + 3,
    forecast: forecast
  };
}

// Weather advisories posted by the Admin
function getWeatherAdvisories() {
  var words = ["typhoon", "storm", "flood", "rain", "heat", "weather", "wind", "signal"];
  return loadAnnouncementsList().filter(function (a) {
    var hay = (a.title + " " + a.description).toLowerCase();
    var active = a.status === "Important" || a.status === "Notice" || a.status === "Active";
    return active && words.some(function (w) { return hay.indexOf(w) !== -1; });
  });
}

// Emergency alerts posted by the Admin
function getEmergencyAlerts() {
  var words = ["earthquake", "fire", "flood", "typhoon", "storm", "disaster",
               "emergency", "evacuat", "rescue", "casual"];
  var alerts = [];

  loadAnnouncementsList().forEach(function (a) {
    var hay = (a.title + " " + a.description).toLowerCase();
    var active = a.status === "Important" || a.status === "Notice" || a.status === "Active";
    if (active && words.some(function (w) { return hay.indexOf(w) !== -1; })) {
      alerts.push({ title: a.title, status: a.status, date: a.date, desc: a.description });
    }
  });

  loadNewsList().forEach(function (n) {
    var hay = (n.title + " " + n.description).toLowerCase();
    if (words.some(function (w) { return hay.indexOf(w) !== -1; })) {
      alerts.push({ title: n.title, status: "News", date: n.date, desc: n.description });
    }
  });

  return alerts.slice(0, 4);
}

// Built-in sample stories so every category can answer something
function getDemoStories() {
  return [
    { title: "Senate Passes New Budget Bill", category: "Political", demo: true,
      summary: "Lawmakers approved the national budget after three days of debates." },
    { title: "Local Officials Launch Youth Employment Program", category: "Political", demo: true,
      summary: "The program aims to help young residents find their first jobs." },
    { title: "Prices of Basic Goods Remain Stable This Week", category: "Business", demo: true,
      summary: "Market monitors reported no major price changes for rice and vegetables." },
    { title: "Small Businesses Offered Free Training Seminars", category: "Business", demo: true,
      summary: "Entrepreneurs can join free seminars on bookkeeping and online selling." },
    { title: "New Mobile App Helps Residents Report Road Problems", category: "Technology", demo: true,
      summary: "The app lets users send photos of damaged roads to city hall." },
    { title: "Schools Expand Computer Laboratories", category: "Technology", demo: true,
      summary: "Several public schools received new computers for digital classes." },
    { title: "Free Vaccination Drive Continues in Health Centers", category: "Health", demo: true,
      summary: "Residents are encouraged to avail of free vaccines this month." },
    { title: "Tips for a Healthier Rainy Season", category: "Health", demo: true,
      summary: "Doctors remind the public to drink clean water and avoid floodwater." },
    { title: "Scholarship Portal Opens for Next School Year", category: "Education", demo: true,
      summary: "Students may submit applications online until the end of the month." },
    { title: "Teachers Attend Special Training Workshop", category: "Education", demo: true,
      summary: "The workshop focused on new reading and mathematics methods." },
    { title: "Inter-Barangay Basketball Finals Set This Weekend", category: "Sports", demo: true,
      summary: "The two strongest teams will battle for the championship cup." },
    { title: "Community Run Scheduled Next Month", category: "Sports", demo: true,
      summary: "Runners of all ages can join the 3-kilometer fun run." },
    { title: "Local Film Festival Announces Nominations", category: "Entertainment", demo: true,
      summary: "Independent films from the region competed in five categories." },
    { title: "Free Concert to Celebrate Founding Anniversary", category: "Entertainment", demo: true,
      summary: "Performers and bands will entertain the crowd at the plaza." },
    { title: "Government Announces Infrastructure Upgrades", category: "National", demo: true,
      summary: "New roads and bridges are planned across several provinces." },
    { title: "World Leaders Meet for Climate Summit", category: "International", demo: true,
      summary: "Countries agreed to set new targets for reducing carbon emissions." }
  ];
}

// Find stories by keywords: local news first, then sample stories
function searchStories(keywords) {
  var found = [];

  loadNewsList().forEach(function (n) {
    var hay = (n.title + " " + n.category + " " + n.description).toLowerCase();
    if (keywords.some(function (k) { return hay.indexOf(k) !== -1; })) {
      found.push({ title: n.title, category: n.category, date: n.date,
                   summary: n.description, demo: false });
    }
  });

  if (found.length === 0) {
    getDemoStories().forEach(function (s) {
      var hay = (s.title + " " + s.category + " " + s.summary).toLowerCase();
      if (keywords.some(function (k) { return hay.indexOf(k) !== -1; })) {
        found.push(s);
      }
    });
  }

  return found.slice(0, 5);
}

// Turn a question into a category (used by summarize / explain / search)
function detectStoryCategory(q) {
  var groups = [
    { label: "Political", keys: ["politic", "election", "government", "senator", "president", "mayor", "congress"] },
    { label: "Business", keys: ["business", "econom", "market", "stock", "inflation", "price"] },
    { label: "Technology", keys: ["technolog", "tech", "internet", "gadget", "software", "digital"] },
    { label: "Health", keys: ["health", "vaccine", "disease", "virus", "covid", "medical"] },
    { label: "Education", keys: ["educat", "school", "student", "teacher", "scholar"] },
    { label: "Sports", keys: ["sport", "basketball", "football", "volleyball", "league", "athlete"] },
    { label: "Entertainment", keys: ["entertain", "celebrity", "movie", "film", "music", "concert"] },
    { label: "Local", keys: ["local", "community", "barangay", "purok", "neighborhood"] },
    { label: "International", keys: ["international", "world", "global", "united states", "china", "europe"] },
    { label: "National", keys: ["national", "philippine", "philippines", "manila", "malacanang"] }
  ];

  for (var i = 0; i < groups.length; i++) {
    for (var j = 0; j < groups[i].keys.length; j++) {
      if (q.indexOf(groups[i].keys[j]) !== -1) return groups[i];
    }
  }
  return null;
}

// Style a list of stories for the chat bubble
function storyListHtml(items) {
  var html = "<ul>";
  items.forEach(function (s) {
    html += "<li><strong>" + escapeHtml(s.title) + "</strong> &mdash; " +
            escapeHtml(s.category) +
            (s.date ? ", " + formatDate(s.date) : "") +
            (s.demo ? " <em>(sample)</em>" : "") + "</li>";
  });
  return html + "</ul>";
}

// Style a list of alerts for the chat bubble
function alertListHtml(alerts) {
  var html = "<ul>";
  alerts.forEach(function (a) {
    html += "<li><strong>" + escapeHtml(a.title) + "</strong> &mdash; " +
            escapeHtml(a.status) + ", " + formatDate(a.date) + "</li>";
  });
  return html + "</ul>";
}

// ---- 23.2 The main answer engine ----

// Knowledge base for common factual and how-to questions
function newsAiKnowledge(q) {
  function has(keys) {
    return keys.some(function (k) { return q.indexOf(k) !== -1; });
  }
  function note(text) {
    return "<span class=\"ai-note ai-note-blue\">" + text + "</span>";
  }
  // Only answer "who/what is..." knowledge when the user is actually asking
  // (so "news about the president" still goes to the news engines)
  var asking = /^(who|what|when|where|why|how|whose|which|is|are)\b/.test(q) ||
               q.indexOf("name of") !== -1 || q.indexOf("meaning") !== -1 ||
               q.indexOf("define") !== -1;

  // Date and time
  if (has(["what time", "what is the date", "what's the date", "what day is it",
           "today's date", "todays date"])) {
    var now = new Date();
    return "<p><strong>Today is " + formatPhilippineNow() + "</strong></p>" +
           "<p>The current Philippine time is <strong>" +
           formatPhilippineNow(false) + "</strong>.</p>" +
           note("Time shown is Philippine time (Asia/Manila).");
  }

  // National officials (VP checked before President: "vice president" contains "president")
  if (asking && has(["vice president", "vice-president", "bise presidente"])) {
    return "<p><strong>Vice President of the Philippines</strong></p>" +
           "<p>Based on our records, the Vice President is <strong>Sara Duterte</strong>, " +
           "who took office on June 30, 2022.</p>" +
           note("Demo knowledge for a school project. Verify current officials with official government sources.");
  }
  if (asking && has(["president", "presidente", "malacanang"])) {
    return "<p><strong>President of the Philippines</strong></p>" +
           "<p>Based on our records, the President is <strong>Ferdinand &quot;Bongbong&quot; Marcos Jr.</strong>, " +
           "who took office on June 30, 2022.</p>" +
           note("Demo knowledge for a school project. Verify current officials with official government sources.");
  }
  if (asking && has(["senator", "senate president", "chief justice", "supreme court"])) {
    return "<p>I do not have a complete directory of national officials in this demo.</p>" +
           "<p>Please check official government websites for the latest list of senators and officials.</p>";
  }

  // Local officials
  if (asking && has(["mayor", "governor", "barangay captain", "punong barangay",
                     "kagawad", "councilor", "local official"])) {
    return "<p>I do not have an updated directory of local officials in this demo.</p>" +
           "<p>Please call the community office at <strong>(02) 1234-5678</strong> " +
           "or open the <strong>Contact</strong> page for assistance.</p>";
  }

  // National hero
  if (asking && has(["national hero", "jose rizal", "hero of the philippines"])) {
    return "<p><strong>Jose Rizal</strong> is the national hero of the Philippines. " +
           "He was a writer and doctor whose novels inspired the country's reform movement.</p>" +
           note("Sample general knowledge for this school project.");
  }

  // Definitions
  if (asking && has(["barangay meaning", "define barangay", "what is a barangay",
                     "what is a purok", "define purok", "what is a purok"])) {
    if (q.indexOf("purok") !== -1) {
      return "<p>A <strong>purok</strong> (zone) is a small group of households inside a barangay, " +
             "usually led by a purok leader who helps pass announcements to residents.</p>";
    }
    return "<p>A <strong>barangay</strong> is the smallest administrative unit in the Philippines, " +
           "led by a barangay captain and a council (kagawad). This website serves one barangay community.</p>";
  }

  // About this website
  if (has(["what is community connect", "about this website", "what is this website",
           "what is this site"])) {
    return "<p><strong>Community Connect</strong> is a community news and announcements website.</p>" +
           "<p>Residents can read news, announcements, events, activities, and photos, " +
           "while admins post updates from the admin panel.</p>";
  }

  // How to register / login
  if (has(["how to register", "how do i register", "create an account", "sign up"])) {
    return "<p><strong>How to create an account</strong></p><ol>" +
           "<li>Open the <strong>Register</strong> link in the top bar.</li>" +
           "<li>Choose a username (at least 3 characters) and a password (at least 6 characters).</li>" +
           "<li>Click <strong>REGISTER</strong>, then log in from <strong>User Login</strong>.</li>" +
           "</ol><p>After logging in, open <strong>My Dashboard</strong> to manage your profile.</p>";
  }

  // How to post (admin)
  if (has(["how to post", "how do i post", "how to add news", "how to publish",
           "how to announce", "how to add an announcement"])) {
    return "<p>Only admins can post updates.</p><ol>" +
           "<li>Open <strong>Admin Login</strong> at the bottom of the footer.</li>" +
           "<li>Sign in with the admin account.</li>" +
           "<li>Use the sidebar to add News, Announcements, Events, Activities, or Photos.</li>" +
           "</ol><p>Residents do not need an account to read the website.</p>";
  }

  // Contact details
  if (has(["contact", "phone number", "email address", "office address",
           "where is the office", "how to reach"])) {
    return "<p><strong>Community Office</strong></p><ul>" +
           "<li>Address: 123 Community Street, Barangay Central</li>" +
           "<li>Phone: (02) 1234-5678</li>" +
           "<li>Email: communityconnect@email.com</li>" +
           "<li>Hours: Monday to Friday, 8:00 AM to 5:00 PM</li></ul>" +
           "<p>You can also send a message through the <strong>Contact</strong> page.</p>";
  }

  return null;
}

function newsAiAnswer(question) {
  var q = question.toLowerCase().trim();

  // Fix common typos so keywords still match (e.g. "phillipines")
  q = q.replace(/\b(phillipines|philipines|fillipines|filipines|filipinas|pilipinas)\b/g, "philippines")
       .replace(/\bpresedent/g, "president")
       .replace(/\bweater\b|\bwether\b/g, "weather")
       .replace(/\bearthqake\b|\beartquake\b/g, "earthquake")
       .replace(/\btyhpone\b|\btayphoon\b/g, "typhoon")
       .replace(/\bemergancy\b/g, "emergency");
  var today = formatDate(new Date().toISOString().split("T")[0]);
  var weather = getWeatherData();
  var advisories = getWeatherAdvisories();
  var emergencies = getEmergencyAlerts();

  function hasAny(words) {
    return words.some(function (w) { return q.indexOf(w) !== -1; });
  }

  // --- Greeting (only when the message starts with a greeting word) ---
  if (/^(hi|hello|hey|yo|good morning|good afternoon|good evening)\b/.test(q) && q.length < 30) {
    return "<p>Hello! I am <strong>News AI Assistant</strong>, your smart source for " +
           "real-time news, weather, and public updates.</p>" +
           "<p>You can ask me about headlines, weather forecasts, emergencies, " +
           "or public advisories.</p>";
  }

  // --- Help / who are you ---
  if (hasAny(["what can you do", "help", "who are you", "capabilities", "your features"])) {
    return "<p>I can assist you with:</p><ul>" +
           "<li>Top headlines and latest news by category</li>" +
           "<li>Weather forecasts, rain and storm updates</li>" +
           "<li>Emergency alerts such as earthquakes, floods, and fires</li>" +
           "<li>Public information like advisories and suspensions</li>" +
           "<li>Events, activities, and the photo gallery</li>" +
           "<li>News summaries, explanations, and recommendations</li>" +
           "<li>Common questions about officials, how-to steps, and contact details</li></ul>" +
           "<p>Try one of the suggested questions below the chat.</p>";
  }

  // --- Knowledge base: factual and how-to questions ---
  var kb = newsAiKnowledge(q);
  if (kb) return kb;

  // --- Summarize ---
  if (hasAny(["summarize", "summary", "summarise"])) {
    var cat = detectStoryCategory(q);
    var stories = cat
      ? searchStories(cat.keys)
      : loadNewsList().slice(0, 3).map(function (n) {
          return { title: n.title, category: n.category, date: n.date,
                   summary: n.description, demo: false };
        });
    if (stories.length === 0) {
      return "<p>I could not find stories to summarize for that topic yet.</p>" +
             "<p>Try asking about politics, business, technology, health, education, sports, or entertainment.</p>";
    }
    var html = "<p><strong>News Summary" + (cat ? ": " + cat.label : "") + "</strong> (" + today + ")</p><ol>";
    stories.forEach(function (s) {
      html += "<li><strong>" + escapeHtml(s.title) + "</strong> &mdash; " +
              escapeHtml(s.summary) + (s.demo ? " <em>(sample)</em>" : "") + "</li>";
    });
    return html + "</ol>";
  }

  // --- Explain ---
  if (hasAny(["explain", "what does", "meaning of", "in simple terms"])) {
    var cat2 = detectStoryCategory(q);
    var explainables = cat2 ? searchStories(cat2.keys) : searchStories(["news"]);
    if (explainables.length === 0) {
      explainables = loadNewsList().slice(0, 2).map(function (n) {
        return { title: n.title, category: n.category, date: n.date,
                 summary: n.description, demo: false };
      });
    }
    if (explainables.length === 0) {
      return "<p>Please tell me which news topic you would like me to explain.</p>";
    }
    var exp = "<p>Here is the topic explained in simple terms:</p>";
    explainables.slice(0, 2).forEach(function (s) {
      exp += "<p><strong>" + escapeHtml(s.title) + "</strong><br>" +
             escapeHtml(s.summary) + "</p>";
    });
    exp += "<span class=\"ai-note ai-note-blue\">I keep explanations short and clear " +
           "so anyone can understand the news.</span>";
    return exp;
  }

  // --- Recommendations ---
  if (hasAny(["recommend", "suggest", "should i read", "what should i read", "best stories"])) {
    var recent = loadNewsList().slice(0, 3);
    if (recent.length === 0) {
      return "<p>There are no stories to recommend right now. Please check again later.</p>";
    }
    return "<p>Based on recency and importance, I recommend reading:</p>" +
           storyListHtml(recent.map(function (n) {
             return { title: n.title, category: n.category, date: n.date, demo: false };
           })) +
           "<span class=\"ai-note ai-note-blue\">These are the newest posts from the Community Connect office.</span>";
  }

  // --- Earthquake alerts ---
  if (hasAny(["earthquake", "lindol"])) {
    var quake = emergencies.filter(function (a) {
      return (a.title + " " + a.desc).toLowerCase().indexOf("earthquake") !== -1;
    });
    if (quake.length > 0) {
      return "<span class=\"ai-note ai-note-red\"><strong>EARTHQUAKE ALERT</strong></span>" +
             alertListHtml(quake) +
             "<p>Follow drop, cover, and hold on. Stay away from damaged structures.</p>";
    }
    return "<p><strong>Earthquake Bulletin (" + today + ")</strong></p>" +
           "<p>There are <strong>no earthquake alerts</strong> in our records today.</p>" +
           "<span class=\"ai-note ai-note-green\">Status: Normal</span>" +
           "<p>In case of a quake, remember: <strong>Drop, Cover, and Hold On.</strong> " +
           "Report damage to the community office at (02) 1234-5678.</p>";
  }

  // --- Fire incidents ---
  if (hasAny(["fire", "sunog"])) {
    var fires = emergencies.filter(function (a) {
      return (a.title + " " + a.desc).toLowerCase().indexOf("fire") !== -1;
    });
    if (fires.length > 0) {
      return "<span class=\"ai-note ai-note-red\"><strong>FIRE INCIDENT</strong></span>" +
             alertListHtml(fires) + "<p>Evacuate calmly and call the fire station immediately.</p>";
    }
    return "<p>There are <strong>no active fire incidents</strong> reported in the community today.</p>" +
           "<span class=\"ai-note ai-note-green\">Status: Safe</span>" +
           "<p>Keep fire exits clear and never leave cooking unattended.</p>";
  }

  // --- General emergency / disaster ---
  if (hasAny(["emergency", "disaster", "calamity", "alert today", "disaster update"])) {
    if (emergencies.length > 0) {
      return "<span class=\"ai-note ai-note-red\"><strong>ACTIVE EMERGENCY INFORMATION</strong></span>" +
             alertListHtml(emergencies) +
             "<p>Stay tuned to official announcements and follow instructions from responders.</p>";
    }
    return "<p><strong>Emergency Status (" + today + ")</strong></p>" +
           "<p>No active emergency alerts are posted in the system right now.</p>" +
           "<span class=\"ai-note ai-note-green\">All clear</span>" +
           "<p>In any emergency, call the community office at <strong>(02) 1234-5678</strong>.</p>";
  }

  // --- Typhoon ---
  if (hasAny(["typhoon", "bagyo"])) {
    var tyAdvisories = advisories.filter(function (a) {
      return (a.title + " " + a.description).toLowerCase().indexOf("typhoon") !== -1;
    });
    if (tyAdvisories.length > 0) {
      return "<span class=\"ai-note ai-note-red\"><strong>TYPHOON ADVISORY</strong></span>" +
             alertListHtml(tyAdvisories.map(function (a) {
               return { title: a.title, status: a.status, date: a.date };
             })) +
             "<p>Prepare emergency kits and monitor official bulletins.</p>";
    }
    return "<p><strong>Typhoon Update (" + today + ")</strong></p>" +
           "<p>Based on the latest information in our system, there is <strong>no active typhoon</strong> " +
           "affecting the community.</p>" +
           "<span class=\"ai-note ai-note-green\">No typhoon signal in our area</span>" +
           "<p>For official forecasts, always check PAGASA bulletins before travelling.</p>";
  }

  // --- Flood ---
  if (hasAny(["flood", "baha"])) {
    var floodAdv = advisories.filter(function (a) {
      return (a.title + " " + a.description).toLowerCase().indexOf("flood") !== -1;
    });
    if (floodAdv.length > 0) {
      return "<span class=\"ai-note ai-note-orange\"><strong>FLOOD ADVISORY</strong></span>" +
             alertListHtml(floodAdv);
    }
    return "<p><strong>Flood Advisory (" + today + ")</strong></p>" +
           "<p>No flood warnings are posted in our area right now.</p>" +
           "<span class=\"ai-note ai-note-blue\">Rain may still cause street flooding — " +
           "avoid crossing flooded roads.</span>";
  }

  // --- Storm warning ---
  if (hasAny(["storm", "storm warning", "signal number"])) {
    var stormAdv = advisories.filter(function (a) {
      return (a.title + " " + a.description).toLowerCase().indexOf("storm") !== -1;
    });
    if (stormAdv.length > 0) {
      return "<span class=\"ai-note ai-note-orange\"><strong>STORM WARNING</strong></span>" +
             alertListHtml(stormAdv);
    }
    return "<p>No storm warning is in effect according to our records.</p>" +
           "<p>Current sky condition: <strong>" + weather.condition + "</strong> at " +
           weather.temp + "&deg;C.</p>";
  }

  // --- Heat index ---
  if (hasAny(["heat index", "too hot", "mainit", "heat advisory"])) {
    return "<p><strong>Heat Index Information (" + today + ")</strong></p><ul>" +
           "<li>Temperature: <strong>" + weather.temp + "&deg;C</strong></li>" +
           "<li>Heat Index: <strong>" + weather.heatIndex + "&deg;C</strong></li>" +
           "<li>Humidity: " + weather.humidity + "%</li></ul>" +
           "<span class=\"ai-note ai-note-orange\">Drink plenty of water and avoid " +
           "long exposure under the sun.</span>";
  }

  // --- Weekly forecast ---
  if (hasAny(["weekly forecast", "week ahead", "7-day", "seven day", "forecast for the week"])) {
    var week = "<p><strong>Weekly Weather Forecast</strong></p><ul>";
    weather.forecast.forEach(function (f) {
      week += "<li>" + f.day + ": " + f.condition + ", " + f.low + "&deg;C to " + f.high + "&deg;C</li>";
    });
    return week + "</ul><span class=\"ai-note ai-note-blue\">Sample forecast data for this " +
           "school project.</span>";
  }

  // --- Today's weather ---
  if (hasAny(["weather", "forecast", "temperature", "rain", "will it rain", "ulan", "hot outside"])) {
    var todayHtml = "<p><strong>Weather Update (" + today + ")</strong></p><ul>" +
      "<li>Current: <strong>" + weather.temp + "&deg;C, " + weather.condition + "</strong></li>" +
      "<li>Humidity: " + weather.humidity + "%</li>" +
      "<li>Wind: " + weather.wind + " km/h</li>" +
      "<li>Heat Index: " + weather.heatIndex + "&deg;C</li></ul>";

    if (advisories.length > 0) {
      todayHtml += "<span class=\"ai-note ai-note-orange\"><strong>Active advisory:</strong> " +
                   escapeHtml(advisories[0].title) + "</span>";
    } else {
      todayHtml += "<span class=\"ai-note ai-note-green\">No weather warnings in our area.</span>";
    }
    todayHtml += "<span class=\"ai-note ai-note-blue\">Sample data for this project. " +
                 "Check PAGASA for official forecasts.</span>";
    return todayHtml;
  }

  // --- School suspension / class ---
  if (hasAny(["suspension", "class suspension", "no class", "classes suspended"])) {
    var suspensions = loadAnnouncementsList().filter(function (a) {
      var hay = (a.title + " " + a.description).toLowerCase();
      return hay.indexOf("class") !== -1 || hay.indexOf("school") !== -1 ||
             hay.indexOf("suspension") !== -1;
    });
    if (suspensions.length > 0) {
      return "<p><strong>School / Class Information</strong></p>" + alertListHtml(
        suspensions.map(function (a) {
          return { title: a.title, status: a.status, date: a.date };
        }));
    }
    return "<p>There are <strong>no class suspension notices</strong> posted right now.</p>" +
           "<span class=\"ai-note ai-note-green\">Classes are considered normal.</span>" +
           "<p>Always wait for an official announcement before assuming there is no class.</p>";
  }

  // --- Traffic / transportation ---
  if (hasAny(["traffic", "transportation", "jeepney", "bus schedule", "road closure", "commut"])) {
    var roadNews = searchStories(["road", "repair", "transport", "traffic"]);
    if (roadNews.length > 0) {
      return "<p><strong>Transportation &amp; Traffic Updates</strong></p>" + storyListHtml(roadNews);
    }
    return "<p>No transportation or traffic updates are posted at the moment.</p>" +
           "<span class=\"ai-note ai-note-blue\">Check back later for road and transport advisories.</span>";
  }

  // --- Government announcements / public info ---
  if (hasAny(["government announcement", "public advis", "public information", "public info",
              "announcement", "advisory", "government"])) {
    var important = loadAnnouncementsList().slice(0, 5);
    if (important.length === 0) {
      return "<p>No public announcements are posted right now.</p>";
    }
    return "<p><strong>Latest Public Information</strong> (live from Community Connect)</p>" +
           alertListHtml(important.map(function (a) {
             return { title: a.title, status: a.status, date: a.date };
           })) +
           "<p>Open the <strong>Announcements</strong> page for full details.</p>";
  }

  // --- Upcoming events ---
  if (hasAny(["event", "calendar", "coming up"])) {
    var upcoming = loadEventsList().slice(0, 4);
    if (upcoming.length === 0) {
      return "<p>No upcoming events are posted right now.</p>" +
             "<span class=\"ai-note ai-note-blue\">Check back later or open the Events page.</span>";
    }
    var evHtml = "<p><strong>Upcoming Events</strong></p><ul>";
    upcoming.forEach(function (e) {
      evHtml += "<li><strong>" + escapeHtml(e.name) + "</strong> &mdash; " +
                formatDate(e.date) + (e.time ? ", " + escapeHtml(e.time) : "") +
                (e.location ? " at " + escapeHtml(e.location) : "") + "</li>";
    });
    return evHtml + "</ul>" +
           "<span class=\"ai-note ai-note-blue\">Open the Events page for full details and countdowns.</span>";
  }

  // --- Community activities ---
  if (hasAny(["activit"])) {
    var acts = loadActivitiesList().slice(0, 4);
    if (acts.length === 0) {
      return "<p>No community activities are listed right now.</p>";
    }
    var actHtml = "<p><strong>Community Activities</strong></p><ul>";
    acts.forEach(function (a) {
      actHtml += "<li><strong>" + escapeHtml(a.name) + "</strong>" +
                 (a.date ? " &mdash; " + formatDate(a.date) : "") + "</li>";
    });
    return actHtml + "</ul>" +
           "<span class=\"ai-note ai-note-blue\">Open the Activities page to learn more.</span>";
  }

  // --- Photo gallery ---
  if (hasAny(["gallery", "photo", "picture", "image"])) {
    var pics = loadGalleryList().slice(0, 4);
    if (pics.length === 0) {
      return "<p>No photos are posted in the gallery right now.</p>";
    }
    var picHtml = "<p><strong>Recent Photos</strong></p><ul>";
    pics.forEach(function (g) {
      picHtml += "<li><strong>" + escapeHtml(g.caption) + "</strong> &mdash; " +
                 formatDate(g.date) + "</li>";
    });
    return picHtml + "</ul>" +
           "<span class=\"ai-note ai-note-blue\">Open the Gallery page to view the photos.</span>";
  }

  // --- News categories ---
  var categoryMap = [
    { label: "Breaking News", words: ["breaking", "urgent news", "just in"], keys: ["breaking", "urgent"] },
    { label: "Sports News", words: ["sport", "basketball", "football", "volleyball", "league"], keys: ["sport", "basketball", "league"] },
    { label: "Technology News", words: ["technolog", " tech", "gadget", "internet"], keys: ["technolog", "tech"] },
    { label: "Health News", words: ["health", "vaccine", "medical"], keys: ["health", "vaccine", "medical"] },
    { label: "Education News", words: ["educat", "school news", "scholar"], keys: ["educat", "school"] },
    { label: "Business News", words: ["business", "economy", "market", "stock"], keys: ["business", "econom", "market"] },
    { label: "Political News", words: ["politic", "election", "government news", "president", "senate"], keys: ["politic", "election", "government", "president"] },
    { label: "Entertainment News", words: ["entertain", "celebrity", "movie", "concert", "music"], keys: ["entertain", "celebrity", "movie", "music"] },
    { label: "International News", words: ["international", "world news", "global"], keys: ["international", "world", "global"] },
    { label: "National News", words: ["national", "philippine"], keys: ["national", "philippine"] },
    { label: "Local News", words: ["local", "community news", "barangay"], keys: ["local", "community", "barangay"] }
  ];

  for (var ci = 0; ci < categoryMap.length; ci++) {
    var cm = categoryMap[ci];
    if (hasAny(cm.words)) {
      var items = searchStories(cm.keys);
      if (items.length === 0) {
        return "<p>I could not find " + escapeHtml(cm.label) + " right now.</p>" +
               "<p>Try another category such as sports, health, or business.</p>";
      }
      return "<p><strong>" + escapeHtml(cm.label) + "</strong> (latest updates)</p>" +
             storyListHtml(items) +
             (items.some(function (s) { return s.demo; })
               ? "<span class=\"ai-note ai-note-blue\">Local posts appear first; " +
                 "marked items are sample stories.</span>"
               : "");
    }
  }

  // --- Trending ---
  if (hasAny(["trending", "popular", "hottest", "buzz"])) {
    var trending = loadNewsList().slice(0, 3);
    var topAnn = loadAnnouncementsList().filter(function (a) { return a.status === "Important"; })[0];
    if (trending.length === 0) {
      return "<p>There are no stories to show as trending right now.</p>";
    }
    var trendHtml = "<p><strong>Trending Now</strong></p>" + storyListHtml(
      trending.map(function (n) {
        return { title: n.title, category: n.category, date: n.date, demo: false };
      }));
    if (topAnn) {
      trendHtml += "<span class=\"ai-note ai-note-orange\"><strong>Most important:</strong> " +
                   escapeHtml(topAnn.title) + "</span>";
    }
    return trendHtml;
  }

  // --- Top headlines ---
  if (hasAny(["headline", "top news", "latest news", "today's news", "todays news",
              "news today", "what is the news", "current events", "big news"])) {
    var headlines = loadNewsList().slice(0, 5);
    if (headlines.length === 0) {
      return "<p>No news has been posted yet. Please check again later.</p>";
    }
    return "<p><strong>Today's Top Headlines</strong> (" + today + ")</p>" +
           storyListHtml(headlines.map(function (n) {
             return { title: n.title, category: n.category, date: n.date, demo: false };
           })) +
           "<span class=\"ai-note ai-note-blue\">Live from Community Connect. " +
           "Ask me to summarize any story.</span>";
  }

  // --- Search fallback: match meaningful words against stories ---
  var stopWords = ["what", "when", "where", "which", "whose", "whom", "about", "name",
                   "there", "their", "them", "then", "than", "this", "that", "these",
                   "those", "with", "from", "into", "some", "more", "most", "many",
                   "just", "like", "been", "were", "have", "does", "will", "would",
                   "could", "should", "your", "yours", "tell", "give", "show", "find",
                   "news", "today", "latest", "please", "really", "vice"];
  var plainWords = q.split(/[^a-z0-9]+/).filter(function (w) {
    return w.length > 3 && stopWords.indexOf(w) === -1;
  });
  if (plainWords.length > 0) {
    var results = searchStories(plainWords);
    if (results.length > 0) {
      return "<p>Here is what I found for <strong>\"" + escapeHtml(question) + "\"</strong>:</p>" +
             storyListHtml(results);
    }
  }

  // --- Honest "could not find" for questions instead of random stories ---
  if (/^(who|whose|what|when|where|why|how|is|are|do|does|did|can|could|would|should)\b/.test(q)) {
    return "<p>Sorry, I could not find an answer to <strong>\"" + escapeHtml(question) +
           "\"</strong> in my records.</p>" +
           "<p>I can answer questions about:</p><ul>" +
           "<li>News headlines and categories (sports, health, business, and more)</li>" +
           "<li>Weather, typhoons, floods, and other emergencies</li>" +
           "<li>Announcements, events, activities, and photos</li>" +
           "<li>Philippine leaders, simple definitions, and how-to questions</li></ul>" +
           "<span class=\"ai-note ai-note-blue\">Try re-wording your question or tap a suggestion.</span>";
  }

  // --- Restriction: only news and public information ---
  return "<p>I am <strong>News AI Assistant</strong>, and I only answer questions about " +
         "news, weather, public information, and emergencies.</p>" +
         "<p>Please try a question like:</p><ul>" +
         "<li>What are today's top headlines?</li>" +
         "<li>What is the weather forecast today?</li>" +
         "<li>Are there any earthquake alerts today?</li>" +
         "<li>Give me the latest sports news.</li></ul>";
}

// ---- 23.3 Chat interface ----

function getChatHistory() { return getData("newsAiChat", []); }
function saveChatHistory(list) { setData("newsAiChat", list); }

function chatTimeNow() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Add a message bubble to the screen (and save it)
function appendChatMessage(who, text, time, save) {
  var box = document.getElementById("chatMessages");
  if (!box) return;

  var wrap = document.createElement("div");
  wrap.className = "msg " + (who === "user" ? "user" : "bot");

  var avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = who === "user" ? "U" : "AI";

  var right = document.createElement("div");

  var bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = text;

  var stamp = document.createElement("div");
  stamp.className = "msg-time";
  stamp.textContent = time;

  right.appendChild(bubble);
  right.appendChild(stamp);
  wrap.appendChild(avatar);
  wrap.appendChild(right);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;

  if (save !== false) {
    var history = getChatHistory();
    history.push({ who: who, text: text, time: time });
    // Keep only the last 60 messages
    saveChatHistory(history.slice(-60));
  }

  return wrap;
}

// Empty-state welcome shown when there is no conversation yet
function hideChatHero() {
  var hero = document.getElementById("chatHero");
  if (hero) hero.style.display = "none";
}

function showChatHero() {
  var hero = document.getElementById("chatHero");
  if (hero) hero.style.display = "";
}

// Reveal an assistant reply block by block, like a streaming answer
function streamMessage(wrap) {
  var bubble = wrap.querySelector(".msg-bubble");
  var box = document.getElementById("chatMessages");
  if (!bubble) return;
  var kids = Array.prototype.slice.call(bubble.children);
  if (kids.length === 0) {
    addCopyButton(wrap);
    return;
  }
  kids.forEach(function (k) {
    k.style.opacity = "0";
    k.style.transform = "translateY(6px)";
  });
  var i = 0;
  (function step() {
    if (i >= kids.length) {
      addCopyButton(wrap);
      return;
    }
    var k = kids[i++];
    k.style.transition = "opacity 0.22s ease, transform 0.22s ease";
    k.style.opacity = "1";
    k.style.transform = "none";
    if (box) box.scrollTop = box.scrollHeight;
    setTimeout(step, 160);
  })();
}

// Copy button under an assistant reply
function addCopyButton(wrap) {
  if (!wrap || wrap.querySelector(".msg-copy")) return;
  var bubble = wrap.querySelector(".msg-bubble");
  if (!bubble) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", function () {
    copyText(bubble.innerText);
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = "Copy"; }, 1500);
  });
  var stamp = wrap.querySelector(".msg-time");
  if (stamp && stamp.parentNode === bubble.parentNode) {
    bubble.parentNode.insertBefore(btn, stamp);
  } else {
    bubble.parentNode.appendChild(btn);
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* ignored */ }
  document.body.removeChild(ta);
}

// Show the "assistant is typing" indicator
function showChatTyping() {
  var box = document.getElementById("chatMessages");
  if (!box) return;
  var wrap = document.createElement("div");
  wrap.className = "msg bot";
  wrap.id = "chatTyping";
  wrap.innerHTML =
    '<div class="msg-avatar">AI</div>' +
    '<div><div class="msg-bubble"><span class="typing">' +
    "<span></span><span></span><span></span></span></div></div>";
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

function hideChatTyping() {
  var el = document.getElementById("chatTyping");
  if (el) el.remove();
}

// Send a question and receive an answer
function sendChatMessage(text) {
  if (!text) return;

  hideChatHero();
  appendChatMessage("user", escapeHtml(text), chatTimeNow(), true);
  showChatTyping();

  // Small delay so it feels like the assistant is thinking
  var delay = 600 + Math.floor(Math.random() * 500);
  setTimeout(function () {
    hideChatTyping();
    var reply = newsAiAnswer(text);
    var wrap = appendChatMessage("bot", reply, chatTimeNow(), true);
    streamMessage(wrap);
  }, delay);
}

function initNewsAiPage() {
  var box = document.getElementById("chatMessages");
  if (!box) return;

  // Hero welcome when there is no conversation, or restore saved history
  var history = getChatHistory();
  if (history.length === 0) {
    showChatHero();
  } else {
    hideChatHero();
    history.forEach(function (m) {
      var wrap = appendChatMessage(m.who, m.text, m.time, false);
      if (m.who !== "user") addCopyButton(wrap);
    });
    box.scrollTop = box.scrollHeight;
  }

  // Suggested sample questions
  var suggestions = [
    "What are today's top headlines?",
    "Is there a typhoon in the Philippines?",
    "What is the weather forecast today?",
    "Give me the latest sports news.",
    "What are the trending news stories right now?",
    "Are there any earthquake alerts today?",
    "Summarize today's political news.",
    "What are the latest technology updates?"
  ];
  var suggBox = document.getElementById("chatSuggestions");
  if (suggBox) {
    suggBox.innerHTML = "";
    suggestions.forEach(function (s) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-chip";
      btn.textContent = s;
      btn.addEventListener("click", function () { sendChatMessage(s); });
      suggBox.appendChild(btn);
    });
  }

  // Category chips (static buttons in the page)
  var chips = document.getElementById("chatChips");
  if (chips) {
    chips.addEventListener("click", function (event) {
      var chip = event.target.closest(".chat-chip");
      if (!chip) return;
      sendChatMessage(chip.getAttribute("data-q"));
    });
  }

  // Message form (auto-growing textarea, Enter to send)
  var form = document.getElementById("chatForm");
  var input = document.getElementById("chatInput");
  var sendBtn = document.getElementById("chatSendBtn");

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function updateSendState() {
    if (sendBtn) sendBtn.disabled = !input.value.trim();
  }

  if (form && input) {
    input.addEventListener("input", function () {
      autoGrow();
      updateSendState();
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      autoGrow();
      updateSendState();
      sendChatMessage(text);
    });

    updateSendState();
  }

  // New chat (clear conversation)
  var clearBtn = document.getElementById("chatClearBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      openConfirmModal("Start a new chat?", "NEW CHAT", function () {
        saveChatHistory([]);
        Array.prototype.slice.call(box.querySelectorAll(".msg")).forEach(function (m) {
          m.remove();
        });
        showChatHero();
        if (input) {
          input.value = "";
          autoGrow();
          updateSendState();
          input.focus();
        }
      });
    });
  }
}

initNewsAiPage();

/* ------------------------------------------------------------
   24. SECURITY HELPERS - password hashing + login attempt limiter
   Simple non-cryptographic hash for the school demo. It stores a
   one-way fingerprint instead of the raw password. This is still
   NOT real authentication security.
   ------------------------------------------------------------ */

function hashPassword(plain) {
  var str = "CommunityConnect$" + String(plain) + "$ws101";
  var h1 = 0x811c9dc5;
  var h2 = 0x1b873593;
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code * (i + 1)) >>> 0;
    h2 = ((h2 << 5) | (h2 >>> 27)) >>> 0;
    h2 = (h2 ^ code) >>> 0;
  }
  return "h$" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function isHashedPassword(value) {
  return typeof value === "string" && value.indexOf("h$") === 0 && value.length === 18;
}

// Verify a password against a stored value (hash or legacy plain text)
function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (isHashedPassword(stored)) return hashPassword(plain) === stored;
  return plain === stored;
}

// ---- Login attempt limiter (5 wrong tries = 30 second lock) ----
function getLoginAttempts(scope) {
  try {
    var raw = sessionStorage.getItem("ccLoginAttempts:" + scope);
    if (!raw) return { count: 0, lockedUntil: 0 };
    return JSON.parse(raw) || { count: 0, lockedUntil: 0 };
  } catch (e) {
    return { count: 0, lockedUntil: 0 };
  }
}

function setLoginAttempts(scope, data) {
  try { sessionStorage.setItem("ccLoginAttempts:" + scope, JSON.stringify(data)); } catch (e) {}
}

function clearLoginAttempts(scope) {
  setLoginAttempts(scope, { count: 0, lockedUntil: 0 });
}

function isLoginLocked(scope) {
  var state = getLoginAttempts(scope);
  if (state.lockedUntil > Date.now()) return true;
  if (state.lockedUntil) clearLoginAttempts(scope);
  return false;
}

// Re-enable the form once the lock expires
function runLoginLockCountdown(scope, form) {
  var btn = form.querySelector("button[type='submit']");
  var timer = setInterval(function () {
    var state = getLoginAttempts(scope);
    var secondsLeft = Math.ceil((state.lockedUntil - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      clearInterval(timer);
      clearLoginAttempts(scope);
      if (btn) { btn.disabled = false; btn.textContent = btn.getAttribute("data-original-label") || "LOGIN"; }
      return;
    }
    if (btn) btn.textContent = "TRY AGAIN IN " + secondsLeft + "S";
  }, 250);
}

function lockLoginForm(scope, form) {
  var btn = form.querySelector("button[type='submit']");
  if (btn) {
    if (!btn.getAttribute("data-original-label")) btn.setAttribute("data-original-label", btn.textContent);
    btn.disabled = true;
    btn.textContent = "TOO MANY TRIES - WAIT 30S";
  }
  runLoginLockCountdown(scope, form);
}

function setupLoginLimiter(form, scope) {
  if (isLoginLocked(scope)) lockLoginForm(scope, form);
}

function registerLoginFailure(scope, form, errorBox) {
  var state = getLoginAttempts(scope);
  state.count += 1;
  if (state.count >= 5) {
    state.count = 0;
    state.lockedUntil = Date.now() + 30000;
    setLoginAttempts(scope, state);
    lockLoginForm(scope, form);
    if (errorBox) {
      errorBox.textContent = "Too many failed attempts. Please wait 30 seconds.";
      errorBox.classList.add("show");
    }
    return;
  }
  setLoginAttempts(scope, state);
  if (errorBox) {
    errorBox.textContent = "Invalid username or password.";
    errorBox.classList.add("show");
  }
}

/* ------------------------------------------------------------
   25. VIEWS COUNTER + BOOKMARKS (Save for later) + Saved section
   ------------------------------------------------------------ */

function loadViews() { return getData("communityViews", {}); }
function getViewCount(id) { var v = loadViews(); return v[id] || 0; }

// Daily view counts (map of "YYYY-MM-DD" -> number) for the admin chart.
// Seeded with a week of sample data the first time it is needed.
function loadViewLog() {
  var log = getData("communityViewLog", null);
  if (!log) {
    log = {};
    var seed = [4, 7, 3, 9, 6, 8, 5];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      log[d.toISOString().slice(0, 10)] = seed[6 - i];
    }
    setData("communityViewLog", log);
  }
  return log;
}

function recordNewsView(id) {
  var v = loadViews();
  v[id] = (v[id] || 0) + 1;
  setData("communityViews", v);
  var log = loadViewLog();
  var today = new Date().toISOString().slice(0, 10);
  log[today] = (log[today] || 0) + 1;
  setData("communityViewLog", log);
}

function loadBookmarks() { return getData("communityBookmarks", []); }

function isCurrentSaved(type, id) {
  var user = getActor();
  if (!user) return false;
  return loadBookmarks().some(function (b) {
    return b.username === user.username && b.type === type && b.id === id;
  });
}

function bookmarkBtnLabel(type, id) {
  return isCurrentSaved(type, id) ? "SAVED" : "SAVE";
}

// Refresh every SAVE/SAVED button on the page for one item
function refreshSaveButtons(type, id, saved) {
  var attr = type === "news" ? "data-save-news" : (type === "activity" ? "data-save-act" : "data-save-ann");
  document.querySelectorAll("[" + attr + '="' + id + '"]').forEach(function (btn) {
    var label = btn.querySelector(".feed-action-label");
    if (label) label.textContent = t(saved ? "SAVED" : "SAVE");
    else btn.textContent = t(saved ? "SAVED" : "SAVE");
    btn.classList.toggle("saved", saved);
  });
}

function toggleBookmark(type, id, btn) {
  var user = getActor();
  if (!user) {
    openConfirmModal("Please log in first to save items for later.", "LOGIN", function () {
      window.location.href = "user-login.html";
    });
    return;
  }

  var list = loadBookmarks();
  var index = -1;
  list.forEach(function (b, i) {
    if (b.username === user.username && b.type === type && b.id === id) index = i;
  });

  var saved;
  if (index >= 0) {
    list.splice(index, 1);
    saved = false;
  } else {
    list.push({
      username: user.username,
      type: type,
      id: id,
      date: new Date().toISOString().split("T")[0]
    });
    saved = true;
    var saveTarget = notifyTarget(id);
    notifyAdmin("save", user.username, {
      targetType: (saveTarget && saveTarget.type) || type,
      targetId: id,
      targetTitle: (saveTarget && saveTarget.title) || ""
    });
  }
  setData("communityBookmarks", list);
  refreshSaveButtons(type, id, saved);
  renderSavedSection();
  showToast(saved ? "Saved to your items." : "Removed from saved items.", "success");
}

function removeSaved(type, id) {
  var user = getActor();
  if (!user) return;
  var list = loadBookmarks().filter(function (b) {
    return !(b.username === user.username && b.type === type && b.id === id);
  });
  setData("communityBookmarks", list);
  refreshSaveButtons(type, id, false);
  renderSavedSection();
  showToast("Removed from saved items.", "success");
}

/* ------------------------------------------------------------
   25b. FACEBOOK-STYLE NEWS FEED (user dashboard community news)
   Full-width post cards + like/comment/share bar + infinite scroll
   ------------------------------------------------------------ */

var FEED_PAGE_SIZE = 3;

function loadNewsLikes() { return getData("communityNewsLikes", {}); }
function loadUserLikesAll() { return getData("communityNewsUserLikes", {}); }
// Guests (no account) get one reaction per post, remembered per browser
function loadGuestLikes() { return getData("communityGuestLikes", []); }

function getNewsLikeCount(id) {
  var likes = loadNewsLikes();
  return likes[id] || 0;
}

function hasLikedNews(id) {
  var user = getActor();
  if (!user) return loadGuestLikes().indexOf(id) >= 0;
  var all = loadUserLikesAll();
  return (all[user.username] || []).indexOf(id) >= 0;
}

function toggleNewsLike(id) {
  var user = getActor();
  var counts = loadNewsLikes();

  if (!user) {
    // Guests can react without signing in (once per browser)
    var guest = loadGuestLikes();
    var gIdx = guest.indexOf(id);
    if (gIdx >= 0) {
      guest.splice(gIdx, 1);
      counts[id] = Math.max(0, (counts[id] || 0) - 1);
    } else {
      guest.push(id);
      counts[id] = (counts[id] || 0) + 1;
      var guestLikeTarget = notifyTarget(id);
      if (guestLikeTarget) {
        notifyAdmin("like", "", { targetType: guestLikeTarget.type, targetId: id, targetTitle: guestLikeTarget.title });
      }
    }
    setData("communityGuestLikes", guest);
    setData("communityNewsLikes", counts);
    refreshNewsLikeUI(id);
    return;
  }

  var all = loadUserLikesAll();
  var mine = all[user.username] || [];
  var idx = mine.indexOf(id);
  if (idx >= 0) {
    mine.splice(idx, 1);
    counts[id] = Math.max(0, (counts[id] || 0) - 1);
  } else {
    mine.push(id);
    counts[id] = (counts[id] || 0) + 1;
    var likeTarget = notifyTarget(id);
    if (likeTarget) {
      notifyAdmin("like", user.username, { targetType: likeTarget.type, targetId: id, targetTitle: likeTarget.title });
    }
  }
  all[user.username] = mine;
  setData("communityNewsLikes", counts);
  setData("communityNewsUserLikes", all);
  refreshNewsLikeUI(id);
}

// Update every like button + counter for one news item in place
function refreshNewsLikeUI(id) {
  var liked = hasLikedNews(id);
  var count = getNewsLikeCount(id);
  document.querySelectorAll('[data-like-news="' + id + '"]').forEach(function (btn) {
    btn.classList.toggle("liked", liked);
    btn.setAttribute("aria-pressed", liked ? "true" : "false");
    var label = btn.querySelector(".feed-action-label");
    if (label) label.textContent = liked ? t("Liked") : t("Like");
  });
  document.querySelectorAll('[data-like-count="' + id + '"]').forEach(function (el) {
    el.textContent = count + " " + t("likes");
  });
}

function legacyCopyText(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

// Copy a public news link (prefilled search) to the clipboard
function shareNewsItem(id) {
  var news = loadNewsList();
  var item = news.find(function (n) { return n.id === id; });
  var base = location.href.replace(/[^/]*$/, "") + "news.html";
  var url = item ? base + "?q=" + encodeURIComponent(item.title) : base;
  if (item) {
    notifyAdmin("share", (getSessionUser() || {}).username || "",
      { targetType: "news", targetId: id, targetTitle: item.title });
  }
  function done() { showToast(t("Link copied to clipboard."), "success"); }
  function fail() { showToast(url, "info"); }
  // Synchronous path first (works on a real click)
  if (legacyCopyText(url)) { done(); return; }
  var settled = false;
  function settle(fn) { if (!settled) { settled = true; fn(); } }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () { settle(done); }, function () { settle(fail); });
    // The clipboard promise can hang without user activation (e.g. headless)
    setTimeout(function () { settle(fail); }, 800);
  } else {
    fail();
  }
}

// Build the media block (video + photo collage) for one news item.
// `video` may be a local path, a direct link, or a data URL; `images` is the
// list of photos (item.images, falling back to the single item.image).
// Returns "" when the item has no media at all.
function newsMediaHtml(item, opts) {
  opts = opts || {};
  var cls = opts.wrapClass || "feed-image-wrap";
  var imgCls = opts.imgClass || "feed-image";
  var vidCls = opts.vidClass || "feed-video";
  var videos = getMediaVideos(item);
  var images = getMediaImages(item);
  if (!videos.length && !images.length) return "";
  var alt = item.title || item.name || "";
  var inner = "";
  // Each video renders its own player. An "idb:" reference is not a URL, so
  // it is emitted as a data attribute and swapped for a blob URL by
  // resolveVideoRefs() after insertion.
  videos.forEach(function (video, i) {
    var isRef = video.indexOf("idb:") === 0;
    var srcAttr = isRef
      ? ' data-video-ref="' + escapeHtml(video) + '"'
      : ' src="' + escapeHtml(video) + '"';
    // Poster: the captured video thumbnail (first video), else the first photo.
    var poster = mediaVideoPoster(item, i);
    inner += '<video class="' + vidCls + '"' + srcAttr +
      (poster ? ' poster="' + escapeHtml(poster) + '"' : '') +
      ' controls preload="metadata" playsinline></video>';
  });
  // Photos alongside videos: a lone photo is already the first video's
  // poster (showing it twice looks duplicated), but a set of photos is
  // real content and renders as the collage below the players.
  if (images.length === 1 && !videos.length) {
    inner += '<img class="' + imgCls + '" src="' + escapeHtml(images[0]) +
      '" alt="' + escapeHtml(alt) + '" loading="lazy" ' +
      'onerror="this.style.display=\'none\'">';
  } else if (images.length > 1) {
    // Facebook-style collage. Up to 4 tiles are shown; extras get a "+N"
    // overlay on the last tile so a post can hold many photos cheaply.
    var shown = images.slice(0, 4);
    var extra = images.length - shown.length;
    var layout = shown.length;
    inner += '<div class="news-collage collage-' + layout + '">' +
      shown.map(function (src, i) {
        var last = i === shown.length - 1;
        var overlay = (last && extra > 0)
          ? '<span class="collage-more">+' + extra + '</span>'
          : "";
        return '<span class="collage-cell">' +
          '<img class="collage-tile" src="' + escapeHtml(src) +
          '" alt="' + escapeHtml(alt) + ' photo ' + (i + 1) + '" loading="lazy">' +
          overlay +
        '</span>';
      }).join("") +
    '</div>';
  }
  var open = opts.onclick ? ' onclick="' + opts.onclick + '"' : "";
  return '<div class="' + cls + '"' + open + '>' + inner + '</div>';
}

// Swap any data-video-ref="idb:..." placeholders inside `root` for a playable
// blob URL loaded from IndexedDB. Call this after inserting media HTML.
// Videos saved before thumbnails existed get a poster backfilled once.
function resolveVideoRefs(root) {
  if (!root || !root.querySelectorAll) return;
  var vids = root.querySelectorAll("video[data-video-ref]");
  for (var i = 0; i < vids.length; i++) {
    (function (v) {
      var ref = v.getAttribute("data-video-ref");
      v.removeAttribute("data-video-ref");
      videoSrcFromRef(ref).then(function (src) {
        if (!src) return;
        v.src = src;
        // Backfill a poster for videos stored before thumbnails were captured.
        if (!v.getAttribute("poster")) {
          captureVideoPoster(src).then(function (poster) {
            if (!poster) return;
            v.setAttribute("poster", poster);
            // Backfill the stored poster on whichever collection holds the ref.
            [["communityNews", loadNewsList()], ["communityActivities", loadActivitiesList()],
             ["communityAnnouncements", loadAnnouncementsList()]].forEach(function (pair) {
              var items = pair[1];
              var item = items.find(function (n) {
                return getMediaVideos(n).indexOf(ref) >= 0;
              });
              if (item && !item.videoPoster) {
                item.videoPoster = poster;
                setData(pair[0], items);
              }
            });
          });
        }
      });
    })(vids[i]);
  }
}

// One Facebook-style post card for the dashboard news feed.
// `opts.query` (optional) highlights search matches on the public news page.
function renderNewsFeedCard(item, opts) {
  opts = opts || {};
  var q = opts.query || "";
  var views = getViewCount(item.id);
  var commentCount = getCommentCount(item.id);
  var likeCount = getNewsLikeCount(item.id);
  var liked = hasLikedNews(item.id);
  var saved = isCurrentSaved("news", item.id);
  var desc = item.description || "";
  var isLong = desc.length > 320;
  var img = newsMediaHtml(item, getMediaVideos(item).length ? {} : { onclick: "showNewsDetails('" + item.id + "')" });
  var titleHtml = q ? highlightText(item.title, q) : escapeHtml(item.title);
  var descHtml = q ? highlightText(shortText(desc, 320), q) : escapeHtml(shortText(desc, 320));
  var catHtml = q ? highlightText(t(item.category), q) : t(item.category);
  return "" +
    '<article class="feed-card">' +
      '<div class="feed-header">' +
        '<span class="feed-avatar" aria-hidden="true">' + avatarInner(item.postedBy || "Community Office") + '</span>' +
        '<div class="feed-head-text">' +
          '<strong class="feed-author">' + escapeHtml(item.postedBy || t("Community Office")) + '</strong>' +
          '<div class="feed-meta">' +
            '<span class="badge">' + catHtml + '</span>' +
            '<span>' + formatDate(item.date) + '</span>' +
            '<span>&middot;</span>' +
            '<span>' + views + ' ' + t("views") + '</span>' +
          '</div>' +
        '</div>' +
        (item.pinned ? '<span class="badge badge-featured">' + t("FEATURED") + '</span>' : '') +
      '</div>' +
      '<div class="feed-body">' +
        '<h3 class="feed-title" onclick="showNewsDetails(\'' + item.id + '\')">' + titleHtml + '</h3>' +
        '<p class="feed-text">' + descHtml +
          (isLong ? ' <a href="#" class="feed-more" onclick="event.preventDefault();showNewsDetails(\'' + item.id + '\')">' + t("SEE MORE") + '</a>' : '') +
        '</p>' +
      '</div>' +
      img +
      '<div class="feed-stats">' +
        '<span class="feed-stat">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span data-like-count="' + item.id + '">' + likeCount + ' ' + t("likes") + '</span>' +
        '</span>' +
        '<span class="feed-stat">' + commentCount + ' ' + t("comments") + ' &middot; ' + views + ' ' + t("views") + '</span>' +
      '</div>' +
      '<div class="feed-actions">' +
        '<button class="feed-action-btn' + (liked ? " liked" : "") + '" type="button" data-like-news="' + item.id + '" aria-pressed="' + (liked ? "true" : "false") + '" onclick="toggleNewsLike(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span class="feed-action-label">' + t(liked ? "Liked" : "Like") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="showNewsDetails(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
          '<span class="feed-action-label">' + t("Comment") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="shareNewsItem(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          '<span class="feed-action-label">' + t("Share") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn' + (saved ? " saved" : "") + '" type="button" data-save-news="' + item.id + '" onclick="toggleBookmark(\'news\',\'' + item.id + '\', this)">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="feed-action-label">' + t(bookmarkBtnLabel("news", item.id)) + '</span>' +
        '</button>' +
      '</div>' +
    '</article>';
}

// Copy a public activity link to the clipboard
function shareActivityItem(id) {
  var list = loadActivitiesList();
  var item = list.find(function (a) { return a.id === id; });
  var base = location.href.replace(/[^/]*$/, "") + "activities.html";
  var url = item ? base + "?q=" + encodeURIComponent(item.name) : base;
  if (item) {
    notifyAdmin("share", (getSessionUser() || {}).username || "",
      { targetType: "activity", targetId: id, targetTitle: item.name });
  }
  function done() { showToast(t("Link copied to clipboard."), "success"); }
  function fail() { showToast(url, "info"); }
  if (legacyCopyText(url)) { done(); return; }
  var settled = false;
  function settle(fn) { if (!settled) { settled = true; fn(); } }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () { settle(done); }, function () { settle(fail); });
    setTimeout(function () { settle(fail); }, 800);
  } else {
    fail();
  }
}

function shareAnnouncementItem(id) {
  var list = loadAnnouncementsList();
  var item = list.find(function (a) { return a.id === id; });
  var base = location.href.replace(/[^/]*$/, "") + "announcements.html";
  var url = item ? base + "?q=" + encodeURIComponent(item.title) : base;
  if (item) {
    notifyAdmin("share", (getSessionUser() || {}).username || "",
      { targetType: "announcement", targetId: id, targetTitle: item.title });
  }
  function done() { showToast(t("Link copied to clipboard."), "success"); }
  function fail() { showToast(url, "info"); }
  if (legacyCopyText(url)) { done(); return; }
  var settled = false;
  function settle(fn) { if (!settled) { settled = true; fn(); } }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () { settle(done); }, function () { settle(fail); });
    setTimeout(function () { settle(fail); }, 800);
  } else {
    fail();
  }
}

// One Facebook-style post card for the dashboard activities feed
function renderActivityFeedCard(item) {
  var likeCount = getNewsLikeCount(item.id);
  var liked = hasLikedNews(item.id);
  var saved = isCurrentSaved("activity", item.id);
  var desc = item.description || "";
  var isLong = desc.length > 320;
  var img = newsMediaHtml(item, getMediaVideos(item).length
    ? {}
    : { onclick: "showActivityDetails('" + item.id + "')"});
  return "" +
    '<article class="feed-card">' +
      '<div class="feed-header">' +
        '<span class="feed-avatar" aria-hidden="true">' + avatarInner(item.postedBy || "Community Office") + '</span>' +
        '<div class="feed-head-text">' +
          '<strong class="feed-author">' + escapeHtml(item.postedBy || t("Community Office")) + '</strong>' +
          '<div class="feed-meta">' +
            '<span class="badge">' + t("ACTIVITY") + '</span>' +
            '<span>' + formatDate(item.date) + '</span>' +
            '<span>&middot;</span>' +
            '<span>' + t("Location:") + ' ' + escapeHtml(item.location) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="feed-body">' +
        '<h3 class="feed-title" onclick="showActivityDetails(\'' + item.id + '\')">' + escapeHtml(item.name) + '</h3>' +
        '<p class="feed-text">' + escapeHtml(shortText(desc, 320)) +
          (isLong ? ' <a href="#" class="feed-more" onclick="event.preventDefault();showActivityDetails(\'' + item.id + '\')">' + t("SEE MORE") + '</a>' : '') +
        '</p>' +
      '</div>' +
      img +
      '<div class="feed-stats">' +
        '<span class="feed-stat">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span data-like-count="' + item.id + '">' + likeCount + ' ' + t("likes") + '</span>' +
        '</span>' +
        '<span class="feed-stat">' + t("Open for joining") + '</span>' +
      '</div>' +
      '<div class="feed-actions">' +
        '<button class="feed-action-btn' + (liked ? " liked" : "") + '" type="button" data-like-news="' + item.id + '" aria-pressed="' + (liked ? "true" : "false") + '" onclick="toggleNewsLike(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span class="feed-action-label">' + t(liked ? "Liked" : "Like") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="showActivityDetails(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
          '<span class="feed-action-label">' + t("Details") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="shareActivityItem(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          '<span class="feed-action-label">' + t("Share") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn' + (saved ? " saved" : "") + '" type="button" data-save-act="' + item.id + '" onclick="toggleBookmark(\'activity\',\'' + item.id + '\', this)">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="feed-action-label">' + t(bookmarkBtnLabel("activity", item.id)) + '</span>' +
        '</button>' +
      '</div>' +
    '</article>';
}

// One Facebook-style post card for the dashboard announcements feed
function renderAnnouncementFeedCard(item) {
  var saved = isCurrentSaved("announcement", item.id);
  var likeCount = getNewsLikeCount(item.id);
  var liked = hasLikedNews(item.id);
  var commentCount = getCommentCount(item.id);
  var desc = item.description || "";
  var isLong = desc.length > 320;
  var img = newsMediaHtml(item, getMediaVideos(item).length
    ? {}
    : { onclick: "showAnnouncementDetails('" + item.id + "')" });
  return "" +
    '<article class="feed-card">' +
      '<div class="feed-header">' +
        '<span class="feed-avatar" aria-hidden="true">' + avatarInner(item.postedBy || "Community Office") + '</span>' +
        '<div class="feed-head-text">' +
          '<strong class="feed-author">' + escapeHtml(item.postedBy || t("Community Office")) + '</strong>' +
          '<div class="feed-meta">' +
            '<span class="badge">' + t(item.category) + '</span>' +
            '<span>' + formatDate(item.date) + '</span>' +
            '<span>&middot;</span>' +
            '<span class="' + statusBadgeClass(item.status) + '">' + t(item.status) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="feed-body">' +
        '<h3 class="feed-title" onclick="showAnnouncementDetails(\'' + item.id + '\')">' + escapeHtml(item.title) + '</h3>' +
        '<p class="feed-text">' + escapeHtml(shortText(desc, 320)) +
          (isLong ? ' <a href="#" class="feed-more" onclick="event.preventDefault();showAnnouncementDetails(\'' + item.id + '\')">' + t("SEE MORE") + '</a>' : '') +
        '</p>' +
      '</div>' +
      img +
      '<div class="feed-stats">' +
        '<span class="feed-stat">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span data-like-count="' + item.id + '">' + likeCount + ' ' + t("likes") + '</span>' +
        '</span>' +
        '<span class="feed-stat">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '<span data-comment-count="' + item.id + '">' + commentCount + ' ' + t("comments") + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="feed-actions">' +
        '<button class="feed-action-btn' + (liked ? " liked" : "") + '" type="button" data-like-news="' + item.id + '" aria-pressed="' + (liked ? "true" : "false") + '" onclick="toggleNewsLike(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span class="feed-action-label">' + t(liked ? "Liked" : "Like") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="showAnnouncementDetails(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="feed-action-label">' + t("Comment") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn" type="button" onclick="shareAnnouncementItem(\'' + item.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          '<span class="feed-action-label">' + t("Share") + '</span>' +
        '</button>' +
        '<button class="feed-action-btn' + (saved ? " saved" : "") + '" type="button" data-save-ann="' + item.id + '" onclick="toggleBookmark(\'announcement\',\'' + item.id + '\', this)">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="feed-action-label">' + t(bookmarkBtnLabel("announcement", item.id)) + '</span>' +
        '</button>' +
      '</div>' +
    '</article>';
}

// Footer for a feed list: a sentinel to keep scrolling, or an end message
function feedFooterHtml(box, items) {
  return items.length > (box._feedCount || FEED_PAGE_SIZE)
    ? '<div class="feed-sentinel"></div>'
    : '<p class="feed-end">' + t("You're all caught up.") + '</p>';
}

// Draw the visible slice of a feed list (first render or after loading more).
// Each box keeps its own counter + IntersectionObserver so multiple feeds
// (news + activities) can scroll independently on the same page.
function drawFeedList(box, items, renderCard, emptyMsg) {
  if (!box) return;
  if (items.length === 0) {
    box.innerHTML = '<div class="empty-state"><p>' + t(emptyMsg) + '</p></div>';
    return;
  }
  var visible = box._feedCount || FEED_PAGE_SIZE;
  box.innerHTML = items.slice(0, visible).map(renderCard).join("") + feedFooterHtml(box, items);
  resolveVideoRefs(box);
  setupFeedObserver(box, items, renderCard, emptyMsg);
}

// Infinite scroll: load the next page when this list's sentinel scrolls into view
function setupFeedObserver(box, items, renderCard, emptyMsg) {
  var sentinel = box.querySelector(".feed-sentinel");
  if (!sentinel) return;
  if (box._feedObserver) box._feedObserver.disconnect();
  if (typeof IntersectionObserver === "undefined") return;
  box._feedLoading = false;
  box._feedObserver = new IntersectionObserver(function (entries) {
    // Guard the whole callback on the loading flag: the observer can deliver
    // more than one intersecting entry in a single batch, and re-checking per
    // entry would let a second one queue a duplicate page load.
    if (box._feedLoading) return;
    if (!entries.some(function (e) { return e.isIntersecting; })) return;
    box._feedLoading = true;
    box._feedObserver.disconnect();
    sentinel.className = "feed-sentinel feed-loading";
    sentinel.innerHTML = '<span class="feed-spinner" aria-hidden="true"></span> ' + t("Loading more posts...");
    // Small delay so the spinner is visible, like a real social feed
    setTimeout(function () {
      box._feedCount = (box._feedCount || FEED_PAGE_SIZE) + FEED_PAGE_SIZE;
      drawFeedList(box, items, renderCard, emptyMsg);
      box._feedLoading = false;
    }, 400);
  }, { rootMargin: "200px" });
  box._feedObserver.observe(sentinel);
}

function renderDashNewsFeed() {
  var box = document.getElementById("dashNewsList");
  if (!box) return;
  box._feedCount = FEED_PAGE_SIZE;
  drawFeedList(box, loadNewsList(), renderNewsFeedCard, "No community news posted yet.");
}

function renderDashActivitiesFeed() {
  var box = document.getElementById("dashActivitiesList");
  if (!box) return;
  box._feedCount = FEED_PAGE_SIZE;
  drawFeedList(box, loadActivitiesList(), renderActivityFeedCard, "No community activities posted yet.");
}

function renderDashAnnouncementsFeed() {
  var box = document.getElementById("dashAnnouncementsList");
  if (!box) return;
  box._feedCount = FEED_PAGE_SIZE;
  drawFeedList(box, loadAnnouncementsList(), renderAnnouncementFeedCard, "No community announcements posted yet.");
}

// The "Saved Items" dashboard section
function renderSavedSection() {
  var box = document.getElementById("dashSavedList");
  if (!box) return;

  var user = getSessionUser();
  var items = user ? loadBookmarks().filter(function (b) { return b.username === user.username; }) : [];

  if (items.length === 0) {
    box.innerHTML = '<div class="empty-state"><p>' + t("You have not saved anything yet.") + ' ' +
      t('Click <strong>SAVE</strong> on any news article or announcement to keep it here.') + '</p></div>';
    return;
  }

  var news = loadNewsList();
  var anns = loadAnnouncementsList();
  var acts = loadActivitiesList();

  box.innerHTML = items.map(function (b) {
    var source = b.type === "news"
      ? news.find(function (n) { return n.id === b.id; })
      : b.type === "activity"
        ? acts.find(function (a) { return a.id === b.id; })
        : anns.find(function (a) { return a.id === b.id; });
    if (!source) return "";

    var title = source.title || source.name;
    var typeLabel = b.type === "news" ? "NEWS" : (b.type === "activity" ? "ACTIVITY" : "ANNOUNCEMENT");
    var showFn = b.type === "news" ? "showNewsDetails" : (b.type === "activity" ? "showActivityDetails" : "showAnnouncementDetails");

    return '' +
      '<div class="list-item">' +
        '<div class="item-content">' +
          '<p class="meta"><span class="badge">' + t(typeLabel) + '</span> ' +
            formatDate(source.date) + ' &nbsp; <span class="meta-stat">' + t("saved") + ' ' + formatDate(b.date) + '</span></p>' +
          '<h3>' + escapeHtml(title) + '</h3>' +
          '<div class="item-actions">' +
            '<button class="btn btn-small" type="button" onclick="' + showFn + '(\'' + b.id + '\')">' + t("VIEW DETAILS") + '</button>' +
            '<button class="btn btn-small btn-danger" type="button" onclick="removeSaved(\'' + b.type + '\',\'' + b.id + '\')">' + t("REMOVE") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }).join("");
}

/* ------------------------------------------------------------
   26. NEWS COMMENTS
   ------------------------------------------------------------ */

function loadComments() { return getData("communityComments", []); }

// Comments are keyed by post id (news / announcement / activity) in `newsId`
// for backwards compatibility, with the post kind in `postType`.
function getComments(postId) {
  return loadComments()
    .filter(function (c) { return c.newsId === postId && !c.hidden; })
    .sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
}

function getCommentCount(postId) {
  return loadComments().filter(function (c) { return c.newsId === postId && !c.hidden; }).length;
}

// Every comment on a post, with the post's own kind
function renderCommentsHtml(postId, postType) {
  postType = postType || "news";
  var list = getComments(postId);
  var user = getActor();

  var rows = list.map(function (c) {
    var mine = user && user.username === c.username;
    return '' +
      '<div class="comment">' +
        '<div class="comment-head">' +
          '<span class="comment-avatar ' + commentAvatarClass(c.username) + '" aria-hidden="true">' + avatarInner(c.username) + '</span>' +
          '<strong>' + escapeHtml(displayNameFor(c.username)) + '</strong>' +
          (c.guest ? ' <span class="badge">' + t("GUEST") + '</span>' : '') +
          '<span class="meta">' + formatDate((c.date || "").slice(0, 10)) + '</span>' +
          (mine ? '<button class="comment-del" type="button" title="Delete my comment" onclick="deleteNewsComment(\'' + c.id + '\',\'' + postId + '\',\'' + postType + '\')">&times;</button>' : '') +
        '</div>' +
        '<p>' + escapeHtml(c.text) + '</p>' +
      '</div>';
  }).join("");

  var formHtml;
  if (user) {
    formHtml = '<form class="comment-form" onsubmit="return submitNewsComment(event, \'' + postId + '\', \'' + postType + '\')">' +
        '<textarea id="commentInput" rows="2" placeholder="' + t("Write a comment...") + '" maxlength="500"></textarea>' +
        '<button type="submit" class="btn btn-small">' + t("POST COMMENT") + '</button>' +
      '</form>';
  } else {
    // Guests can join the discussion with just a display name
    formHtml =
      '<form class="comment-form comment-form-guest" onsubmit="return submitNewsComment(event, \'' + postId + '\', \'' + postType + '\')">' +
        '<input type="text" id="guestName" class="guest-name-input" placeholder="' + t("Your name (optional)") + '" maxlength="40" autocomplete="name">' +
        '<textarea id="commentInput" rows="2" placeholder="' + t("Write a comment...") + '" maxlength="500"></textarea>' +
        '<button type="submit" class="btn btn-small">' + t("POST COMMENT") + '</button>' +
      '</form>' +
      '<p class="meta comment-login"><a href="user-login.html">' + t("Log in") + '</a> ' + t("to join the discussion.") + '</p>';
  }

  return '' +
    '<div class="comments-box" id="commentsBox">' +
      '<h4>' + t("COMMENTS") + ' (' + list.length + ')</h4>' +
      '<div id="commentsList">' + (rows || '<p class="meta">' + t("No comments yet. Be the first to share your thoughts.") + '</p>') + '</div>' +
      formHtml +
    '</div>';
}

function refreshCommentsArea(postId, postType) {
  var box = document.getElementById("commentsBox");
  if (box) box.outerHTML = renderCommentsHtml(postId, postType);
}

function submitNewsComment(event, postId, postType) {
  event.preventDefault();
  var user = getActor();
  var input = document.getElementById("commentInput");
  var text = (input && input.value ? input.value : "").trim();
  if (!text) return false;

  var isGuest = !user;
  var name = "";
  if (isGuest) {
    var nameEl = document.getElementById("guestName");
    name = (nameEl && nameEl.value ? nameEl.value : "").trim().slice(0, 40) || t("Guest");
  } else {
    name = user.username;
  }

  var list = loadComments();
  var record = {
    id: generateId(),
    newsId: postId,
    postType: postType || "news",
    username: name,
    text: text.slice(0, 500),
    date: new Date().toISOString()
  };
  if (isGuest) record.guest = true;
  list.push(record);
  setData("communityComments", list);

  var commentTarget = notifyTarget(postId);
  notifyAdmin("comment", isGuest ? "" : user.username, {
    targetType: (commentTarget && commentTarget.type) || postType || "news",
    targetId: postId,
    targetTitle: (commentTarget && commentTarget.title) || "",
    text: text
  });

  refreshCommentsArea(postId, postType);
  refreshCommentCounters(postId);
  showToast("Comment posted.", "success");
  return false;
}

function deleteNewsComment(id, postId, postType) {
  var user = getActor();
  if (!user) return;
  var list = loadComments().filter(function (c) {
    return !(c.id === id && c.username === user.username);
  });
  setData("communityComments", list);
  refreshCommentsArea(postId, postType);
  refreshCommentCounters(postId);
  showToast("Comment deleted.", "success");
}

// Update every inline comment badge/counter for one post in place
function refreshCommentCounters(postId) {
  var n = getCommentCount(postId);
  document.querySelectorAll('[data-comment-count="' + postId + '"]').forEach(function (el) {
    el.textContent = n + " " + t("comments");
  });
}

/* ------------------------------------------------------------
   26b. ADMIN COMMENTS - Facebook-style post-grouped threads
   ------------------------------------------------------------ */

// Escape a value for use inside a single-quoted JS string in an attribute
function jsAttrStr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// Open the user detail modal by username (from comment rows)
function viewUserByUsername(username) {
  var u = loadUsers().find(function (x) { return x.username === username; });
  if (!u) {
    showToast(t("User not found."), "error");
    return;
  }
  viewUser(u.id);
}

// Stable avatar colour based on the username
function commentAvatarClass(username) {
  var sum = 0;
  var name = String(username || "");
  for (var i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return "avatar-" + ((sum % 4) + 1);
}

// Resolve the post a comment belongs to - news, announcement, or activity
function findCommentedPost(postId) {
  var n = loadNewsList().find(function (x) { return x.id === postId; });
  if (n) return { type: "news", title: n.title, icon: "N", post: n };
  var a = loadAnnouncementsList().find(function (x) { return x.id === postId; });
  if (a) return { type: "announcement", title: a.title, icon: "A", post: a };
  var c = loadActivitiesList().find(function (x) { return x.id === postId; });
  if (c) return { type: "activity", title: c.name, icon: "C", post: c };
  var up = loadUserPosts().find(function (x) { return x.id === postId; });
  if (up) return { type: "post", title: up.title || postKindLabel(up.kind), icon: "P", post: up };
  return null;
}

// Group every comment under its post, newest activity first
function getCommentThreads() {
  var byPost = {};
  loadComments().forEach(function (c) {
    var key = c.newsId || "";
    if (!byPost[key]) {
      var found = findCommentedPost(key);
      byPost[key] = {
        post: found ? found.post : null,
        title: found ? found.title : t("Deleted post"),
        type: found ? found.type : (c.postType || "news"),
        icon: found ? found.icon : "?",
        comments: []
      };
    }
    byPost[key].comments.push(c);
  });
  var threads = Object.keys(byPost).map(function (key) {
    var thread = byPost[key];
    thread.comments.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
    thread.latest = thread.comments[0] ? thread.comments[0].date : "";
    return thread;
  });
  threads.sort(function (a, b) { return (b.latest || "").localeCompare(a.latest || ""); });
  return threads;
}

function adminCommentRowHtml(c) {
  return '' +
    '<div class="comment-admin-row' + (c.hidden ? " comment-hidden" : "") + '">' +
      '<span class="comment-avatar ' + commentAvatarClass(c.username) + '" aria-hidden="true">' + avatarInner(c.username) + '</span>' +
      '<div class="comment-admin-body">' +
        '<div class="comment-admin-head">' +
          '<strong>' + escapeHtml(displayNameFor(c.username)) + '</strong>' +
          (c.guest ? ' <span class="badge">' + t("GUEST") + '</span>' : '') +
          '<span class="meta">' + formatDate((c.date || "").slice(0, 10)) + '</span>' +
          (c.hidden ? ' <span class="badge badge-hidden">' + t("HIDDEN") + '</span>' : '') +
        '</div>' +
        '<p>' + escapeHtml(c.text) + '</p>' +
        '<div class="comment-admin-actions">' +
          (c.guest ? "" :
            '<button class="btn btn-small" type="button" onclick="viewUserByUsername(\'' + jsAttrStr(c.username) + '\')">' + t("VIEW PROFILE") + '</button>') +
          '<button class="btn btn-small" type="button" onclick="toggleCommentHidden(\'' + c.id + '\')">' + t(c.hidden ? "SHOW" : "HIDE") + '</button>' +
          '<button class="btn btn-small btn-danger" type="button" onclick="deleteAdminComment(\'' + c.id + '\')">' + t("DELETE") + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function renderAdminComments() {
  var box = document.getElementById("adminCommentThreads");
  if (!box) return;
  var q = getTableQuery("commentsTableSearch");
  var threads = getCommentThreads();
  var totalComments = 0;
  var shownComments = 0;

  threads.forEach(function (thread) { totalComments += thread.comments.length; });

  var html = threads.map(function (thread) {
    var postTitle = thread.title;
    var rows = thread.comments.filter(function (c) {
      return matchesQuery(q, [postTitle, c.username, c.text]);
    });
    if (!rows.length) return "";
    shownComments += rows.length;
    return '<div class="comment-post-card">' +
      '<div class="comment-post-head">' +
        '<span class="comment-post-icon comment-post-icon-' + thread.type + '" aria-hidden="true">' + thread.icon + '</span>' +
        '<div>' +
          '<strong>' + escapeHtml(postTitle) + '</strong>' +
          '<span class="meta">' + t(thread.type.toUpperCase()) + ' · ' + rows.length + ' ' + t("comments") + '</span>' +
        '</div>' +
      '</div>' +
      rows.map(adminCommentRowHtml).join("") +
    '</div>';
  }).join("");

  updateTableCount("commentsTableCount", shownComments, totalComments);

  if (!threads.length) {
    box.innerHTML = '<p class="meta admin-comments-empty">' + t("No comments on any post yet.") + '</p>';
    return;
  }
  box.innerHTML = html || '<p class="meta admin-comments-empty">' + t("No matching results.") + '</p>';
}

// Hide a comment from the public site (admins can bring it back)
function toggleCommentHidden(id) {
  var target = loadComments().find(function (x) { return x.id === id; });
  if (!target) return;
  target.hidden = !target.hidden;
  setData("communityComments", loadComments().map(function (x) {
    return x.id === id ? target : x;
  }));
  renderAdminComments();
  showToast(target.hidden ? t("Comment hidden.") : t("Comment shown."), "success");
  logAudit(target.hidden ? "hid comment" : "showed comment", target.username);
}

// Confirm, then permanently delete a comment
function deleteAdminComment(id) {
  var target = loadComments().find(function (x) { return x.id === id; });
  if (!target) return;
  openConfirmModal("Are you sure you want to delete this comment?", "DELETE", function () {
    setData("communityComments", loadComments().filter(function (x) { return x.id !== id; }));
    renderAdminComments();
    updateDashboardStats();
    logAudit("deleted comment", target.username);
    showToast(t("Comment deleted."), "success");
  });
}

// Jump from a content table's comment badge to the matching thread
function gotoCommentsFor(postId) {
  var found = findCommentedPost(postId);
  showAdminSection("comments");
  var input = document.getElementById("commentsTableSearch");
  if (input && found) input.value = found.title;
  renderAdminComments();
}

function initCommentsAdmin() {
  bindTableSearch("commentsTableSearch", renderAdminComments);
  renderAdminComments();
}

initCommentsAdmin();

/* ------------------------------------------------------------
   27. EVENT RSVP ("I'm going")
   ------------------------------------------------------------ */

function loadRsvps() { return getData("communityRsvps", []); }

function rsvpCount(eventId) {
  return loadRsvps().filter(function (r) { return r.eventId === eventId; }).length;
}

function isGoing(eventId) {
  var user = getActor();
  if (!user) return false;
  return loadRsvps().some(function (r) {
    return r.username === user.username && r.eventId === eventId;
  });
}

function toggleRsvp(eventId, btn) {
  var user = getActor();
  if (!user) {
    openConfirmModal("Please log in first to RSVP for community events.", "LOGIN", function () {
      window.location.href = "user-login.html";
    });
    return;
  }

  var list = loadRsvps();
  var index = -1;
  list.forEach(function (r, i) {
    if (r.username === user.username && r.eventId === eventId) index = i;
  });

  var going;
  if (index >= 0) {
    list.splice(index, 1);
    going = false;
  } else {
    list.push({ username: user.username, eventId: eventId, date: new Date().toISOString().split("T")[0] });
    going = true;
  }
  setData("communityRsvps", list);

  if (going) {
    var ev = loadEventsList().filter(function (e) { return e.id === eventId; })[0];
    notifyAdmin("rsvp", user.username, {
      targetType: "event",
      targetId: eventId,
      targetTitle: ev ? ev.name : ""
    });
  }

  document.querySelectorAll('[data-rsvp="' + eventId + '"]').forEach(function (b) {
    b.textContent = (going ? t("YOU'RE GOING") : t("I'M GOING")) + " (" + rsvpCount(eventId) + ")";
    b.classList.toggle("active", going);
  });
  showToast(going ? "See you there! Your RSVP is confirmed." : "Your RSVP was removed.", "success");
}

/* ------------------------------------------------------------
   27b. EMERGENCY HOTLINES DIRECTORY (hotlines.html)
   ------------------------------------------------------------ */

var HOTLINES = [
  { icon: "hall", tone: "blue", name: "Barangay Hall",
    desc: "Barangay services, blotter reports, mediation, and community assistance.",
    number: "(02) 8123-4567", tel: "+63281234567", hours: "Mon - Fri, 8:00 AM - 5:00 PM" },
  { icon: "shield", tone: "navy", name: "Police Station",
    desc: "Crime reports, peace and order concerns, and police assistance.",
    number: "117 / (02) 8123-4568", tel: "117", hours: "Available 24/7" },
  { icon: "health", tone: "green", name: "Rural Health Unit",
    desc: "Medical consultations, maternal care, immunization, and ambulance referral.",
    number: "(02) 8123-4569", tel: "+63281234569", hours: "Available 24/7" },
  { icon: "fire", tone: "red", name: "Fire Department",
    desc: "Fire emergencies, rescue operations, and fire safety inspections.",
    number: "(02) 8123-4570", tel: "+63281234570", hours: "Available 24/7" },
  { icon: "rescue", tone: "amber", name: "Rescue Unit (MDRRMO)",
    desc: "Typhoon, flood, and disaster response plus search and rescue operations.",
    number: "0917-123-4567", tel: "+639171234567", hours: "Available 24/7" }
];

function hotlineIcon(name) {
  var paths = {
    hall: '<path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M9 21v-4h6v4"/><path d="M9 7h2"/><path d="M13 7h2"/><path d="M9 11h2"/><path d="M13 11h2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    health: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/>',
    fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    rescue: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/><line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/><line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/><line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/>'
  };
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    (paths[name] || "") + "</svg>";
}

function renderHotlinesPage() {
  var box = document.getElementById("hotlinesList");
  if (!box) return;
  box.innerHTML = HOTLINES.map(function (h) {
    var isAlways = h.hours.indexOf("24/7") >= 0;
    return '<article class="hotline-card tone-' + (h.tone || "blue") + '">' +
      '<div class="hotline-head">' +
        '<span class="hotline-icon" aria-hidden="true">' + hotlineIcon(h.icon) + '</span>' +
        '<div class="hotline-title">' +
          '<h3>' + t(h.name) + '</h3>' +
          '<span class="badge' + (isAlways ? " badge-green" : "") + '">' + t(h.hours) + '</span>' +
        '</div>' +
      '</div>' +
      '<p class="hotline-desc">' + t(h.desc) + '</p>' +
      '<p class="hotline-number">' + escapeHtml(h.number) + '</p>' +
      '<div class="hotline-actions">' +
        '<a class="btn btn-small" href="tel:' + escapeHtml(h.tel) + '">' + t("CALL NOW") + '</a>' +
        '<button class="btn btn-small btn-outline-dark" type="button" data-copy-number="' +
          escapeHtml(h.number) + '">' + t("COPY NUMBER") + '</button>' +
      '</div>' +
    '</article>';
  }).join("");

  box.querySelectorAll("[data-copy-number]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      copyTextToClipboard(btn.getAttribute("data-copy-number"), btn);
    });
  });
}

// Add the Emergency Hotlines link to every public nav + footer
function injectHotlinesLinks() {
  document.querySelectorAll(".main-nav ul").forEach(function (ul) {
    var existing = ul.querySelector('a[href="hotlines.html"]');
    if (existing) { existing.textContent = t("HOTLINES"); return; }
    var contact = ul.querySelector('a[href="contact.html"]');
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "hotlines.html";
    a.textContent = t("HOTLINES");
    li.appendChild(a);
    if (contact && contact.parentNode) ul.insertBefore(li, contact.parentNode);
    else ul.appendChild(li);
  });
  document.querySelectorAll(".site-footer ul").forEach(function (ul) {
    var existing = ul.querySelector('a[href="hotlines.html"]');
    if (existing) { existing.textContent = t("Emergency Hotlines"); return; }
    var contact = ul.querySelector('a[href="contact.html"]');
    if (!contact || !contact.parentNode) return;
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "hotlines.html";
    a.textContent = t("Emergency Hotlines");
    li.appendChild(a);
    ul.insertBefore(li, contact.parentNode);
  });
}

/* ------------------------------------------------------------
   28. EMERGENCY ALERT BANNER (shown on every public page)
   An announcement saved with status "Emergency" turns on the bar.
   ------------------------------------------------------------ */

function getActiveEmergency() {
  var list = loadAnnouncementsList().filter(function (a) { return a.status === "Emergency"; });
  list.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
  return list[0] || null;
}

function renderEmergencyBanner() {
  var header = document.querySelector(".site-header");
  if (!header) return;

  var em = getActiveEmergency();
  var existing = document.getElementById("emergencyBanner");

  if (!em || sessionStorage.getItem("ccEmergencyDismissed") === em.id) {
    if (existing) existing.remove();
    return;
  }

  if (!existing) {
    existing = document.createElement("div");
    existing.className = "emergency-banner";
    existing.id = "emergencyBanner";
    header.parentNode.insertBefore(existing, header);
  }

  existing.innerHTML =
    '<div class="container">' +
      '<span class="eb-tag">' + t("EMERGENCY ALERT") + '</span>' +
      '<a class="eb-link" href="announcements.html">' + escapeHtml(shortText(em.title, 90)) + '</a>' +
      '<button type="button" class="eb-close" id="emergencyDismiss" aria-label="' + t("Dismiss") + '">&times;</button>' +
    '</div>';

  document.getElementById("emergencyDismiss").addEventListener("click", function () {
    sessionStorage.setItem("ccEmergencyDismissed", em.id);
    existing.remove();
  });
}

/* ------------------------------------------------------------
   29. IMAGE UPLOAD (file picker + canvas compression)
   Admins can pick a real image instead of typing a file path.
   The picture is resized and saved as a data URL in LocalStorage.
   ------------------------------------------------------------ */

function compressImage(dataUrl, maxSize, callback) {
  var img = new Image();
  img.onload = function () {
    var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width * scale));
    var h = Math.max(1, Math.round(img.height * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    try {
      callback(canvas.toDataURL("image/jpeg", 0.75));
    } catch (e) {
      callback(dataUrl);
    }
  };
  img.onerror = function () { callback(dataUrl); };
  img.src = dataUrl;
}

function initOneUpload(fileId, targetId, previewId) {
  var fileInput = document.getElementById(fileId);
  if (!fileInput) return;
  var target = document.getElementById(targetId);
  var preview = document.getElementById(previewId);

  fileInput.addEventListener("change", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      showToast("Please choose an image file (JPG, PNG, GIF, or WEBP).", "error");
      this.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      compressImage(e.target.result, 900, function (dataUrl) {
        if (target) target.value = dataUrl;
        if (preview) { preview.src = dataUrl; preview.classList.add("show"); }
      });
    };
    reader.readAsDataURL(file);
  });
}

function initImageUploads() {
  // News, activities, and announcements all support several photos per post.
  initNewsMultiUpload();
  initActivityMultiUpload();
  initAnnMultiUpload();
  initOneUpload("galleryImageFile", "galleryImage", "galleryImagePreview");
}

/* ------------------------------------------------------------
   29a. MULTI-PHOTO NEWS POSTS
   A news post can carry up to MAX_NEWS_IMAGES photos. They live in
   item.images (array); item.image always mirrors the first one so older
   code (table thumbs, CSV, video posters) keeps working unchanged.
   ------------------------------------------------------------ */

var MAX_MEDIA_IMAGES = 6;
var MAX_MEDIA_VIDEOS = 3;

// The photo list for one item, tolerating older single-image records.
// Works for both news (item.title) and activities (item.name).
function getMediaImages(item) {
  if (!item) return [];
  if (Array.isArray(item.images)) {
    return item.images.map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  }
  var single = item.image ? String(item.image).trim() : "";
  return single ? [single] : [];
}

// Back-compat alias used by the news renderers.
function getNewsImages(item) { return getMediaImages(item); }

// The video list for one item. Older records kept a single `video` string;
// newer ones use a `videos` array. Each entry is a path, link, data URL, or
// an "idb:<key>" reference to a file in IndexedDB.
function getMediaVideos(item) {
  if (!item) return [];
  if (Array.isArray(item.videos)) {
    return item.videos.map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  }
  var single = item.video ? String(item.video).trim() : "";
  return single ? [single] : [];
}

// A thumbnail for one video: the captured frame if present, else the first photo.
function mediaVideoPoster(item, index) {
  var images = getMediaImages(item);
  if (index === 0 && item && item.videoPoster) return String(item.videoPoster).trim();
  return images.length ? images[0] : "";
}

// Read the picked photos from a hidden JSON field (falls back to the single
// path box so a typed path still counts as one image).
function readImagesField(jsonPathId, pathId) {
  var jsonEl = document.getElementById(jsonPathId);
  if (jsonEl && jsonEl.value.trim()) {
    try {
      var arr = JSON.parse(jsonEl.value);
      if (Array.isArray(arr)) {
        return arr.map(function (s) { return String(s || "").trim(); }).filter(Boolean);
      }
    } catch (e) { /* fall through to the path box */ }
  }
  var pathEl = document.getElementById(pathId);
  var single = pathEl ? pathEl.value.trim() : "";
  return single ? [single] : [];
}

function readNewsImagesField() { return readImagesField("newsImagesJson", "newsImage"); }
function readActivityImagesField() { return readImagesField("activityImagesJson", "activityImage"); }
function readAnnImagesField() { return readImagesField("annImagesJson", "annImage"); }

// Redraw the small thumbnail strip + "N photos" label under the picker.
function renderImageStrip(stripId, countId, images) {
  var strip = document.getElementById(stripId);
  var countEl = document.getElementById(countId);
  if (strip) {
    strip.innerHTML = "";
    if (images.length) {
      images.forEach(function (src, i) {
        var im = document.createElement("img");
        im.src = src;
        im.alt = "Selected photo " + (i + 1);
        strip.appendChild(im);
      });
      strip.classList.add("show");
    } else {
      strip.classList.remove("show");
    }
  }
  if (countEl) {
    if (images.length > 1) {
      countEl.textContent = images.length + " " + t("photos selected");
      countEl.classList.add("show");
    } else {
      countEl.textContent = "";
      countEl.classList.remove("show");
    }
  }
}

function renderNewsImageStrip(images) {
  renderImageStrip("newsImageStrip", "newsImageCount", images);
}
function renderActivityImageStrip(images) {
  renderImageStrip("activityImageStrip", "activityImageCount", images);
}
function renderAnnImageStrip(images) {
  renderImageStrip("annImageStrip", "annImageCount", images);
}

// Store the chosen photos as JSON + mirror the first into the path box.
function setImagesField(jsonPathId, pathId, previewId, stripId, countId, images) {
  images = (images || []).map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  var jsonEl = document.getElementById(jsonPathId);
  if (jsonEl) jsonEl.value = JSON.stringify(images);
  var pathEl = document.getElementById(pathId);
  if (pathEl) pathEl.value = images.length ? images[0] : "";
  var preview = document.getElementById(previewId);
  if (preview) {
    if (images.length) { preview.src = images[0]; preview.classList.add("show"); }
    else { preview.classList.remove("show"); preview.removeAttribute("src"); }
  }
  renderImageStrip(stripId, countId, images);
}

function setNewsImagesField(images) {
  setImagesField("newsImagesJson", "newsImage", "newsImagePreview", "newsImageStrip", "newsImageCount", images);
}
function setActivityImagesField(images) {
  setImagesField("activityImagesJson", "activityImage", "activityImagePreview", "activityImageStrip", "activityImageCount", images);
}
function setAnnImagesField(images) {
  setImagesField("annImagesJson", "annImage", "annImagePreview", "annImageStrip", "annImageCount", images);
}

// Compress every picked file, then hand the full list to the field.
function initMultiUpload(fileId, storeFn) {
  var fileInput = document.getElementById(fileId);
  if (!fileInput) return;

  fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;

    var valid = files.filter(function (f) {
      return /^image\/(png|jpe?g|gif|webp)$/i.test(f.type);
    });
    if (valid.length !== files.length) {
      showToast("Please choose image files (JPG, PNG, GIF, or WEBP).", "error");
    }
    if (!valid.length) { this.value = ""; return; }

    if (valid.length > MAX_MEDIA_IMAGES) {
      showToast("You can attach up to " + MAX_MEDIA_IMAGES + " photos per post.", "error");
      valid = valid.slice(0, MAX_MEDIA_IMAGES);
    }

    var results = [];
    var pending = valid.length;
    valid.forEach(function (file, idx) {
      var reader = new FileReader();
      reader.onload = function (e) {
        compressImage(e.target.result, 900, function (dataUrl) {
          results[idx] = dataUrl;
          if (--pending === 0) {
            storeFn(results.filter(Boolean));
          }
        });
      };
      reader.readAsDataURL(file);
    });
  });
}

function initNewsMultiUpload() {
  initMultiUpload("newsImageFile", setNewsImagesField);
}
function initActivityMultiUpload() {
  initMultiUpload("activityImageFile", setActivityImagesField);
}
function initAnnMultiUpload() {
  initMultiUpload("annImageFile", setAnnImagesField);
}

// Keep the photo list in sync when an admin types path(s) into the box.
function wireImagePathField(pathId, jsonId, stripId) {
  var input = document.getElementById(pathId);
  if (!input) return;
  // The "N photos selected" label lives beside the strip (newsImageCount,
  // activityImageCount, annImageCount), so derive it from the strip id.
  var countId = stripId.replace("Strip", "Count");
  input.addEventListener("input", function () {
    var raw = input.value.trim();
    // A pasted data URL is a single image; a typed list may use commas.
    var parts = raw.indexOf("data:") === 0
      ? (raw ? [raw] : [])
      : raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var jsonEl = document.getElementById(jsonId);
    if (jsonEl) jsonEl.value = JSON.stringify(parts);
    renderImageStrip(stripId, countId, parts);
  });
}

function wireNewsImagePathField() {
  wireImagePathField("newsImage", "newsImagesJson", "newsImageStrip");
}
function wireActivityImagePathField() {
  wireImagePathField("activityImage", "activityImagesJson", "activityImageStrip");
}
function wireAnnImagePathField() {
  wireImagePathField("annImage", "annImagesJson", "annImageStrip");
}

/* ------------------------------------------------------------
   29b. VIDEO UPLOAD (file picker -> data URL)
   Uploaded videos are stored in IndexedDB (see section 1b), so there is
   no practical size limit; the news item's `video` field only holds a
   short "idb:<key>" reference (or a path / link / legacy data URL).
   ------------------------------------------------------------ */

// Stage the picked video for IndexedDB and show a live preview. The path
// field gets a short reference so the form looks clean; the real file is
// written to IndexedDB when the post is submitted.
function initVideoUpload(fileId, targetId, previewId) {
  var fileInput = document.getElementById(fileId);
  if (!fileInput) return;
  var target = document.getElementById(targetId);
  var preview = document.getElementById(previewId);

  fileInput.addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;
    var valid = [];
    for (var i = 0; i < files.length; i++) {
      if (!/^video\//i.test(files[i].type)) {
        showToast("Please choose a video file (MP4, WEBM, or OGG).", "error");
        this.value = "";
        return;
      }
      valid.push(files[i]);
    }
    if (valid.length > MAX_MEDIA_VIDEOS) {
      showToast("You can attach up to " + MAX_MEDIA_VIDEOS + " videos per post.", "error");
      this.value = "";
      return;
    }
    pendingVideoFiles = valid;
    pendingVideoPosters = [];
    // Local object URL for the preview only; the files themselves are saved later.
    var url = URL.createObjectURL(valid[0]);
    if (target) {
      target.value = "idb:pending";
      target.setAttribute("data-pending-video", "1");
      target.removeAttribute("data-original-video");
    }
    if (preview) { preview.src = url; preview.classList.add("show"); }
    // The hint sits beside the picker (newsVideoHint, activityVideoHint,
    // annVideoHint), so derive it from the file input id.
    var hint = document.getElementById(fileId.replace("File", "Hint"));
    if (hint) {
      hint.textContent = valid.length === 1
        ? "1 video selected. Pick new files to replace it."
        : valid.length + " videos selected. Pick new files to replace them.";
    }
    // Capture a still frame from each video to use as the feed poster.
    Promise.all(valid.map(function (f) {
      var u = URL.createObjectURL(f);
      return captureVideoPoster(u).then(function (poster) {
        URL.revokeObjectURL(u);
        return poster;
      });
    })).then(function (posters) { pendingVideoPosters = posters; });
  });
}

function initNewsVideoUpload() {
  initVideoUpload("newsVideoFile", "newsVideo", "newsVideoPreview");
}
function initActivityVideoUpload() {
  initVideoUpload("activityVideoFile", "activityVideo", "activityVideoPreview");
}
function initAnnVideoUpload() {
  initVideoUpload("annVideoFile", "annVideo", "annVideoPreview");
}

// Keep the video preview in sync when an admin types/pastes a path or link.
// An "idb:" reference is not a playable URL, so the preview is driven by the
// pending file's object URL (already set by the picker) instead.
function wireVideoPreview(pathId, previewId) {
  var input = document.getElementById(pathId);
  var preview = document.getElementById(previewId);
  if (!input || !preview) return;
  input.addEventListener("input", function () {
    var v = input.value.trim();
    if (v.indexOf("idb:") === 0) {
      // Stored-in-IndexedDB video: keep current preview, or load it on edit.
      if (input.getAttribute("data-pending-video") === "1" && preview.src) {
        preview.classList.add("show");
      } else {
        videoSrcFromRef(v).then(function (src) {
          if (!src) return;
          preview.src = src;
          preview.classList.add("show");
        });
      }
      return;
    }
    if (!v) { preview.classList.remove("show"); preview.removeAttribute("src"); return; }
    preview.src = v;
    preview.classList.add("show");
  });
}

function refreshVideoPreview(pathId, previewId) {
  var input = document.getElementById(pathId);
  if (input) input.dispatchEvent(new Event("input"));
}

function clearVideoPreview(previewId) {
  var preview = document.getElementById(previewId);
  if (!preview) return;
  preview.classList.remove("show");
  preview.removeAttribute("src");
}

initNewsVideoUpload();
wireVideoPreview("newsVideo", "newsVideoPreview");

initActivityVideoUpload();
wireVideoPreview("activityVideo", "activityVideoPreview");

initAnnVideoUpload();
wireVideoPreview("annVideo", "annVideoPreview");

/* ------------------------------------------------------------
   30. DARK MODE (theme toggle on public pages + both dashboards)
   ------------------------------------------------------------ */

function getTheme() {
  // The premium glass design is dark by default; users can switch to light.
  return localStorage.getItem("communityTheme") === "light" ? "light" : "dark";
}

// Moon / sun icons for the dashboard theme pill
function themeMoonSvg() {
  return '<svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
}
function themeSunSvg() {
  return '<svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.93 4.93l1.7 1.7M17.37 17.37l1.7 1.7M19.07 4.93l-1.7 1.7M6.63 17.37l-1.7 1.7"/></svg>';
}

function updateThemeButtons() {
  var isDark = getTheme() === "dark";
  // Public topbar keeps a simple text toggle (shows the mode you switch to)
  var pub = document.getElementById("themeToggleBtn");
  if (pub) pub.textContent = isDark ? "LIGHT" : "DARK";
  // Dashboard pills show the current mode with an icon (moon = Dark, sun = Light)
  var dash = document.getElementById("themeToggleBtnDash");
  if (dash) {
    dash.innerHTML = (isDark ? themeMoonSvg() : themeSunSvg()) +
      '<span class="theme-btn-label">' + t(isDark ? "Dark" : "Light") + "</span>";
    dash.classList.toggle("theme-dark", isDark);
    dash.classList.toggle("theme-light", !isDark);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("communityTheme", theme); } catch (e) {}
  updateThemeButtons();
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

function updateSettingsLabels() {
  var tv = document.getElementById("settingsThemeValue");
  if (tv) tv.textContent = getTheme() === "dark" ? "LIGHT" : "DARK";
  var lv = document.getElementById("settingsLangValue");
  if (lv) lv.textContent = currentLang === "fil" ? "FIL" : "EN";
}

// Wire the dashboard Settings button + dropdown panel
function initDashboardSettings() {
  var panel = document.getElementById("dashSettingsPanel");
  if (!panel || panel._wired) return;
  panel._wired = true;

  function closePanel() { panel.classList.add("hidden"); }

  var themeItem = document.getElementById("settingsThemeItem");
  if (themeItem) themeItem.addEventListener("click", function () { toggleTheme(); updateSettingsLabels(); });
  var langItem = document.getElementById("settingsLangItem");
  if (langItem) langItem.addEventListener("click", function () { toggleLang(); updateSettingsLabels(); });

  var profileItem = document.getElementById("settingsProfileItem");
  if (profileItem) profileItem.addEventListener("click", function () {
    closePanel();
    if (document.body.classList.contains("official-body")) showOfficialSection("profile");
    else if (document.body.classList.contains("admin-body")) showAdminSection("profile");
    else showUserSection("profile");
  });

  var logoutItem = document.getElementById("settingsLogoutItem");
  if (logoutItem) logoutItem.addEventListener("click", function () {
    if (document.body.classList.contains("official-body")) officialLogout();
    else if (document.body.classList.contains("admin-body")) adminLogout();
    else userLogout();
  });

  panel.addEventListener("click", function (event) { event.stopPropagation(); });

  document.addEventListener("click", function () {
    if (!panel.classList.contains("hidden")) closePanel();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closePanel();
  });
}

/* ------------------------------------------------------------
   30a. ADMIN SYSTEM SETTINGS
   One organised settings hub for the admin dashboard: appearance,
   branding, notifications, security, backup/data tools, and a
   directory summary. Stored under communityAdminSettings and
   applied live across the app.
   ------------------------------------------------------------ */

var ADMIN_SETTINGS_KEY = "communityAdminSettings";
var ADMIN_SETTINGS_DEFAULTS = {
  theme: "dark",
  language: "en",
  siteTitle: "Community Connect - Admin",
  siteName: "Community Connect",
  logo: "",
  maintenance: false,
  autoBackup: true,
  backupFreq: "Daily",
  retention: "30",
  sessionTimeout: "0",
  adminPasswordHash: ""
};

function loadAdminSettings() {
  var saved = getData(ADMIN_SETTINGS_KEY, null) || {};
  var out = {};
  Object.keys(ADMIN_SETTINGS_DEFAULTS).forEach(function (k) {
    out[k] = (saved[k] === undefined) ? ADMIN_SETTINGS_DEFAULTS[k] : saved[k];
  });
  return out;
}

function saveAdminSettings(s) { return setData(ADMIN_SETTINGS_KEY, s); }

function resolveAdminTheme(theme) {
  if (theme === "system") {
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  return theme === "light" ? "light" : "dark";
}

// Show a maintenance notice bar across the public site when enabled
function applyMaintenanceBanner(on) {
  var publicPage = !document.body.classList.contains("admin-body") &&
    !document.body.classList.contains("user-body") &&
    !document.body.classList.contains("official-body");
  var existing = document.getElementById("maintenanceBanner");
  if (!on || !publicPage) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  var bar = document.createElement("div");
  bar.id = "maintenanceBanner";
  bar.className = "maintenance-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = "<strong>" + t("Maintenance Notice") + "</strong> " +
    t("Some features may be unavailable while the site is being updated.");
  document.body.insertBefore(bar, document.body.firstChild);
}

// Apply branding + maintenance across the current page
function applyAdminSettingsChrome() {
  var s = loadAdminSettings();
  if (s.siteTitle && document.body.classList.contains("admin-body")) {
    document.title = s.siteTitle;
  }
  if (s.logo) {
    document.querySelectorAll(".logo-mark-img").forEach(function (img) {
      img.src = s.logo;
    });
  }
  applyMaintenanceBanner(s.maintenance);
}

function markSegmented(id, value) {
  var box = document.getElementById(id);
  if (!box) return;
  box.querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-value") === String(value));
  });
}

function getSegmented(id) {
  var box = document.getElementById(id);
  if (!box) return "";
  var active = box.querySelector("button.active");
  return active ? active.getAttribute("data-value") : "";
}

function renderSettingsNotifList() {
  var box = document.getElementById("setNotifList");
  if (!box) return;
  var prefs = loadNotifPrefs();
  box.innerHTML = NOTIF_TYPES.map(function (tp) {
    return '<label class="settings-notif"><span>' + escapeHtml(t(tp.label)) + "</span>" +
      '<input type="checkbox" class="switch" data-notif-type="' + tp.key + '"' +
      (prefs[tp.key] !== false ? " checked" : "") + "></label>";
  }).join("");
}

function renderSettingsUserStats() {
  var officials = loadOfficials();
  var active = officials.filter(function (o) { return o.active !== false; }).length;
  var a = document.getElementById("setStatResidents");
  if (a) a.textContent = loadUsers().length;
  var b = document.getElementById("setStatOfficials");
  if (b) b.textContent = officials.length;
  var c = document.getElementById("setStatActive");
  if (c) c.textContent = active;
}

function populateAdminSettings() {
  var s = loadAdminSettings();
  markSegmented("setTheme", s.theme);
  var lang = document.getElementById("setLang"); if (lang) lang.value = s.language;
  var st = document.getElementById("setSiteTitle"); if (st) st.value = s.siteTitle;
  var sn = document.getElementById("setSiteName"); if (sn) sn.value = s.siteName;
  var mt = document.getElementById("setMaintenance"); if (mt) mt.checked = !!s.maintenance;
  var ab = document.getElementById("setAutoBackup"); if (ab) ab.checked = !!s.autoBackup;
  var bf = document.getElementById("setBackupFreq"); if (bf) bf.value = s.backupFreq;
  var rt = document.getElementById("setRetention"); if (rt) rt.value = s.retention;
  var sto = document.getElementById("setSessionTimeout"); if (sto) sto.value = s.sessionTimeout;
  var prev = document.getElementById("setLogoPreview");
  if (prev) prev.innerHTML = s.logo ? '<img src="' + escapeHtml(s.logo) + '" alt="">' : "CC";
  renderSettingsNotifList();
  renderSettingsUserStats();
}

function collectAdminSettings() {
  var s = loadAdminSettings();
  s.theme = getSegmented("setTheme") || s.theme;
  var lang = document.getElementById("setLang"); if (lang) s.language = lang.value;
  var st = document.getElementById("setSiteTitle"); if (st) s.siteTitle = st.value.trim() || s.siteTitle;
  var sn = document.getElementById("setSiteName"); if (sn) s.siteName = sn.value.trim();
  var mt = document.getElementById("setMaintenance"); if (mt) s.maintenance = mt.checked;
  var ab = document.getElementById("setAutoBackup"); if (ab) s.autoBackup = ab.checked;
  var bf = document.getElementById("setBackupFreq"); if (bf) s.backupFreq = bf.value;
  var rt = document.getElementById("setRetention"); if (rt) s.retention = rt.value;
  var sto = document.getElementById("setSessionTimeout"); if (sto) s.sessionTimeout = sto.value;
  return s;
}

function applyAdminSettings(s) {
  try { localStorage.setItem("communityThemeChoice", s.theme); } catch (e) {}
  applyTheme(resolveAdminTheme(s.theme));
  if (typeof currentLang !== "undefined" && s.language && s.language !== currentLang) {
    currentLang = s.language;
    try { localStorage.setItem("communityLang", currentLang); } catch (e) {}
    if (typeof applyLang === "function") applyLang();
  }
  applyAdminSettingsChrome();
}

function showAdminSettingsTab(name) {
  document.querySelectorAll("#adminSettingsTabs .settings-tab").forEach(function (tb) {
    var on = tb.getAttribute("data-settings-tab") === name;
    tb.classList.toggle("active", on);
    tb.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("#adminSettingsBody .settings-pane").forEach(function (pane) {
    pane.classList.toggle("hidden", pane.getAttribute("data-settings-pane") !== name);
  });
}

function openAdminSettingsModal() {
  var modal = document.getElementById("adminSettingsModal");
  if (!modal) return;
  populateAdminSettings();
  showAdminSettingsTab("general");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  var body = document.getElementById("adminSettingsBody");
  if (body) body.scrollTop = 0;
}

function closeAdminSettingsModal() {
  var modal = document.getElementById("adminSettingsModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

// Sign the admin out after a period with no activity (if configured)
function initAdminIdleLogout() {
  if (!document.body.classList.contains("admin-body")) return;
  var mins = parseInt(loadAdminSettings().sessionTimeout, 10) || 0;
  if (mins <= 0) return;
  var timer = null;
  function reset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      showToast(t("Signed out after inactivity."), "info");
      setTimeout(function () { adminLogout(); }, 700);
    }, mins * 60000);
  }
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, reset, { passive: true });
  });
  reset();
}

function initAdminSettingsModal() {
  var modal = document.getElementById("adminSettingsModal");
  if (!modal || modal._wired) return;
  modal._wired = true;

  var tabs = document.getElementById("adminSettingsTabs");
  if (tabs) tabs.addEventListener("click", function (event) {
    var tb = event.target.closest(".settings-tab");
    if (tb) showAdminSettingsTab(tb.getAttribute("data-settings-tab"));
  });

  var segmented = ["setTheme"];
  segmented.forEach(function (id) {
    var box = document.getElementById(id);
    if (box) box.addEventListener("click", function (event) {
      var b = event.target.closest("button[data-value]");
      if (b) markSegmented(id, b.getAttribute("data-value"));
    });
  });

  var close = document.getElementById("adminSettingsClose");
  if (close) close.addEventListener("click", closeAdminSettingsModal);
  var cancel = document.getElementById("adminSettingsCancel");
  if (cancel) cancel.addEventListener("click", closeAdminSettingsModal);

  var save = document.getElementById("adminSettingsSave");
  if (save) save.addEventListener("click", function () {
    var s = collectAdminSettings();
    saveAdminSettings(s);
    applyAdminSettings(s);
    var msg = document.getElementById("adminSettingsSavedMsg");
    if (msg) msg.classList.remove("hidden");
    showToast(t("Settings saved."), "success");
    setTimeout(function () {
      if (msg) msg.classList.add("hidden");
      closeAdminSettingsModal();
    }, 900);
  });

  var def = document.getElementById("adminSettingsDefaults");
  if (def) def.addEventListener("click", function () {
    openConfirmModal("Reset all settings to their defaults?", "RESET", function () {
      saveAdminSettings(ADMIN_SETTINGS_DEFAULTS);
      populateAdminSettings();
      showToast(t("Settings reset to defaults."), "success");
    });
  });

  // Change admin password
  var cp = document.getElementById("setChangePassword");
  if (cp) cp.addEventListener("click", function () {
    var np = prompt("Enter a new admin password (at least 6 characters):");
    if (np === null) return;
    if (np.length < 6) { showToast("Password must be at least 6 characters.", "error"); return; }
    var again = prompt("Type the new password again:");
    if (again !== np) { showToast("Passwords do not match.", "error"); return; }
    var s = loadAdminSettings();
    s.adminPasswordHash = hashPassword(np);
    saveAdminSettings(s);
    logAudit("changed admin password", "admin");
    showToast("Admin password updated.", "success");
  });

  // Logo upload / remove
  var logoFile = document.getElementById("setLogoFile");
  if (logoFile) logoFile.addEventListener("change", function () {
    var f = this.files && this.files[0];
    this.value = "";
    if (!f) return;
    if (!/^image\//i.test(f.type)) { showToast("Please choose an image file.", "error"); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      compressAvatar(e.target.result, function (dataUrl) {
        var s = loadAdminSettings();
        s.logo = dataUrl;
        saveAdminSettings(s);
        var prev = document.getElementById("setLogoPreview");
        if (prev) prev.innerHTML = '<img src="' + escapeHtml(dataUrl) + '" alt="">';
        applyAdminSettingsChrome();
        showToast("Logo updated.", "success");
      });
    };
    reader.readAsDataURL(f);
  });
  var logoRemove = document.getElementById("setLogoRemove");
  if (logoRemove) logoRemove.addEventListener("click", function () {
    var s = loadAdminSettings();
    s.logo = "";
    saveAdminSettings(s);
    var prev = document.getElementById("setLogoPreview");
    if (prev) prev.innerHTML = "CC";
    document.querySelectorAll(".logo-mark-img").forEach(function (img) { img.src = "logo.svg"; });
    showToast("Logo removed.", "success");
  });

  // Notification toggles -> existing prefs
  var nl = document.getElementById("setNotifList");
  if (nl) nl.addEventListener("change", function (event) {
    var input = event.target.closest("[data-notif-type]");
    if (!input) return;
    var prefs = loadNotifPrefs();
    prefs[input.getAttribute("data-notif-type")] = input.checked;
    saveNotifPrefs(prefs);
    notifyBus.post();
    if (typeof updateNotifBell === "function") updateNotifBell("admin");
  });

  // Directory shortcuts
  var oud = document.getElementById("setOpenUserDir");
  if (oud) oud.addEventListener("click", function () {
    closeAdminSettingsModal();
    showAdminSection("users");
  });
  var onb = document.getElementById("setOpenNotifications");
  if (onb) onb.addEventListener("click", function () {
    closeAdminSettingsModal();
    showAdminSection("notifications");
  });

  modal.addEventListener("click", function (event) {
    if (event.target === modal) closeAdminSettingsModal();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && modal.classList.contains("open")) closeAdminSettingsModal();
  });

  initAdminIdleLogout();
}

function initTheme() {
  document.documentElement.setAttribute("data-theme", getTheme());

  // Public topbar tools (language + theme buttons live together)
  var authArea = document.getElementById("userAuthArea");
  if (authArea && !document.getElementById("themeToggleBtn")) {
    var tools = document.createElement("span");
    tools.className = "topbar-tools";

    var langBtn = document.createElement("button");
    langBtn.type = "button";
    langBtn.className = "topbar-btn";
    langBtn.id = "langToggleBtn";
    langBtn.addEventListener("click", toggleLang);
    tools.appendChild(langBtn);

    var themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "topbar-btn";
    themeBtn.id = "themeToggleBtn";
    themeBtn.addEventListener("click", toggleTheme);
    tools.appendChild(themeBtn);

    authArea.appendChild(tools);
  }

  // Dashboard / admin headers (language + theme buttons)
  var dashArea = document.querySelector(".admin-user");
  if (dashArea && !document.getElementById("themeToggleBtnDash")) {
    var langDash = document.createElement("button");
    langDash.type = "button";
    langDash.className = "topbar-btn topbar-btn-dark";
    langDash.id = "langToggleBtnDash";
    langDash.addEventListener("click", toggleLang);
    dashArea.insertBefore(langDash, dashArea.firstChild);

    var dashBtn = document.createElement("button");
    dashBtn.type = "button";
    dashBtn.className = "topbar-btn topbar-btn-dark";
    dashBtn.id = "themeToggleBtnDash";
    dashBtn.addEventListener("click", toggleTheme);
    dashArea.insertBefore(dashBtn, langDash.nextSibling);

    // Settings dropdown panel, opened from the account menu's Settings item
    var settingsPanel = document.createElement("div");
    settingsPanel.className = "dash-settings-panel hidden";
    settingsPanel.id = "dashSettingsPanel";
    settingsPanel.setAttribute("role", "menu");
    settingsPanel.setAttribute("aria-label", "Settings");
    settingsPanel.innerHTML =
      '<div class="dash-settings-head"><strong>' + t("SETTINGS") + "</strong></div>" +
      '<div class="dash-settings-list">' +
        '<button type="button" class="dash-settings-item" id="settingsThemeItem" role="menuitem">' +
          '<span class="dash-settings-label">' + t("Dark Mode") + "</span>" +
          '<span class="dash-settings-value" id="settingsThemeValue">DARK</span>' +
        "</button>" +
        '<button type="button" class="dash-settings-item" id="settingsLangItem" role="menuitem">' +
          '<span class="dash-settings-label">' + t("Language") + "</span>" +
          '<span class="dash-settings-value" id="settingsLangValue">EN</span>' +
        "</button>" +
      "</div>";
    dashArea.appendChild(settingsPanel);
    initDashboardSettings();
  }

  updateThemeButtons();
}

/* ------------------------------------------------------------
   31. SHARE + PRINT HELPERS (used by the detail modal footer)
   ------------------------------------------------------------ */

function copyTextToClipboard(text, btn) {
  var original = btn ? btn.textContent : "";
  function done() {
    if (btn) {
      btn.textContent = "COPIED!";
      btn.classList.add("copied");
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1500);
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else {
    fallbackCopy(text);
    done();
  }
}

function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
}

/* ------------------------------------------------------------
   32. HOME PAGE WEATHER CARD
   ------------------------------------------------------------ */

function renderWeatherCard() {
  var box = document.getElementById("weatherCard");
  if (!box) return;

  var w = getWeatherData();
  var advisory = getWeatherAdvisories()[0];
  var today = w.forecast[0];

  var html = '' +
    '<div class="weather-main">' +
      '<span class="weather-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg></span>' +
      '<span class="weather-temp">' + w.temp + '&deg;</span>' +
      '<div class="weather-info">' +
        '<strong>' + escapeHtml(w.condition) + '</strong>' +
        '<p class="meta">' + t("Feels like") + ' ' + w.heatIndex + '&deg;C &middot; ' + t("Humidity") + ' ' + w.humidity +
          '% &middot; ' + t("Wind") + ' ' + w.wind + ' km/h</p>' +
        '<p class="meta">' + t("Updated") + " " + formatPhilippineNow() + " (" + t("sample data") + ")</p>" +
      '</div>' +
    '</div>' +
    '<div class="weather-days">' +
      w.forecast.slice(0, 5).map(function (f) {
        return '<div class="weather-day">' +
          '<strong>' + t(f.day) + '</strong>' +
          '<span class="weather-hl">' + f.high + '&deg; / ' + f.low + '&deg;</span>' +
          '<small>' + escapeHtml(f.condition) + '</small>' +
        '</div>';
      }).join("") +
    '</div>';

  if (w.heatIndex >= 35) {
    html += '<p class="weather-alert">' + t("Heat advisory: drink plenty of water and limit time under the sun.") + '</p>';
  }
  if (advisory) {
    html += '<p class="weather-alert">' + t("Posted advisory:") + ' <a href="announcements.html">' +
      escapeHtml(shortText(advisory.title, 80)) + '</a></p>';
  }

  box.innerHTML = html;
}

/* ------------------------------------------------------------
   33. ADMIN CHARTS + DATA BACKUP (Export / Import / Reset)
   ------------------------------------------------------------ */

function renderAdminCharts() {
  var mixBox = document.getElementById("chartContentMix");
  if (mixBox) {
    var mix = [
      ["News", loadNewsList().length, "bar-blue"],
      ["Announcements", loadAnnouncementsList().length, "bar-orange"],
      ["Events", loadEventsList().length, "bar-green"],
      ["Activities", loadActivitiesList().length, "bar-red"],
      ["Gallery Photos", loadGalleryList().length, "bar-blue"]
    ];
    var max = Math.max.apply(null, mix.map(function (m) { return m[1]; })) || 1;
    mixBox.innerHTML = mix.map(function (m) {
      return '<div class="bar-row">' +
        '<span class="bar-label">' + t(m[0]) + '</span>' +
        '<div class="bar-track"><div class="bar-fill ' + m[2] + '" style="width:' +
          Math.max(2, Math.round(m[1] / max * 100)) + '%"></div></div>' +
        '<span class="bar-value">' + m[1] + '</span>' +
      '</div>';
    }).join("");
  }

  var monthBox = document.getElementById("chartMonthly");
  if (monthBox) {
    var monthNames = (typeof currentLang !== "undefined" && currentLang === "fil")
      ? ["Ene", "Peb", "Mar", "Abr", "May", "Hun", "Hul", "Ago", "Set", "Okt", "Nob", "Dis"]
      : ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var now = new Date();
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"),
        label: monthNames[d.getMonth()] + " " + d.getFullYear()
      });
    }

    var counts = {};
    months.forEach(function (m) { counts[m.key] = 0; });

    var all = loadNewsList().concat(loadAnnouncementsList(),
      loadEventsList(), loadActivitiesList(), loadGalleryList());
    all.forEach(function (item) {
      var key = (item.date || "").slice(0, 7);
      if (counts[key] !== undefined) counts[key]++;
    });

    var maxM = Math.max.apply(null, months.map(function (m) { return counts[m.key]; })) || 1;
    monthBox.innerHTML = months.map(function (m) {
      var value = counts[m.key];
      return '<div class="bar-row">' +
        '<span class="bar-label">' + m.label + '</span>' +
        '<div class="bar-track"><div class="bar-fill bar-blue" style="width:' +
          Math.max(2, Math.round(value / maxM * 100)) + '%"></div></div>' +
        '<span class="bar-value">' + value + '</span>' +
      '</div>';
    }).join("");
  }

  var viewsBox = document.getElementById("chartViews");
  if (viewsBox) {
    var log = loadViewLog();
    var dayNames = (typeof currentLang !== "undefined" && currentLang === "fil")
      ? ["Lin", "Lun", "Mar", "Miy", "Huw", "Biy", "Sab"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var days = [];
    for (var j = 6; j >= 0; j--) {
      var day = new Date();
      day.setDate(day.getDate() - j);
      var key = day.toISOString().slice(0, 10);
      days.push({ key: key, label: dayNames[day.getDay()] + " " + day.getDate() });
    }
    var maxV = Math.max.apply(null, days.map(function (d) { return log[d.key] || 0; })) || 1;
    viewsBox.innerHTML = days.map(function (d) {
      var value = log[d.key] || 0;
      return '<div class="bar-row">' +
        '<span class="bar-label">' + d.label + '</span>' +
        '<div class="bar-track"><div class="bar-fill bar-green" style="width:' +
          Math.max(2, Math.round(value / maxV * 100)) + '%"></div></div>' +
        '<span class="bar-value">' + value + '</span>' +
      '</div>';
    }).join("");
  }
}

var DATA_KEYS = ["communityNews", "communityAnnouncements", "communityEvents",
  "communityActivities", "communityGallery", "communityUsers",
  "communityBookmarks", "communityComments", "communityRsvps",
  "communityViews", "communityViewLog", "newsAiChat", "communityAuditLog",
  "communityLiveArchive", "communityGuestLikes", "communityAdminProfile",
  "communityNotifications", "communityNotificationPrefs",
  "barangayOfficials", "certificateRequests", "communityOfficialNotifications",
  "incidentReports", "communityEmergencyAlerts",
  "communityUserPosts", "communityUserAlerts"];

// Current LocalStorage layout; bump when migration steps are added
var SCHEMA_VERSION = 13;

// Bring old browser storage up to the current layout (runs once per version)
function runMigrations() {
  var stored = parseInt(localStorage.getItem("communitySchemaVersion") || "1", 10);
  if (stored >= SCHEMA_VERSION) return;

  // v1 -> v2: comment moderation got the "hidden" flag
  if (stored < 2) {
    var cs = getData("communityComments", []);
    if (cs.some(function (c) { return c.hidden === undefined; })) {
      setData("communityComments", cs.map(function (c) {
        c.hidden = !!c.hidden;
        return c;
      }));
    }
  }

  // v2 -> v3: sample photos replaced with real community images
  if (stored < 3) {
    var cleanupImg = "Cleanup-drive-1024x682.webp";
    var gardenImg = "Community-Garden.webp";
    var healthImg = "New Health Center Now Open for Residents.jfif";
    var sportsImg = "Youth Sports League Kicks Off This Month.jfif";
    var scholarImg = "Scholarship Applications Now Open.jpg";
    var roadImg = "Road Repair.jfif";
    var legacyMap = {
      "news-01.jpg": cleanupImg,
      "news-02.jpg": healthImg,
      "news-03.jpg": sportsImg
    };

    var news = getData("communityNews", []);
    var newsChanged = false;
    news.forEach(function (n) {
      if (legacyMap[n.image]) {
        n.image = legacyMap[n.image];
        newsChanged = true;
      }
      if (/garden/i.test(n.title || "")) {
        n.image = gardenImg;
        newsChanged = true;
      }
      if (/health center/i.test(n.title || "") && n.image !== healthImg) {
        n.image = healthImg;
        newsChanged = true;
      }
      if (/sports/i.test(n.title || "")) {
        n.image = sportsImg;
        newsChanged = true;
      }
      if (/scholarship/i.test(n.title || "")) {
        n.image = scholarImg;
        newsChanged = true;
      }
      if (/road repair/i.test(n.title || "")) {
        n.image = roadImg;
        newsChanged = true;
      }
      if (/clean-?up/i.test(n.title || "")) {
        n.image = cleanupImg;
        newsChanged = true;
      }
    });
    if (newsChanged) setData("communityNews", news);

    var acts = getData("communityActivities", []);
    var actsChanged = false;
    acts.forEach(function (a) {
      if (legacyMap[a.image]) {
        a.image = legacyMap[a.image];
        actsChanged = true;
      }
      if (a.image === "activity-01.jpg" && /clean-?up/i.test(a.name || "")) {
        a.image = cleanupImg;
        actsChanged = true;
      }
      if (/tree planting|garden/i.test(a.name || "")) {
        a.image = gardenImg;
        actsChanged = true;
      }
    });
    if (actsChanged) setData("communityActivities", acts);

    var gal = getData("communityGallery", []);
    var galChanged = false;
    gal.forEach(function (g) {
      if (legacyMap[g.image]) {
        g.image = legacyMap[g.image];
        galChanged = true;
      }
      if (g.image === "activity-01.jpg" && /clean-?up|volunteer/i.test(g.caption || "")) {
        g.image = cleanupImg;
        galChanged = true;
      }
      if (/health/i.test(g.caption || "")) {
        g.image = healthImg;
        galChanged = true;
      }
      if (/sports/i.test(g.caption || "")) {
        g.image = sportsImg;
        galChanged = true;
      }
    });
    if (galChanged) setData("communityGallery", gal);
  }

  // v3 -> v4: activities pointed at placeholder paths that were never shipped;
  // remap each one to the real photo that lives in 
  if (stored < 4) {
    var actMap = {
      "community-01.jpg": "Youth Leadership Activity.jfif",
      "community-02.jpg": "Inter-Purok Sports Activity.jfif",
      "activity-01.jpg": "Environmental Recycling Drive.webp"
    };
    var acts4 = getData("communityActivities", []);
    var acts4Changed = false;
    acts4.forEach(function (a) {
      if (actMap[a.image]) {
        a.image = actMap[a.image];
        acts4Changed = true;
      } else if (a.image === "Community-Garden.webp" && /tree planting/i.test(a.name || "")) {
        a.image = "Volunteer Tree Planting.webp";
        acts4Changed = true;
      }
    });
    if (acts4Changed) setData("communityActivities", acts4);
  }

  // v4 -> v5: news posts can carry a video. Normalise older items so the
  // field always exists (empty string = no video) for renderers and export.
  if (stored < 5) {
    var news5 = getData("communityNews", []);
    var news5Changed = false;
    news5.forEach(function (n) {
      if (n.video === undefined || n.video === null) {
        n.video = "";
        news5Changed = true;
      }
    });
    if (news5Changed) setData("communityNews", news5);
  }

  // v5 -> v6: news posts can carry several photos. Give every older item an
  // `images` array (seeded from its single `image`) so renderers can rely on
  // one shape; `image` keeps mirroring the first photo for older code paths.
  if (stored < 6) {
    var news6 = getData("communityNews", []);
    var news6Changed = false;
    news6.forEach(function (n) {
      if (!Array.isArray(n.images)) {
        var single = n.image ? String(n.image).trim() : "";
        n.images = single ? [single] : [];
        news6Changed = true;
      } else if (n.images.length && n.image !== n.images[0]) {
        n.image = n.images[0];
        news6Changed = true;
      }
    });
    if (news6Changed) setData("communityNews", news6);
  }

  // v6 -> v7: activities carry several photos and videos, and news posts
  // carry several videos. Give every older item the array shape the renderers
  // rely on (`image`/`video` keep mirroring the first item for old paths).
  if (stored < 7) {
    var acts7 = getData("communityActivities", []);
    var acts7Changed = false;
    acts7.forEach(function (a) {
      if (!Array.isArray(a.images)) {
        var singleImg = a.image ? String(a.image).trim() : "";
        a.images = singleImg ? [singleImg] : [];
        acts7Changed = true;
      } else if (a.images.length && a.image !== a.images[0]) {
        a.image = a.images[0];
        acts7Changed = true;
      }
      if (!Array.isArray(a.videos)) {
        var singleVid = a.video ? String(a.video).trim() : "";
        a.videos = singleVid ? [singleVid] : [];
        acts7Changed = true;
      }
    });
    if (acts7Changed) setData("communityActivities", acts7);

    var news7 = getData("communityNews", []);
    var news7Changed = false;
    news7.forEach(function (n) {
      if (!Array.isArray(n.videos)) {
        var singleVidN = n.video ? String(n.video).trim() : "";
        n.videos = singleVidN ? [singleVidN] : [];
        news7Changed = true;
      }
    });
    if (news7Changed) setData("communityNews", news7);
  }

  // v7 -> v8: announcements can carry several photos and videos, exactly like
  // news. Give every older item the array shape the renderers rely on
  // (`image`/`video` keep mirroring the first item for old code paths).
  if (stored < 8) {
    var ann8 = getData("communityAnnouncements", []);
    var ann8Changed = false;
    ann8.forEach(function (a) {
      if (!Array.isArray(a.images)) {
        var singleImgA = a.image ? String(a.image).trim() : "";
        a.images = singleImgA ? [singleImgA] : [];
        ann8Changed = true;
      } else if (a.images.length && a.image !== a.images[0]) {
        a.image = a.images[0];
        ann8Changed = true;
      }
      if (!Array.isArray(a.videos)) {
        var singleVidA = a.video ? String(a.video).trim() : "";
        a.videos = singleVidA ? [singleVidA] : [];
        ann8Changed = true;
      }
    });
    if (ann8Changed) setData("communityAnnouncements", ann8);
  }

  // v8 -> v9: comments work on news, announcements, and activities. Tag every
  // older comment as a news comment so moderation can label each thread.
  if (stored < 9) {
    var cs9 = getData("communityComments", []);
    var cs9Changed = false;
    cs9.forEach(function (c) {
      if (!c.postType) {
        c.postType = "news";
        cs9Changed = true;
      }
    });
    if (cs9Changed) setData("communityComments", cs9);
  }

  // v9 -> v10: Barangay Officials + certificate services. Seed one demo
  // official account so the flow can be tried right away; the admin can
  // add, edit, deactivate, or delete officials afterwards.
  if (stored < 10) {
    if (getData(OFFICIALS_KEY, null) === null) {
      setData(OFFICIALS_KEY, [{
        id: generateId(),
        username: "official",
        name: "Maria Santos",
        position: OFFICIAL_ROLE,
        barangay: "Barangay Central",
        email: "secretary@barangaycentral.gov.ph",
        phone: "0917-000-0000",
        password: hashPassword("official123"),
        joined: new Date().toISOString().slice(0, 10),
        active: true
      }]);
    }
    if (getData(CERT_REQUESTS_KEY, null) === null) setData(CERT_REQUESTS_KEY, []);
    if (getData(OFFICIAL_NOTIFICATIONS_KEY, null) === null) setData(OFFICIAL_NOTIFICATIONS_KEY, []);
  }

  // v10 -> v11: officials are always "Barangay Official" and carry the
  // barangay they belong to (typed by the admin).
  if (stored < 11) {
    var offs11 = getData(OFFICIALS_KEY, null);
    if (Array.isArray(offs11)) {
      var offs11Changed = false;
      offs11.forEach(function (o) {
        if (o.barangay === undefined) { o.barangay = ""; offs11Changed = true; }
        if (o.position !== OFFICIAL_ROLE) { o.position = OFFICIAL_ROLE; offs11Changed = true; }
      });
      if (offs11Changed) setData(OFFICIALS_KEY, offs11);
    }
  }

  // v11 -> v12: certificate requests and their notifications are tagged
  // with the barangay the resident selected, so each barangay office only
  // handles the requests addressed to it.
  if (stored < 12) {
    var reqs12 = getData(CERT_REQUESTS_KEY, null);
    if (Array.isArray(reqs12)) {
      var reqs12Changed = false;
      reqs12.forEach(function (r) {
        if (r.barangay === undefined) { r.barangay = ""; reqs12Changed = true; }
      });
      if (reqs12Changed) setData(CERT_REQUESTS_KEY, reqs12);
    }
    var notifs12 = getData(OFFICIAL_NOTIFICATIONS_KEY, null);
    if (Array.isArray(notifs12)) {
      var notifs12Changed = false;
      notifs12.forEach(function (n) {
        if (n.barangay === undefined) { n.barangay = ""; notifs12Changed = true; }
      });
      if (notifs12Changed) setData(OFFICIAL_NOTIFICATIONS_KEY, notifs12);
    }
  }

  // v12 -> v13: incident reporting (Barangay Services). Seed an empty store so
  // the resident form, official dashboard, and backups all see the key.
  if (stored < 13) {
    if (getData(INCIDENTS_KEY, null) === null) setData(INCIDENTS_KEY, []);
  }

  localStorage.setItem("communitySchemaVersion", String(SCHEMA_VERSION));
}

function exportAllData() {
  var payload = { app: "Community Connect", exportedAt: new Date().toISOString(),
                  schemaVersion: SCHEMA_VERSION };
  DATA_KEYS.forEach(function (key) {
    payload[key] = getData(key, null);
  });
  // "idb:" video refs point at browser-local IndexedDB blobs, which cannot be
  // exported. Strip them so a restored backup has no dead video references.
  ["communityNews", "communityActivities", "communityAnnouncements"].forEach(function (key) {
    if (Array.isArray(payload[key])) {
      payload[key] = payload[key].map(function (n) {
        if (!n) return n;
        var c = n;
        if (typeof n.video === "string" && n.video.indexOf("idb:") === 0) {
          c = Object.assign({}, c);
          c.video = "";
        }
        if (Array.isArray(n.videos)) {
          var cleaned = n.videos.filter(function (v) {
            return typeof v !== "string" || v.indexOf("idb:") !== 0;
          });
          if (cleaned.length !== n.videos.length) {
            c = Object.assign({}, c);
            c.videos = cleaned;
          }
        }
        return c;
      });
    }
  });
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "community-connect-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  showToast("Backup file downloaded.", "success");
  setTimeout(function () {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 500);
}

// Export the news list as a spreadsheet-friendly CSV file
function exportNewsCsv() {
  var rows = [["Title", "Category", "Date", "Featured", "Views", "Description"]];
  loadNewsList().forEach(function (n) {
    rows.push([
      n.title,
      n.category,
      n.date,
      n.pinned ? "Yes" : "No",
      String(getViewCount(n.id)),
      (n.description || n.details || "").replace(/\s+/g, " ")
    ]);
  });
  var csv = rows.map(function (row) {
    return row.map(function (cell) {
      return '"' + String(cell).replace(/"/g, '""') + '"';
    }).join(",");
  }).join("\r\n");
  var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "community-news-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(link);
  link.click();
  showToast("News CSV downloaded.", "success");
  setTimeout(function () {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 500);
}

function importFromFile(file) {
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var payload = JSON.parse(e.target.result);

      // Reject files that are valid JSON but not a Community Connect backup
      if (!payload || payload.app !== "Community Connect") {
        showToast(t("That file is not a valid Community Connect backup."), "error");
        return;
      }
      // Refuse backups written by a newer site version than this one
      if (payload.schemaVersion && payload.schemaVersion > SCHEMA_VERSION) {
        showToast(t("This backup was made by a newer version of the site."), "error");
        return;
      }

      // Only accept data sets whose shape matches what this key expects
      var objectKeys = { communityViews: true, communityViewLog: true };
      var restored = 0;
      DATA_KEYS.forEach(function (key) {
        var value = payload[key];
        if (value === null || value === undefined) return;
        var valid = objectKeys[key]
          ? (value && typeof value === "object" && !Array.isArray(value))
          : Array.isArray(value);
        if (!valid) return;
        setData(key, value);
        restored++;
      });

      if (restored === 0) {
        showToast(t("Import found no valid data sets."), "error");
        return;
      }

      logAudit("imported data", file.name || "backup.json");
      showToast(t("Import finished.") + " " + restored + " " + t("data sets restored."), "success");
      setTimeout(function () { location.reload(); }, 1000);
    } catch (err) {
      showToast(t("That file is not a valid Community Connect backup."), "error");
    }
  };
  reader.readAsText(file);
}

function resetAllData() {
  // Keep one automatic restore point so an accidental reset can be undone
  try {
    var snap = { app: "Community Connect", exportedAt: new Date().toISOString(),
                 schemaVersion: SCHEMA_VERSION };
    DATA_KEYS.forEach(function (key) { snap[key] = getData(key, null); });
    localStorage.setItem("communityAutoBackup", JSON.stringify(snap));
  } catch (e) {}
  DATA_KEYS.forEach(function (key) { localStorage.removeItem(key); });
  // Leave a single audit entry so the fresh start records what happened
  logAudit("reset data", "");
  location.reload();
}

// Undo a reset using the automatic snapshot taken by resetAllData()
function restoreAutoBackup() {
  var raw = localStorage.getItem("communityAutoBackup");
  if (!raw) {
    showToast(t("No automatic backup found."), "error");
    return;
  }
  var snap;
  try {
    snap = JSON.parse(raw);
  } catch (err) {
    showToast(t("No automatic backup found."), "error");
    return;
  }
  if (!snap || snap.app !== "Community Connect") {
    showToast(t("No automatic backup found."), "error");
    return;
  }
  openConfirmModal("Restore the automatic backup taken before the last reset?", "RESTORE", function () {
    var restored = 0;
    DATA_KEYS.forEach(function (key) {
      if (snap[key] !== null && snap[key] !== undefined) {
        setData(key, snap[key]);
        restored++;
      }
    });
    if (restored) {
      logAudit("restored backup", snap.exportedAt || "");
      showToast(t("Backup restored."), "success");
    }
    setTimeout(function () { location.reload(); }, 600);
  });
}

function wireDataBackupButtons() {
  var exportBtn = document.getElementById("exportDataBtn");
  if (!exportBtn) return;

  exportBtn.addEventListener("click", exportAllData);

  var csvBtn = document.getElementById("exportNewsCsvBtn");
  if (csvBtn) csvBtn.addEventListener("click", exportNewsCsv);

  document.getElementById("importDataBtn").addEventListener("click", function () {
    document.getElementById("importFile").click();
  });

  document.getElementById("importFile").addEventListener("change", function () {
    if (this.files && this.files[0]) {
      importFromFile(this.files[0]);
      this.value = "";
    }
  });

  document.getElementById("resetDataBtn").addEventListener("click", function () {
    openConfirmModal("Reset ALL content, accounts, and saved items back to the original demo data?", "RESET", resetAllData);
  });

  var restoreBtn = document.getElementById("restoreBackupBtn");
  if (restoreBtn) restoreBtn.addEventListener("click", restoreAutoBackup);
}

/* ------------------------------------------------------------
   34. PWA - installable + offline cache (only when hosted on
   http/https; file:// pages skip the service worker safely)
   ------------------------------------------------------------ */

function initPwa() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  navigator.serviceWorker.register("sw.js").catch(function () {});
}

/* ------------------------------------------------------------
   35. LANGUAGE TOGGLE (English / Filipino) for the public site
   Exact-match dictionary: only listed strings are translated.
   ------------------------------------------------------------ */

var I18N_MAP = {
  "HOME": "Tahanan",
  "ABOUT": "Tungkol Sa Amin",
  "NEWS": "Mga Balita",
  "ANNOUNCEMENTS": "Mga Anunsyo",
  "EVENTS": "Mga Kaganapan",
  "ACTIVITIES": "Mga Gawain",
  "GALLERY": "Mga Larawan",
  "AI ASSISTANT": "AI Katulong",
  "AI Assistant": "AI Katulong",
  "CONTACT": "Makipag-ugnayan",
  "Home": "Tahanan",
  "About": "Tungkol Sa Amin",
  "News": "Mga Balita",
  "Announcements": "Mga Anunsyo",
  "Events": "Mga Kaganapan",
  "Activities": "Mga Gawain",
  "Gallery": "Mga Larawan",
  "Contact": "Makipag-ugnayan",
  "User Login": "Pag-login ng Miyembro",
  "Register": "Magrehistro",
  "My Dashboard": "Ang Aking Dashboard",
  "Community Office: (02) 1234-5678": "Opisina ng Komunidad: (02) 1234-5678",
  "Stay Informed. Stay Connected.": "Maging Informed. Manatiling Konektado.",
  "Welcome to Community Connect, your one-stop source for community news, announcements, events, and activities. Everything you need to know about our community is right here.":
    "Maligayang pagdating sa Community Connect, ang iyong pinagkukunan ng balita, anunsyo, kaganapan, at gawain para sa komunidad. Nandito ang lahat ng kailangan mong malaman.",
  "READ THE NEWS": "BASAHIN ANG MGA BALITA",
  "VIEW ANNOUNCEMENTS": "TINGNAN ANG MGA ANUNSYO",
  "READ MORE": "BASAHIN PA",
  "VIEW DETAILS": "TINGNAN ANG DETALYE",
  "LOAD MORE": "IPAKITA PA",
  "left": "pa",
  "SAVE": "I-SAVE",
  "SAVED": "NAI-SAVE",
  "Like": "Gusto",
  "Liked": "Gusto Mo",
  "Comment": "Komento",
  "Share": "Ibahagi",
  "likes": "mga gusto",
  "Community Office": "Opisina ng Komunidad",
  "SEE MORE": "TINGNAN PA",
  "Details": "Detalye",
  "Open for joining": "Bukas para salihan",
  "Loading more posts...": "Naglo-load ng mga post...",
  "You're all caught up.": "Wala nang bagong post.",
  "Link copied to clipboard.": "Na-copy ang link sa clipboard.",
  "Please log in first to like community news.": "Mag-login muna upang mag-like ng mga balita.",
  "photos selected": "mga larawan ang napili",
  "I'M GOING": "SASALI AKO",
  "YOU'RE GOING": "SASALI KA NA",
  "VIEW ALL NEWS": "TINGNAN LAHAT NG BALITA",
  "VIEW ALL ANNOUNCEMENTS": "TINGNAN LAHAT NG ANUNSYO",
  "VIEW ALL EVENTS": "TINGNAN LAHAT NG KAGANAPAN",
  "VIEW ALL ACTIVITIES": "TINGNAN LAHAT NG GAWAIN",
  "Quick Links": "Mabilis na Links",
  "Jump straight to what you need.": "Diretso agad sa kailangan mo.",
  "Latest News": "Pinakabagong Balita",
  "Recent stories from around the community.": "Mga bagong kwento mula sa paligid ng komunidad.",
  "Important Announcements": "Mga Mahalagang Anunsyo",
  "Notices you should not miss.": "Mga paalalang hindi mo dapat makalimutan.",
  "Upcoming Events": "Mga Paparating na Kaganapan",
  "Mark your calendars.": "I-mark ang inyong kalendaryo.",
  "Community Activities": "Mga Gawain sa Komunidad",
  "Ways to get involved in the community.": "Mga paraan upang lumahok sa komunidad.",
  "Community News": "Balita sa Komunidad",
  "Latest stories and updates": "Mga bagong kwento at update",
  "Important notices for everyone": "Mga mahalagang paalala para sa lahat",
  "Don't miss what's coming up": "Huwag palampasin ang mga parating",
  "Activities": "Mga Gawain",
  "Join and be part of the fun": "Sali at maging bahagi",
  "More": "Iba Pa",
  "Community Office": "Opisina ng Komunidad",
  "Always Updated": "Laging Updated",
  "News and announcements are posted regularly by the community office.":
    "Regular na nagpo-post ng balita at anunsyo ang opisina ng komunidad.",
  "For Everyone": "Para Sa Lahat",
  "Residents of all ages can read everything without signing in.":
    "Maaaring basahin ng lahat ng edad ang lahat nang walang pag-login.",
  "One Place": "Isang Lugar",
  "News, events, activities, and photos are gathered in one website.":
    "Nakakaisang website ang balita, kaganapan, gawain, at mga larawan.",
  "Today's Weather": "Panahon Ngayong Araw",
  "Quick conditions for our community.": "Mabilis na kondisyon ng panahon sa ating komunidad.",
  "ASK THE AI ASSISTANT": "TANUNGIN ANG AI KATULONG",
  "All": "Lahat",
  "Community": "Komunidad",
  "Health": "Kalusugan",
  "Education": "Edukasyon",
  "Public Notice": "Pampublikong Abiso",
  "About Community Connect": "Tungkol Sa Community Connect",
  "Our Story": "Ang Aming Kuwento",
  "One Place": "Isang Lugar",
  "for every update": "para sa bawat update",
  "No Login": "Hindi Kailangang Mag-login",
  "to read the news": "para makabasa ng balita",
  "community updates": "mga update ng komunidad",
  "Our Purpose": "Ang Aming Layunin",
  "Our Mission": "Ang Aming Misyon",
  "Our Vision": "Ang Aming Bisyon",
  "What You Can Find Here": "Ang Makikita Mo Dito",
  "Behind the Project": "Sa Likod ng Proyekto",
  "Everything the community needs, in one website.": "Lahat ng kailangan ng komunidad, sa isang website.",
  "This system is a WS101 Mini Capstone Project.": "Ang sistemang ito ay isang WS101 Mini Capstone Project.",
  "Have a question or need help?": "May tanong o kailangan ng tulong?",
  "Reach the community office anytime.": "Kontakin ang opisina ng komunidad anumang oras.",
  "Community Gallery": "Gallery Ng Komunidad",
  "Contact Us": "Makipag-ugnayan Sa Amin",
  "News AI Assistant": "Balita AI Assistant",
  "Learn more about our community information website.": "Alamin pa ang aming website para sa impormasyon ng komunidad.",
  "Read the latest stories, updates, and reports from the community office.": "Basahin ang mga pinakabagong kwento, update, at ulat mula sa opisina ng komunidad.",
  "Important notices about health, education, events, and public safety.": "Mga mahalagang abiso tungkol sa kalusugan, edukasyon, kaganapan, at kaligtasan.",
  "See upcoming events with countdowns and browse past community activities.": "Tingnan ang mga paparating na kaganapan na may countdown at ang mga nagawang gawain.",
  "Read the latest stories and updates from the community.": "Basahin ang mga pinakabagong kwento at update mula sa komunidad.",
  "Important notices and information for the community.": "Mga mahalagang abiso at impormasyon para sa komunidad.",
  "See what is happening in the community and count down to each event.": "Alamin ang mga nangyayari sa komunidad at i-countdown ang bawat kaganapan.",
  "Programs and activities that bring the community together.": "Mga programa at gawain na nagbubuklod sa komunidad.",
  "Photographs from community events and activities. Click a photo to view it larger.": "Mga larawan mula sa mga kaganapan at gawain. I-click ang larawan para palakihin.",
  "Get in touch with the community office.": "Makipag-ugnayan sa opisina ng komunidad.",
  "What can I help you with today?": "Paano kita matutulungan ngayon?",
  "news found": "balita ang nahanap",
  "announcements found": "anunsyo ang nahanap",
  "views": "pagtingin",
  "comments": "komento",
  "going": "sasali",
  "saved": "na-save",
  "FEATURED": "PILING",
  "All Categories": "Lahat ng Kategorya",
  "Any Date": "Anumang Petsa",
  "Last 7 Days": "Nakaraang 7 Araw",
  "Last 30 Days": "Nakaraang 30 Araw",
  "This Year": "Ngayong Taon",
  "EVENT": "KAGANAPAN",
  "ACTIVITY": "GAWAIN",
  "USER": "GUMAGAMIT",
  "COMMENT": "KOMENTO",
  "VIEW ALL": "TINGNAN LAHAT",
  "Back to top": "Bumalik sa itaas",
  "SHARE": "IBAHAGI",
  "SEARCH": "HANAPIN",
  "Search": "Hanapin",
  "Search everything": "Hanapin ang lahat",
  "results": "mga resulta",
  "result": "resulta",
  "LIST": "LISTA",
  "CALENDAR": "KALENDARYO",
  "TODAY": "NGAYON",
  "Previous month": "Nakaraang buwan",
  "Next month": "Susunod na buwan",
  "View mode": "Paraan ng pagpapakita",
  "Type a keyword to search the whole community.": "Mag-type ng keyword para hanapin sa buong komunidad.",
  "No results found. Please try another search.": "Walang nahanap. Subukan ang ibang keyword.",
  "Time:": "Oras:",
  "Location:": "Lokasyon:",
  "Days": "Araw",
  "Hours": "Oras",
  "Mins": "Min",
  "Secs": "Seg",
  "This event has started or already passed.": "Nagsimula na ang kaganapan na ito o lumipas na.",
  "COMMENTS": "MGA KOMENTO",
  "POST COMMENT": "MAGPOST NG KOMENTO",
  "Write a comment...": "Mag-isip ng komento...",
  "No comments yet. Be the first to share your thoughts.": "Wala pang komento. Ikaw ang unang magbahagi ng iyong mga saloobin.",
  "Log in": "Mag-login",
  "to join the discussion.": "upang sumali sa usapan.",
  "COPY LINK": "KOPYAHIN ANG LINK",
  "PRINT": "I-PRINT",
  "CLOSE": "ISARA",
  "Confirm": "Kumpirmahin",
  "Close": "Isara",
  "CANCEL": "KANSELA",
  "DELETE": "BURAHIN",
  "LOGIN": "MAG-LOGIN",
  "RESET": "I-RESET",
  "RESTORE": "IBALIK",
  "NEW CHAT": "BAGONG CHAT",
  "EDIT": "I-EDIT",
  "REMOVE": "ALISIN",
  "NEWS": "BALITA",
  "ANNOUNCEMENT": "ANUNSYO",
  "NEW": "BAGO",
  "EMERGENCY ALERT": "ALERTO SA EMERGENSIYA",
  "Dismiss": "Isara",
  "No notifications right now.": "Wala pang abiso ngayon.",
  "No announcements yet.": "Wala pang anunsyo.",
  "No upcoming events.": "Wala pang paparating na kaganapan.",
  "You have not saved anything yet.": "Wala ka pang na-save.",
  "Click <strong>SAVE</strong> on any news article or announcement to keep it here.": "I-click ang <strong>SAVE</strong> sa anumang balita o anunsyo para mapanatili ito dito.",
  "No news found. Please try another search.": "Walang nahanap na balita. Subukan ang ibang paghahanap.",
  "No announcements in this category.": "Walang anunsyo sa kategoryang ito.",
  "Add News": "Idagdag ang Balita",
  "Edit News": "I-edit ang Balita",
  "ADD NEWS": "IDAGDAG ANG BALITA",
  "UPDATE NEWS": "I-UPDATE ANG BALITA",
  "Add Announcement": "Idagdag ang Anunsyo",
  "Edit Announcement": "I-edit ang Anunsyo",
  "ADD ANNOUNCEMENT": "IDAGDAG ANG ANUNSYO",
  "UPDATE ANNOUNCEMENT": "I-UPDATE ANG ANUNSYO",
  "Add Event": "Idagdag ang Kaganapan",
  "Edit Event": "I-edit ang Kaganapan",
  "ADD EVENT": "IDAGDAG ANG KAGANAPAN",
  "UPDATE EVENT": "I-UPDATE ANG KAGANAPAN",
  "Add Activity": "Idagdag ang Gawain",
  "Edit Activity": "I-edit ang Gawain",
  "ADD ACTIVITY": "IDAGDAG ANG GAWAIN",
  "UPDATE ACTIVITY": "I-UPDATE ANG GAWAIN",
  "Add Photo": "Idagdag ang Larawan",
  "Edit Photo": "I-edit ang Larawan",
  "ADD PHOTO": "IDAGDAG ANG LARAWAN",
  "UPDATE PHOTO": "I-UPDATE ANG LARAWAN",
  "No news yet. Add your first news above.": "Wala pang balita. Idagdag ang unang balita sa itaas.",
  "No events yet.": "Wala pang kaganapan.",
  "No activities yet.": "Wala pang gawain.",
  "No photos yet.": "Wala pang larawan.",
  "Gallery Photos": "Mga Larawan sa Gallery",
  "Feels like": "Ramdam na parang",
  "Humidity": "Halumigmig",
  "Wind": "Hangin",
  "ALERTS": "ANUNSYO",
  "MENU": "MENU",
  "Title": "Pamagat",
  "Name": "Pangalan",
  "Date": "Petsa",
  "Time": "Oras",
  "Location": "Lugar",
  "Photo": "Larawan",
  "Caption": "Caption",
  "User": "User",
  "Upload Photos (recommended)": "Mag-upload ng mga Larawan (inirerekomenda)",
  "Or enter image paths": "O maglagay ng mga path ng larawan",
  "Add Videos (optional)": "Magdagdag ng Video (opsyonal)",
  "Or enter a video path / link": "O maglagay ng path / link ng video",
  "Pick one or more photos from your device - each is resized automatically and saved in the browser. You can select up to 6.": "Pumili ng isa o higit pang larawan mula sa iyong device - awtomatikong nililiit ang bawat isa at naka-save sa browser. Puwede kang pumili ng hanggang 6.",
  "Use a local file, or several separated by commas: a.jpg, b.jpg": "Gumamit ng lokal na file, o ilang pinaghihiwalay ng kuwit: a.jpg, b.jpg",
  "Pick one or more short videos from your device (MP4, WEBM, or OGG) - they are saved in the browser.": "Pumili ng isa o higit pang maiikling video mula sa iyong device (MP4, WEBM, o OGG) - naka-save ang mga ito sa browser.",
  "Use a local file or a direct video link (MP4, WEBM, or OGG).": "Gumamit ng lokal na file o direktang link ng video (MP4, WEBM, o OGG).",
  "Emergency Hotlines": "Mga Emergency Hotline",
  "HOTLINES": "HOTLINE",
  "Quick-dial numbers for urgent help in our community.": "Mga numerong mabilis i-dial para sa agarang tulong sa ating komunidad.",
  "In an emergency, call 911": "Sa oras ng emergency, tumawag sa 911",
  "One national number for police, fire, and medical emergencies — free and available 24/7 on any phone.": "Isang national number para sa pulis, sunog, at medikal na emergency — libre at available 24/7 sa kahit anong telepono.",
  "CALL 911": "TAWAGAN ANG 911",
  "CALL NOW": "TAWAGAN NGAYON",
  "COPY NUMBER": "KOPYAHIN ANG NUMERO",
  "Keep these numbers saved on your phone and posted at home. During an emergency, stay calm, give your exact address, and follow the operator's instructions.": "Itago ang mga numerong ito sa iyong telepono at ipaskil sa bahay. Sa oras ng emergency, manatiling kalmado, ibigay ang eksaktong address, at sundin ang tagubilin ng operator.",
  "Barangay services, blotter reports, mediation, and community assistance.": "Mga serbisyo ng barangay, blotter, mediasyon, at tulong sa komunidad.",
  "Police Station": "Presinto ng Pulis",
  "Crime reports, peace and order concerns, and police assistance.": "Pag-uulat ng krimen, usapin sa kapayapaan at kaayusan, at tulong ng pulis.",
  "Medical consultations, maternal care, immunization, and ambulance referral.": "Konsultasyon, maternal care, immunization, at ambulanse.",
  "Fire Department": "Kagawaran ng Bumbero",
  "Fire emergencies, rescue operations, and fire safety inspections.": "Sunog, rescue operations, at inspeksyon sa kaligtasan sa sunog.",
  "Typhoon, flood, and disaster response plus search and rescue operations.": "Tugon sa bagyo, baha, at sakuna, kasama ang search and rescue.",
  "Mon - Fri, 8:00 AM - 5:00 PM": "Lun - Biy, 8:00 AM - 5:00 PM",
  "RSVP attendance": "RSVP at bilang ng dadalo",
  "Going": "Dadalo",
  "View attendees": "Tingnan ang dadalo",
  "No RSVPs yet for this event.": "Wala pang RSVP para sa event na ito.",
  "Upcoming events:": "Mga paparating na event:",
  "Total RSVPs:": "Kabuuang RSVP:",
  "Biggest gathering:": "Pinakamalaking pagtitipon:",
  "Your name (optional)": "Iyong pangalan (opsyonal)",
  "Guest": "Bisita",
  "GUEST": "BISITA",
  "Profile Picture": "Larawan sa Profile",
  "Display Name": "Pangalan ng Ipapakita",
  "Name shown on your comments": "Pangalan na ipinapakita sa iyong mga komento",
  "Name shown as the author of posts": "Pangalan na ipinapakita bilang may-akda ng mga post",
  "Choose a photo from your device - it is cropped to a square and saved in your browser.": "Pumili ng larawan mula sa iyong device - ginagawang parisukat at naka-save sa browser.",
  "REMOVE PHOTO": "TANGGALIN ANG LARAWAN",
  "Title / Position": "Titulo / Posisyon",
  "e.g. Barangay Administrator": "hal. Barangay Administrator",
  "Your profile has been saved.": "Nai-save na ang iyong profile.",
  "Your profile has been saved successfully.": "Matagumpay na nai-save ang iyong profile.",
  "Change Password": "Palitan ang Password",
  "Profile saved.": "Nai-save ang profile.",
  "Show password": "Ipakita ang password",
  "Hide password": "Itago ang password",
  "Likes": "Mga Gusto",
  "Shares": "Mga Share",
  "Saves": "Mga Save",
  "New members": "Mga Bagong Miyembro",
  "Go Live": "Go Live",
  "liked": "nag-like ng",
  "commented on": "nagkomento sa",
  "shared": "nag-share ng",
  "is going to": "sasali sa",
  "joined the community": "sumali sa komunidad",
  "started a live broadcast": "nagsimula ng live broadcast",
  "a news post": "isang balita",
  "an announcement": "isang anunsyo",
  "an activity": "isang gawain",
  "an event": "isang kaganapan",
  "a profile": "isang profile",
  "a post": "isang post",
  "Just now": "Ngayon lang",
  "notifications": "notifications",
  "MARK ALL READ": "MARKAHAN LAHAT",
  "MARK ALL AS READ": "MARKAHAN LAHAT BILANG BASA",
  "CLEAR HISTORY": "BURAHIN ANG KASAYSAYAN",
  "Notification Settings": "Mga Setting ng Notification",
  "Unread": "Hindi pa Basa",
  "CLEAR": "BURAHIN",
  "No notifications yet.": "Wala pang notifications.",
  "No unread notifications.": "Walang hindi pa basang notification.",
  "This post is no longer available.": "Hindi na available ang post na ito.",
  "All notifications marked as read.": "Namarkahan na ang lahat ng notification bilang basa.",
  "Notification history cleared.": "Nabura ang kasaysayan ng notification.",
  "Clear the whole notification history?": "Burahin ang buong kasaysayan ng notification?",
  "Every like, comment, share, save, and RSVP from your residents.": "Bawat like, komento, share, save, at RSVP mula sa iyong mga residente.",
  "Choose which resident activity should alert you. Turning a type off keeps its history but hides it from the bell and the count.": "Piliin kung aling aktibidad ng residente ang mag-aalerto sa iyo. Kapag pinatay ang isang uri, nananatili ang kasaysayan nito ngunit hindi na ito lumalabas sa bell at sa bilang.",
  "Updated": "Na-update",
  "sample data": "halimbawang data",
  "Time shown is Philippine time (Asia/Manila).": "Ang oras na ipinapakita ay oras ng Pilipinas (Asia/Manila).",
  "Heat advisory: drink plenty of water and limit time under the sun.": "Heat advisory: uminom ng maraming tubig at bawasan ang oras sa ilalim ng araw.",
  "Posted advisory:": "Nai-post na abiso:",
  "Today": "Ngayon",
  "Fri": "Biy",
  "Sat": "Sab",
  "Sun": "Lin",
  "Mon": "Lun",
  "Tue": "Mar",
  "Wed": "Miy",
  "Thu": "Huw",
  "Overview": "Buod",
  "Browse": "I-browse",
  "My Account": "Ang Aking Account",
  "HOME / OVERVIEW": "TAHANAN / BUOD",
  "UPCOMING EVENTS": "PAPARATING NA KAGANAPAN",
  "SAVED ITEMS": "MGA NA-SAVE",
  "NOTIFICATIONS": "MGA ABISO",
  "MY PROFILE": "ANG AKING PROFILE",
  "COMMUNITY NEWS": "MGA BALITA NG KOMUNIDAD",
  "LOGOUT": "MAG-LOGOUT",
  "Log out": "Mag-log out",
  "SETTINGS": "MGA SETTING",
  "Settings": "Mga Setting",
  "Sign Out": "Mag-sign Out",
  "BACK TO WEBSITE": "BUMALIK SA WEBSITE",
  "Website": "Website",
  "Dark": "Madilim",
  "Light": "Maliwanag",
  "Settings saved.": "Nai-save ang mga setting.",
  "Settings reset to defaults.": "Ibinalik ang mga setting sa default.",
  "Signed out after inactivity.": "Ni-log out dahil sa kawalan ng aktibidad.",
  "Maintenance Notice": "Abiso sa Maintenance",
  "Some features may be unavailable while the site is being updated.": "Ang ilang feature ay maaaring hindi available habang ina-update ang site.",
  "Dark Mode": "Maitim na Mode",
  "Language": "Wika",
  "Community Member": "Member ng Komunidad",
  "Manage Content": "I-manage ang Nilalaman",
  "Account": "Account",
  "Here is the latest from your community at a glance.": "Narito ang pinakabago sa iyong komunidad sa isang tingin.",
  "Latest Announcement": "Pinakabagong Anunsyo",
  "Next Event": "Susunod na Kaganapan",
  "Use the menu on the left to read community news, announcements, events, activities, and photos. Keep your profile updated under My Profile, and check Notifications for the latest important updates.":
    "Gamitin ang menu sa kaliwa para basahin ang balita, anunsyo, kaganapan, gawain, at larawan ng komunidad. I-update ang iyong profile sa My Profile, at tingnan ang Mga Abiso para sa mga mahalagang update.",
  "Latest articles posted by the community office.": "Mga bagong artikulo mula sa opisina ng komunidad.",
  "Important notices and public information for residents.": "Mga mahalagang abiso at pampublikong impormasyon para sa mga residente.",
  "Dates, times, and locations of community events.": "Mga petsa, oras, at lokasyon ng mga kaganapan sa komunidad.",
  "Programs and activities you can join.": "Mga programa at gawain na maaari mong salihan.",
  "Photos from community events and activities.": "Mga larawan mula sa mga kaganapan at gawain ng komunidad.",
  "News and announcements you saved for later reading.": "Mga balita at anunsyo na iyong na-save para basahin mamaya.",
  "Important announcements and upcoming events, newest first.": "Mga mahalagang anunsyo at paparating na kaganapan, pinakabago muna.",
  "Update your contact details and password.": "I-update ang iyong mga detalye ng contact at password.",
  "Saved Items": "Mga Na-Save",
  "Notifications": "Mga Abiso",
  "My Profile": "Ang Aking Profile",
  "Phone": "Telepono",
  "Address": "Address",
  "New Password (optional)": "Bagong Password (opsyonal)",
  "Confirm New Password": "Kumpirmahin ang Bagong Password",
  "SAVE PROFILE": "I-SAVE ANG PROFILE",
  "Username cannot be changed.": "Hindi mababago ang username.",
  "Dashboard": "Dashboard",
  "Manage News": "I-manage ang Balita",
  "Manage Announcements": "I-manage ang Mga Anunsyo",
  "Manage Events": "I-manage ang Mga Kaganapan",
  "Manage Activities": "I-manage ang Mga Gawain",
  "Manage Gallery": "I-manage ang Gallery",
  "Overview of all community content on Community Connect.": "Buod ng lahat ng nilalaman ng komunidad sa Community Connect.",
  "Add, edit, or remove news articles shown on the website.": "Magdagdag, mag-edit, o mag-alis ng balita na ipinapakita sa website.",
  "Post important notices and public information for residents.": "Mag-post ng mahalagang abiso at pampublikong impormasyon para sa mga residente.",
  "Schedule events with dates, times, and locations.": "Mag-iskedyul ng kaganapan na may petsa, oras, at lokasyon.",
  "Keep the community activity list up to date.": "Panatilihing updated ang listahan ng mga gawain ng komunidad.",
  "Manage the photos displayed on the public gallery page.": "I-manage ang mga larawan sa pampublikong gallery page.",
  "Content by Type": "Nilalaman ayon sa Uri",
  "Posts per Month (last 6 months)": "Mga Post kada Buwan (nakaraang 6 buwan)",
  "News Views (last 7 days)": "Mga View ng Balita (nakaraang 7 araw)",
  "How much of each content type is stored in this browser.": "Kung gaano karami ng bawat uri ng nilalaman ang naka-save sa browser na ito.",
  "News, announcements, events, activities, and photos combined.": "Kombinasyon ng balita, anunsyo, kaganapan, gawain, at larawan.",
  "How often news articles were opened each day.": "Kung gaano kadalas binubuksan ang mga balita araw-araw.",
  "Backup & Data Tools": "Backup at mga Kasangkapan sa Data",
  "About this Admin Panel": "Tungkol sa Admin Panel na ito",
  "Use the menu on the left to manage community information.": "Gamitin ang menu sa kaliwa para pamahalaan ang impormasyon ng komunidad.",
  "Log in to join the discussion.": "Mag-login upang sumali sa usapan.",
  "items": "mga item",
  "No matching results.": "Walang tumutugma na resulta.",
  "Search news": "Hanapin ang Balita",
  "Search announcements": "Hanapin ang Mga Anunsyo",
  "Search events": "Hanapin ang Mga Kaganapan",
  "Search activities": "Hanapin ang Mga Gawain",
  "Search photos": "Hanapin ang Mga Larawan",
  "USERS": "MGA USER",
  "MANAGE USERS": "PAMAHALAAN ANG MGA USER",
  "Manage Users": "Pamahalaan ang Mga User",
  "Create Barangay Official accounts and view every registered community account.": "Gumawa ng mga account ng Opisyal ng Barangay at tingnan ang lahat ng rehistradong account ng komunidad.",
  "Residents who signed up from the public site.": "Mga residenteng nag-sign up mula sa pampublikong site.",
  "View registered community accounts.": "Tingnan ang mga rehistradong account ng komunidad.",
  "Registered Users": "Mga Rehistradong User",
  "Actions": "Mga Aksyon",
  "Joined": "Nagsimula",
  "VIEW": "TINGNAN",
  "SIGNED IN": "Naka-sign in",
  "No registered users yet.": "Wala pang rehistradong user.",
  "Are you sure you want to delete this user?": "Sigurado ka bang gustong tanggalin ang user na ito?",
  "User deleted.": "Natanggal ang user.",
  "Currently signed in": "Kasalukuyang naka-sign in",
  "Not signed in": "Hindi naka-sign in",
  "Saved items": "Mga naka-save",
  "Comments": "Mga komento",
  "Status": "Katayuan",
  "Event RSVPs": "Mga RSVP sa Kaganapan",
  "Registered community member": "Rehistradong miyembro ng komunidad",
  "Manage Comments": "Pamahalaan ang mga Komento",
  "See who commented on each post.": "Tingnan kung sino ang nagkomento sa bawat post.",
  "Search posts or people": "Maghanap ng post o tao",
  "No comments on any post yet.": "Wala pang komento sa anumang post.",
  "Deleted post": "Naburang post",
  "VIEW PROFILE": "TINGNAN ANG PROFILE",
  "HIDE": "ITAGO",
  "SHOW": "IPAKITA",
  "HIDDEN": "TAGO",
  "Comment hidden.": "Nakatago ang komento.",
  "Comment shown.": "Ipinakita ang komento.",
  "Comment deleted.": "Natanggal ang komento.",
  "Are you sure you want to delete this comment?": "Sigurado ka bang gusto mong burahin ang komentong ito?",
  "Recent Admin Activity": "Kamakailang Aktibidad ng Admin",
  "No activity recorded yet.": "Wala pang naitalang aktibidad.",
  "User not found.": "Hindi mahanap ang user.",
  "See comments": "Tingnan ang mga komento",
  "created news": "nakalikha ng balita",
  "updated news": "nag-update ng balita",
  "deleted news": "nagbura ng balita",
  "pinned news": "nag-pin sa balita",
  "unpinned news": "tinanggal ang pin sa balita",
  "created announcement": "nakalikha ng paunawa",
  "updated announcement": "nag-update ng paunawa",
  "deleted announcement": "nagbura ng paunawa",
  "created event": "nakalikha ng kaganapan",
  "updated event": "nag-update ng kaganapan",
  "deleted event": "nagbura ng kaganapan",
  "created activity": "nakalikha ng gawain",
  "updated activity": "nag-update ng gawain",
  "deleted activity": "nagbura ng gawain",
  "created photo": "nakalikha ng larawan",
  "updated photo": "nag-update ng larawan",
  "deleted photo": "nagbura ng larawan",
  "deleted user": "nagbura ng user",
  "deleted comment": "nagbura ng komento",
  "hid comment": "nagtago ng komento",
  "showed comment": "nagpakita ng komento",
  "RESTORE LAST RESET": "IBALIK ANG HULING RESET",
  "No community news posted yet.": "Wala pang nai-post na balita sa komunidad.",
  "No community announcements posted yet.": "Wala pang nai-post na anunsyo sa komunidad.",
  "No announcements found. Please try another search.": "Walang nahanap na anunsyo. Subukan ang ibang paghahanap.",
  "No upcoming events right now. Please check again later.": "Walang paparating na kaganapan sa ngayon. Pakisubukan muli mamaya.",
  "No community activities posted yet.": "Wala pang nai-post na gawain sa komunidad.",
  "No photos in the gallery yet.": "Wala pang larawan sa gallery.",
  "No automatic backup found.": "Walang nahanap na awtomatikong backup.",
  "Backup restored.": "Naibalik ang backup.",
  "Restore the automatic backup taken before the last reset?": "Ibalik ang awtomatikong backup na kinuha bago ang huling reset?",
  "This backup was made by a newer version of the site.": "Gawa ito ng mas bagong bersyon ng site.",
  "Import found no valid data sets.": "Walang wastong data set na nahanap sa import.",
  "That file is not a valid Community Connect backup.": "Hindi ito wastong Community Connect backup.",
  "Import finished.": "Tapos ang import.",
  "data sets restored.": "data set ang naibalik.",
  "imported data": "nag-import ng data",
  "reset data": "nag-reset ng data",
  "restored backup": "nag-restore ng backup",
  "Camera access was denied. Please allow the camera and microphone, then try again.": "Tinanggihan ang access sa camera. Payagan ang camera at mikropono, pagkatapos subukan muli.",
  "No camera or microphone was found on this device.": "Walang nahanap na camera o mikropono sa device na ito.",
  "Could not use the camera or microphone. It may be in use by another app.": "Hindi magamit ang camera o mikropono. Maaaring ginagamit ng ibang app.",
  "Live broadcasting is not supported in this browser. Please use Chrome or Edge.": "Hindi sinusuportahan ang live broadcasting sa browser na ito. Gumamit ng Chrome o Edge.",
  "viewers": "manonood",
  "watching": "nanonood",
  "On Air": "Nasa Live",
  "Offline": "Hindi Live",
  "LIVE": "LIVE",
  "GO LIVE": "MAG-LIVE",
  "Broadcast to the community in real time.": "Mag-broadcast sa komunidad nang real time.",
  "Broadcast camera video and audio to the community in real time.": "I-broadcast ang camera video at audio sa komunidad nang real time.",
  "Go Live Studio": "Go Live Studio",
  "Enable the camera and microphone to preview yourself before going live.": "Payagan ang camera at mikropono para makita ang sarili bago mag-live.",
  "Enable Camera & Microphone": "I-enable ang Camera at Mikropono",
  "Live Stream Title": "Pamagat ng Live Stream",
  "Description": "Paglalarawan",
  "Category": "Kategorya",
  "Save a recording to Live Archives when I end the broadcast": "Mag-save ng recording sa Live Archives kapag tinapos ko ang broadcast",
  "Start Broadcast": "Simulan ang Broadcast",
  "End Broadcast": "Itapos ang Broadcast",
  "Live Archives": "Mga Live Archive",
  "Saved broadcasts play back like any other video post.": "Ang mga naka-save na broadcast ay mapaparating tulad ng ibang video post.",
  "No saved broadcasts yet.": "Wala pang naka-save na broadcast.",
  "No Live Broadcast Right Now": "Walang Live Broadcast Ngayon",
  "When the community office goes live, the broadcast appears here automatically.": "Kapag nag-live ang community office, awtomatikong lilitaw dito ang broadcast.",
  "Please enter a title for the live stream.": "Maglagay ng pamagat para sa live stream.",
  "Another broadcast is already running. End it before starting a new one.": "May ibang broadcast na tumatakbo. Itapos muna bago magsimula ng bago.",
  "The broadcast was interrupted.": "Naantala ang broadcast.",
  "Broadcast is live.": "Live na ang broadcast.",
  "Live broadcast": "Live na broadcast",
  "Broadcast saved to Live Archives.": "Nasave ang broadcast sa Live Archives.",
  "Broadcast ended.": "Natapos ang broadcast.",
  "This recording is no longer available.": "Hindi na available ang recording na ito.",
  "Broadcast deleted.": "Nabura ang broadcast.",
  "PLAY": "I-PLAY",
  "Your browser cannot play live video. Please use Chrome or Edge.": "Hindi kayang i-play ng browser mo ang live video. Gumamit ng Chrome o Edge.",
  "Connecting to the live broadcast...": "Kinokonekta sa live broadcast..."
};

var I18N_PH = {
  "Search everything...": "I-search ang lahat...",
  "Search Community News (title or category)": "Hanapin ang Balita (pamagat o kategorya)",
  "Search Community News": "Hanapin ang Balita",
  "Search news...": "Hanapin ang balita...",
  "Search announcements (title or text)": "Hanapin ang Mga Anunsyo (pamagat o teksto)",
  "Message News AI Assistant...": "Mag-message sa News AI Assistant...",
  "Write a comment...": "Mag-isip ng komento...",
  "09XX-XXX-XXXX": "09XX-XXX-XXXX",
  "Purok / Street / Barangay": "Purok / Kalye / Barangay",
  "Leave blank to keep current password": "Iwanan blanko para panatilihin ang kasalukuyang password",
  "Type the new password again": "I-type muli ang bagong password",
  "Search announcements...": "Hanapin ang mga anunsyo...",
  "Search events...": "Hanapin ang mga kaganapan...",
  "Search activities...": "Hanapin ang mga gawain...",
  "Search photos...": "Hanapin ang mga larawan...",
  "Search users...": "Hanapin ang mga user...",
  "Search posts or people...": "Hanapin ang mga post o tao...",
  "videos/community-update.mp4 or https://.../video.mp4": "videos/community-update.mp4 o https://.../video.mp4",
  "community-01.jpg": "community-01.jpg",
  "Enter announcement title": "Ilagay ang pamagat ng anunsyo",
  "Announcement details": "Detalye ng anunsyo",
  "Name shown on your comments": "Pangalan na ipinapakita sa iyong mga komento",
  "Name shown as the author of posts": "Pangalan na ipinapakita bilang may-akda ng mga post",
  "e.g. Barangay Administrator": "hal. Barangay Administrator",
  "office@email.com": "office@email.com",
  "e.g. Town Hall Q&A with the Captain": "hal. Town Hall Q&A kasama ang Kapitan",
  "What is this broadcast about?": "Ano ang tungkol sa broadcast na ito?",

  /* Barangay Officials + certificate services */
  "Barangay Officials": "Mga Opisyal ng Barangay",
  "OFFICIALS": "MGA OPISYAL",
  "Barangay Services": "Serbisyong Barangay",
  "REQUEST CERTIFICATE": "HUMILING NG SERTIPIKO",
  "Manage Barangay Officials": "Pamahalaan ang mga Opisyal ng Barangay",
  "Add and manage the accounts of the Barangay Officials. Officials sign in through the same login page as residents.": "Idagdag at pamahalaan ang mga account ng mga Opisyal ng Barangay. Nag-sign in ang mga opisyal sa parehong login page ng mga residente.",
  "Add Barangay Official": "Magdagdag ng Opisyal ng Barangay",
  "Edit Barangay Official": "I-edit ang Opisyal ng Barangay",
  "Full Name": "Buong Pangalan",
  "e.g. Maria Santos": "hal. Maria Santos",
  "Position": "Posisyon",
  "Barangay Captain": "Kapitan ng Barangay",
  "Barangay Kagawad": "Kagawad ng Barangay",
  "SK Chairperson": "Tagapangulo ng SK",
  "Barangay Secretary": "Kalihim ng Barangay",
  "Barangay Treasurer": "Ingat-yaman ng Barangay",
  "Barangay Tanod": "Tanod ng Barangay",
  "Other Official": "Iba pang Opisyal",
  "Username": "Username",
  "Choose a username": "Pumili ng username",
  "e.g. official.santos": "hal. official.santos",
  "Password": "Password",
  "At least 6 characters": "Hindi bababa sa 6 na karakter",
  "Leave blank to keep the current password": "Iwanang blangko upang panatilihin ang kasalukuyang password",
  "Email (optional)": "Email (opsyonal)",
  "Phone (optional)": "Telepono (opsyonal)",
  "Barangay": "Barangay",
  "Please enter the barangay.": "Pakilagay ang barangay.",
  "ADD OFFICIAL": "IDAGDAG ANG OPISYAL",
  "BACK": "BUMALIK",
  "SAVE CHANGES": "I-SAVE ANG MGA PAGBABAGO",
  "ACTIVATE": "I-ACTIVATE",
  "DEACTIVATE": "I-DEACTIVATE",
  "Active": "Aktibo",
  "Inactive": "Hindi Aktibo",
  "Search officials...": "Maghanap ng opisyal...",
  "No barangay officials yet. Add one using the form above.": "Wala pang opisyal ng barangay. Magdagdag gamit ang form sa itaas.",
  "Barangay Official added. They can now sign in on the login page.": "Naidagdag ang Opisyal ng Barangay. Maaari na silang mag-sign in sa login page.",
  "Barangay Official updated.": "Na-update ang Opisyal ng Barangay.",
  "Barangay Official deleted.": "Nabura ang Opisyal ng Barangay.",
  "Official account activated.": "Na-activate ang account ng opisyal.",
  "Official account deactivated.": "Na-deactivate ang account ng opisyal.",
  "Please enter the official's full name.": "Pakilagay ang buong pangalan ng opisyal.",
  "That username is already taken.": "Nakuha na ang username na iyon.",
  "This official account has been deactivated.": "Na-deactivate na ang account ng opisyal na ito.",
  "Barangay Official": "Opisyal ng Barangay",

  /* Certificate requests */
  "Barangay Certificates": "Mga Sertipiko ng Barangay",
  "Request barangay certificates online. The Barangay Officials are notified automatically.": "Humiling ng mga sertipiko ng barangay online. Awtomatikong naaabisuhan ang mga Opisyal ng Barangay.",
  "Request a Certificate": "Humiling ng Sertipiko",
  "Certificate Type": "Uri ng Sertipiko",
  "Barangay Certificate of Indigency": "Sertipiko ng Indigency ng Barangay",
  "Barangay Clearance": "Barangay Clearance",
  "Certificate of Residency": "Sertipiko ng Paninirahan",
  "Certificate of Good Moral Character": "Sertipiko ng Magandang Asal",
  "Barangay Business Clearance": "Barangay Business Clearance",
  "Purpose of Request": "Layunin ng Kahilingan",
  "e.g. For employment requirements": "hal. Para sa pangangailangan sa trabaho",
  "Age": "Edad",
  "Civil Status": "Katayuang Sibil",
  "Single": "Walang Asawa",
  "Married": "May Asawa",
  "Widowed": "Balo",
  "Separated": "Hiwalay",
  "Complete Address": "Kumpletong Address",
  "Purok / Street / Barangay": "Purok / Kalye / Barangay",
  "Contact Number": "Numero ng Telepono",
  "Years of Residency": "Taon ng Paninirahan",
  "Business Name": "Pangalan ng Negosyo",
  "SUBMIT REQUEST": "ISUMITE ANG KAHILINGAN",
  "My Certificate Requests": "Aking mga Kahilingan ng Sertipiko",
  "Track the status of the certificates you requested.": "Subaybayan ang estado ng mga sertipikong hiniling mo.",
  "You have not requested any certificates yet.": "Wala ka pang hinihiling na sertipiko.",
  "Please describe the purpose of your request.": "Pakilarawan ang layunin ng iyong kahilingan.",
  "Your Barangay": "Iyong Barangay",
  "Type to search your barangay...": "I-type upang hanapin ang iyong barangay...",
  "Search and select your barangay. Your request is sent only to that barangay's officials.": "Hanapin at piliin ang iyong barangay. Ang iyong kahilingan ay ipapadala lamang sa mga opisyal ng barangay na iyon.",
  "No barangay found.": "Walang nahanap na barangay.",
  "Please search and select your barangay.": "Mangyaring hanapin at piliin ang iyong barangay.",
  "Please enter your complete address.": "Pakilagay ang iyong kumpletong address.",
  "Please enter the business name.": "Pakilagay ang pangalan ng negosyo.",
  "Certificate request submitted. The Barangay Officials have been notified.": "Naisumite ang kahilingan ng sertipiko. Naabisuhan na ang mga Opisyal ng Barangay.",
  "requests": "mga kahilingan",
  "Certificate": "Sertipiko",

  /* Official dashboard */
  "Barangay Official Dashboard": "Dashboard ng Opisyal ng Barangay",
  "Review certificate requests and keep up with community updates.": "Suriin ang mga kahilingan ng sertipiko at manatiling updated sa komunidad.",
  "CERTIFICATE REQUESTS": "MGA KAHILINGAN NG SERTIPIKO",
  "Certificate Requests": "Mga Kahilingan ng Sertipiko",
  "Review, approve, and print the certificates requested by residents.": "Suriin, aprubahan, at i-print ang mga sertipikong hiniling ng mga residente.",
  "Search requests...": "Maghanap ng kahilingan...",
  "All Statuses": "Lahat ng Estado",
  "Pending": "Nakabinbin",
  "Ready for Pickup": "Handa nang Kunin",
  "Released": "Naibigay Na",
  "No certificate requests match your filter.": "Walang kahilingang tugma sa iyong filter.",
  "Pending Requests": "Nakabinbing Kahilingan",
  "Ready to Print": "Handa nang I-print",
  "Released Certificates": "Naibigay na Sertipiko",
  "Total Requests": "Kabuuang Kahilingan",
  "Recent Certificate Requests": "Mga Kamakailang Kahilingan",
  "No certificate requests yet.": "Wala pang kahilingan ng sertipiko.",
  "Reference No.": "Numero ng Reference",
  "Resident": "Residente",
  "Date Requested": "Petsa ng Kahilingan",
  "Date Printed": "Petsa ng Pag-print",
  "Printed By": "Ni-print Ni",
  "REVIEW": "SURIIN",
  "PRINT": "I-PRINT",
  "MARK AS READY": "MARKAHAN NG HANDA",
  "PRINT CERTIFICATE": "I-PRINT ANG SERTIPIKO",
  "Request marked as ready for pickup.": "Namarkahan na ang kahilingan bilang handa nang kunin.",
  "Certificate printed and marked as released.": "Na-print ang sertipiko at namarkahan bilang naibigay na.",
  "requested a certificate": "ay humiling ng sertipiko",
  "Report Incident": "I-report ang Insidente",
  "Report an Incident": "Mag-report ng Insidente",
  "Incident Reports": "Mga Ulat ng Insidente",
  "Incident Report": "Ulat ng Insidente",
  "My Incident Reports": "Aking mga Ulat ng Insidente",
  "Incident Type": "Uri ng Insidente",
  "Severity": "Kalubhaan",
  "Describe what happened": "Ilarawan ang nangyari",
  "SUBMIT REPORT": "ISUMITE ANG ULAT",
  "Reported": "Naiulat",
  "Responding": "Tumutugon",
  "Resolved": "Naresolba",
  "reports": "ulat",
  "Reported By": "Nag-ulat",
  "Date Reported": "Petsa ng Pag-uulat",
  "Official Response": "Tugon ng Opisyal",
  "Responded By": "Tumugon",
  "Vehicular Accident": "Aksidente sa Sasakyan",
  "Fire": "Sunog",
  "Flood / Typhoon": "Baha / Bagyo",
  "Crime / Theft": "Krimen / Pagnanakaw",
  "Medical Emergency": "Medikal na Emergency",
  "Utility / Power Problem": "Problema sa Kuryente",
  "Other Emergency": "Iba pang Emergency",
  "Low": "Mababa",
  "Medium": "Katamtaman",
  "High": "Mataas",
  "reported an incident": "nag-ulat ng insidente",
  "Incident report submitted. The Barangay Officials have been notified.": "Naisumite ang ulat ng insidente. Naabisuhan na ang mga Barangay Official.",
  "Incident report updated.": "Na-update ang ulat ng insidente.",
  "Please enter the location of the incident.": "Pakilagay ang lokasyon ng insidente.",
  "Please describe what happened.": "Pakilarawan ang nangyari.",
  "You have not reported any incidents yet.": "Wala ka pang naiuulat na insidente.",
  "No incident reports match your filter.": "Walang ulat ng insidente na tumutugma sa iyong filter.",
  "No incident reports yet.": "Wala pang ulat ng insidente.",
  "MARK AS RESPONDING": "MARKAHAN BILANG TUMUTUGON",
  "MARK AS RESOLVED": "MARKAHAN BILANG NARESOLBA",
  "Active Incidents": "Aktibong Insidente",
  "On Duty": "Naka-duty",
  "Off Duty": "Wala sa Duty",
  "Open Incidents": "Bukas na Insidente",
  "Escalated": "Na-escalate",
  "ESCALATED": "NA-ESCALATE",
  "Avg Response Time": "Karaniwang Oras ng Tugon",
  "Incidents by type": "Mga insidente ayon sa uri",
  "min": "min",
  "Assigned To": "Itinalaga Sa",
  "Unassigned": "Hindi pa naitalaga",
  "CLAIM REPORT": "SANGKAPIN ANG ULAT",
  "Report claimed": "Sinangkapan ang ulat ni",
  "You are now handling this report.": "Ikaw na ang humahawak ng ulat na ito.",
  "Add an update": "Magdagdag ng update",
  "Show this update to the resident": "Ipakita sa residente ang update na ito",
  "ADD UPDATE": "IDAGDAG ANG UPDATE",
  "Update added.": "Naidagdag ang update.",
  "Please type an update first.": "Mag-type muna ng update.",
  "Response Timeline": "Talaan ng Tugon",
  "No updates yet.": "Wala pang update.",
  "internal note": "internal na tala",
  "View on map": "Tingnan sa mapa",
  "Incident photo": "Larawan ng insidente",
  "Landmark (optional)": "Palatandaan (opsyonal)",
  "USE MY LOCATION": "GAMITIN ANG AKING LOKASYON",
  "Coordinates (optional)": "Mga coordinate (opsyonal)",
  "Location captured": "Nakuha ang lokasyon",
  "Could not get your location.": "Hindi makuha ang iyong lokasyon.",
  "Location is not available in this browser.": "Walang lokasyon sa browser na ito.",
  "Photo (optional)": "Larawan (opsyonal)",
  "Released To (name)": "Naibigay Kay (pangalan)",
  "Name of person claiming": "Pangalan ng kumukuha",
  "ID / Reference": "ID / Reference",
  "Valid ID or reference no.": "Valid ID o reference no.",
  "Reject with remarks": "Tanggihan na may paliwanag",
  "Reason (shown to the resident)": "Dahilan (ipapakita sa residente)",
  "REJECT REQUEST": "TANGGIHAN ANG KAHILINGAN",
  "Request rejected and the resident was informed.": "Tinanggihan ang kahilingan at naabisuhan ang residente.",
  "Please add a reason for rejecting.": "Maglagay ng dahilan ng pagtanggi.",
  "MARK SELECTED READY": "MARKAHAN ANG NAPILI",
  "Select at least one pending request first.": "Pumili muna ng kahilingang nakabinbin.",
  "requests marked as ready.": "kahilingan ang namarkahang handa.",
  "EXPORT CSV": "I-EXPORT ANG CSV",
  "EXPORT LOG": "I-EXPORT ANG LOG",
  "Incidents CSV downloaded.": "Na-download ang CSV ng mga insidente.",
  "Certificate log CSV downloaded.": "Na-download ang CSV ng log ng sertipiko.",
  "Alert sound on": "Tunog ng alerto: bukas",
  "Alert sound off": "Tunog ng alerto: patay",
  "Select request": "Piliin ang kahilingan",
  "Released To": "Naibigay Kay",
  "Remarks": "Puna",
  "EMERGENCY ALERT": "ALERTO NG EMERGENCY",
  "Minimize": "I-minimize",
  "Type": "Uri",
  "Date & Time": "Petsa at Oras",
  "Description": "Paglalarawan",
  "Safety Instructions": "Mga Tagubilin sa Kaligtasan",
  "STOP ALARM": "IHINTO ANG ALARMA",
  "REPEAT ANNOUNCEMENT": "ULITIN ANG ANUNSYO",
  "View Details": "Tingnan ang Detalye",
  "Alarm stopped.": "Huminto ang alarma.",
  "Alarm will stop automatically in": "Awtomatikong hihinto ang alarma sa loob ng",
  "seconds": "segundo",
  "Emergency": "Emergency",
  "Follow the instructions of your barangay officials.": "Sundin ang mga tagubilin ng inyong mga barangay official.",
  "Emergency broadcast published.": "Nailathala ang emergency broadcast.",
  "Emergency broadcast resolved.": "Naresolba na ang emergency broadcast.",
  "No active emergency broadcasts.": "Walang aktibong emergency broadcast.",
  "Please enter an emergency title.": "Maglagay ng pamagat ng emergency.",
  "Please describe the emergency.": "Ilarawan ang emergency.",
  "All Barangays": "Lahat ng Barangay",
  "RESOLVE": "TAPUSIN",
  "expires": "mag-eexpire",
  "Flood": "Baha",
  "Earthquake": "Lindol",
  "Typhoon": "Bagyo",
  "Security / Crime": "Seguridad / Krimen",
  "Save": "I-save",
  "Saved": "Naka-save",
  "Saved.": "Nai-save.",
  "Removed from saved.": "Inalis sa naka-save.",
  "Member": "Miyembro",
  "Posted by": "Ipinost ni",
  "Item": "Item",
  "Lost Item": "Nawawalang Bagay",
  "Found Item": "Nakita Na Bagay",
  "Community Share": "Ibinahaging Post",
  "posts": "post",
  "shares": "share",
  "Community Feed": "Community Feed",
  "Create a Post": "Gumawa ng Post",
  "Post Type": "Uri ng Post",
  "Item Type": "Uri ng Bagay",
  "Title": "Pamagat",
  "Last Seen / Found At": "Huling Nakita / Natagpuan Sa",
  "Contact Info": "Impormasyon sa Kontak",
  "Photos (up to 4)": "Mga Larawan (hanggang 4)",
  "POST TO COMMUNITY": "I-POST SA KOMUNIDAD",
  "Remove": "Alisin",
  "Log in to react.": "Mag-login upang mag-react.",
  "Log in to save.": "Mag-login upang mag-save.",
  "Please sign in to post.": "Mag-sign in upang mag-post.",
  "Please write something to share.": "Magsulat ng ibabahagi.",
  "Please add a title for the item.": "Maglagay ng pamagat ng bagay.",
  "Posted to the community feed.": "Nai-post sa community feed.",
  "No community posts yet. Be the first to share!": "Wala pang post sa komunidad. Ikaw ang mauna!",
  "No community posts.": "Walang post sa komunidad.",
  "Post hidden from the feed.": "Naitago ang post sa feed.",
  "Post is visible again.": "Muling makikita ang post.",
  "Post deleted.": "Na-delete ang post.",
  "Visible": "Nakikita",
  "Hidden": "Nakatago",
  "UNHIDE": "IPAKITA",
  "ALERT COMMUNITY": "ALERTUHAN ANG KOMUNIDAD",
  "Send Community Alert": "Magpadala ng Alerto sa Komunidad",
  "Send to": "Ipadala sa",
  "Message": "Mensahe",
  "SEND ALERT": "IPADALA ANG ALERTO",
  "Community alert sent.": "Naipadala ang alerto sa komunidad.",
  "Please be on the lookout for this lost item.": "Bantayan ang nawawalang bagay na ito.",
  "Please be on the lookout for this item.": "Bantayan ang bagay na ito.",
  "No active community alerts.": "Walang aktibong alerto sa komunidad.",
  "Alert cleared.": "Naalis ang alerto.",
  "CLEAR": "ALISIN",
  "Dismiss": "Isara",
  "All Types": "Lahat ng Uri",
  "Mobile Phone": "Cellphone",
  "Wallet": "Pitaka",
  "ID / Documents": "ID / Dokumento",
  "Keys": "Susi",
  "Bag": "Bag",
  "Jewelry": "Alahas",
  "Pet": "Alagang Hayop",
  "Bicycle": "Bisikleta",
  "Other": "Iba pa",
  "Lost & Found": "Nawala at Natagpuan",
  "No lost or found items reported yet.": "Wala pang naiulat na nawala o natagpuang bagay.",
  "VIEW ALL": "TINGNAN LAHAT",
  "Quick Actions": "Mabilisang Aksyon",
  "Request Certificate": "Humiling ng Sertipiko",
  "View Website": "Tingnan ang Website",
  "Delete my post": "I-delete ang post ko",
  "Delete": "I-delete",
  "Post options": "Mga opsyon sa post",
  "Edit post": "I-edit ang post",
  "Delete post": "I-delete ang post",
  "Edit Post": "I-edit ang Post",
  "Post updated.": "Na-update ang post.",
  "You can only edit your own posts.": "Maaari mo lamang i-edit ang sarili mong post.",
  "DELETE MY POST": "I-DELETE ANG POST KO",
  "You can only delete your own posts.": "Maaari mo lamang i-delete ang sarili mong post.",
  "Delete this post? This cannot be undone.": "I-delete ang post na ito? Hindi na ito maibabalik.",
  "Community Updates": "Mga Update sa Komunidad",
  "Read the news and announcements posted by the admin.": "Basahin ang mga balita at anunsyong inilathala ng admin.",
  "No community announcements posted yet.": "Wala pang anunsyong naipost sa komunidad.",
  "Update your name, photo, contact details, and password.": "I-update ang iyong pangalan, larawan, detalye ng contact, at password.",
  "Username cannot be changed here. Ask the admin to rename it.": "Hindi mababago ang username dito. Ipaalam sa admin upang palitan ito.",
  "Sign in to comment, join events, and see updates.": "Mag-sign in upang magkomento, sumali sa mga kaganapan, at makita ang mga update."
};

var currentLang = localStorage.getItem("communityLang") === "fil" ? "fil" : "en";

function t(key) {
  if (typeof currentLang === "undefined" || currentLang !== "fil") return key;
  if (typeof I18N_MAP === "undefined") return key;
  return I18N_MAP[key] || key;
}

function walkI18nText() {
  var textSelectors = [
    ".topbar a", ".topbar span", ".main-nav a",
    ".hero h1", ".hero p", ".hero .btn",
    ".section-title", ".section-subtitle",
    ".page-header h1", ".page-header p", ".page-header .breadcrumb a", ".page-header .breadcrumb span",
    ".site-footer h4", ".site-footer li a", ".site-footer .footer-grid > div > p",
    ".quick-link h4", ".quick-link p",
    ".filter-btn", ".search-box label", ".filter-select option",
    ".empty-state p",
    ".sidebar-label", ".admin-sidebar a", ".admin-user .logo-text span",
    ".notif-panel-head strong", ".notif-view-all", ".notif-mark-all", ".cal-nav",
    ".dash-settings-head strong", ".dash-settings-label",
    ".header-account-item",
    ".admin-page-title", ".admin-page-sub", ".profile-section-label",
    ".stat-label", ".form-box > h3", ".form-box h3",
    ".user-welcome h2", ".user-welcome p",
    ".data-table th", "main label", "main option", ".alert",
    ".chat-chip", ".chat-top h2", ".chat-top p", "#chatClearBtn",
    ".chat-hero h2", ".chat-hero p", ".chat-note", ".chat-input label",
    ".about-eyebrow", ".about-hero-sub", ".about-stat strong", ".about-stat span",
    ".about-purpose h2", ".mv-card h3", ".about-feature h3", ".about-feature p",
    ".team-card h4", ".team-card p", ".about-cta h3", ".about-cta p"
  ].join(", ");

  // Containers filled by JavaScript: their text is translated with t()
  // at render time, so the walker must never touch them.
  var skip = "#newsList, #announcementsList, #eventsList, #activitiesList, " +
    "#homeLatestNews, #homeAnnouncements, #homeEvents, #homeActivities, " +
    "#dashNewsList, #dashAnnouncementsList, #dashEventsList, #dashActivitiesList, " +
    "#dashGalleryGrid, #dashSavedList, #dashNotifications, #dashLatestAnnouncement, " +
    "#dashNextEvent, [id$='TableBody'], .modal-overlay, .toast-host, " +
    "#emergencyBanner, #weatherCard, #commentsBox, #dashWelcome, " +
    ".notif-panel-list, #adminNotifList, #userNotifList, #officialNotifList, #globalSearchResults, " +
    "#calTitle, #calWeek, #calGrid, #adminCommentThreads, #auditLogList, " +
    "#offRecentRequests";

  function walkElement(el) {
    if (el.closest(skip)) return;
    if (el.children.length === 0) {
      // Simple element: swap the whole text
      if (!el.dataset.en) el.dataset.en = el.textContent;
      var original = el.dataset.en;
      el.textContent = currentLang === "fil" ? (I18N_MAP[original] || original) : original;
      return;
    }
    // Element with children (e.g. sidebar links with icon spans):
    // translate each text node while remembering the English original.
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.__en === undefined) node.__en = node.nodeValue;
      var orig = node.__en;
      var key = orig.trim();
      if (!key) continue;
      var lead = orig.match(/^\s*/)[0];
      var trail = orig.match(/\s*$/)[0];
      node.nodeValue = lead + (currentLang === "fil" ? (I18N_MAP[key] || key) : key) + trail;
    }
  }

  document.querySelectorAll(textSelectors).forEach(walkElement);

  document.querySelectorAll("section input[placeholder], section textarea[placeholder], main input[placeholder], main textarea[placeholder]")
    .forEach(function (el) {
      if (el.closest(skip)) return;
      if (!el.dataset.enPh) el.dataset.enPh = el.placeholder;
      var original = el.dataset.enPh;
      el.placeholder = currentLang === "fil" ? (I18N_PH[original] || original) : original;
    });
}

// The Go Live studio sits inside .modal-overlay (skipped by the walker) and the
// user live card uses dynamic ids, so neither is reached by walkI18nText().
// Restore the stored English original first, then translate only in FIL mode.
function applyLiveStudioLang() {
  var textIds = [
    "liveStudioTitle", "livePreviewPh", "liveEnableBtn", "liveKeepRecLabel",
    "liveStartBtn", "liveStopBtn", "liveCtaHint", "liveArchiveHead",
    "liveArchiveNote"
  ];
  textIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!el.dataset.en) el.dataset.en = el.textContent;
    el.textContent = t(el.dataset.en);
  });
  // The archive list is re-rendered by renderLiveArchiveList(), so only its
  // heading and empty-state note are handled here.
  [["liveTitle", "Live Stream Title"], ["liveDescription", "Description"],
   ["liveCategory", "Category"]].forEach(function (pair) {
    var lbl = document.querySelector('label[for="' + pair[0] + '"]');
    if (!lbl) return;
    if (!lbl.dataset.en) lbl.dataset.en = lbl.textContent;
    lbl.textContent = t(lbl.dataset.en);
  });
}

function refreshPublicLists() {
  if (document.getElementById("homeLatestNews")) renderHomePage();
  if (document.getElementById("newsList")) filterNews();
  if (document.getElementById("announcementsList")) {
    var active = document.querySelector("#annFilters .filter-btn.active");
    filterAnnouncements(active ? active.getAttribute("data-category") : "All");
  }
  if (document.getElementById("eventsList")) {
    document.getElementById("eventsList").innerHTML =
      loadEventsList().map(renderEventPageCard).join("");
    updateCountdowns();
    if (eventsCalState && eventsCalState.view === "calendar") renderEventsCalendar();
  }
  if (document.getElementById("activitiesList")) {
    var actListBox = document.getElementById("activitiesList");
    actListBox.innerHTML = loadActivitiesList().map(renderActivityPageCard).join("");
    resolveVideoRefs(actListBox);
  }
  if (document.getElementById("weatherCard")) renderWeatherCard();
  renderEmergencyBanner();
}

// Re-render the admin panel with the current language
function refreshAdminPanels() {
  if (typeof renderNewsTable === "function") renderNewsTable();
  if (typeof renderAnnTable === "function") renderAnnTable();
  if (typeof renderEventTable === "function") renderEventTable();
  if (typeof renderActivityTable === "function") renderActivityTable();
  if (typeof renderGalleryTable === "function") renderGalleryTable();
  if (typeof renderUserTable === "function") renderUserTable();
  if (typeof renderOfficialsTable === "function") renderOfficialsTable();
  if (typeof renderAdminPosts === "function") renderAdminPosts();
  if (typeof renderCommunityAlertsAdmin === "function") renderCommunityAlertsAdmin();
  if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
  if (typeof updateDashboardStats === "function") updateDashboardStats();
  if (typeof renderAdminCharts === "function") renderAdminCharts();

  var forms = [
    ["newsEditingId", "newsFormTitle", "newsSubmitBtn", "Add News", "Edit News", "ADD NEWS", "UPDATE NEWS"],
    ["annEditingId", "annFormTitle", "annSubmitBtn", "Add Announcement", "Edit Announcement", "ADD ANNOUNCEMENT", "UPDATE ANNOUNCEMENT"],
    ["eventEditingId", "eventFormTitle", "eventSubmitBtn", "Add Event", "Edit Event", "ADD EVENT", "UPDATE EVENT"],
    ["activityEditingId", "activityFormTitle", "activitySubmitBtn", "Add Activity", "Edit Activity", "ADD ACTIVITY", "UPDATE ACTIVITY"],
    ["galleryEditingId", "galleryFormTitle", "gallerySubmitBtn", "Add Photo", "Edit Photo", "ADD PHOTO", "UPDATE PHOTO"],
    ["officialEditingId", "officialFormTitle", "officialSubmitBtn", "Add Barangay Official", "Edit Barangay Official", "ADD OFFICIAL", "SAVE CHANGES"]
  ];
  forms.forEach(function (f) {
    var editing = typeof window[f[0]] !== "undefined" && window[f[0]];
    var title = document.getElementById(f[1]);
    var btn = document.getElementById(f[2]);
    if (title) title.textContent = t(editing ? f[4] : f[3]);
    if (btn) btn.textContent = t(editing ? f[6] : f[5]);
  });
}

function updateLangButtons() {
  // Simple SVG flags (emoji flags don't render on Windows).
  // English mode → PH flag (switch to Filipino); Filipino mode → US flag (switch to English).
  var phFlag =
    '<svg viewBox="0 0 24 16" width="20" height="14" aria-hidden="true" focusable="false" style="display:block;vertical-align:middle;border-radius:2px">' +
    '<rect width="24" height="8" fill="#0038a8"/>' +
    '<rect y="8" width="24" height="8" fill="#ce1126"/>' +
    '<path d="M0 0 L10 8 L0 16 Z" fill="#fff"/>' +
    '<circle cx="3.2" cy="8" r="1.35" fill="#fcd116"/>' +
    '<circle cx="1.1" cy="4.6" r="0.55" fill="#fcd116"/>' +
    '<circle cx="1.1" cy="11.4" r="0.55" fill="#fcd116"/>' +
    '<circle cx="5.8" cy="3.2" r="0.55" fill="#fcd116"/>' +
    '<circle cx="5.8" cy="12.8" r="0.55" fill="#fcd116"/>' +
    "</svg>";
  var usFlag =
    '<svg viewBox="0 0 24 16" width="20" height="14" aria-hidden="true" focusable="false" style="display:block;vertical-align:middle;border-radius:2px">' +
    '<rect width="24" height="16" fill="#fff"/>' +
    '<path fill="#b22234" d="M0 0h24v1.23H0zm0 2.46h24v1.23H0zm0 2.46h24v1.23H0zm0 2.46h24v1.23H0zm0 2.46h24v1.23H0zm0 2.46h24v1.23H0zm0 2.46h24v1.23H0z"/>' +
    '<rect width="10" height="8.61" fill="#3c3b6e"/>' +
    '<g fill="#fff">' +
    '<circle cx="1.5" cy="1.4" r="0.55"/><circle cx="3.9" cy="1.4" r="0.55"/><circle cx="6.3" cy="1.4" r="0.55"/><circle cx="8.7" cy="1.4" r="0.55"/>' +
    '<circle cx="2.7" cy="2.85" r="0.55"/><circle cx="5.1" cy="2.85" r="0.55"/><circle cx="7.5" cy="2.85" r="0.55"/>' +
    '<circle cx="1.5" cy="4.3" r="0.55"/><circle cx="3.9" cy="4.3" r="0.55"/><circle cx="6.3" cy="4.3" r="0.55"/><circle cx="8.7" cy="4.3" r="0.55"/>' +
    '<circle cx="2.7" cy="5.75" r="0.55"/><circle cx="5.1" cy="5.75" r="0.55"/><circle cx="7.5" cy="5.75" r="0.55"/>' +
    '<circle cx="1.5" cy="7.2" r="0.55"/><circle cx="3.9" cy="7.2" r="0.55"/><circle cx="6.3" cy="7.2" r="0.55"/><circle cx="8.7" cy="7.2" r="0.55"/>' +
    "</g></svg>";
  var html = currentLang === "fil" ? usFlag : phFlag;
  var label = currentLang === "fil" ? "Switch to English" : "Palitan ang wika sa Filipino";
  ["langToggleBtn", "langToggleBtnDash"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.innerHTML = html;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  });
}

function applyLang() {
  updateLangButtons();
  if (typeof updateThemeButtons === "function") updateThemeButtons();
  if (document.querySelector(".login-page")) return;

  walkI18nText();
  applyLiveStudioLang();
  renderBottomNav();
  injectHotlinesLinks();
  renderHotlinesPage();
  refreshPublicLists();

  if (document.body.classList.contains("user-body") &&
      typeof renderUserDashboardContent === "function") {
    renderUserDashboardContent();
  }
  if (typeof renderCommunityFeed === "function") renderCommunityFeed();
  if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
  if (document.body.classList.contains("admin-body") &&
      typeof refreshAdminPanels === "function") {
    refreshAdminPanels();
  }
  if (document.body.classList.contains("official-body")) {
    if (typeof renderOfficialDashboardStats === "function") renderOfficialDashboardStats();
    if (typeof renderOfficialRequests === "function") renderOfficialRequests();
    if (typeof renderOfficialIncidents === "function") renderOfficialIncidents();
    if (typeof renderOfficialIncidentAnalytics === "function") renderOfficialIncidentAnalytics();
    if (typeof renderOfficialDutyUi === "function") renderOfficialDutyUi();
    if (typeof renderOfficialCommunity === "function") renderOfficialCommunity();
  }
  if (document.getElementById("detailModal")) refreshDetailModalLabels();
}

function toggleLang() {
  currentLang = currentLang === "fil" ? "en" : "fil";
  try { localStorage.setItem("communityLang", currentLang); } catch (e) {}
  applyLang();
}

/* ------------------------------------------------------------
   36. TOAST NOTIFICATIONS (replace browser alert/confirm popups)
   ------------------------------------------------------------ */

function showToast(message, type) {
  var host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  var toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "info");
  toast.setAttribute("role", "status");
  toast.textContent = message;
  host.appendChild(toast);
  void toast.offsetHeight; // force reflow so the entry transition plays
  toast.classList.add("show");
  setTimeout(function () {
    toast.classList.remove("show");
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 350);
  }, 3200);
}

/* ------------------------------------------------------------
   36a. GLOBAL SEARCH PAGE (search.html - every content type)
   ------------------------------------------------------------ */

function initGlobalSearchPage() {
  var input = document.getElementById("globalSearch");
  if (!input) return;

  // openLightbox() reads this shared list on the gallery page
  galleryItems = loadGalleryList();

  var state = { q: "", type: "all" };

  // Lists are loaded fresh on every search run so newly saved
  // content (from another tab or an admin edit) is found too.
  var specs = [
    {
      type: "news", label: "NEWS",
      keys: ["title", "category", "description", "details"],
      load: function () { return loadNewsList(); },
      make: function (n) {
        return { id: n.id, title: n.title, meta: formatDate(n.date) + " · " + n.category, desc: n.description };
      }
    },
    {
      type: "announcements", label: "ANNOUNCEMENTS",
      keys: ["title", "category", "description", "status"],
      load: function () { return loadAnnouncementsList(); },
      make: function (a) {
        return { id: a.id, title: a.title, meta: formatDate(a.date) + " · " + a.category, desc: a.description };
      }
    },
    {
      type: "events", label: "EVENTS",
      keys: ["name", "location", "description"],
      load: function () { return loadEventsList(); },
      make: function (e) {
        return { id: e.id, title: e.name, meta: formatDate(e.date) + " · " + e.location, desc: e.description };
      }
    },
    {
      type: "activities", label: "ACTIVITIES",
      keys: ["name", "location", "description"],
      load: function () { return loadActivitiesList(); },
      make: function (a) {
        return { id: a.id, title: a.name, meta: formatDate(a.date) + " · " + a.location, desc: a.description };
      }
    },
    {
      type: "gallery", label: "GALLERY",
      keys: ["caption"],
      load: function () {
        galleryItems = loadGalleryList();
        return galleryItems;
      },
      make: function (g, index) {
        return { id: index, title: g.caption, meta: formatDate(g.date), desc: "", galleryIndex: index };
      }
    }
  ];

  var resultsBox = document.getElementById("globalSearchResults");
  var emptyBox = document.getElementById("globalSearchEmpty");
  var emptyText = document.getElementById("globalSearchEmptyText");
  var countEl = document.getElementById("globalSearchCount");

  function textOf(item, keys) {
    return keys.map(function (k) { return String(item[k] || ""); }).join(" ").toLowerCase();
  }

  function syncChips() {
    document.querySelectorAll("#globalSearchTypes .filter-btn").forEach(function (btn) {
      var active = btn.getAttribute("data-type") === state.type;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function readHash() {
    if (location.hash.length <= 1) return;
    var params = new URLSearchParams(location.hash.slice(1));
    var q = params.get("q") || "";
    var type = params.get("type") || "all";
    if (q) input.value = q;
    if (type) state.type = type;
    state.q = q;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.type !== "all") params.set("type", state.type);
    var s = params.toString();
    try {
      history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : "#"));
    } catch (e) {}
  }

  function run() {
    var q = state.q.toLowerCase();
    countEl.textContent = "";

    if (!q) {
      resultsBox.innerHTML = "";
      emptyBox.style.display = "";
      emptyText.textContent = t("Type a keyword to search the whole community.");
      writeHash();
      return;
    }

    var groups = [];
    specs.forEach(function (spec) {
      if (state.type !== "all" && state.type !== spec.type) return;
      var matches = [];
      var items = spec.load();
      items.forEach(function (item, index) {
        if (textOf(item, spec.keys).indexOf(q) >= 0) matches.push(spec.make(item, index));
      });
      if (matches.length) groups.push({ spec: spec, matches: matches });
    });

    var total = groups.reduce(function (sum, g) { return sum + g.matches.length; }, 0);

    if (!total) {
      resultsBox.innerHTML = "";
      emptyBox.style.display = "";
      emptyText.textContent = t("No results found. Please try another search.");
      writeHash();
      return;
    }

    emptyBox.style.display = "none";
    countEl.textContent = total + " " + t(total === 1 ? "result" : "results");
    resultsBox.innerHTML = groups.map(function (g) {
      return '<div class="search-group">' +
        '<h4 class="search-group-head">' + t(g.spec.label) +
          ' <span class="meta">(' + g.matches.length + ")</span></h4>" +
        g.matches.map(function (m) {
          var kindAttr = g.spec.type === "gallery"
            ? ' data-index="' + m.galleryIndex + '"'
            : ' data-id="' + escapeHtml(String(m.id)) + '"';
          return '<button type="button" class="search-result" data-kind="' + g.spec.type + '"' + kindAttr + ">" +
            "<strong>" + highlightText(m.title, state.q) + "</strong>" +
            '<span class="search-result-meta meta">' + escapeHtml(m.meta) + "</span>" +
            (m.desc ? '<span class="search-result-desc">' + highlightText(shortText(m.desc, 140), state.q) + "</span>" : "") +
          "</button>";
        }).join("") +
      "</div>";
    }).join("");
    writeHash();
  }

  input.addEventListener("input", function () {
    state.q = input.value.trim();
    run();
  });

  var typesBar = document.getElementById("globalSearchTypes");
  if (typesBar) {
    typesBar.addEventListener("click", function (event) {
      var btn = event.target.closest(".filter-btn");
      if (!btn) return;
      state.type = btn.getAttribute("data-type") || "all";
      syncChips();
      run();
    });
  }

  // Click a result to open its detail modal right on this page
  if (resultsBox) {
    resultsBox.addEventListener("click", function (event) {
      var btn = event.target.closest(".search-result");
      if (!btn) return;
      var kind = btn.getAttribute("data-kind");
      var id = btn.getAttribute("data-id");
      if (kind === "news") showNewsDetails(id);
      else if (kind === "announcements") showAnnouncementDetails(id);
      else if (kind === "events") showEventDetails(id);
      else if (kind === "activities") showActivityDetails(id);
      else if (kind === "gallery") openLightbox(parseInt(btn.getAttribute("data-index"), 10) || 0);
    });
  }

  readHash();
  syncChips();
  run();
}

initGlobalSearchPage();

/* ------------------------------------------------------------
   36b. BACK-TO-TOP FLOATING BUTTON (every page)
   ------------------------------------------------------------ */

function initBackToTop() {
  if (document.querySelector(".back-to-top")) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "back-to-top";
  btn.id = "backToTop";
  btn.setAttribute("aria-label", t("Back to top"));
  btn.title = t("Back to top");
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  btn.addEventListener("click", function () {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  document.body.appendChild(btn);

  function onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    btn.classList.toggle("visible", y > 400);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ------------------------------------------------------------
   37. FINAL STARTUP - features that run after everything loads
   ------------------------------------------------------------ */

renderEmergencyBanner();
renderWeatherCard();
renderSavedSection();
runMigrations();
initTheme();
initAdminSettingsModal();
applyAdminSettingsChrome();
applyLang();
initPwa();
initBackToTop();

/* ------------------------------------------------------------
   38. GO LIVE - real camera + microphone broadcasting
   The admin captures camera/mic with getUserMedia, records it with
   MediaRecorder, and streams encoded chunks to every viewer in real
   time. Transport is dual: a WebSocket relay (server.js) carries the
   stream across devices on the network; a BroadcastChannel carries it
   within the same browser as a zero-setup fallback. User dashboards
   play chunks live through MediaSource, so viewers see and hear the
   admin in real time - the LIVE badge, viewer count, and duration are
   driven by the same channel messages, and the broadcast ends
   automatically if the admin tab closes. Recordings can be archived
   in IndexedDB through the existing video store.
   ------------------------------------------------------------ */

var LIVE_CHANNEL_NAME = "cc-live-v1";
var LIVE_RELAY_PATH = "/live";
var LIVE_TIMESLICE_MS = 1000;      // stream a chunk every second
var LIVE_STALL_MS = 6000;          // no messages for this long = offline
var LIVE_VIEWER_TIMEOUT_MS = 6000; // viewer heartbeat expiry
var LIVE_MAX_APPEND_QUEUE = 30;    // cap buffered chunks on slow devices

// ---- transport: WebSocket relay when available, BroadcastChannel fallback ----
var liveBus = {
  bc: null,
  ws: null,
  wsOpen: false,
  listeners: [],
  reconnectTimer: null,
  openCallbacks: [],
  ready: false
};

function liveRelayUrl() {
  // Served over http(s) by server.js -> same host; opened via file:// -> local relay.
  try {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + LIVE_RELAY_PATH;
    }
  } catch (e) {}
  var custom = "";
  try { custom = localStorage.getItem("ccLiveRelay") || ""; } catch (e) {}
  return custom || "ws://localhost:8787/live";
}

function liveBusEmit(data) {
  liveBus.listeners.forEach(function (fn) {
    try { fn(data); } catch (e) {}
  });
}

function liveBusInit() {
  if (liveBus.ready) return;
  liveBus.ready = true;
  try {
    liveBus.bc = new BroadcastChannel(LIVE_CHANNEL_NAME);
    liveBus.bc.onmessage = function (ev) { liveBusEmit(ev.data); };
  } catch (e) { liveBus.bc = null; }
  liveBusConnect();
}

function liveBusConnect() {
  if (liveBus.ws) {
    try { liveBus.ws.close(); } catch (e) {}
    liveBus.ws = null;
  }
  liveBus.wsOpen = false;
  if (typeof WebSocket === "undefined") return;
  var url;
  try { url = liveRelayUrl(); } catch (e) { return; }
  var ws;
  try { ws = new WebSocket(url); } catch (e) { liveBusScheduleReconnect(); return; }
  ws.binaryType = "arraybuffer";
  liveBus.ws = ws;
  ws.onopen = function () {
    liveBus.wsOpen = true;
    liveBus.openCallbacks.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  };
  ws.onmessage = function (ev) {
    if (typeof ev.data === "string") {
      try { liveBusEmit(JSON.parse(ev.data)); } catch (e) {}
      return;
    }
    // Binary frame: "C|" + chunk, or "H|" + viewerId + "|" + header chunk.
    var bytes = new Uint8Array(ev.data);
    var kind = bytes.length > 0 ? String.fromCharCode(bytes[0]) : "";
    if (kind === "C") {
      liveBusEmit({ t: "chunk", data: ev.data.slice(2) });
    } else if (kind === "H") {
      var end = 2;
      while (end < bytes.length && bytes[end] !== 124) end++; // 124 = "|"
      var to = "";
      for (var i = 2; i < end; i++) to += String.fromCharCode(bytes[i]);
      liveBusEmit({ t: "header", to: to, data: ev.data.slice(end + 1) });
    }
  };
  ws.onclose = function () {
    liveBus.wsOpen = false;
    if (liveBus.ws === ws) liveBus.ws = null;
    liveBusScheduleReconnect();
  };
  ws.onerror = function () {
    try { ws.close(); } catch (e) {}
  };
}

function liveBusScheduleReconnect() {
  if (liveBus.reconnectTimer) return;
  liveBus.reconnectTimer = setTimeout(function () {
    liveBus.reconnectTimer = null;
    liveBusConnect();
  }, 5000);
}

function liveBusOn(fn) {
  liveBus.listeners.push(fn);
}

function liveBusOnOpen(fn) {
  liveBus.openCallbacks.push(fn);
}

// Control messages: JSON text over WebSocket when connected, else BroadcastChannel.
function liveBusSend(msg) {
  if (liveBus.wsOpen && liveBus.ws) {
    try { liveBus.ws.send(JSON.stringify(msg)); return; } catch (e) {}
  }
  if (liveBus.bc) {
    try { liveBus.bc.postMessage(msg); } catch (e) {}
  }
}

// Media payloads: raw binary over WebSocket, structured-clone over BroadcastChannel.
function liveBusSendBinary(buf, kind, targetId) {
  if (liveBus.wsOpen && liveBus.ws) {
    try {
      var prefix;
      if (kind === "H") {
        var id = String(targetId || "");
        prefix = new Uint8Array(2 + id.length + 1);
        prefix[0] = 72; // H
        prefix[1] = 124; // |
        for (var i = 0; i < id.length; i++) prefix[2 + i] = id.charCodeAt(i) & 0xff;
        prefix[2 + id.length] = 124; // |
      } else {
        prefix = new Uint8Array([67, 124]); // C|
      }
      var body = new Uint8Array(buf);
      var out = new Uint8Array(prefix.length + body.length);
      out.set(prefix, 0);
      out.set(body, prefix.length);
      liveBus.ws.send(out);
      return;
    } catch (e) {}
  }
  if (liveBus.bc) {
    try {
      if (kind === "H") liveBus.bc.postMessage({ t: "header", to: targetId, data: buf });
      else liveBus.bc.postMessage({ t: "chunk", data: buf });
    } catch (e) {}
  }
}

function formatLiveDuration(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec || 0));
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

function loadLiveArchive() {
  return getData("communityLiveArchive", []);
}
function saveLiveArchiveList(list) {
  return setData("communityLiveArchive", list);
}

// ---------- ADMIN: Go Live studio ----------
function initAdminLiveStudio() {
  if (!document.body.classList.contains("admin-body")) return;
  var goBtn = document.getElementById("liveGoBtn");
  if (!goBtn) return;

  var studio = document.getElementById("liveStudio");
  var preview = document.getElementById("livePreview");
  var previewPh = document.getElementById("livePreviewPh");
  var enableBtn = document.getElementById("liveEnableBtn");
  var errorBox = document.getElementById("liveError");
  var titleEl = document.getElementById("liveTitle");
  var descEl = document.getElementById("liveDescription");
  var catEl = document.getElementById("liveCategory");
  var keepRecEl = document.getElementById("liveKeepRec");
  var startBtn = document.getElementById("liveStartBtn");
  var stopBtn = document.getElementById("liveStopBtn");
  var badge = document.getElementById("liveStudioBadge");
  var statusEl = document.getElementById("liveStudioStatus");
  var viewersEl = document.getElementById("liveStudioViewers");
  var durationEl = document.getElementById("liveStudioDuration");
  var closeBtn = document.getElementById("liveCloseBtn");
  var ctaHint = document.getElementById("liveCtaHint");

  var state = {
    stream: null, recorder: null, parts: [], mime: "",
    session: null, live: false,
    viewers: {}, peakViewers: 0, tickTimer: null, countTimer: null,
    firstChunk: null, remoteLiveAt: 0, lastTitle: ""
  };

  liveBusInit();

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }
  function clearError() {
    if (errorBox) { errorBox.textContent = ""; errorBox.classList.add("hidden"); }
  }

  function describeMediaError(err) {
    var name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return t("Camera access was denied. Please allow the camera and microphone, then try again.");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return t("No camera or microphone was found on this device.");
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return t("Could not use the camera or microphone. It may be in use by another app.");
    }
    return t("Could not use the camera or microphone. It may be in use by another app.");
  }

  function setPreviewVisible(on) {
    if (preview) {
      if (on) preview.classList.add("show");
      else preview.classList.remove("show");
    }
    if (previewPh) previewPh.classList.toggle("hidden", on);
    if (enableBtn) enableBtn.classList.toggle("hidden", on);
  }

  function enableCamera() {
    clearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(t("Live broadcasting is not supported in this browser. Please use Chrome or Edge."));
      return Promise.resolve(false);
    }
    // Modest defaults keep bandwidth reasonable on slower connections.
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      state.stream = stream;
      if (preview) preview.srcObject = stream;
      setPreviewVisible(true);
      return true;
    }).catch(function (err) {
      showError(describeMediaError(err));
      setPreviewVisible(false);
      return false;
    });
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return "";
    var candidates = [
      'video/webm;codecs="vp8,opus"',
      'video/webm;codecs="vp9,opus"',
      "video/webm;codecs=h264,opus",
      "video/webm",
      "video/mp4"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function postMsg(msg) { liveBusSend(msg); }

  function liveViewerIds() {
    var now = Date.now();
    return Object.keys(state.viewers).filter(function (id) {
      return now - state.viewers[id] < LIVE_VIEWER_TIMEOUT_MS;
    });
  }

  function updateViewerDisplay() {
    var n = liveViewerIds().length;
    if (state.live) state.peakViewers = Math.max(state.peakViewers, n);
    if (viewersEl) viewersEl.textContent = n + " " + t("viewers");
    if (state.live) postMsg({ t: "count", n: n });
  }

  function updateDurationDisplay() {
    var sec = state.session ? (Date.now() - state.session.startedAt) / 1000 : 0;
    var text = formatLiveDuration(sec);
    if (durationEl) durationEl.textContent = text;
    if (ctaHint && state.live) {
      ctaHint.textContent = t("On Air") + " · " + liveViewerIds().length + " " + t("viewers") + " · " + text;
    }
  }

  function setLiveUi(on) {
    if (badge) badge.classList.toggle("hidden", !on);
    if (statusEl) statusEl.textContent = on ? t("On Air") : t("Offline");
    if (startBtn) startBtn.classList.toggle("hidden", on);
    if (stopBtn) stopBtn.classList.toggle("hidden", !on);
    [titleEl, descEl, catEl].forEach(function (el) { if (el) el.disabled = on; });
    if (ctaHint && !on) {
      ctaHint.textContent = t("Broadcast to the community in real time.");
    }
  }

  function startBroadcast() {
    var title = titleEl ? titleEl.value.trim() : "";
    if (!title) {
      showToast(t("Please enter a title for the live stream."), "error");
      if (titleEl) titleEl.focus();
      return;
    }
    if (Date.now() - state.remoteLiveAt < 5000) {
      showToast(t("Another broadcast is already running. End it before starting a new one."), "error");
      return;
    }
    if (!state.stream) {
      enableCamera().then(function (ok) {
        if (ok) startBroadcast();
      });
      return;
    }
    var mime = pickRecorderMime();
    if (!mime) {
      showError(t("Live broadcasting is not supported in this browser. Please use Chrome or Edge."));
      return;
    }
    clearError();
    state.parts = [];
    state.firstChunk = null;
    state.mime = mime;
    state.session = {
      id: "L" + Date.now() + Math.floor(Math.random() * 1000),
      title: title,
      description: descEl ? descEl.value.trim() : "",
      category: catEl ? catEl.value : "Community",
      startedAt: Date.now()
    };
    state.lastTitle = title;
    state.viewers = {};
    state.peakViewers = 0;
    try {
      state.recorder = new MediaRecorder(state.stream, { mimeType: mime });
    } catch (e) {
      showError(t("Live broadcasting is not supported in this browser. Please use Chrome or Edge."));
      return;
    }
    state.recorder.ondataavailable = function (ev) {
      if (!ev.data || !ev.data.size) return;
      state.parts.push(ev.data);
      if (!state.firstChunk) state.firstChunk = ev.data; // webm header for late joiners
      ev.data.arrayBuffer().then(function (buf) {
        liveBusSendBinary(buf, "C");
      }).catch(function () {});
    };
    state.recorder.onerror = function () {
      showToast(t("The broadcast was interrupted."), "error");
      stopBroadcast(true);
    };
    state.recorder.start(LIVE_TIMESLICE_MS);
    state.live = true;
    setLiveUi(true);
    updateDurationDisplay();
    updateViewerDisplay();
    postMsg({ t: "state", live: true, session: state.session, mime: state.mime });
    state.tickTimer = setInterval(updateDurationDisplay, 1000);
    state.countTimer = setInterval(updateViewerDisplay, 2000);
    showToast(t("Broadcast is live."), "success");
    logAudit("started live stream", title);
    notifyAdmin("live", localStorage.getItem("adminName") || "admin", { targetTitle: title });
  }

  function finalizeRecording() {
    if (!state.parts.length) return Promise.resolve("");
    var blob = new Blob(state.parts, { type: state.mime || "video/webm" });
    var meta = state.session || { title: state.lastTitle, description: "", category: "Community", startedAt: Date.now() };
    var durationSec = Math.max(1, Math.round((Date.now() - meta.startedAt) / 1000));
    var posterUrl = URL.createObjectURL(blob);
    return captureVideoPoster(posterUrl).then(function (poster) {
      URL.revokeObjectURL(posterUrl);
      return saveVideoBlob(blob).catch(function () { return ""; });
    }).then(function (ref) {
      if (!ref) return "";
      var rec = {
        id: generateId(),
        title: meta.title || t("Live broadcast"),
        description: meta.description || "",
        category: meta.category || "Community",
        startedAt: meta.startedAt,
        endedAt: Date.now(),
        durationSec: durationSec,
        peakViewers: state.peakViewers,
        videoRef: ref
      };
      if (poster) rec.poster = poster;
      var list = loadLiveArchive();
      list.unshift(rec);
      if (!saveLiveArchiveList(list)) { deleteVideoRef(ref); return ""; }
      return ref;
    });
  }

  function stopBroadcast(silent) {
    var wasLive = state.live;
    var title = state.lastTitle;
    if (state.recorder && state.recorder.state !== "inactive") {
      try { state.recorder.stop(); } catch (e) {}
    }
    state.recorder = null;
    var keepRec = keepRecEl ? keepRecEl.checked : true;
    if (wasLive && keepRec) {
      finalizeRecording().then(function (ref) {
        if (ref) {
          renderLiveArchiveList();
          showToast(t("Broadcast saved to Live Archives."), "success");
        }
      });
    }
    if (state.stream) {
      state.stream.getTracks().forEach(function (tr) { tr.stop(); });
      state.stream = null;
    }
    if (preview) preview.srcObject = null;
    setPreviewVisible(false);
    postMsg({ t: "end", sid: state.session ? state.session.id : "" });
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.countTimer) { clearInterval(state.countTimer); state.countTimer = null; }
    state.live = false;
    state.session = null;
    state.viewers = {};
    state.parts = [];
    state.firstChunk = null;
    setLiveUi(false);
    if (viewersEl) viewersEl.textContent = "0 " + t("viewers");
    if (durationEl) durationEl.textContent = "00:00";
    if (wasLive) {
      if (!silent) showToast(t("Broadcast ended."), "success");
      logAudit("ended live stream", title);
    }
  }

  function openStudio() {
    if (studio) { studio.classList.add("open"); studio.setAttribute("aria-hidden", "false"); }
    renderLiveArchiveList();
    if (!state.live && !state.stream) enableCamera();
  }
  function closeStudio() {
    if (studio) { studio.classList.remove("open"); studio.setAttribute("aria-hidden", "true"); }
    // Closing while live keeps broadcasting; only idle preview is released.
    if (!state.live && state.stream) {
      state.stream.getTracks().forEach(function (tr) { tr.stop(); });
      state.stream = null;
      if (preview) preview.srcObject = null;
      setPreviewVisible(false);
    }
  }

  liveBusOn(function (m) {
    if (m.t === "hello" || m.t === "join" || m.t === "ping") {
      if (m.viewerId) state.viewers[m.viewerId] = Date.now();
      if (state.live && m.t !== "ping") {
        // A viewer that opens after the broadcast started missed the original
        // "state" announcement, so re-send it, then the webm header chunk the
        // live chunks depend on.
        postMsg({ t: "state", live: true, session: state.session, mime: state.mime });
        if (state.firstChunk) {
          state.firstChunk.arrayBuffer().then(function (buf) {
            liveBusSendBinary(buf, "H", m.viewerId);
          }).catch(function () {});
        }
      }
      updateViewerDisplay();
    } else if (m.t === "state" && m.live) {
      state.remoteLiveAt = Date.now(); // another tab is already live
    }
  });

  // If the admin tab closes or navigates away, viewers must not hang.
  window.addEventListener("pagehide", function () {
    if (state.live) stopBroadcast(true);
  });

  goBtn.addEventListener("click", openStudio);
  if (closeBtn) closeBtn.addEventListener("click", closeStudio);
  if (enableBtn) enableBtn.addEventListener("click", enableCamera);
  if (startBtn) startBtn.addEventListener("click", startBroadcast);
  if (stopBtn) stopBtn.addEventListener("click", function () { stopBroadcast(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && studio && studio.classList.contains("open")) closeStudio();
  });

  setLiveUi(false);
}

// Archive playback / removal (admin studio list)
function playLiveArchive(id) {
  var rec = loadLiveArchive().find(function (r) { return r.id === id; });
  if (!rec) return;
  videoSrcFromRef(rec.videoRef).then(function (src) {
    if (!src) {
      showToast(t("This recording is no longer available."), "error");
      return;
    }
    var body =
      '<video class="detail-media-video" controls playsinline src="' + escapeHtml(src) + '"' +
      (rec.poster ? ' poster="' + escapeHtml(rec.poster) + '"' : '') + '></video>' +
      (rec.description ? '<p class="mt-20">' + escapeHtml(rec.description) + '</p>' : "");
    openDetailModal(rec.title, formatDate(rec.startedAt) + " · " + formatLiveDuration(rec.durationSec), body);
  });
}

function deleteLiveArchive(id) {
  var list = loadLiveArchive();
  var rec = list.find(function (r) { return r.id === id; });
  if (!rec) return;
  openConfirmModal("Delete this saved broadcast?", "DELETE", function () {
    saveLiveArchiveList(list.filter(function (r) { return r.id !== id; }));
    if (rec.videoRef) deleteVideoRef(rec.videoRef);
    renderLiveArchiveList();
    showToast(t("Broadcast deleted."), "success");
    logAudit("deleted live archive", rec.title);
  });
}

function renderLiveArchiveList() {
  var box = document.getElementById("liveArchiveList");
  if (!box) return;
  var list = loadLiveArchive();
  if (!list.length) {
    box.innerHTML = '<p class="meta">' + t("No saved broadcasts yet.") + "</p>";
    return;
  }
  box.innerHTML = list.map(function (r) {
    return '<div class="live-archive-item">' +
      '<div class="live-archive-info">' +
        "<strong>" + escapeHtml(r.title) + "</strong>" +
        '<span class="meta">' + formatDate(r.startedAt) + " · " + formatLiveDuration(r.durationSec) +
        " · " + (r.peakViewers || 0) + " " + t("viewers") + "</span>" +
      "</div>" +
      '<div class="live-archive-actions">' +
        '<button class="btn btn-small" type="button" onclick="playLiveArchive(\'' + r.id + "')\">" + t("PLAY") + "</button>" +
        '<button class="btn btn-small btn-danger" type="button" onclick="deleteLiveArchive(\'' + r.id + "')\">" + t("DELETE") + "</button>" +
      "</div>" +
    "</div>";
  }).join("");
}

// ---------- USER: live player on the dashboard ----------
function initUserLivePlayer() {
  var section = document.getElementById("liveSection");
  if (!section) return;

  var card = document.getElementById("liveCard");
  var player = document.getElementById("livePlayer");
  var overlay = document.getElementById("livePlayerOverlay");
  var overlayText = document.getElementById("liveOverlayText");
  var titleOut = document.getElementById("liveTitleOut");
  var descOut = document.getElementById("liveDescOut");
  var catOut = document.getElementById("liveCategoryOut");
  var viewersOut = document.getElementById("liveViewersOut");
  var durationOut = document.getElementById("liveDurationOut");

  var viewerId = sessionStorage.getItem("ccLiveViewerId");
  if (!viewerId) {
    viewerId = "v" + Date.now() + Math.floor(Math.random() * 1000000);
    sessionStorage.setItem("ccLiveViewerId", viewerId);
  }

  liveBusInit();

  var live = false;
  var session = null;
  var viewers = 0;
  var lastMsgAt = 0;
  var mediaSource = null;
  var sourceBuffer = null;
  var appendQueue = [];
  var objectUrl = null;
  var durationTimer = null;
  var watchdogTimer = null;
  var pingTimer = null;
  var seenHeader = false;

  function postMsg(msg) { liveBusSend(msg); }

  function showOverlay(text) {
    if (overlay) {
      if (text) {
        if (overlayText) overlayText.textContent = text;
        overlay.classList.remove("hidden");
      } else {
        overlay.classList.add("hidden");
      }
    }
  }

  // Dismiss the "connecting" overlay as soon as the stream has data and try to
  // start playback. Autoplay with live audio may need a user gesture, so the
  // native controls stay reachable for the viewer to press play.
  if (player) {
    var startLivePlayback = function () {
      if (!live) return;
      showOverlay("");
      var pr = player.play();
      if (pr && pr.catch) pr.catch(function () {});
    };
    player.addEventListener("loadeddata", startLivePlayback);
    player.addEventListener("canplay", startLivePlayback);
    player.addEventListener("playing", function () { if (live) showOverlay(""); });
  }

  function updateViewers() {
    if (viewersOut) viewersOut.textContent = viewers + " " + t("watching");
  }
  function updateDuration() {
    if (!durationOut) return;
    var sec = session ? (Date.now() - session.startedAt) / 1000 : 0;
    durationOut.textContent = formatLiveDuration(sec);
  }

  function teardown() {
    live = false;
    session = null;
    viewers = 0;
    appendQueue = [];
    sourceBuffer = null;
    seenHeader = false;
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (mediaSource) {
      try { if (mediaSource.readyState === "open") mediaSource.endOfStream(); } catch (e) {}
    }
    mediaSource = null;
    if (player) {
      try { player.removeAttribute("src"); player.load(); } catch (e) {}
    }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  function showOffline(toastMsg) {
    teardown();
    if (section) section.classList.add("hidden");
    if (card) card.classList.add("hidden");
    if (toastMsg) showToast(toastMsg, "error");
  }

  function pumpQueue() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    if (!appendQueue.length) return;
    try {
      sourceBuffer.appendBuffer(appendQueue.shift());
    } catch (e) {
      appendQueue = [];
    }
  }

  function enqueueChunk(data) {
    // Buffer pre-sourceopen data (notably the webm header) so nothing is lost
    // before the MediaSource is ready; pumpQueue flushes it in order.
    appendQueue.push(data);
    // Keep memory bounded on slow devices: keep the newest chunks.
    if (appendQueue.length > LIVE_MAX_APPEND_QUEUE) {
      appendQueue.splice(0, appendQueue.length - 10);
    }
    pumpQueue();
  }

  function setupPlayback(mime) {
    if (!window.MediaSource || !player) {
      showOverlay(t("Your browser cannot play live video. Please use Chrome or Edge."));
      return;
    }
    teardownBuffersOnly();
    mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);
    player.src = objectUrl;
    mediaSource.addEventListener("sourceopen", function () {
      var useMime = mime || 'video/webm;codecs="vp8,opus"';
      try {
        sourceBuffer = mediaSource.addSourceBuffer(useMime);
      } catch (e) {
        try { sourceBuffer = mediaSource.addSourceBuffer("video/webm"); } catch (e2) {
          showOverlay(t("Your browser cannot play live video. Please use Chrome or Edge."));
          return;
        }
      }
      sourceBuffer.addEventListener("updateend", pumpQueue);
      pumpQueue();
    });
  }
  function teardownBuffersOnly() {
    appendQueue = [];
    sourceBuffer = null;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  }

  function showLive(meta) {
    if (titleOut) titleOut.textContent = meta.title || t("Live broadcast");
    if (descOut) {
      descOut.textContent = meta.description || "";
      descOut.style.display = meta.description ? "" : "none";
    }
    if (catOut) catOut.textContent = meta.category || "Community";
    viewers = 0;
    updateViewers();
    updateDuration();
    if (section) section.classList.remove("hidden");
    if (card) card.classList.remove("hidden");
    showOverlay(t("Connecting to the live broadcast..."));
    if (durationTimer) clearInterval(durationTimer);
    durationTimer = setInterval(updateDuration, 1000);
  }

  function goLive(meta, mime) {
    if (live && session && meta && session.id === meta.id) return;
    teardown();
    session = meta;
    live = true;
    lastMsgAt = Date.now();
    showLive(meta);
    setupPlayback(mime);
    postMsg({ t: "join", viewerId: viewerId });
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(function () {
      if (!live) return;
      if (Date.now() - lastMsgAt > LIVE_STALL_MS) {
        showOffline(t("The broadcast was interrupted."));
      }
    }, 2000);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(function () {
      if (live) postMsg({ t: "ping", viewerId: viewerId });
    }, 3000);
  }

  liveBusOn(function (m) {
    if (!m || !m.t) return;
    lastMsgAt = Date.now();
    if (m.t === "state" && m.live && m.session) {
      goLive(m.session, m.mime || "");
    } else if (m.t === "header") {
      if (m.to && m.to !== viewerId) return;
      // Append the webm init segment exactly once, buffering it until the
      // SourceBuffer exists (otherwise live clusters fail to decode).
      if (live && !seenHeader) {
        seenHeader = true;
        enqueueChunk(m.data);
      }
    } else if (m.t === "chunk") {
      if (live && (!m.sid || !session || m.sid === session.id)) enqueueChunk(m.data);
    } else if (m.t === "count") {
      viewers = m.n | 0;
      updateViewers();
    } else if (m.t === "end") {
      if (!session || !m.sid || session.id === m.sid) {
        showOffline();
      }
    }
  });

  // If the WS relay connects after the first hello, re-announce so the
  // admin on another device learns about this viewer too.
  liveBusOnOpen(function () {
    postMsg({ t: "hello", viewerId: viewerId });
    if (live) postMsg({ t: "join", viewerId: viewerId });
  });

  // Ask any live admin for the current state, then stay hidden if none.
  postMsg({ t: "hello", viewerId: viewerId });
}

initAdminLiveStudio();
initUserLivePlayer();

/* ============================================================
   24. EMERGENCY BROADCAST
   The admin publishes an emergency alert to one barangay or all
   barangays. Residents and Barangay Officials of the affected
   barangay instantly get a prominent popup with a 30-second alarm
   and an AI voice reading the description. Each viewer can STOP
   ALARM on their own device without cancelling the broadcast, and
   the popup stays until the alert is resolved or expires.
   ============================================================ */

var EMERGENCY_KEY = "communityEmergencyAlerts";
var EMERGENCY_ALARM_SECONDS = 30;

var EMERGENCY_TYPES = [
  { key: "flood", label: "Flood" },
  { key: "fire", label: "Fire" },
  { key: "earthquake", label: "Earthquake" },
  { key: "typhoon", label: "Typhoon" },
  { key: "medical", label: "Medical Emergency" },
  { key: "security", label: "Security / Crime" },
  { key: "other", label: "Other Emergency" }
];

function emergencyTypeLabel(key) {
  var found = EMERGENCY_TYPES.filter(function (x) { return x.key === key; })[0];
  return found ? found.label : key;
}

function loadEmergencyAlerts() { return getData(EMERGENCY_KEY, []); }
function saveEmergencyAlerts(list) { return setData(EMERGENCY_KEY, list); }

function emergencyExpired(a) {
  return a && a.expiresAt && Date.now() > new Date(a.expiresAt).getTime();
}
function activeEmergencyAlerts() {
  return loadEmergencyAlerts().filter(function (a) { return !a.resolved && !emergencyExpired(a); });
}

// Emergencies fail open: if the viewer's own barangay is unknown, they still
// receive targeted alerts so nobody misses a warning.
function emergencyMatches(a, barangay) {
  if (!a || a.resolved || emergencyExpired(a)) return false;
  var target = normalizeBarangay(a.barangay);
  if (!target || target === "all") return true;
  var mine = normalizeBarangay(barangay);
  if (!mine) return true;
  return target === mine;
}

function residentBarangay() {
  var u = getSessionUser();
  return u ? (u.barangay || "") : "";
}

// The single active alert a viewer should currently see (newest first)
function currentEmergencyFor(barangay) {
  var list = activeEmergencyAlerts().filter(function (a) { return emergencyMatches(a, barangay); });
  list.sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
  return list[0] || null;
}

/* ---- Alarm (Web Audio siren) + AI voice (SpeechSynthesis) ---- */

var emergencyAlarm = { ctx: null, osc: null, gain: null, alt: null, stopTimer: null, tick: null, deadline: 0, running: false };
var emergencyCurrentAlert = null;
var emergencyCurrentId = null;

// True once the alarm has finished (naturally or via STOP) for the current
// alert in this tab, so the minimized top banner can auto-dismiss.
function emergencyAlarmIsDone() {
  if (emergencyAlarm.running) return false;
  if (!emergencyCurrentId) return false;
  try { return sessionStorage.getItem("ccEmergencyAlarm:" + emergencyCurrentId) === "1"; } catch (e) { return false; }
}

// Called when the alarm finishes (30s elapsed or STOP ALARM). The minimized top
// banner disappears now; the full popup (if open) stays until resolved/expired.
function onEmergencyAlarmFinished() {
  emergencyAlarm.running = false;
  var overlay = document.getElementById("emergencyOverlay");
  if (overlay && !overlay.hidden) return; // full popup is open: keep it visible
  if (emergencyCurrentId) {
    try { sessionStorage.setItem("ccEmergencyHidden:" + emergencyCurrentId, "1"); } catch (e) {}
  }
  var banner = document.getElementById("emergencyBanner");
  if (banner) banner.hidden = true;
}

function updateEmergencyCountdown(left) {
  var c = document.getElementById("emergencyCount");
  if (c) c.textContent = left;
  var tm = document.getElementById("emergencyTimer");
  if (tm) tm.textContent = "00:" + String(Math.max(0, left)).padStart(2, "0");
  var p = document.getElementById("emergencyProgress");
  if (p) p.style.width = (100 * (1 - Math.max(0, left) / EMERGENCY_ALARM_SECONDS)) + "%";
}

function stopEmergencyAlarm() {
  emergencyAlarm.running = false;
  if (emergencyAlarm.alt) { clearInterval(emergencyAlarm.alt); emergencyAlarm.alt = null; }
  if (emergencyAlarm.tick) { clearInterval(emergencyAlarm.tick); emergencyAlarm.tick = null; }
  if (emergencyAlarm.stopTimer) { clearTimeout(emergencyAlarm.stopTimer); emergencyAlarm.stopTimer = null; }
  try { if (emergencyAlarm.osc) { emergencyAlarm.osc.stop(); emergencyAlarm.osc.disconnect(); } } catch (e) {}
  try { if (emergencyAlarm.gain) emergencyAlarm.gain.disconnect(); } catch (e) {}
  emergencyAlarm.osc = null;
  emergencyAlarm.gain = null;
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  var bar = document.getElementById("emergencyAlarmBar");
  if (bar) bar.classList.add("done");
  var txt = document.getElementById("emergencyAlarmText");
  if (txt) txt.innerHTML = t("Alarm stopped.");
}

function startEmergencyAlarm(seconds) {
  stopEmergencyAlarm();
  emergencyAlarm.running = true;
  if (emergencyCurrentId) {
    try { sessionStorage.removeItem("ccEmergencyHidden:" + emergencyCurrentId); } catch (e) {}
  }
  var bar = document.getElementById("emergencyAlarmBar");
  if (bar) bar.classList.remove("done");
  var txt = document.getElementById("emergencyAlarmText");
  if (txt) txt.innerHTML = t("Alarm will stop automatically in") + " <b id=\"emergencyCount\">" + seconds + "</b> " + t("seconds");
  emergencyAlarm.deadline = Date.now() + seconds * 1000;

  // Two-tone siren
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      var ctx = emergencyAlarm.ctx || (emergencyAlarm.ctx = new Ctx());
      if (ctx.state === "suspended" && ctx.resume) { try { ctx.resume(); } catch (e) {} }
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      var now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.14, now + 0.05);
      gain.gain.setValueAtTime(0.14, now + Math.max(0.1, seconds - 0.15));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
      osc.frequency.setValueAtTime(700, now);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + seconds);
      emergencyAlarm.osc = osc;
      emergencyAlarm.gain = gain;
      var high = false;
      emergencyAlarm.alt = setInterval(function () {
        try { osc.frequency.setValueAtTime(high ? 700 : 1000, ctx.currentTime); } catch (e) {}
        high = !high;
      }, 450);
    }
  } catch (e) {}

  updateEmergencyCountdown(seconds);
  emergencyAlarm.tick = setInterval(function () {
    var left = Math.max(0, Math.round((emergencyAlarm.deadline - Date.now()) / 1000));
    updateEmergencyCountdown(left);
    if (left <= 0) { stopEmergencyAlarm(); onEmergencyAlarmFinished(); }
  }, 250);
  emergencyAlarm.stopTimer = setTimeout(function () {
    stopEmergencyAlarm();
    onEmergencyAlarmFinished();
  }, seconds * 1000);
}

function speakEmergency(alert) {
  if (!alert) return;
  try {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return;
    window.speechSynthesis.cancel();
    var text = alert.title + ". " + (alert.description || "");
    if (alert.location) text += " " + t("Location") + ": " + alert.location + ".";
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 1;
    u.volume = 1;
    u.lang = (typeof currentLang !== "undefined" && currentLang === "fil") ? "fil-PH" : "en-US";
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

/* ---- Viewer popup (injected on the member + official dashboards) ---- */

function emergencyWarningSvg(size) {
  return '<svg viewBox="0 0 24 24" width="' + (size || 22) + '" height="' + (size || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
}
function emergencyMegaphoneSvg(size) {
  return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
}
function emergencyPinSvg(size) {
  return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
}

function ensureEmergencyDom() {
  if (document.getElementById("emergencyOverlay")) return;
  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<div class="emergency-overlay" id="emergencyOverlay" hidden>' +
      '<div class="emergency-card" role="alertdialog" aria-modal="true" aria-labelledby="emergencyHeadTitle">' +
        '<div class="emergency-head">' +
          '<span class="emergency-head-icon" aria-hidden="true">' + emergencyWarningSvg(21) + "</span>" +
          '<h2 id="emergencyHeadTitle">' + t("EMERGENCY ALERT") + "</h2>" +
          '<button type="button" class="emergency-close" id="emergencyClose" aria-label="' + t("Minimize") + '">&times;</button>' +
        "</div>" +
        '<div class="emergency-content">' +
          '<div class="emergency-title-row">' +
            '<span class="emergency-icon" aria-hidden="true">' + emergencyMegaphoneSvg(21) + "</span>" +
            '<h3 class="emergency-title" id="emergencyTitle"></h3>' +
          "</div>" +
          '<p class="emergency-meta"><strong>' + t("Type") + ':</strong><span id="emergencyType"></span></p>' +
          '<p class="emergency-meta"><strong>' + t("Date & Time") + ':</strong><span id="emergencyDate"></span></p>' +
          '<p class="emergency-meta"><strong>' + t("Location") + ':</strong><span id="emergencyLocation"></span></p>' +
          '<div class="emergency-desc"><strong>' + t("Description") + ':</strong><p id="emergencyDesc"></p></div>' +
          '<div class="emergency-instr"><strong>' + t("Safety Instructions") + ':</strong><ul id="emergencyInstr"></ul></div>' +
          '<div class="emergency-alarm" id="emergencyAlarmBar">' +
            '<span class="emergency-alarm-icon" aria-hidden="true">' + emergencyMegaphoneSvg(17) + "</span>" +
            '<span class="emergency-alarm-text" id="emergencyAlarmText"></span>' +
            '<span class="emergency-timer" id="emergencyTimer">00:30</span>' +
            '<div class="emergency-progress"><div class="emergency-progress-fill" id="emergencyProgress"></div></div>' +
          "</div>" +
        "</div>" +
        '<div class="emergency-actions">' +
          '<button type="button" class="btn btn-danger" id="emergencyStop">' + t("STOP ALARM") + "</button>" +
          '<button type="button" class="btn btn-primary" id="emergencyRepeat">' + t("REPEAT ANNOUNCEMENT") + "</button>" +
        "</div>" +
      "</div>" +
    "</div>" +
    '<div class="emergency-banner" id="emergencyBanner" hidden>' +
      '<span class="emergency-banner-icon" aria-hidden="true">' + emergencyWarningSvg(16) + "</span>" +
      '<span class="emergency-banner-text"><strong id="emergencyBannerTitle"></strong>' +
        '<span id="emergencyBannerLoc"></span></span>' +
      '<button type="button" class="btn btn-small btn-danger" id="emergencyBannerOpen">' + t("VIEW") + "</button>" +
    "</div>";
  document.body.appendChild(wrap);

  var stopBtn = document.getElementById("emergencyStop");
  if (stopBtn) stopBtn.addEventListener("click", function () {
    stopEmergencyAlarm();
    onEmergencyAlarmFinished();
  });
  var repeatBtn = document.getElementById("emergencyRepeat");
  if (repeatBtn) repeatBtn.addEventListener("click", function () {
    speakEmergency(emergencyCurrentAlert);
  });
  var closeBtn = document.getElementById("emergencyClose");
  if (closeBtn) closeBtn.addEventListener("click", function () { showEmergencyOverlay(false); });
  var openBtn = document.getElementById("emergencyBannerOpen");
  if (openBtn) openBtn.addEventListener("click", function () { showEmergencyOverlay(true); });
}

// Toggle between the full popup and the persistent banner (a minimized popup
// still stays visible until the alert is resolved or expires).
function showEmergencyOverlay(show) {
  var overlay = document.getElementById("emergencyOverlay");
  var banner = document.getElementById("emergencyBanner");
  if (show) {
    if (overlay) overlay.hidden = false;
    if (banner) banner.hidden = true;
    if (emergencyCurrentId) { try { sessionStorage.setItem("ccEmergencyMin:" + emergencyCurrentId, "0"); } catch (e) {} }
  } else {
    // If the alarm has already finished, minimizing just dismisses it - no
    // lingering top banner. Otherwise show the banner while the alarm runs.
    if (emergencyAlarmIsDone()) {
      if (overlay) overlay.hidden = true;
      if (banner) banner.hidden = true;
      if (emergencyCurrentId) { try { sessionStorage.setItem("ccEmergencyHidden:" + emergencyCurrentId, "1"); } catch (e) {} }
      return;
    }
    if (overlay) overlay.hidden = true;
    if (banner) banner.hidden = false;
    if (emergencyCurrentId) { try { sessionStorage.setItem("ccEmergencyMin:" + emergencyCurrentId, "1"); } catch (e) {} }
  }
}

function fillEmergencyDom(alert) {
  var set = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text; };
  set("emergencyTitle", alert.title || t("Emergency"));
  set("emergencyType", t(emergencyTypeLabel(alert.type)));
  var when = alert.createdAt ? new Date(alert.createdAt) : new Date();
  set("emergencyDate", when.toLocaleString());
  set("emergencyLocation", alert.location || "—");
  set("emergencyDesc", alert.description || "");
  set("emergencyBannerTitle", alert.title || t("Emergency"));
  set("emergencyBannerLoc", alert.location ? " · " + alert.location : "");
  var instr = document.getElementById("emergencyInstr");
  if (instr) {
    var items = Array.isArray(alert.instructions) ? alert.instructions : [];
    instr.innerHTML = items.length
      ? items.map(function (s) { return "<li>" + escapeHtml(s) + "</li>"; }).join("")
      : "<li>" + t("Follow the instructions of your barangay officials.") + "</li>";
  }
}

function renderEmergency() {
  var isUser = document.body.classList.contains("user-body");
  var isOfficial = document.body.classList.contains("official-body");
  if (!isUser && !isOfficial) return;
  ensureEmergencyDom();

  var barangay = isOfficial ? officialBarangay() : residentBarangay();
  var alert = currentEmergencyFor(barangay);
  var overlay = document.getElementById("emergencyOverlay");
  var banner = document.getElementById("emergencyBanner");

  if (!alert) {
    if (overlay) overlay.hidden = true;
    if (banner) banner.hidden = true;
    if (emergencyCurrentId) stopEmergencyAlarm();
    emergencyCurrentId = null;
    emergencyCurrentAlert = null;
    return;
  }

  fillEmergencyDom(alert);
  emergencyCurrentAlert = alert;

  // A new alert: reset the minimized/hidden state and (once per session) sound off.
  if (emergencyCurrentId !== alert.id) {
    emergencyCurrentId = alert.id;
    try {
      sessionStorage.removeItem("ccEmergencyMin:" + alert.id);
      sessionStorage.removeItem("ccEmergencyHidden:" + alert.id);
    } catch (e) {}
    if (sessionStorage.getItem("ccEmergencyAlarm:" + alert.id) !== "1") {
      try { sessionStorage.setItem("ccEmergencyAlarm:" + alert.id, "1"); } catch (e) {}
      startEmergencyAlarm(EMERGENCY_ALARM_SECONDS);
      speakEmergency(alert);
    }
  }

  // The viewer tucked this alert away after the alarm finished: stay hidden.
  var hidden = false;
  try { hidden = sessionStorage.getItem("ccEmergencyHidden:" + alert.id) === "1"; } catch (e) {}
  if (hidden) {
    if (overlay) overlay.hidden = true;
    if (banner) banner.hidden = true;
    return;
  }

  var minimized = false;
  try { minimized = sessionStorage.getItem("ccEmergencyMin:" + alert.id) === "1"; } catch (e) {}
  showEmergencyOverlay(!minimized);
}

function initEmergencyBroadcast() {
  if (!document.body.classList.contains("user-body") &&
      !document.body.classList.contains("official-body")) return;
  ensureEmergencyDom();
  renderEmergency();
  notifyBus.onMessage(renderEmergency);
  // Catch an alert expiring while the dashboard stays open.
  setInterval(renderEmergency, 30000);
  window.addEventListener("focus", renderEmergency);
}

/* ---- Admin: publish + resolve ---- */

var EMERGENCY_EXPIRY_OPTIONS = [
  { v: "1", label: "1 hour" },
  { v: "6", label: "6 hours" },
  { v: "12", label: "12 hours" },
  { v: "24", label: "24 hours" },
  { v: "72", label: "3 days" }
];

function initAdminEmergency() {
  if (!document.body.classList.contains("admin-body")) return;
  var btn = document.getElementById("emergencyBroadcastBtn");
  if (!btn) return;

  var modal = document.getElementById("emergencyStudio");
  var closeBtn = document.getElementById("emergencyStudioClose");
  var form = document.getElementById("emergencyForm");

  // Fill the type + target + expiry selects once
  var typeEl = document.getElementById("emergencyType");
  if (typeEl && typeEl.options.length <= 1) {
    typeEl.innerHTML = EMERGENCY_TYPES.map(function (x) {
      return '<option value="' + x.key + '">' + escapeHtml(x.label) + "</option>";
    }).join("");
  }
  var expiryEl = document.getElementById("emergencyExpiry");
  if (expiryEl && expiryEl.options.length <= 1) {
    expiryEl.innerHTML = EMERGENCY_EXPIRY_OPTIONS.map(function (x) {
      return '<option value="' + x.v + '"' + (x.v === "24" ? " selected" : "") + ">" + x.label + "</option>";
    }).join("");
  }
  var brgyEl = document.getElementById("emergencyBarangay");
  if (brgyEl) {
    brgyEl.innerHTML = '<option value="all">' + t("All Barangays") + "</option>" +
      barangayOptions().map(function (b) {
        return '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + "</option>";
      }).join("");
  }

  function open() {
    if (modal) { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); }
    renderActiveEmergencyList();
  }
  function close() {
    if (modal) { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }
  }
  btn.addEventListener("click", open);
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
  if (form) form.addEventListener("submit", function (e) { e.preventDefault(); publishEmergency(); });

  renderActiveEmergencyList();
}

function publishEmergency() {
  var titleEl = document.getElementById("emergencyTitle");
  var descEl = document.getElementById("emergencyDescription");
  var instrEl = document.getElementById("emergencyInstructions");
  var locEl = document.getElementById("emergencyLocation");
  var typeEl = document.getElementById("emergencyType");
  var brgyEl = document.getElementById("emergencyBarangay");
  var expEl = document.getElementById("emergencyExpiry");

  var title = titleEl ? titleEl.value.trim() : "";
  var description = descEl ? descEl.value.trim() : "";
  if (!title) { showToast(t("Please enter an emergency title."), "error"); if (titleEl) titleEl.focus(); return; }
  if (!description) { showToast(t("Please describe the emergency."), "error"); if (descEl) descEl.focus(); return; }

  var hours = parseFloat(expEl ? expEl.value : "24") || 24;
  var rec = {
    id: generateId(),
    title: title,
    type: typeEl ? typeEl.value : "other",
    location: locEl ? locEl.value.trim() : "",
    description: description,
    instructions: instrEl ? instrEl.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean) : [],
    barangay: brgyEl ? (brgyEl.value || "all") : "all",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
    resolved: false,
    createdBy: localStorage.getItem("adminName") || "admin"
  };

  var list = loadEmergencyAlerts();
  list.unshift(rec);
  saveEmergencyAlerts(list);
  notifyBus.post();

  var form = document.getElementById("emergencyForm");
  if (form) form.reset();
  renderActiveEmergencyList();
  showToast(t("Emergency broadcast published."), "success");
  logAudit("published emergency", title + " (" + rec.barangay + ")");
}

function resolveEmergency(id) {
  var list = loadEmergencyAlerts();
  var rec = list.filter(function (a) { return a.id === id; })[0];
  if (!rec) return;
  rec.resolved = true;
  rec.resolvedAt = new Date().toISOString();
  saveEmergencyAlerts(list);
  notifyBus.post();
  renderActiveEmergencyList();
  showToast(t("Emergency broadcast resolved."), "success");
  logAudit("resolved emergency", rec.title);
}

function renderActiveEmergencyList() {
  var box = document.getElementById("emergencyActiveList");
  if (!box) return;
  var list = activeEmergencyAlerts();
  if (!list.length) {
    box.innerHTML = '<p class="meta">' + t("No active emergency broadcasts.") + "</p>";
    return;
  }
  box.innerHTML = list.map(function (a) {
    var target = normalizeBarangay(a.barangay) === "all" || !a.barangay ? t("All Barangays") : a.barangay;
    var exp = a.expiresAt ? t("expires") + " " + new Date(a.expiresAt).toLocaleString() : "";
    return '<div class="emergency-active-item">' +
      "<div>" +
        "<strong>" + escapeHtml(a.title) + "</strong>" +
        '<span class="meta">' + escapeHtml(t(emergencyTypeLabel(a.type))) + " &middot; " +
          escapeHtml(target) + " &middot; " + notifRelativeTime(a.createdAt) +
          (exp ? " &middot; " + escapeHtml(exp) : "") + "</span>" +
      "</div>" +
      '<button type="button" class="btn btn-small btn-danger" onclick="resolveEmergency(\'' + a.id + '\')">' +
        t("RESOLVE") + "</button>" +
    "</div>";
  }).join("");
}

initEmergencyBroadcast();
initAdminEmergency();

/* ============================================================
   25. COMMUNITY FEED + LOST & FOUND
   Residents publish lost/found/share posts (with photos). The feed
   is visible to all users + officials, newest first, with
   Like / Comment / Share / Save. The admin moderates every post.
   The admin + officials can raise a community alert about a lost
   item (all barangays or one barangay) that shows as a dismissible
   banner + a bell notification on the member/official dashboards,
   in real time. Comments reuse the shared comment pipeline so they
   also appear in the admin COMMENTS moderation.
   ============================================================ */

var POSTS_KEY = "communityUserPosts";
var USER_ALERTS_KEY = "communityUserAlerts";
var POST_MAX_IMAGES = 4;

var POST_KINDS = [
  { key: "lost", label: "Lost Item" },
  { key: "found", label: "Found Item" },
  { key: "share", label: "Community Share" }
];
var POST_CATEGORIES = [
  "Mobile Phone", "Wallet", "ID / Documents", "Keys", "Bag",
  "Jewelry", "Pet", "Bicycle", "Other"
];

function postKindLabel(key) {
  var found = POST_KINDS.filter(function (x) { return x.key === key; })[0];
  return found ? found.label : key;
}
function postKindMeta(key) {
  return POST_KINDS.filter(function (x) { return x.key === key; })[0] || POST_KINDS[2];
}

function loadUserPosts() { return getData(POSTS_KEY, []); }
function saveUserPosts(list) { return setData(POSTS_KEY, list); }
function loadUserAlerts() { return getData(USER_ALERTS_KEY, []); }
function saveUserAlerts(list) { return setData(USER_ALERTS_KEY, list); }
function postById(id) { return loadUserPosts().filter(function (p) { return p.id === id; })[0] || null; }

function postLiked(p, who) { return !!(p && who && p.likes && p.likes.indexOf(who) !== -1); }
function postSaved(p, who) { return !!(p && who && p.saves && p.saves.indexOf(who) !== -1); }
function postAuthorName(p) { return p.authorName || displayNameFor(p.author) || p.author || t("Member"); }

// Visible posts (hidden ones are moderated out), newest first
function visibleUserPosts() {
  return loadUserPosts().filter(function (p) { return !p.hidden; })
    .sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
}

function postImagesHtml(p) {
  var imgs = (Array.isArray(p.images) ? p.images : []).filter(Boolean);
  if (!imgs.length) return "";
  var cls = imgs.length === 1 ? "post-media one" : imgs.length === 2 ? "post-media two" : "post-media grid";
  return '<div class="' + cls + '">' + imgs.map(function (src) {
    return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(p.title || t("Photo")) + '" loading="lazy" onclick="openUserPostDetail(\'' + p.id + '\')">';
  }).join("") + "</div>";
}

function postDetailsHtml(p) {
  var kind = p.kind || "share";
  if (kind !== "lost" && kind !== "found") return "";
  var rows = [];
  if (p.category) rows.push(['Item', t(p.category)]);
  if (p.location) rows.push([t("Location"), p.location]);
  if (p.date) rows.push([t("Date"), formatDate(p.date)]);
  if (p.contact) rows.push([t("Contact"), p.contact]);
  if (!rows.length) return "";
  return '<div class="post-details">' + rows.map(function (r) {
    return '<span class="post-detail"><strong>' + escapeHtml(r[0]) + ":</strong> " + escapeHtml(r[1]) + "</span>";
  }).join("") + "</div>";
}

function postDeleteIconSvg() {
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
}

function postEditIconSvg() {
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
}

function postDotsSvg() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
}

function renderUserPostCard(p) {
  var actor = getActor();
  var who = actor ? actor.username : "";
  var isOwner = !!(actor && actor.username === p.author);
  var liked = postLiked(p, who);
  var saved = postSaved(p, who);
  var likeCount = (p.likes || []).length;
  var commentCount = getCommentCount(p.id);
  var kind = p.kind || "share";
  return "" +
    '<article class="feed-card post-card" data-post="' + p.id + '">' +
      '<div class="feed-header">' +
        '<span class="feed-avatar" aria-hidden="true">' + avatarInner(p.author) + "</span>" +
        '<div class="feed-head-text">' +
          '<strong class="feed-author">' + escapeHtml(postAuthorName(p)) + "</strong>" +
          '<div class="feed-meta">' +
            '<span class="badge post-kind-' + escapeHtml(kind) + '">' + escapeHtml(t(postKindLabel(kind))) + "</span>" +
            "<span>" + notifRelativeTime(p.createdAt) + "</span>" +
            (p.barangay ? "<span>&middot;</span><span>" + escapeHtml(p.barangay) + "</span>" : "") +
          "</div>" +
        "</div>" +
        (isOwner ? '<div class="post-menu">' +
          '<button type="button" class="post-menu-btn" aria-haspopup="true" aria-expanded="false" aria-label="' + t("Post options") + '" onclick="togglePostMenu(event, \'' + p.id + '\')">' + postDotsSvg() + "</button>" +
          '<div class="post-menu-list" id="postMenu-' + p.id + '" role="menu">' +
            '<button type="button" class="post-menu-item" role="menuitem" onclick="openEditPost(\'' + p.id + '\')">' + postEditIconSvg() + "<span>" + t("Edit post") + "</span></button>" +
            '<button type="button" class="post-menu-item post-menu-danger" role="menuitem" onclick="deleteOwnPost(\'' + p.id + '\')">' + postDeleteIconSvg() + "<span>" + t("Delete post") + "</span></button>" +
          "</div>" +
        "</div>" : "") +
      "</div>" +
      '<div class="feed-body">' +
        (p.title ? '<h3 class="feed-title" onclick="openUserPostDetail(\'' + p.id + '\')">' + escapeHtml(p.title) + "</h3>" : "") +
        '<p class="feed-text">' + escapeHtml(p.description || "") +
          ' <a href="#" class="feed-more" onclick="event.preventDefault();openUserPostDetail(\'' + p.id + '\')">' + t("SEE MORE") + "</a>" +
        "</p>" +
      "</div>" +
      postDetailsHtml(p) +
      postImagesHtml(p) +
      '<div class="feed-stats">' +
        '<span class="feed-stat">' + likeCount + " " + t("likes") + "</span>" +
        '<span class="feed-stat" data-comment-count="' + p.id + '">' + commentCount + " " + t("comments") + "</span>" +
        (p.shares ? '<span class="feed-stat">' + p.shares + " " + t("shares") + "</span>" : "") +
      "</div>" +
      '<div class="feed-actions">' +
        '<button class="feed-action-btn' + (liked ? " liked" : "") + '" type="button" aria-pressed="' + (liked ? "true" : "false") + '" onclick="toggleUserPostLike(\'' + p.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>' +
          '<span class="feed-action-label">' + t(liked ? "Liked" : "Like") + "</span>" +
        "</button>" +
        '<button class="feed-action-btn" type="button" onclick="openUserPostDetail(\'' + p.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
          '<span class="feed-action-label">' + t("Comment") + "</span>" +
        "</button>" +
        '<button class="feed-action-btn" type="button" onclick="shareUserPost(\'' + p.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          '<span class="feed-action-label">' + t("Share") + "</span>" +
        "</button>" +
        '<button class="feed-action-btn' + (saved ? " saved" : "") + '" type="button" onclick="toggleUserPostSave(\'' + p.id + '\')">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="feed-action-label">' + t(saved ? "Saved" : "Save") + "</span>" +
        "</button>" +
      "</div>" +
    "</article>";
}

/* ---- Interactions ---- */

function toggleUserPostLike(id) {
  var actor = getActor();
  if (!actor) { showToast(t("Log in to react."), "error"); return; }
  var list = loadUserPosts();
  var p = list.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  p.likes = Array.isArray(p.likes) ? p.likes : [];
  var i = p.likes.indexOf(actor.username);
  if (i === -1) {
    p.likes.push(actor.username);
    notifyAdmin("like", actor.resident ? actor.username : "", { targetType: "post", targetId: id, targetTitle: p.title || "" });
  } else {
    p.likes.splice(i, 1);
  }
  saveUserPosts(list);
  notifyBus.post();
  renderCommunityFeed();
}

function toggleUserPostSave(id) {
  var actor = getActor();
  if (!actor) { showToast(t("Log in to save."), "error"); return; }
  var list = loadUserPosts();
  var p = list.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  p.saves = Array.isArray(p.saves) ? p.saves : [];
  var i = p.saves.indexOf(actor.username);
  if (i === -1) {
    p.saves.push(actor.username);
    notifyAdmin("save", actor.resident ? actor.username : "", { targetType: "post", targetId: id, targetTitle: p.title || "" });
    showToast(t("Saved."), "success");
  } else {
    p.saves.splice(i, 1);
    showToast(t("Removed from saved."), "success");
  }
  saveUserPosts(list);
  notifyBus.post();
  renderCommunityFeed();
}

function shareUserPost(id) {
  var p = postById(id);
  if (!p) return;
  var url = location.href.replace(/[#?].*$/, "") + "#post-" + id;
  var list = loadUserPosts();
  var rec = list.filter(function (x) { return x.id === id; })[0];
  if (rec) { rec.shares = (rec.shares || 0) + 1; saveUserPosts(list); }
  notifyAdmin("share", (getSessionUser() || {}).username || "", { targetType: "post", targetId: id, targetTitle: p.title || "" });
  function done() { showToast(t("Link copied to clipboard."), "success"); renderCommunityFeed(); }
  function fail() { showToast(url, "info"); }
  if (legacyCopyText(url)) { done(); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, fail);
  } else { fail(); }
}

function openUserPostDetail(id) {
  var p = postById(id);
  if (!p) return;
  var isAdmin = document.body.classList.contains("admin-body");
  var isOfficial = document.body.classList.contains("official-body");
  var canModerate = isAdmin || isOfficial;
  var actor = getActor();
  var isOwner = !!(actor && actor.username === p.author);

  var body = postDetailsHtml(p) + postImagesHtml(p);
  body += '<p class="meta">' + escapeHtml(t("Posted by")) + " " + escapeHtml(postAuthorName(p)) +
    " &middot; " + notifRelativeTime(p.createdAt) +
    (p.barangay ? " &middot; " + escapeHtml(p.barangay) : "") + "</p>";

  var actions = "";
  if (isOwner) {
    actions += '<div class="modal-actions-row">' +
      '<button type="button" class="btn btn-small btn-danger" id="postDeleteOwnBtn">' + t("DELETE MY POST") + "</button>" +
    "</div>";
  }
  if (canModerate) {
    actions += '<div class="modal-actions-row post-mod-actions">' +
      '<button type="button" class="btn btn-small" id="postAlertBtn">' + t("ALERT COMMUNITY") + "</button>" +
      (isAdmin ? '<button type="button" class="btn btn-small" id="postHideBtn">' + t(p.hidden ? "UNHIDE" : "HIDE") + "</button>" +
                 '<button type="button" class="btn btn-small btn-danger" id="postDeleteBtn">' + t("DELETE") + "</button>" : "") +
    "</div>";
  }

  openDetailModal(escapeHtml(p.title || t(postKindLabel(p.kind))), escapeHtml(t(postKindLabel(p.kind))), body + actions + renderCommentsHtml(p.id, "userpost"));

  if (isOwner) {
    var ownDelBtn = document.getElementById("postDeleteOwnBtn");
    if (ownDelBtn) ownDelBtn.addEventListener("click", function () { deleteOwnPost(id); });
  }
  if (canModerate) {
    var alertBtn = document.getElementById("postAlertBtn");
    if (alertBtn) alertBtn.addEventListener("click", function () { openCommunityAlertDialog(id); });
    var hideBtn = document.getElementById("postHideBtn");
    if (hideBtn) hideBtn.addEventListener("click", function () { setUserPostHidden(id, !p.hidden); closeDetailModal(); });
    var delBtn = document.getElementById("postDeleteBtn");
    if (delBtn) delBtn.addEventListener("click", function () { deleteUserPost(id); closeDetailModal(); });
  }
}

// A resident (or official) can delete a post they created
function deleteOwnPost(id) {
  var p = postById(id);
  if (!p) return;
  var actor = getActor();
  var allowed = (actor && actor.username === p.author) || document.body.classList.contains("admin-body");
  if (!allowed) { showToast(t("You can only delete your own posts."), "error"); return; }
  var doDelete = function () {
    closeDetailModal();
    deleteUserPost(id);
  };
  if (typeof openConfirmModal === "function") {
    openConfirmModal("Delete this post? This cannot be undone.", "DELETE", doDelete);
  } else {
    doDelete();
  }
}

/* ---- Post ⋮ menu (own posts: Edit / Delete) ---- */

function togglePostMenu(event, id) {
  if (event) event.stopPropagation();
  var menu = document.getElementById("postMenu-" + id);
  var isOpen = menu && menu.classList.contains("open");
  closePostMenus();
  if (menu && !isOpen) {
    menu.classList.add("open");
    var btn = menu.parentNode && menu.parentNode.querySelector(".post-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
}

function closePostMenus() {
  document.querySelectorAll(".post-menu-list.open").forEach(function (m) {
    m.classList.remove("open");
    var btn = m.parentNode && m.parentNode.querySelector(".post-menu-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

function openEditPost(id) {
  var p = postById(id);
  if (!p) return;
  var actor = getActor();
  if (!(actor && actor.username === p.author) && !document.body.classList.contains("admin-body")) {
    showToast(t("You can only edit your own posts."), "error");
    return;
  }
  closePostMenus();
  var kind = p.kind || "share";
  var isItem = kind === "lost" || kind === "found";
  var catOptions = POST_CATEGORIES.map(function (c) {
    return '<option value="' + escapeHtml(c) + '"' + (p.category === c ? " selected" : "") + ">" + escapeHtml(t(c)) + "</option>";
  }).join("");
  var body = '<form id="editPostForm" class="alert-dialog" novalidate>' +
    '<div class="form-group"><label for="editPostTitle">' + t("Title") + '</label><input type="text" id="editPostTitle" maxlength="100" value="' + escapeHtml(p.title || "") + '"></div>' +
    '<div class="form-group"><label for="editPostDescription">' + t("Description") + '</label><textarea id="editPostDescription" rows="3" maxlength="600">' + escapeHtml(p.description || "") + "</textarea></div>" +
    (isItem
      ? '<div class="form-row">' +
          '<div class="form-group"><label for="editPostCategory">' + t("Item Type") + '</label><select id="editPostCategory">' + catOptions + "</select></div>" +
          '<div class="form-group"><label for="editPostDate">' + t("Date") + '</label><input type="date" id="editPostDate" value="' + escapeHtml(p.date || "") + '"></div>' +
        "</div>" +
        '<div class="form-group"><label for="editPostLocation">' + t("Last Seen / Found At") + '</label><input type="text" id="editPostLocation" maxlength="120" value="' + escapeHtml(p.location || "") + '"></div>' +
        '<div class="form-group"><label for="editPostContact">' + t("Contact Info") + '</label><input type="text" id="editPostContact" maxlength="80" value="' + escapeHtml(p.contact || "") + '"></div>'
      : "") +
    '<div class="modal-actions-row"><button type="button" class="btn btn-success" id="editPostSaveBtn">' + t("SAVE CHANGES") + "</button></div>" +
  "</form>";
  openDetailModal(t("Edit Post"), escapeHtml(t(postKindLabel(kind))), body);
  var saveBtn = document.getElementById("editPostSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", function () { savePostEdit(id); });
}

function savePostEdit(id) {
  var list = loadUserPosts();
  var p = list.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  var titleEl = document.getElementById("editPostTitle");
  var descEl = document.getElementById("editPostDescription");
  if (titleEl) p.title = titleEl.value.trim().slice(0, 100);
  if (descEl) p.description = descEl.value.trim().slice(0, 600);
  var catEl = document.getElementById("editPostCategory");
  var locEl = document.getElementById("editPostLocation");
  var dateEl = document.getElementById("editPostDate");
  var conEl = document.getElementById("editPostContact");
  if (catEl) p.category = catEl.value;
  if (locEl) p.location = locEl.value.trim().slice(0, 120);
  if (dateEl) p.date = dateEl.value;
  if (conEl) p.contact = conEl.value.trim().slice(0, 80);
  p.updated = new Date().toISOString();
  saveUserPosts(list);
  closeDetailModal();
  notifyBus.post();
  renderCommunityFeed();
  renderLostFoundOverview();
  showToast(t("Post updated."), "success");
  logAudit("edited community post", p.title || id);
}

/* ---- Feed rendering ---- */

var communityFeedFilter = "all";
function setCommunityFeedFilter(kind) {
  communityFeedFilter = kind || "all";
  document.querySelectorAll(".community-feed-chips .filter-btn").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-feed-kind") === communityFeedFilter);
  });
  renderCommunityFeed();
}

function renderCommunityFeed() {
  var box = document.getElementById("userPostsFeed") || document.getElementById("offPostsFeed");
  if (!box) return;
  var list = visibleUserPosts().filter(function (p) {
    return communityFeedFilter === "all" || (p.kind || "share") === communityFeedFilter;
  });
  var countEl = document.getElementById("communityFeedCount");
  if (countEl) countEl.textContent = list.length + " " + t("posts");
  if (!list.length) {
    box.innerHTML = '<p class="empty-state">' + t("No community posts yet. Be the first to share!") + "</p>";
    return;
  }
  box.innerHTML = list.map(renderUserPostCard).join("");
}

/* ---- Lost & Found overview widget (Home / Overview of every dashboard) ---- */

function lostFoundIconSvg(kind) {
  if (kind === "found") {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
}

function latestLostFound(limit) {
  return visibleUserPosts().filter(function (p) {
    return p.kind === "lost" || p.kind === "found";
  }).slice(0, limit || 4);
}

function lostFoundOverviewHtml(limit) {
  var list = latestLostFound(limit);
  if (!list.length) {
    return '<p class="meta">' + t("No lost or found items reported yet.") + "</p>";
  }
  return '<div class="lf-list">' + list.map(function (p) {
    var kind = p.kind;
    var thumb = (Array.isArray(p.images) && p.images[0])
      ? '<img src="' + escapeHtml(p.images[0]) + '" alt="">'
      : lostFoundIconSvg(kind);
    var metaBits = [];
    if (p.location) metaBits.push(escapeHtml(p.location));
    if (p.category) metaBits.push(escapeHtml(t(p.category)));
    return '<button type="button" class="lf-item" onclick="openUserPostDetail(\'' + p.id + '\')">' +
      '<span class="lf-thumb lf-' + escapeHtml(kind) + '">' + thumb + "</span>" +
      '<span class="lf-body">' +
        '<span class="lf-top">' +
          '<span class="badge post-kind-' + escapeHtml(kind) + '">' + escapeHtml(t(postKindLabel(kind))) + "</span>" +
          '<span class="lf-time">' + notifRelativeTime(p.createdAt) + "</span>" +
        "</span>" +
        '<strong class="lf-title">' + escapeHtml(p.title || t(postKindLabel(kind))) + "</strong>" +
        '<span class="lf-meta">' + (metaBits.length ? metaBits.join(" &middot; ") : escapeHtml(postAuthorName(p))) + "</span>" +
      "</span>" +
    "</button>";
  }).join("") + "</div>";
}

function renderLostFoundOverview() {
  ["dashLostFound", "offLostFound", "adminLostFound"].forEach(function (id) {
    var box = document.getElementById(id);
    if (box) box.innerHTML = lostFoundOverviewHtml(4);
  });
}

function initCommunityFeed() {
  var isUser = document.body.classList.contains("user-body");
  var isOfficial = document.body.classList.contains("official-body");
  if (!isUser && !isOfficial) return;
  ensureCommunityAlertDom();
  if (isUser) initUserPostComposer();
  renderCommunityFeed();
  renderLostFoundOverview();
  renderCommunityAlertBanner();
  updateUserNotifBellSoon();
  notifyBus.onMessage(function () {
    renderCommunityFeed();
    renderLostFoundOverview();
    renderCommunityAlertBanner();
    refreshCommunityFeedCounters();
  });
  setInterval(function () { renderCommunityAlertBanner(); }, 30000);
  window.addEventListener("focus", renderCommunityAlertBanner);
  document.addEventListener("click", closePostMenus);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePostMenus(); });
}

function refreshCommunityFeedCounters() {
  // Update visible comment counters without a full re-render (keeps typing calm)
  loadUserPosts().forEach(function (p) {
    document.querySelectorAll('[data-comment-count="' + p.id + '"]').forEach(function (el) {
      el.textContent = getCommentCount(p.id) + " " + t("comments");
    });
  });
}

/* ---- Composer (member dashboard) ---- */

function initUserPostComposer() {
  var form = document.getElementById("userPostForm");
  if (!form) return;

  var kindEl = document.getElementById("postKind");
  function syncFields() {
    var kind = kindEl ? kindEl.value : "share";
    document.querySelectorAll("#userPostForm [data-post-field]").forEach(function (wrap) {
      var want = (wrap.getAttribute("data-post-field") || "").split(/\s+/);
      wrap.classList.toggle("hidden", want.indexOf(kind) === -1);
    });
  }
  if (kindEl) kindEl.addEventListener("change", syncFields);
  syncFields();

  var pending = [];
  var fileInput = document.getElementById("userPostImages");
  var preview = document.getElementById("userPostPreview");
  function paintPreview() {
    if (!preview) return;
    preview.innerHTML = pending.map(function (src, i) {
      return '<span class="post-thumb"><img src="' + escapeHtml(src) + '" alt=""><button type="button" class="post-thumb-remove" data-i="' + i + '" aria-label="' + t("Remove") + '">&times;</button></span>';
    }).join("");
  }
  if (fileInput) {
    fileInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      files.forEach(function (file) {
        if (pending.length >= POST_MAX_IMAGES) return;
        var reader = new FileReader();
        reader.onload = function () {
          compressIncidentPhoto(reader.result, function (dataUrl) {
            if (pending.length < POST_MAX_IMAGES) { pending.push(dataUrl); paintPreview(); }
          });
        };
        reader.readAsDataURL(file);
      });
      fileInput.value = "";
    });
  }
  if (preview) {
    preview.addEventListener("click", function (e) {
      var btn = e.target.closest(".post-thumb-remove");
      if (btn) { pending.splice(Number(btn.getAttribute("data-i")), 1); paintPreview(); }
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var user = getSessionUser() || getSessionOfficial();
    if (!user) { showToast(t("Please sign in to post."), "error"); return; }
    var kind = kindEl ? kindEl.value : "share";
    var title = (document.getElementById("postTitle").value || "").trim();
    var description = (document.getElementById("postDescription").value || "").trim();
    var category = document.getElementById("postCategory") ? document.getElementById("postCategory").value : "";
    var location = document.getElementById("postLocation") ? document.getElementById("postLocation").value.trim() : "";
    var date = document.getElementById("postDate") ? document.getElementById("postDate").value : "";
    var contact = document.getElementById("postContact") ? document.getElementById("postContact").value.trim() : "";

    if (kind === "share" && !title && !description) { showToast(t("Please write something to share."), "error"); return; }
    if (kind !== "share" && !title) { showToast(t("Please add a title for the item."), "error"); return; }

    var territory = (getSessionOfficial() && officialBarangay()) || (getSessionUser() && getSessionUser().barangay) || "";
    var record = {
      id: generateId(),
      kind: kind,
      title: title,
      description: description,
      category: kind === "share" ? "" : category,
      location: kind === "share" ? "" : location,
      date: kind === "share" ? "" : date,
      contact: kind === "share" ? "" : contact,
      images: pending.slice(),
      author: (getSessionOfficial() ? "official:" + getSessionOfficial().username : (getSessionUser() || {}).username || ""),
      authorName: user.name || user.username,
      barangay: territory,
      likes: [], saves: [], shares: 0,
      hidden: false,
      createdAt: new Date().toISOString()
    };
    var list = loadUserPosts();
    list.unshift(record);
    saveUserPosts(list);
    notifyAdmin("post", (getSessionUser() || {}).username || (getSessionOfficial() ? getSessionOfficial().username : ""),
      { targetType: "post", targetId: record.id, targetTitle: record.title || t(postKindLabel(record.kind)) });
    notifyBus.post();
    form.reset();
    pending = [];
    paintPreview();
    syncFields();
    renderCommunityFeed();
    showToast(t("Posted to the community feed."), "success");
    logAudit("created community post", (record.title || postKindLabel(record.kind)));
  });
}

/* ---- Admin moderation ---- */

function renderAdminPosts() {
  var body = document.getElementById("postsTableBody");
  if (!body) return;
  var q = getTableQuery("postsSearch");
  var kindEl = document.getElementById("postsKindFilter");
  var kindFilter = kindEl ? kindEl.value : "all";
  var all = loadUserPosts().sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
  var shown = all.filter(function (p) {
    if (kindFilter !== "all" && (p.kind || "share") !== kindFilter) return false;
    if (!q) return true;
    return [p.title, p.description, p.authorName, p.author, p.location, p.category].join(" ").toLowerCase().indexOf(q) !== -1;
  });
  updateTableCount("postsTableCount", shown.length, all.length);
  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">' + t("No community posts.") + "</td></tr>";
    return;
  }
  body.innerHTML = shown.map(function (p) {
    return "<tr>" +
      '<td><span class="badge post-kind-' + escapeHtml(p.kind || "share") + '">' + escapeHtml(t(postKindLabel(p.kind))) + "</span></td>" +
      "<td><strong>" + escapeHtml(p.title || "—") + "</strong>" +
        (p.hidden ? ' <span class="badge badge-hidden">' + t("HIDDEN") + "</span>" : "") +
        '<br><span class="meta">' + escapeHtml(shortText(p.description || "", 70)) + "</span></td>" +
      "<td>" + escapeHtml(postAuthorName(p)) + "</td>" +
      "<td>" + formatDate((p.createdAt || "").slice(0, 10)) + "</td>" +
      "<td>" + (p.hidden ? t("Hidden") : t("Visible")) + "</td>" +
      '<td class="table-actions">' +
        '<button type="button" class="btn btn-small" onclick="openUserPostDetail(\'' + p.id + '\')">' + t("VIEW") + "</button> " +
        '<button type="button" class="btn btn-small" onclick="setUserPostHidden(\'' + p.id + '\', ' + (p.hidden ? "false" : "true") + ')">' + t(p.hidden ? "UNHIDE" : "HIDE") + "</button> " +
        '<button type="button" class="btn btn-small btn-danger" onclick="deleteUserPost(\'' + p.id + '\')">' + t("DELETE") + "</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

function setUserPostHidden(id, hidden) {
  var list = loadUserPosts();
  var p = list.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  p.hidden = !!hidden;
  saveUserPosts(list);
  notifyBus.post();
  renderAdminPosts();
  if (typeof renderCommunityFeed === "function") renderCommunityFeed();
  if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
  showToast(t(hidden ? "Post hidden from the feed." : "Post is visible again."), "success");
  logAudit(hidden ? "hid community post" : "unhid community post", p.title || id);
}

function deleteUserPost(id) {
  var p = postById(id);
  if (p) {
    setData("communityComments", loadComments().filter(function (c) { return c.newsId !== id; }));
  }
  saveUserPosts(loadUserPosts().filter(function (x) { return x.id !== id; }));
  saveUserAlerts(loadUserAlerts().filter(function (a) { return a.postId !== id; }));
  notifyBus.post();
  renderAdminPosts();
  renderCommunityAlertsAdmin();
  if (typeof renderCommunityFeed === "function") renderCommunityFeed();
  if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
  showToast(t("Post deleted."), "success");
  logAudit("deleted community post", (p && p.title) || id);
}

function initAdminPosts() {
  if (!document.body.classList.contains("admin-body")) return;
  if (!document.getElementById("postsTableBody")) return;
  var kindEl = document.getElementById("postsKindFilter");
  if (kindEl && kindEl.options.length <= 1) {
    kindEl.innerHTML = '<option value="all">' + t("All Types") + "</option>" +
      POST_KINDS.map(function (k) { return '<option value="' + k.key + '">' + escapeHtml(t(k.label)) + "</option>"; }).join("");
  }
  var search = document.getElementById("postsSearch");
  if (search) search.addEventListener("input", renderAdminPosts);
  if (kindEl) kindEl.addEventListener("change", renderAdminPosts);
  renderAdminPosts();
  renderCommunityAlertsAdmin();
  if (typeof renderLostFoundOverview === "function") renderLostFoundOverview();
}

/* ---- Community alerts (admin / official) ---- */

function activeUserAlerts() {
  return loadUserAlerts().slice().sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
}

// Emergencies / alerts fail open: unknown barangay still sees them.
function userAlertMatches(alert, barangay) {
  if (!alert) return false;
  var target = normalizeBarangay(alert.target);
  if (!target || target === "all") return true;
  var mine = normalizeBarangay(barangay);
  if (!mine) return true;
  return target === mine;
}

function currentUserAlertFor(barangay) {
  return activeUserAlerts().filter(function (a) { return userAlertMatches(a, barangay); })[0] || null;
}

function openCommunityAlertDialog(postId) {
  var p = postById(postId);
  if (!p) return;
  var options = '<option value="all">' + t("All Barangays") + "</option>" +
    barangayOptions().map(function (b) { return '<option value="' + escapeHtml(b) + '">' + escapeHtml(b) + "</option>"; }).join("");
  var body = '<div class="alert-dialog">' +
    '<div class="form-group"><label for="alertTarget">' + t("Send to") + "</label>" +
      '<select id="alertTarget">' + options + "</select></div>" +
    '<div class="form-group"><label for="alertMessage">' + t("Message") + "</label>" +
      '<textarea id="alertMessage" rows="2" maxlength="220">' + escapeHtml(t("Please be on the lookout for this lost item.")) + "</textarea></div>" +
    '<div class="modal-actions-row"><button type="button" class="btn btn-danger" id="alertSendBtn">' + t("SEND ALERT") + "</button></div>" +
  "</div>";
  openDetailModal(t("Send Community Alert"), escapeHtml(p.title || postKindLabel(p.kind)), body);
  var send = document.getElementById("alertSendBtn");
  if (send) send.addEventListener("click", function () {
    var targetEl = document.getElementById("alertTarget");
    var msgEl = document.getElementById("alertMessage");
    raiseCommunityAlert(postId, targetEl ? targetEl.value : "all", msgEl ? msgEl.value.trim() : "");
    closeDetailModal();
  });
}

function raiseCommunityAlert(postId, target, message) {
  var p = postById(postId);
  if (!p) return;
  var rec = {
    id: generateId(),
    postId: postId,
    title: p.title || t(postKindLabel(p.kind)),
    message: message || t("Please be on the lookout for this item."),
    target: target || "all",
    by: getSessionOfficial() ? (getSessionOfficial().name || getSessionOfficial().username) : (localStorage.getItem("adminName") || t("Admin")),
    byRole: getSessionOfficial() ? "official" : "admin",
    createdAt: new Date().toISOString()
  };
  var list = loadUserAlerts();
  list.unshift(rec);
  saveUserAlerts(list);
  notifyBus.post();
  renderCommunityAlertsAdmin();
  renderCommunityAlertBanner();
  showToast(t("Community alert sent."), "success");
  logAudit("sent community alert", rec.title + " (" + rec.target + ")");
}

function ensureCommunityAlertDom() {
  if (document.getElementById("communityAlertBanner")) return;
  var el = document.createElement("div");
  el.className = "community-alert-banner";
  el.id = "communityAlertBanner";
  el.hidden = true;
  el.innerHTML =
    '<span class="ca-icon" aria-hidden="true">' + emergencyWarningSvg(16) + "</span>" +
    '<span class="ca-text"><strong id="communityAlertTitle"></strong>' +
      '<span id="communityAlertMsg"></span></span>' +
    '<button type="button" class="btn btn-small btn-danger" id="communityAlertOpen">' + t("VIEW") + "</button>" +
    '<button type="button" class="ca-close" id="communityAlertClose" aria-label="' + t("Dismiss") + '">&times;</button>';
  document.body.appendChild(el);
}

function renderCommunityAlertBanner() {
  var banner = document.getElementById("communityAlertBanner");
  if (!banner) return;
  var isOfficial = document.body.classList.contains("official-body");
  var barangay = isOfficial ? officialBarangay() : ((getSessionUser() || {}).barangay || "");
  var alert = currentUserAlertFor(barangay);
  if (!alert) { banner.hidden = true; return; }
  var dismissed = false;
  try { dismissed = sessionStorage.getItem("ccUserAlert:" + alert.id) === "1"; } catch (e) {}
  if (dismissed) { banner.hidden = true; return; }
  document.getElementById("communityAlertTitle").textContent = alert.title;
  document.getElementById("communityAlertMsg").textContent = alert.message;
  banner.hidden = false;
  var open = document.getElementById("communityAlertOpen");
  if (open) open.onclick = function () { openUserPostDetail(alert.postId); };
  var close = document.getElementById("communityAlertClose");
  if (close) close.onclick = function () {
    try { sessionStorage.setItem("ccUserAlert:" + alert.id, "1"); } catch (e) {}
    banner.hidden = true;
  };
}

function renderCommunityAlertsAdmin() {
  var box = document.getElementById("communityAlertsAdmin");
  if (!box) return;
  var list = activeUserAlerts();
  if (!list.length) {
    box.innerHTML = '<p class="meta">' + t("No active community alerts.") + "</p>";
    return;
  }
  box.innerHTML = list.map(function (a) {
    var target = normalizeBarangay(a.target) === "all" ? t("All Barangays") : a.target;
    return '<div class="emergency-active-item">' +
      "<div><strong>" + escapeHtml(a.title) + "</strong>" +
        '<span class="meta">' + escapeHtml(a.message) + " &middot; " + escapeHtml(target) +
          " &middot; " + notifRelativeTime(a.createdAt) + "</span></div>" +
      '<button type="button" class="btn btn-small btn-danger" onclick="clearCommunityAlert(\'' + a.id + '\')">' + t("CLEAR") + "</button>" +
    "</div>";
  }).join("");
}

function clearCommunityAlert(id) {
  saveUserAlerts(loadUserAlerts().filter(function (a) { return a.id !== id; }));
  notifyBus.post();
  renderCommunityAlertsAdmin();
  if (typeof renderCommunityAlertBanner === "function") renderCommunityAlertBanner();
  showToast(t("Alert cleared."), "success");
}

function updateUserNotifBellSoon() {
  if (typeof updateNotifBell === "function") updateNotifBell("user");
}

initCommunityFeed();
initAdminPosts();

// ============================================================
// PUBLIC WEBSITE FEATURES (Home, Events, Gallery, News, etc.)
// ============================================================

// ---------- Weather Alert Banner (index.html) ----------
(function () {
  var banner = document.getElementById("weatherAlertBanner");
  var closeBtn = document.getElementById("weatherAlertClose");
  if (banner && closeBtn) {
    var dismissed = localStorage.getItem("weatherAlertDismissed") === "1";
    if (dismissed) {
      banner.style.display = "none";
    } else {
      banner.style.display = "block";
    }
    closeBtn.addEventListener("click", function () {
      banner.style.display = "none";
      localStorage.setItem("weatherAlertDismissed", "1");
    });
  }
})();

// ---------- Events Countdown (index.html) ----------
(function () {
  var targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 14); // 14 days from now
  var daysEl = document.getElementById("cdDays");
  var hoursEl = document.getElementById("cdHours");
  var minsEl = document.getElementById("cdMins");
  var secsEl = document.getElementById("cdSecs");
  if (daysEl && hoursEl && minsEl && secsEl) {
    function updateCountdown() {
      var now = new Date();
      var diff = targetDate - now;
      if (diff < 0) diff = 0;
      var days = Math.floor(diff / (1000 * 60 * 60 * 24));
      var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      var mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      var secs = Math.floor((diff % (1000 * 60)) / 1000);
      daysEl.textContent = String(days).padStart(2, "0");
      hoursEl.textContent = String(hours).padStart(2, "0");
      minsEl.textContent = String(mins).padStart(2, "0");
      secsEl.textContent = String(secs).padStart(2, "0");
    }
    updateCountdown();
    setInterval(updateCountdown, 1000);
  }
})();

// ---------- Quick Poll (index.html) ----------
(function () {
  var pollButtons = document.querySelectorAll(".poll-btn");
  var pollResult = document.getElementById("pollResult");
  if (pollButtons.length && pollResult) {
    var savedVote = localStorage.getItem("pollVote");
    if (savedVote) {
      pollResult.textContent = "You voted: " + savedVote + ". Thank you!";
      pollButtons.forEach(function (b) { b.disabled = true; });
    }
    pollButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var choice = btn.getAttribute("onclick").match(/'([^']+)'/);
        if (choice && choice[1]) {
          localStorage.setItem("pollVote", choice[1]);
          pollResult.textContent = "You voted: " + choice[1] + ". Thank you!";
          pollButtons.forEach(function (b) { b.disabled = true; });
        }
      });
    });
  }
})();

// ---------- SMS Template Copy (hotlines.html) ----------
(function () {
  var copyBtn = document.getElementById("smsCopyBtn");
  var smsText = document.querySelector(".sms-text");
  if (copyBtn && smsText) {
    copyBtn.addEventListener("click", function () {
      smsText.select();
      document.execCommand("copy");
      var original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(function () { copyBtn.textContent = original; }, 1500);
    });
  }
})();

// ---------- FAQ Toggle (contact.html) ----------
(function () {
  document.querySelectorAll(".faq-question").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var answer = btn.nextElementSibling;
      var isOpen = answer.style.display === "block";
      document.querySelectorAll(".faq-answer").forEach(function (a) { a.style.display = "none"; });
      if (!isOpen) {
        answer.style.display = "block";
      }
    });
  });
})();

// ---------- Search History (search.html) ----------
(function () {
  var historyList = document.getElementById("searchHistoryList");
  var searchInput = document.getElementById("globalSearch");
  if (historyList && searchInput) {
    function renderHistory() {
      var history = JSON.parse(localStorage.getItem("searchHistory") || "[]");
      if (history.length === 0) {
        historyList.innerHTML = '<p class="meta">No recent searches.</p>';
      } else {
        historyList.innerHTML = history.map(function (q) {
          return '<button class="filter-btn" type="button" onclick="searchHistoryClick(\'' + q + '\')">' + escapeHtml(q) + '</button>';
        }).join("");
      }
    }
    window.searchHistoryClick = function (q) {
      searchInput.value = q;
      var evt = new Event("input");
      searchInput.dispatchEvent(evt);
    };
    searchInput.addEventListener("change", function () {
      var q = searchInput.value.trim();
      if (q) {
        var history = JSON.parse(localStorage.getItem("searchHistory") || "[]");
        if (history.indexOf(q) === -1) {
          history.unshift(q);
          if (history.length > 5) history.pop();
          localStorage.setItem("searchHistory", JSON.stringify(history));
          renderHistory();
        }
      }
    });
    renderHistory();
  }
})();

// ---------- Voice Input (news-ai.html) ----------
(function () {
  var voiceBtn = document.getElementById("chatVoiceBtn");
  var chatInput = document.getElementById("chatInput");
  if (voiceBtn && chatInput && "webkitSpeechRecognition" in window) {
    voiceBtn.style.display = "inline-block";
    var recognition = new webkitSpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-PH";
    voiceBtn.addEventListener("click", function () {
      recognition.start();
    });
    recognition.onresult = function (event) {
      var transcript = event.results[0][0].transcript;
      chatInput.value = transcript;
      chatInput.dispatchEvent(new Event("input"));
    };
    recognition.onerror = function () {};
  } else if (voiceBtn) {
    voiceBtn.style.display = "none";
  }
})();

// ---------- News Bookmark / Share (news.html) ----------
(function () {
  var bookmarkBtn = document.getElementById("newsBookmarkToggle");
  var shareBtn = document.getElementById("newsShareBtn");
  if (bookmarkBtn) {
    var saved = JSON.parse(localStorage.getItem("communityBookmarks") || "[]");
    if (saved.length > 0) {
      bookmarkBtn.textContent = "⭐ My Saved (" + saved.length + ")";
    }
    bookmarkBtn.addEventListener("click", function () {
      var saved = JSON.parse(localStorage.getItem("communityBookmarks") || "[]");
      window.location.href = "user-dashboard.html#saved";
    });
  }
  if (shareBtn) {
    shareBtn.addEventListener("click", function () {
      var url = window.location.href;
      var title = document.title;
      if (navigator.share) {
        navigator.share({ title: title, text: "Check out this community page!", url: url });
      } else {
        navigator.clipboard.writeText(url).then(function () {
          alert("Page link copied to clipboard!");
        });
      }
    });
  }
})();

// ---------- Gallery Download & Filter (gallery.html) ----------
(function () {
  var downloadBtn = document.getElementById("lightboxDownload");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", function () {
      var img = document.getElementById("lightboxImage");
      if (img && img.src) {
        var a = document.createElement("a");
        a.href = img.src;
        a.download = "community-photo.jpg";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    });
  }

  // Gallery category filter
  document.querySelectorAll("[data-gallery-type]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("[data-gallery-type]").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      var type = btn.getAttribute("data-gallery-type");
      // Trigger gallery re-render if function exists
      if (typeof renderGallery === "function") {
        renderGallery(type);
      }
    });
  });
})();

// ---------- Events Category Filter (events.html) ----------
(function () {
  document.querySelectorAll("[data-event-type]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("[data-event-type]").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      var type = btn.getAttribute("data-event-type");
      if (typeof renderEvents === "function") {
        renderEvents(type);
      }
    });
  });
})();

// Add to Calendar (.ics) for event cards
window.addToCalendar = function (title, date, location, desc) {
  var ics =
    "BEGIN:VCALENDAR\n" +
    "VERSION:2.0\n" +
    "BEGIN:VEVENT\n" +
    "SUMMARY:" + title + "\n" +
    "DTSTART:" + date + "\n" +
    "LOCATION:" + location + "\n" +
    "DESCRIPTION:" + desc + "\n" +
    "END:VEVENT\n" +
    "END:VCALENDAR";
  var blob = new Blob([ics], { type: "text/calendar" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "community-event.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Event countdown timer for user dashboard
(function () {
  var cdDays = document.getElementById("cdDays");
  var cdHours = document.getElementById("cdHours");
  var cdMins = document.getElementById("cdMins");
  var cdSecs = document.getElementById("cdSecs");
  if (!cdDays || !cdHours || !cdMins || !cdSecs) return;

  // Target date: November 6, 2026 at 9:00 AM
  var targetDate = new Date("2026-11-06T09:00:00").getTime();

  function updateCountdown() {
    var now = new Date().getTime();
    var diff = targetDate - now;
    if (diff < 0) diff = 0;

    var days = Math.floor(diff / (1000 * 60 * 60 * 24));
    var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    var mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    var secs = Math.floor((diff % (1000 * 60)) / 1000);

    cdDays.textContent = String(days).padStart(2, "0");
    cdHours.textContent = String(hours).padStart(2, "0");
    cdMins.textContent = String(mins).padStart(2, "0");
    cdSecs.textContent = String(secs).padStart(2, "0");
  }

  updateCountdown();
  setInterval(updateCountdown, 1000);
})();
