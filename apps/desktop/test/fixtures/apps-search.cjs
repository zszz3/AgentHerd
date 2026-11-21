const { app, BrowserWindow } = require("electron");

// Runs in the renderer, with no Node access.
async function searchScenario() {
  const until = async (f) => {
    const end = Date.now() + 5000;
    while (!f()) {
      if (Date.now() > end) throw new Error("UI test timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  const names = () =>
    [...document.querySelectorAll("div.truncate.font-medium")]
      .map((e) => e.textContent)
      .filter((t) => t === "Gmail" || t === "GitHub");
  const fill = async (value) => {
    const input = document.querySelector("input[type=search]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  };
  await until(() => window.searchTest?.pending() === 1);
  await fill("github");
  const immediate = names();
  await until(() => window.searchTest.pending() === 2);
  window.searchTest.answer(1, true);
  await tick();
  const newer = names();
  window.searchTest.answer(0, false);
  await tick();
  const late = names();
  const storedAfterLate = window.searchTest.stored();
  await fill("");
  const clearedPending = names();
  await until(() => window.searchTest.pending() === 3);
  window.searchTest.answer(2, false);
  await tick();
  const cleared = names();
  await fill("github");
  window.searchTest.event();
  await tick();
  const event = names();
  await fill("code_host");
  const slugOnly = names();
  await fill("no-such-app");
  const noMatch = names();
  window.searchTest.many();
  await fill("");
  const appNames = () =>
    [...document.querySelectorAll("div.truncate.font-medium")]
      .map((e) => e.textContent)
      .filter((s) => s.startsWith("App "));
  const more = () =>
    [...document.querySelectorAll("button")].find((e) => e.textContent.includes("显示更多"));
  const firstBatch = appNames();
  const callsBeforeMore = window.searchTest.pending();
  more()?.click();
  await tick();
  const secondBatch = appNames();
  more()?.click();
  await tick();
  const lastBatch = appNames();
  const moreAtEnd = more() !== undefined;
  const extraCalls = window.searchTest.pending() - callsBeforeMore;
  await fill("app");
  const searchBatch = appNames();
  more()?.click();
  await tick();
  const searchExpanded = appNames().length;
  await fill("");
  const resetBatch = appNames().length;
  return {
    firstBatch,
    secondBatch,
    lastBatch,
    moreAtEnd,
    extraCalls,
    searchBatch,
    searchExpanded,
    resetBatch,
    immediate,
    newer,
    late,
    storedAfterLate,
    event,
    clearedPending,
    cleared,
    slugOnly,
    noMatch,
  };
}

const stage = (name) => process.stderr.write(`SEARCH_STAGE ${name}\n`);
stage("electron entry loaded");
app.on("will-quit", () => stage("electron will quit"));
app.on("quit", () => stage("electron quit"));
app.whenReady().then(async () => {
  stage("electron ready");
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  try {
    await win.loadFile(process.argv[2]);
    stage("page loaded; scenario started");
    const result = await win.webContents.executeJavaScript(`(${searchScenario.toString()})()`);
    stage("scenario finished");
    console.log(`SEARCH_RESULT ${JSON.stringify(result)}`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
