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
});
