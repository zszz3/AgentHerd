// Usage on a clean GitHub-hosted Windows runner: node scripts/windows-dws-handoff.mjs
// <absolute installed dws.exe> [--probe-page]. Do not upload the temp tree or CLI output.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

class SmokeError extends Error {}

function validateLink(line) {
  const invalid = new SmokeError("invalid-handoff");
  const endpoint = "https://login.dingtalk.com/oauth2/auth";
  if (!line.startsWith(`${endpoint}?`) || /[\s#\\]/u.test(line)) throw invalid;
  const url = new URL(line);
  const redirects = url.searchParams.getAll("redirect_uri");
  const types = url.searchParams.getAll("response_type");
  if (types.length !== 1 || types[0] !== "code" || redirects.length !== 1) throw invalid;
  // Upstream listens on an ephemeral port and serves this exact route.
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/callback$/u.exec(
    redirects[0],
  );
  if (!match || Number(match[1]) > 65535) throw invalid;
  return url;
}

function readHandoff(executable, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["auth", "login", "--no-browser", "--format=json"], {
      cwd: root,
      env: {
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        APPDATA: root,
        LOCALAPPDATA: root,
        TEMP: root,
        TMP: root,
        DWS_CONFIG_DIR: join(root, "config"),
        DWS_KEYCHAIN_DIR: join(root, "credentials"),
        DO_NOT_TRACK: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let url;
    let failure;
    let pending = "";
    let bytes = 0;
    function stop(reason) {
      failure = reason;
      child.kill();
    }
    const timer = setTimeout(() => stop("cli-timeout"), 20000);
    child.on("error", () => {
      failure = "cli-unavailable";
    });
    child.stderr.on("error", () => stop("cli-unavailable"));
    // Even with --format=json, v1.0.69 prints the URL on a separate stderr line;
    // stdout JSON would describe a completed login, which this smoke must never await.
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (url || failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) return stop("cli-output-limit");
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!/^https?:\/\//iu.test(line)) continue;
        try {
          url = validateLink(line);
        } catch {
          return stop("invalid-handoff");
        }
        child.kill(); // Close the official callback listener before any HTTPS probe.
        return;
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (failure || !url) reject(new SmokeError(failure ?? "no-handoff"));
      else resolve(url);
    });
  });
}

async function probePage(url, report) {
  report.page = "unavailable";
  // Do not route a session URL through an intermediary, or ignore a runner's proxy policy.
  if (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new SmokeError("network-policy");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html", DNT: "1" },
      signal: controller.signal,
    });
    report.httpStatus = response.status;
    report.page = "response-only";
    if (
      response.status !== 200 ||
      !/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")
    ) {
      throw new SmokeError("not-html-page");
    }
    // Confirm a nonempty HTML response without buffering the page or loading subresources.
    const first = await response.body?.getReader().read();
    if (!first?.value?.length) throw new SmokeError("empty-page");
    report.page = "html-response";
  } catch (err) {
    throw err instanceof SmokeError ? err : new SmokeError("request-failed");
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

const report = { link: "not-validated", page: "not-requested", httpStatus: null, error: null };
let root;
try {
  if (
    process.platform !== "win32" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    throw new SmokeError("windows-ci-required");
  }
  const [executable, flag, ...extra] = process.argv.slice(2);
  if (
    !executable ||
    !/^[a-z]:[\\/]/iu.test(executable) ||
    basename(executable).toLowerCase() !== "dws.exe" ||
    (flag !== undefined && flag !== "--probe-page") ||
    extra.length
  )
    throw new SmokeError("invalid-arguments");
  root = await mkdtemp(join(tmpdir(), "agentherd-dws-handoff-"));
  const url = await readHandoff(executable, root);
  report.link = "validated";
  if (flag) await probePage(url, report);
} catch (err) {
  // Never emit a path, raw exception, redirect Location, URL, QR, body or CLI output.
  report.error = err instanceof SmokeError ? err.message : "smoke-failed";
} finally {
  if (root) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      report.error = "cleanup-failed";
    }
  }
}
console.log(JSON.stringify(report));
process.exitCode = report.error === null ? 0 : 1;
