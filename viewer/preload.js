/**
 * Preload bridge: exposes a minimal, read-only API to the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("statusApi", {
  /**
   * Subscribe to status snapshots pushed by the main process.
   * @param {(snapshot: object) => void} callback Called with each snapshot.
   */
  onStatus: (callback) => ipcRenderer.on("status", (_event, snap) => callback(snap)),
  /**
   * Re-run usage.py now and return the current snapshot.
   * @returns {Promise<object>} The snapshot.
   */
  refresh: () => ipcRenderer.invoke("refresh"),
  /**
   * Save new setting values (validated; applied at once).
   * @param {object} values Setting name -> number.
   * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
   */
  saveSettings: (values) => ipcRenderer.invoke("save-settings", values),
  /**
   * Open a session's context folder or memory (Finder, or the default app
   * for a file). Only paths shown in the current status are opened.
   * @param {string} p Path from a snapshot's `links`.
   * @returns {Promise<string>} Empty on success, else the error.
   */
  openPath: (p) => ipcRenderer.invoke("open-path", p),
});
