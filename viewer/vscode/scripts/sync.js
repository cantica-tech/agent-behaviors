/**
 * Copy the files the extension shares with the Electron viewer into media/,
 * so the packaged .vsix is self-contained: the status monitor, renderer and
 * styles from ../shared, and usage.py from the session-status skill.
 * Run before packaging (npm run sync; vscode:prepublish runs it too).
 */

const fs = require("fs");
const path = require("path");

/** Extension root (the folder holding package.json). */
const ROOT = path.join(__dirname, "..");
/** Destination of the copies. */
const MEDIA = path.join(ROOT, "media");
/** Source path -> file name in media/. */
const FILES = {
  [path.join(ROOT, "..", "shared", "status.js")]: "status.js",
  [path.join(ROOT, "..", "shared", "renderer.js")]: "renderer.js",
  [path.join(ROOT, "..", "shared", "styles.css")]: "styles.css",
  [path.join(ROOT, "..", "..", "session-status", "scripts", "usage.py")]: "usage.py",
};

fs.mkdirSync(MEDIA, { recursive: true });
for (const [src, name] of Object.entries(FILES)) {
  fs.copyFileSync(src, path.join(MEDIA, name));
  console.log(`synced media/${name}`);
}
