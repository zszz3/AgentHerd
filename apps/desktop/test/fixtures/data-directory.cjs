const { app, BrowserWindow, dialog } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const [, , desktop, profile, parent, phase] = process.argv;
app.setPath("userData", join(profile, "electron"));
let relaunch = false;
// Simulate dialog answers, and let the harness observe both lifecycles separately.
app.relaunch = () => {
  relaunch = true;
};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
dialog.showMessageBox = async (_win, options) => ({ response: options.buttons.length - 1 });

// Main starts applying a request only after the window's first paint (ready-to-show). This
// listener is added first, so it reads what the owner sees before the copy can start, and
// counts the copy progress the window receives.
let firstPaint;
app.once("browser-window-created", (_event, win) => {
  firstPaint = new Promise((resolve) => {
    win.once("ready-to-show", () => {
      win.webContents
        .executeJavaScript(`(() => {
          window.__copied = 0;
          window.agentherd.dataDirectory.onProgress((files) => { window.__copied = files; });
          return document.body.innerText;
        })()`)
        .then(resolve, resolve);
    });
  });
});

(async () => {
  await import(pathToFileURL(join(desktop, "out/main/index.js")).href);
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  const page = win.webContents;
  if (page.isLoading()) await new Promise((resolve) => page.once("did-finish-load", resolve));
  const result = await page.executeJavaScript(`(async () => {
    const sleep = () => new Promise(r => setTimeout(r, 30));
    const api = window.agentherd.dataDirectory;
    const busy = (state) => state === 'starting' || state === 'moving';
    while (busy((await api.status()).state)) await sleep();
    while (!(await window.agentherd.host.status().catch(() => undefined))) await sleep();
    const view = await api.status();
    const host = await window.agentherd.host.status();
    const copied = window.__copied;
    const change = ${JSON.stringify(phase)} === 'first' ? await api.change() : undefined;
    return { view, host: host.home, copied, change };
  })()`);
  const painted = String(await firstPaint);
  console.log(`SEARCH_RESULT ${JSON.stringify({ ...result, painted, relaunch })}`);
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
