/**
 * Webview bridge: gives the shared renderer the same `window.statusApi` the
 * Electron preload provides, on top of VS Code's webview messaging.
 */
(function () {
  const vscode = acquireVsCodeApi();
  /** Subscribers to status snapshots. */
  const listeners = [];
  /** Pending requests to the extension, by request id. */
  const pending = new Map();
  /** Next request id. */
  let nextId = 1;

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "status") for (const fn of listeners) fn(msg.snapshot);
    if (msg && msg.type === "result" && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });

  /**
   * Send a request to the extension and wait for its result.
   * @param {string} type Request type.
   * @param {object} payload Request fields.
   * @returns {Promise<object>} The result the extension sends back.
   */
  function request(type, payload) {
    const id = nextId++;
    vscode.postMessage({ type, id, ...payload });
    return new Promise((resolve) => pending.set(id, resolve));
  }

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
      return request("saveSettings", { values });
    },
    /**
     * Leave a prompt in a session's inbox.
     * @param {string} session Session id.
     * @param {string} text Prompt.
     * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
     */
    sendMessage(session, text) {
      return request("sendMessage", { session, text });
    },
    /**
     * Open a session so the user can type to it (terminal attach, or its folder).
     * @param {string} session Session id.
     * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
     */
    openSession(session) {
      return request("openSession", { session });
    },
    /**
     * Copy text to the clipboard.
     * @param {string} text Text to copy.
     * @returns {Promise<boolean>} True when copied.
     */
    copyText(text) {
      return request("copyText", { text });
    },
    /**
     * Open a session's context folder or memory. The extension opens only
     * paths shown in the current status.
     * @param {string} p Path from a snapshot's `links`.
     */
    openPath(p) {
      vscode.postMessage({ type: "openPath", path: p });
    },
    /** Open VS Code's settings on this extension's page. */
    openSettings() {
      vscode.postMessage({ type: "openSettings" });
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
