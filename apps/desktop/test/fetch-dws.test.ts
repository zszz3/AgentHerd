import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { checkedArchive, stageVerifiedArchive } from "../scripts/fetch-dws.ts";

it("rejects a changed download before extracting it", async () => {
  const response = new Response(new Uint8Array([1, 2, 4]));
  await expect(
    checkedArchive(response, "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"),
  ).rejects.toThrow("SHA-256 mismatch");
});

it("returns bytes only after verifying the pinned digest", async () => {
  const contents = new Uint8Array([1, 2, 3]);
  const response = new Response(contents);
  await expect(
    checkedArchive(response, "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"),
  ).resolves.toEqual(Buffer.from(contents));
});

async function archiveFixture() {
  const root = await mkdtemp(join(tmpdir(), "fetch-dws-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "out");
  await mkdir(destination);
  const executable = process.platform === "win32" ? "dws.exe" : "dws";
  // These bytes have a known digest but cannot run as a version probe.
  await writeFile(join(root, executable), Buffer.from([1, 2, 3]));
  await writeFile(join(root, "LICENSE"), "license");
  await writeFile(join(root, "NOTICE"), "notice");
  const contents = execFileSync("tar", ["-cf", "-", executable, "LICENSE", "NOTICE"], {
    cwd: root,
  });
  return { contents, destination, executable };
}

it("stages a pinned executable without running it from the temporary directory", async () => {
  const { contents, destination, executable } = await archiveFixture();
  await stageVerifiedArchive(
    contents,
    "fixture.tar",
    "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    destination,
  );
  expect(await readFile(join(destination, executable))).toEqual(Buffer.from([1, 2, 3]));
  expect((await readdir(destination)).sort()).toEqual(["LICENSE", "NOTICE", executable]);
});

it("rejects an unexpected binary before replacing staged files", async () => {
  const { contents, destination, executable } = await archiveFixture();
  await writeFile(join(destination, executable), "previous");
  await expect(
    stageVerifiedArchive(contents, "fixture.tar", "0".repeat(64), destination),
  ).rejects.toThrow("executable SHA-256 mismatch");
  expect(await readFile(join(destination, executable), "utf8")).toBe("previous");
  expect(await readdir(destination)).toEqual([executable]);
});
