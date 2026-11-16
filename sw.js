/* Community Connect - simple offline cache (service worker)
   Only runs when the site is hosted on http:// or https://.
   Opening the folder directly with file:// skips this file. */

var CACHE_NAME = "community-connect-v35";

var CORE_FILES = [
  "index.html",
  "about.html",
  "news.html",
  "announcements.html",
  "events.html",
  "activities.html",
  "gallery.html",
  "contact.html",
  "hotlines.html",
  "news-ai.html",
  "search.html",
  "register.html",
  "user-login.html",
 "admin-login.html",
  "css/style.css",
  "images/Community Plaza.jpg",
  "images/Health Center Visit.jpg",
  "images/logo.svg"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(CORE_FILES.map(function (file) {
        return cache.add(file).catch(function () {});
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, copy);
        }).catch(function () {});
        return response;
      }).catch(function () {
        if (event.request.mode === "navigate") return caches.match("offline.html");
        return caches.match("index.html");
      });
    })
  );
});
