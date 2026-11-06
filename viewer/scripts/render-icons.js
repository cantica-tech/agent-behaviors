/**
 * Render viewer.svg into the PNG icons the viewers need (neither Electron
 * window icons nor VS Code extension icons accept SVG). Run with Electron:
 *
 *   npm run icons
 *
 * Writes:
 *   icons/icon.png            512 px app icon (Electron window and dock)
 *   icons/icon-128.png        128 px extension icon (VS Code)
 *   icons/viewer-dark.svg     white-stroke copy for dark themes (panel tab icon)
 *
 * The PNGs draw the black line art on a light rounded tile so it stays
 * visible on dark backgrounds; the SVG copies keep it transparent.
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

/** Viewer folder (parent of this script). */
const ROOT = path.join(__dirname, "..");
/** Source artwork. */
const SVG = fs.readFileSync(path.join(ROOT, "viewer.svg"), "utf8");
/** Output folder. */
const OUT = path.join(ROOT, "icons");

/**
 * Render the artwork on a rounded light tile.
 * @param {number} size Output width and height in pixels.
 * @returns {Promise<Electron.NativeImage>} The rendered image.
 */
async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const pad = Math.round(size * 0.14);
  const radius = Math.round(size * 0.22);
  const img = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;
  const page = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:#f4f5f7;
      box-sizing:border-box;padding:${pad}px;display:flex">
      <img src="${img}" style="width:100%;height:100%"></div></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return image.resize({ width: size, height: size, quality: "best" });
}

app.whenReady().then(async () => {
  // Keep running while windows are created and destroyed.
  app.on("window-all-closed", () => {});
  fs.mkdirSync(OUT, { recursive: true });
  const image = await render(512);
  fs.writeFileSync(path.join(OUT, "icon.png"), image.toPNG());
  fs.writeFileSync(path.join(OUT, "icon-128.png"), image.resize({ width: 128, height: 128, quality: "best" }).toPNG());
  fs.writeFileSync(path.join(OUT, "viewer-dark.svg"), SVG.replace("<svg ", '<svg fill="#ffffff" '));
  console.log("wrote icons/icon.png, icons/icon-128.png, icons/viewer-dark.svg");
  app.quit();
});
