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
  /**
   * Leave a prompt in a session's inbox (any agent that follows the
   * session-status skill reads it when it next publishes).
   * @param {string} session Session id.
   * @param {string} text Prompt.
   * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
   */
  sendMessage: (session, text) => ipcRenderer.invoke("send-message", session, text),
  /**
   * Open a session so the user can type to it: attach to a background Claude
   * Code session in Terminal, else open its project folder.
   * @param {string} session Session id.
   * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
   */
  openSession: (session) => ipcRenderer.invoke("open-session", session),
  /**
   * Copy text to the clipboard.
   * @param {string} text Text to copy.
   * @returns {Promise<boolean>} True when copied.
   */
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
});
