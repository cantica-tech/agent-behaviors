/**
 * Webview bridge: gives the shared renderer the same `window.statusApi` the
 * Electron preload provides, on top of VS Code's webview messaging.
 */
(function () {
  const vscode = acquireVsCodeApi();
  /** Subscribers to status snapshots. */
  const listeners = [];
  /** Pending saveSettings calls, by request id. */
  const pending = new Map();
  /** Next request id. */
  let nextId = 1;

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "status") for (const fn of listeners) fn(msg.snapshot);
    if (msg && msg.type === "saveResult" && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
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
     * Save new setting values (validated by the extension; applied at once).
     * @param {object} values Setting name -> number.
     * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
     */
    saveSettings(values) {
      const id = nextId++;
      vscode.postMessage({ type: "saveSettings", id, values });
      return new Promise((resolve) => pending.set(id, resolve));
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
