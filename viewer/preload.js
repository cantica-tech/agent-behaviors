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
});
