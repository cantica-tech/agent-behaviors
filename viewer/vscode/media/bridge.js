/**
 * Webview bridge: gives the shared renderer the same `window.statusApi` the
 * Electron preload provides, on top of VS Code's webview messaging.
 */
(function () {
  const vscode = acquireVsCodeApi();
  /** Subscribers to status snapshots. */
  const listeners = [];

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "status") for (const fn of listeners) fn(msg.snapshot);
  });

  window.statusApi = {
    /**
     * Subscribe to status snapshots pushed by the extension.
     * @param {(snapshot: object) => void} callback Called with each snapshot.
     */
    onStatus(callback) {
      listeners.push(callback);
      vscode.postMessage({ type: "ready" });
    },
    /**
     * Ask the extension to re-run usage.py. The fresh snapshot arrives through
     * onStatus, so this resolves with the latest one already shown.
     * @returns {Promise<object>} A promise that never rejects.
     */
    refresh() {
      vscode.postMessage({ type: "refresh" });
      return new Promise((resolve) => listeners.push(function once(snap) {
        listeners.splice(listeners.indexOf(once), 1);
        resolve(snap);
      }));
    },
  };
})();
