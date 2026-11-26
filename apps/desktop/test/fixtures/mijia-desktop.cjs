const { app, BrowserWindow, utilityProcess } = require("electron");
const { EventEmitter, once } = require("node:events");
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const [out, scenario] = process.argv.slice(2);
const report = (result) => process.stdout.write(`SEARCH_RESULT ${JSON.stringify(result)}\n`);
app.setPath("userData", join(out, "user-data"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
const { DesktopMijiaTransport, registerDesktopMijia } = require(join(out, "boundary.cjs"));
const page = join(out, "index.html");
writeFileSync(
  page,
  '<!doctype html><meta charset="utf-8"><div id="root"></div><script defer src="panel.js"></script>',
);
// Only these test sources can supply fixture eligibility. Do not start an AgentHerd server.
let child;
const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 5000;
  do {
    const result = await check();
    if (result) return result;
    await sleep();
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
const mutations = () => {
  const file = join(out, "mutations");
  if (!existsSync(file)) return [];
  const log = readFileSync(file, "utf8");
  return log
    .slice(0, log.lastIndexOf("\n") + 1)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
};
const count = () => mutations().length;
const makeWindow = (show = true) =>
  new BrowserWindow({
    width: 900,
    height: 650,
    show,
    focusable: false,
    webPreferences: {
      preload: join(out, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

async function checkReplacement() {
  const transport = new DesktopMijiaTransport();
  class Port extends EventEmitter {
    postMessage(message) {
      this.last = message;
    }
  }
  const old = new Port();
  const current = new Port();
  transport.attach(old);
  transport.attach(current);
  old.emit("message", { type: "mijia-desktop:ready" });
  if (transport.available()) throw new Error("Old child enabled replacement");
  current.emit("message", { type: "mijia-desktop:ready" });
  const proposal = "00000000-0000-0000-0000-000000000001";
  const preGrant = transport.call(1, ["confirm", [proposal]], () => true);
  const { id, generation } = current.last;
  const challenge = { type: "mijia-desktop:authorize", id, generation };
  const reply = { type: "mijia-desktop:reply", id, generation, ok: true };
  old.emit("message", challenge);
  old.emit("message", { ...reply, value: { state: "acknowledged" } });
  old.emit("exit");
  if (!transport.available()) throw new Error("Old exit disconnected replacement");
  current.emit("message", { ...challenge, generation: generation + 1 });
  if (current.last.granted !== false) throw new Error("Wrong generation was authorized");
  current.emit("message", { ...challenge, id: id + 1 });
  if (current.last.granted !== false) throw new Error("Wrong pending confirmation was authorized");
  transport.revoke(generation);
  if ((await preGrant).state !== "not-sent")
    throw new Error("Retired confirmation carried another child's outcome");
  current.emit("message", challenge);
  if (current.last.granted !== false) throw new Error("Retired confirmation was authorized");

  const pending = transport.call(2, ["confirm", [proposal]], () => true);
  const valid = { type: "mijia-desktop:authorize", id: current.last.id, generation: 2 };
  current.emit("message", valid);
  if (current.last.granted !== true) throw new Error("Expected a matching grant");
  current.emit("message", valid);
  if (current.last.granted !== false) throw new Error("Matching grant was issued twice");
  current.emit("message", { ...reply, generation: 2, value: { state: "acknowledged" } });
  transport.detach(current);
  if ((await pending).state !== "unknown")
    throw new Error("Late reply settled a different confirmation");
}

app
  .whenReady()
  .then(async () => {
    await checkReplacement();
    const transport = new DesktopMijiaTransport();
    const desktop = registerDesktopMijia(transport);
    const win = makeWindow(false);
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") process.stderr.write(`${event.message}\n`);
    });
    const run = (code) => win.webContents.executeJavaScript(code);
    const available = () => run("agentherd.mijiaControl.available()");
    const ready = () => until(available, "local desktop bridge");
    desktop.watch(win, pathToFileURL(page).href);
    await win.loadFile(page);
    win.showInactive();
    desktop.connection(true);
    const external = await available();
    child = utilityProcess.fork(join(__dirname, "mijia-worker.mts"), [out], { stdio: "pipe" });
    child.stderr?.on("data", (data) => process.stderr.write(data));
    transport.attach(child);
    await ready();
    const pet = makeWindow(false);
    await pet.loadFile(page);
    const wrongWindow = await pet.webContents.executeJavaScript(
      "agentherd.mijiaControl.available()",
    );
    pet.destroy();
    const wrongDocument = join(out, "other.html");
    writeFileSync(wrongDocument, "<!doctype html><title>Not the main document</title>");
    await win.loadFile(wrongDocument);
    if (await available()) throw new Error("Unexpected document could use the private bridge");
    await win.loadFile(page);
    await ready();
    const publicSurface = await run(
      "typeof agentherd.host.confirm === 'undefined' && typeof agentherd.host.prepare === 'undefined'",
    );
    if (!publicSurface) throw new Error("Private methods surfaced on the public preload bridge");

    win.webContents.debugger.attach("1.3");
    const text = () => run("document.body.innerText");
    const waitText = (value) => until(async () => (await text()).includes(value), value);
    const select = async (label, value) => {
      const query = `Array.from(document.querySelectorAll('label')).find((l) => l.textContent === ${JSON.stringify(label)})?.control`;
      await until(() => run(`!!(${query})`), label);
      await run(
        `(() => { const e = ${query}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
    };
    const click = async (label) => {
      const point = await until(
        () =>
          run(`(() => {
      const b = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === ${JSON.stringify(label)} && !b.disabled);
      if (!b) return undefined;
      b.scrollIntoView({ block: 'nearest' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`),
        label,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type,
          button: "left",
          clickCount: 1,
          ...point,
        });
      }
    };
    const request = {
      kind: "property",
      homeId: "fictional-home",
      deviceId: "fictional-lamp",
      siid: 2,
      piid: 1,
      value: true,
    };
    const prepare = () => run(`agentherd.mijiaControl.prepare(${JSON.stringify(request)})`);
    const confirm = (id, gesture = false) =>
      win.webContents.executeJavaScript(
        `agentherd.mijiaControl.confirm(${JSON.stringify(id)})`,
        gesture,
      );
    if (scenario === "retire-before-grant") {
      const proposal = await prepare();
      const post = child.postMessage.bind(child);
      const queuedRevokes = [];
      let authorization;
      child.postMessage = (message) => {
        if (message.type === "mijia-desktop:revoke") queuedRevokes.push(message);
        else {
          if (message.type === "mijia-desktop:authorization") authorization = message;
          post(message);
        }
      };
      const hold = join(out, "hold-refresh");
      writeFileSync(hold, "");
      const completion = confirm(proposal.id, true);
      await until(() => existsSync(join(out, "refreshing")), "confirmation refresh");
      let challenge;
      let reply;
      child.on("message", (message) => {
        if (message.type === "mijia-desktop:authorize") challenge = message;
        if (message.type === "mijia-desktop:reply") reply = message;
      });
      win.hide();
      await until(async () => !(await available()), "retired document");
      const result = await completion;
      if (result.state !== "not-sent")
        throw new Error("Pre-grant retirement was not classified as not-sent");
      if (queuedRevokes.length !== 1) throw new Error("Expected one queued retirement notice");
      // Deliver the final arbitration request over the actual port before delivering revoke.
      unlinkSync(hold);
      await until(() => reply, "Host result after final arbitration");
      const denied =
        challenge !== undefined &&
        authorization?.granted === false &&
        authorization.id === challenge.id &&
        authorization.generation === challenge.generation &&
        reply.id === challenge.id &&
        reply.generation === challenge.generation &&
        reply.ok === true &&
        reply.value?.state === "not-sent";
      for (const revoke of queuedRevokes) post(revoke);
      win.showInactive();
      await ready();
      await waitText("控制目标");
      report({
        result,
        denied,
        staleProposal: (await confirm(proposal.id, true)).state,
        mutations: mutations(),
      });
      return;
    }

    if (scenario === "lose-utility") {
      await select("控制目标", "0");
      await select("设备操作", "0");
      await select("Power", "0");
      await click("预览操作");
      await waitText("Power：true");
      writeFileSync(join(out, "hold-receipt"), "");
      await click("确认");
      await until(() => count() === 1, "one simulated dispatch before utility loss");
      const exit = once(child, "exit");
      if (!child.kill()) throw new Error("Could not stop fixture utility");
      // Only this fixture utility is killed; do not wait for it again in cleanup.
      await exit;
      child = undefined;
      await waitText("桌面控制不可用");
      await waitText("先检查设备，未自动重试");
      const stalePreview = await run("!!document.querySelector('[aria-label=操作预览]')");
      const beforeReload = mutations();
      // Reattach a new owned child to the surviving document. It must not resend or regain a preview.
      child = utilityProcess.fork(join(__dirname, "mijia-worker.mts"), [out], { stdio: "pipe" });
      child.stderr?.on("data", (data) => process.stderr.write(data));
      transport.attach(child);
      await ready();
      await waitText("控制目标");
      await waitText("先检查设备，未自动重试");
      const newSelection = await run("document.querySelector('select')?.value");
      const loaded = once(win.webContents, "did-finish-load");
      win.webContents.reload();
      await loaded;
      await ready();
      await waitText("控制目标");
      report({
        beforeReload,
        mutations: mutations(),
        stalePreview,
        newSelection,
        warningAfterReload: (await text()).includes("先检查设备，未自动重试"),
      });
      return;
    }

    const prior = await prepare();
    if ((await confirm(prior.id)).reason !== "blocked")
      throw new Error("Confirmation did not require owner activation");
    const iframe = await run(`new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><title>Child frame</title>';
    frame.onload = () => resolve(typeof frame.contentWindow.agentherd);
    document.body.append(frame);
  })`);
    if (iframe !== "undefined") throw new Error("Subframe unexpectedly exposed a desktop preload");
    writeFileSync(join(out, "hold"), "");
    const prepareCrossed = prepare().then(
      () => false,
      () => true,
    );
    await until(() => existsSync(join(out, "reading")), "held inventory read");
    win.hide();
    win.showInactive();
    unlinkSync(join(out, "hold"));
    await ready();
    if (!(await prepareCrossed)) throw new Error("Retired prepare returned a proposal");
    const old = (await confirm(prior.id, true)).state;
    const crossed = count();
    const priorReload = await prepare();
    await win.webContents.reload();
    await ready();
    const reloaded = await confirm(priorReload.id, true);
    if (reloaded.state !== "not-sent" || reloaded.reason !== "cancelled")
      throw new Error("Reload retained an old proposal");

    await select("控制目标", "0");
    await select("设备操作", "0");
    await select("Power", "0");
    await click("预览操作");
    await waitText("Power：true");
    await click("取消");
    const cancelled = count();
    await click("预览操作");
    await waitText("确认");
    const beforeConfirm = count();
    await click("确认");
    await waitText("已收到执行回执");
    await select("设备操作", "1");
    await run(
      "Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Brightness').control.focus()",
    );
    await win.webContents.debugger.sendCommand("Input.insertText", { text: "40" });
    await click("预览操作");
    await waitText("40");
    await click("确认");
    await waitText("已收到执行回执");
    await select("设备操作", "2");
    await select("Mode", "1");
    await click("预览操作");
    await waitText("Soft (2)");
    await click("确认");
    await waitText("已收到执行回执");
    await select("设备操作", "3");
    await select("Mode", "0");
    await select("Power", "0");
    await click("预览操作");
    await waitText("Reading (1)");
    await waitText("Power：true");
    await click("确认");
    await waitText("已收到执行回执");
    await select("控制目标", "2");
    await click("预览操作");
    await waitText("回执不能确认每一步");
    await click("确认");
    await waitText("已收到执行回执");

    const last = await prepare();
    writeFileSync(join(out, "lose-result"), "");
    const lost = await confirm(last.id, true);
    const replay = await confirm(last.id, true);
    if (lost.state !== "unknown" || replay.state !== "not-sent" || replay.reason !== "cancelled") {
      throw new Error("Loss did not produce one unknown result");
    }
    report({
      external,
      wrongWindow,
      old,
      cancelled,
      crossed,
      beforeConfirm,
      mutations: mutations(),
    });
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    if (!child) return app.quit();
    child.once("exit", () => app.quit());
    child.postMessage({ type: "stop" });
    setTimeout(() => {
      child.kill();
      app.quit();
    }, 2000).unref();
  });
