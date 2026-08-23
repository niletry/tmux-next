// Turning push notifications on and off from the list page.
//
// A subscription is a browser <-> push-service pairing that this server can
// later deliver to. Enabling it registers the service worker, asks the OS for
// permission, subscribes with the server's VAPID key, and hands the
// subscription to the server; disabling it tears that down.

import { tr } from "./i18n-apply.js";

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function existingSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? await reg.pushManager.getSubscription() : null;
}

async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    // On iPhone this only works once the page is added to the Home Screen.
    throw new Error(tr("push.denied"));
  }
  // A module worker: sw.js imports the logic that decides which window a tapped
  // notification lands in, so that part can be tested outside a browser.
  const reg = await navigator.serviceWorker.register("sw.js", { type: "module" });
  await navigator.serviceWorker.ready;
  const { key } = await (await fetch("api/push/key")).json();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(key),
  });
  const res = await fetch("api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error(tr("push.subscribeFailed"));
}

async function disable() {
  const sub = await existingSubscription();
  if (sub) await sub.unsubscribe();
}

/**
 * Wires the header bell to the subscription state. Hidden entirely where push
 * isn't supported, so it never offers something that can't work.
 */
export async function initNotifyToggle(btn) {
  if (!supported()) {
    btn.style.display = "none";
    return;
  }

  const reflect = (on) => {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", tr(on ? "push.turnOff" : "push.turnOn"));
  };
  reflect(!!(await existingSubscription()));

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (await existingSubscription()) {
        await disable();
        reflect(false);
      } else {
        await enable();
        reflect(true);
      }
    } catch (e) {
      alert(e && e.message ? e.message : tr("push.actionFailed"));
    } finally {
      btn.disabled = false;
    }
  });
}
