// "Install App": makes the dashboard / Employee Portal installable as a phone or desktop app (PWA).
// Every element with [data-install-app] becomes an install button. Browsers that offer one-click
// install (Chrome, Edge, Android) get the native prompt; others (iPhone Safari, insecure http://)
// get short step-by-step instructions instead.
(function () {
  let deferredPrompt = null;

  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

  function updateButtons() {
    document.querySelectorAll("[data-install-app]").forEach((btn) => btn.classList.toggle("hidden", isStandalone()));
  }

  function showHelp() {
    const help = document.getElementById("installHelp");
    const steps = document.getElementById("installHelpSteps");
    if (!help || !steps) return;
    let items;
    if (!window.isSecureContext && !isLocalhost) {
      items = [
        "App install needs the secure address of this site (it starts with https://).",
        "Open the https:// link from your administrator, then tap Install App again.",
      ];
    } else if (isIos) {
      items = [
        "Open this page in Safari.",
        "Tap the Share button (the square with an arrow).",
        "Choose \"Add to Home Screen\", then tap Add.",
      ];
    } else {
      items = [
        "Open the browser menu (the three dots at the top right).",
        "Choose \"Install app\" or \"Add to Home screen\".",
        "Confirm. The app opens from your home screen or desktop like any other app.",
      ];
    }
    steps.innerHTML = items.map((t) => `<li>${t.replace(/</g, "&lt;")}</li>`).join("");
    help.classList.remove("hidden");
  }

  async function install() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch { /* dismissed */ }
      deferredPrompt = null;
      updateButtons();
      return;
    }
    showHelp();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    updateButtons();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    updateButtons();
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-install-app]").forEach((btn) => btn.addEventListener("click", install));
    document.querySelectorAll("[data-install-help-close]").forEach((btn) => btn.addEventListener("click", () => {
      document.getElementById("installHelp")?.classList.add("hidden");
    }));
    updateButtons();
  });

  if ("serviceWorker" in navigator && (window.isSecureContext || isLocalhost)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => null);
    });
  }
})();
