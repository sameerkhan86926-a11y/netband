"use strict";

/* =========================================
   NETBAND SERVICE WORKER
   Offline App Shell + Cache Management
========================================= */

const CACHE_NAME = "netband-shell-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

/* =========================================
   INSTALL
========================================= */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        /*
         * Cache files individually.
         * A missing optional file won't stop
         * every other shell file from caching.
         */
        for (const file of APP_SHELL) {
          try {
            const response = await fetch(file, {
              cache: "reload"
            });

            if (response.ok) {
              await cache.put(file, response);
            }
          } catch (error) {
            console.warn(
              "NETBAND: Could not cache",
              file
            );
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

/* =========================================
   ACTIVATE
========================================= */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => {
              return (
                key.startsWith("netband-shell-") &&
                key !== CACHE_NAME
              );
            })
            .map((key) => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

/* =========================================
   FETCH
========================================= */

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never cache POST, PUT, DELETE, etc.
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Only handle this website's own files.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Don't intercept browser navigation outside
  // the website's own scope.
  if (!url.href.startsWith(self.registration.scope)) {
    return;
  }

  // HTML navigation: network first, offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put("./index.html", copy);
              });
          }

          return response;
        })
        .catch(async () => {
          return (
            await caches.match(request) ||
            await caches.match("./index.html") ||
            Response.error()
          );
        })
    );

    return;
  }

  // Static assets: cache first, then network.
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(request).then((response) => {
          if (
            response.ok &&
            response.type === "basic"
          ) {
            const copy = response.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(request, copy);
              });
          }

          return response;
        });
      })
      .catch(() => {
        return new Response(
          "NETBAND: This resource is unavailable offline.",
          {
            status: 503,
            statusText: "Service Unavailable",
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      })
  );
});
