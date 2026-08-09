self.addEventListener(
  "notificationclick",
  (event) => {
    event.notification.close();

    const targetUrl =
      event.notification.data?.url || "/";

    event.waitUntil(
      clients
        .matchAll({
          type: "window",
          includeUncontrolled: true,
        })
        .then((clientList) => {
          for (const client of clientList) {
            if ("focus" in client) {
              client.navigate(targetUrl);
              return client.focus();
            }
          }

          return clients.openWindow(targetUrl);
        })
    );
  }
);

importScripts(
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js"
);

firebase.initializeApp({
  // Salin nilainya persis dari src/firebase.js
  apiKey: "AIzaSyAsYIyD6QkdgUCQ8Gs67OO8LbMSwQzMHWk",
  authDomain: "smartppob-pasirhaur.firebaseapp.com",
  projectId: "smartppob-pasirhaur",
  storageBucket:
    "smartppob-pasirhaur.firebasestorage.app",
  messagingSenderId: "9236752169",
  appId:
    "1:9236752169:web:63f3714d9fb7c001dbb938"
});

const messaging = firebase.messaging();

/*
 * Untuk pesan yang dikirim dari Firebase Console
 * dengan notification title dan body,
 * browser akan menampilkan notifikasi background.
 */
messaging.onBackgroundMessage((payload) => {
  console.log(
    "[sw.js] Pesan background diterima:",
    payload
  );

  const notificationTitle =
    payload.data?.title ||
    payload.notification?.title ||
    "SmartPPOB";

  const notificationOptions = {
    body:
      payload.data?.body ||
      payload.notification?.body ||
      "Ada permintaan pengisian baru.",

    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",

    tag: "smartppob-new-transaction",
    renotify: true,

    data: {
      url:
        payload.data?.url ||
        "/",
    },
  };

  return self.registration.showNotification(
    notificationTitle,
    notificationOptions
  );
});

/* Cache PWA */
const CACHE_NAME = "smartppob-v4";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});