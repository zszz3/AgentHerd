const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(process.argv[2]);
    const passed = await win.webContents.executeJavaScript("window.runDockScenario()");
    app.exit(passed ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
