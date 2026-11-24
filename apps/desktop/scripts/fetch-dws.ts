import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "1.0.69";
// Pin both the release archive and the executable extracted from that archive.
const assets = new Map([
  [
    "darwin-x64",
    {
      name: "dws-darwin-amd64.tar.gz",
      digest: "4ab7511b7481531195a0d2d6cb16df9546e9513f3d375a165fd1afc892b0e559",
      executableDigest: "71348901880277794c6ec0e03137571404a8f0acac1031b0aedc7e5491192cfc",
    },
  ],
  [
    "darwin-arm64",
    {
      name: "dws-darwin-arm64.tar.gz",
      digest: "b7dbea8653bcdaa78934f7e632ed8cb7835ba1647b58ddc9b09c6981fc5560d8",
      executableDigest: "4ae4c20af6b7585d7e425ee1e7c0271a8067f296b618aba3a9bdf49183d6e887",
    },
  ],
  [
    "win32-x64",
    {
      name: "dws-windows-amd64.zip",
      digest: "9684b525e836943f41ea6ca03404b2221a25c6ebe63f569487bd06b732574b48",
      executableDigest: "6fc652113d0669b9b1d3fedabe8dbf00066b24d9c7cfca10c6a5a228e8053d74",
    },
  ],
  [
    "win32-arm64",
    {
      name: "dws-windows-arm64.zip",
      digest: "770372e261b2892e148fa7e8ecf129f20bda760016ca5b03facef03ba83d7ae3",
      executableDigest: "b716994a4a0d9fe24fef5cafd680776be6f08eea7a216b622e27775aabf65bd9",
    },
  ],
]);

export async function checkedArchive(response: Response, digest: string): Promise<Buffer> {
  if (!response.ok || response.body === null) throw new Error("DWS release download failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 32 * 1024 * 1024) throw new Error("DWS release is too large");
    chunks.push(chunk);
  }
  const contents = Buffer.concat(chunks);
  if (createHash("sha256").update(contents).digest("hex") !== digest) {
    throw new Error("DWS release SHA-256 mismatch");
  }
  return contents;
}

async function stageDws(): Promise<void> {
  const asset = assets.get(`${process.platform}-${process.arch}`);
  if (!asset) throw new Error("Unsupported DWS desktop target");
  const { name, digest, executableDigest } = asset;
  const url = `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${version}/${name}`;
  const signal = AbortSignal.timeout(120_000);
  const first = await fetch(url, { redirect: "manual", signal });
  const location = first.headers.get("location");
  let response = first;
  if (first.status === 302 && location !== null) {
    const target = new URL(location);
    if (
      target.origin !== "https://release-assets.githubusercontent.com" ||
      target.username ||
      target.password
    ) {
      throw new Error("Unexpected DWS release redirect");
    }
    await first.body?.cancel();
    response = await fetch(target, { redirect: "error", signal });
  }
  const contents = await checkedArchive(response, digest);
  const destination = fileURLToPath(new URL("../dws", import.meta.url));
  await stageVerifiedArchive(contents, name, executableDigest, destination);
  console.log(`Staged DWS v${version} (${process.platform}-${process.arch})`);
}

export async function stageVerifiedArchive(
  contents: Buffer,
  name: string,
  executableDigest: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const temp = await mkdtemp(join(destination, ".staging-"));
  try {
    const archive = join(temp, name);
    await writeFile(archive, contents);
    const windows = process.platform === "win32";
    const executable = windows ? "dws.exe" : "dws";
    // bsdtar ships on Windows 10/11 and macOS and reads both release formats.
    const tar = windows
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "/usr/bin/tar";
    execFileSync(tar, ["-xf", name, executable, "LICENSE", "NOTICE"], {
      cwd: temp,
      timeout: 30_000,
    });
    // Even --version can leave a telemetry sender holding dws.exe open on Windows.
    const binary = await readFile(join(temp, executable));
    if (createHash("sha256").update(binary).digest("hex") !== executableDigest) {
      throw new Error("DWS executable SHA-256 mismatch");
    }
    for (const entry of ["LICENSE", "NOTICE", executable]) {
      await copyFile(join(temp, entry), join(destination, entry));
    }
    if (!windows) await chmod(join(destination, executable), 0o755);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageDws();
}
