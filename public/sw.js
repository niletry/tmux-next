// Service worker for tmux-next push notifications.
//
// Its whole job: turn an incoming push into a system notification, and on a tap
// open (or point an already-open window at) the terminal for that session.
// Nothing is cached here — the app is served fresh from disk and there is no
// offline story to keep.

// Registered as a module worker (see push.js), which is what lets it import.
// Every browser that can deliver a push to this app supports that: Chrome 91+,
// Safari 15+ — and iOS only pushes to a Home Screen app from 16.4 — Firefox
// 147+. Firefox ESR below 147 is the one gap, and there registration fails
// loudly rather than silently dropping notifications.
import { targetUrl, openTarget } from "./notification-target.js";

// Take over promptly when a new version is deployed, so fixes here don't wait
// for every tab to close first.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with a missing or malformed body still deserves a generic nudge.
  }
  // The server always sends a title (the session name); this only covers a
  // malformed payload, so it stays language-neutral rather than guessing.
  const title = data.title || "tmux-next";
  const session = data.session || "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // One notification per session: a newer one replaces the older.
      tag: session || undefined,
      renotify: !!session,
      data: { session },
      icon: "favicon.svg",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const session = event.notification.data && event.notification.data.session;
  const url = targetUrl(session, self.registration.scope);
  // Deciding which window to use lives in notification-target.js so it can be
  // tested; everything this handler still owns is service worker glue.
  event.waitUntil(
    openTarget(
      {
        matchAll: () => self.clients.matchAll({ type: "window", includeUncontrolled: true }),
        openWindow: (target) => self.clients.openWindow(target),
      },
      url,
    ),
  );
});
