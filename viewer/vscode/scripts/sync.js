/**
 * Prepare the extension folder for packaging, so the .vsix is self-contained:
 *
 * - media/: the files shared with the Electron viewer (status monitor,
 *   renderer, styles from ../shared; icons; usage.py of the session-status skill);
 * - skills/: what the extension deploys into <AgentsMonitor>/skills/ at
 *   activation: viewer/README.md, the repository's LICENSE, and the coding/
 *   and session-status/ skill folders;
 * - README.marketplace.md: the Marketplace page, lines 1 to 84 of
 *   viewer/README.md (vsce rewrites its relative links to the repository).
 *
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
  [path.join(ROOT, "..", "shared", "agent-skills.js")]: "agent-skills.js",
  [path.join(ROOT, "..", "viewer.svg")]: "viewer.svg",
  [path.join(ROOT, "..", "icons", "viewer-dark.svg")]: "viewer-dark.svg",
  [path.join(ROOT, "..", "icons", "icon-128.png")]: "icon.png",
  [path.join(ROOT, "..", "..", "session-status", "scripts", "usage.py")]: "usage.py",
};

fs.mkdirSync(MEDIA, { recursive: true });
for (const [src, name] of Object.entries(FILES)) {
  fs.copyFileSync(src, path.join(MEDIA, name));
  console.log(`synced media/${name}`);
}

/** Repository root. */
const REPO = path.join(ROOT, "..", "..");
/** What the extension deploys into <AgentsMonitor>/skills/. */
const SKILLS = path.join(ROOT, "skills");
/** Names never bundled (caches). */
const SKIP = new Set(["__pycache__", ".DS_Store"]);

fs.rmSync(SKILLS, { recursive: true, force: true });
fs.mkdirSync(SKILLS, { recursive: true });
fs.copyFileSync(path.join(REPO, "viewer", "README.md"), path.join(SKILLS, "README.md"));
fs.copyFileSync(path.join(REPO, "LICENSE"), path.join(SKILLS, "LICENSE"));
for (const dir of ["coding", "session-status"]) {
  fs.cpSync(path.join(REPO, dir), path.join(SKILLS, dir), {
    recursive: true,
    filter: (src) => !SKIP.has(path.basename(src)) && !src.endsWith(".pyc"),
  });
}
console.log("synced skills/ (README.md, LICENSE, coding/, session-status/)");

/** Lines of viewer/README.md that make the Marketplace page. */
const MARKETPLACE_LINES = 84;
const readme = fs.readFileSync(path.join(REPO, "viewer", "README.md"), "utf8").split("\n");
fs.writeFileSync(path.join(ROOT, "README.marketplace.md"), `${readme.slice(0, MARKETPLACE_LINES).join("\n").trimEnd()}\n`);
console.log(`synced README.marketplace.md (viewer/README.md lines 1-${MARKETPLACE_LINES})`);
