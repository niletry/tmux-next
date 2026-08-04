// Service worker for tmux-next push notifications.
//
// Its whole job: turn an incoming push into a system notification, and on a tap
// open (or focus) the terminal for that session. Nothing is cached here — the
// app is served fresh from disk and there is no offline story to keep.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push with a missing or malformed body still deserves a generic nudge.
  }
  const title = data.title || "tmux 会话";
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
  const target = session ? `terminal.html?target=${encodeURIComponent(session)}` : "./";

  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus a tab already on this session; otherwise open a new one.
      for (const win of wins) {
        if (win.url.includes(target) && "focus" in win) return win.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});
