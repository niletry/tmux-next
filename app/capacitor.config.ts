import type { CapacitorConfig } from "@capacitor/cli";

/**
 * tmux-next shell. The WebView loads local assets (www/) — a connection page
 * first, then the copied tmux-next front-end — and talks to the user's own
 * server over HTTPS. Nothing about the app itself is remote.
 */
const config: CapacitorConfig = {
  appId: "work.tmuxnext.app",
  appName: "tmux-next",
  webDir: "www",
  server: {
    androidScheme: "https",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
  },
};

export default config;
