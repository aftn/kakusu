import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { loadMetadataCacheMode } from "./cache/settings";
import { clearAllFiles } from "./cache/store";

// "session" モード：ページ起動ごとに IndexedDB キャッシュをクリア
if (loadMetadataCacheMode() === "session") {
  void clearAllFiles();
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker registration for PWA
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // SW registration failed (e.g. localhost without HTTPS) - ignore
  });
}

// Capture beforeinstallprompt for PWA install button
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__pwaInstallPrompt = e as BeforeInstallPromptEvent;
  window.dispatchEvent(new Event("pwa-prompt-available"));
});
