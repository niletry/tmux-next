// Service worker for tmux-next push notifications.
//
// Its whole job: turn an incoming push into a system notification, and on a tap
// open (or point an already-open window at) the terminal for that session.
// Nothing is cached here — the app is served fresh from disk and there is no
// offline story to keep.

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
  const path = session ? `terminal.html?target=${encodeURIComponent(session)}` : "./";
  // Absolute, resolved against the SW's scope, so it is unambiguous whether the
  // app is opened fresh or an existing window is redirected.
  const url = new URL(path, self.registration.scope).href;

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open app window: an installed PWA otherwise just comes to the
      // foreground without following the link. Navigate it, then focus.
      for (const win of wins) {
        if ("focus" in win) {
          if ("navigate" in win) {
            try {
              await win.navigate(url);
            } catch {
              // Some engines refuse navigate() cross-document; focus anyway.
            }
          }
          return win.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});
