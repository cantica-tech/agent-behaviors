/**
 * Preload of a chat window: exposes the chat API of chat-main.js.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatApi", {
  /**
   * Session, folder, permission modes and known slash commands of this window.
   * @returns {Promise<object>} Chat info.
   */
  info: () => ipcRenderer.invoke("chat-info"),
  /**
   * Send a message with optional attachments (absolute paths).
   * @param {string} text Message text.
   * @param {string[]} files Attachments.
   * @returns {Promise<{ok: boolean, error?: string}>} The outcome.
   */
  send: (text, files) => ipcRenderer.invoke("chat-send", text, files),
  /** Interrupt the agent (the next message resumes the session). */
  stop: () => ipcRenderer.invoke("chat-stop"),
  /**
   * Change the permission mode (applies from the next message).
   * @param {string} mode One of info().modes.
   * @returns {Promise<boolean>} True when accepted.
   */
  setMode: (mode) => ipcRenderer.invoke("chat-mode", mode),
  /**
   * Files of the session folder matching a query, for @-context.
   * @param {string} query Part of a path.
   * @returns {Promise<string[]>} Relative paths.
   */
  files: (query) => ipcRenderer.invoke("chat-files", query),
  /**
   * Let the user pick files to attach.
   * @returns {Promise<string[]>} Absolute paths.
   */
  pickFiles: () => ipcRenderer.invoke("chat-pick"),
  /**
   * Subscribe to chat events (init, assistant, tool_result, result, status, stderr, exit).
   * @param {(event: object) => void} callback Called with each event.
   */
  onEvent: (callback) => ipcRenderer.on("chat-event", (_e, ev) => callback(ev)),
});
