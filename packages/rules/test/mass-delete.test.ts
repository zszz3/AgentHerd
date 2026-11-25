import type { ToolCallInfo } from "@agentherd/protocol";
import { describe, expect, it } from "vitest";
import { massDeleteCheck, TEMP_DIRS } from "../src/mass-delete.ts";

const ctx = { cwd: "/p/app", home: "/Users/me" };
const run = (command: string): ToolCallInfo => ({
  kind: "execute",
  title: command,
  command,
  paths: [],
});

describe("massDeleteCheck", () => {
  it.each([
    "rm -rf .",
    "rm -rf *",
    "rm -rf ./*",
    "rm -rf src/*",
    "rm -rf .*",
    "rm -rf ../other",
    "rm -rf ~",
    "rm -rf /",
    "rm -rf /p/app",
    "rm -rf $DIR",
    "rm -rf /tmp",
    "rm -rf /private/tmp",
    "rm -rf /tmp/../Users/me",
    "echo $(rm -rf .)",
    "find . -delete",
    "find . -type f -exec rm {} +",
    "git ls-files | xargs rm",
  ])("asks for %s", (command) => {
    expect(massDeleteCheck(run(command), ctx).hit).toBe(true);
  });

  it.each([
    "ls -la",
    "rm -rf node_modules",
    "rm src/*.log",
    "rm a.txt b.txt",
    "find . -name '*.tmp' -delete",
    "git clean -fdx",
    "git reset --hard",
    "git push --force",
    "sudo ls",
    "cd src && rm -rf build",
  ])("approves %s", (command) => {
    expect(massDeleteCheck(run(command), ctx).hit).toBe(false);
  });

  it.each([
    "rm -f /tmp/t3-desktop.log",
    "cd /Users/me/t3code && rm -f /tmp/t3-desktop.log && (pnpm run dev:desktop > /tmp/t3-desktop.log 2>&1 &)",
    "rm -rf /tmp/build-cache",
    "rm -rf /tmp/*",
    "rm -rf /private/tmp/x",
    "cd /tmp && rm -rf x",
    "find /tmp/out -name '*.png' -delete",
  ])("never asks about the temporary folders: %s (owner, 2026-11-23)", (command) => {
    expect(massDeleteCheck(run(command), ctx).hit).toBe(false);
  });

  it("still asks when the project itself lives in a temporary folder", () => {
    const inTmp = { cwd: "/tmp/demo", home: "/Users/me" };
    for (const command of ["rm -rf ./*", "rm -rf .", "rm -rf /tmp/demo", "cd .. && rm -rf demo"]) {
      expect(massDeleteCheck(run(command), inTmp).hit).toBe(true);
    }
    expect(massDeleteCheck(run("rm -rf /tmp/other"), inTmp).hit).toBe(false);
  });

  it("knows the system's own temporary folder", () => {
    expect(TEMP_DIRS).toContain("/tmp");
    expect(TEMP_DIRS).toContain("/private/tmp");
    const del = (p: string): ToolCallInfo => ({ kind: "delete", title: "Delete", paths: [p] });
    for (const dir of TEMP_DIRS) {
      expect(massDeleteCheck(del(`${dir}/a/b`), ctx).hit).toBe(false);
      expect(massDeleteCheck(del(dir), ctx).hit).toBe(true);
    }
  });

  it("asks when a delete tool targets the project folder, not a file in it", () => {
    const del = (p: string): ToolCallInfo => ({ kind: "delete", title: "Delete", paths: [p] });
    expect(massDeleteCheck(del("/p/app"), ctx).hit).toBe(true);
    expect(massDeleteCheck(del("/p/app/a.ts"), ctx).hit).toBe(false);
    expect(massDeleteCheck(del("/p/app/..foo"), ctx).hit).toBe(false);
  });

  describe("Windows deletes", () => {
    const winCtx = { cwd: "C:\\p\\app", home: "C:\\Users\\me" };

    it.each([
      "rd /s /q .",
      "rd /s /q .\\",
      "del /q *.*",
      "del /s /q src\\*.*",
      "erase src\\*",
      "Remove-Item -Recurse -Force ..\\other",
      "ri -Recurse ~\\",
      "rd /s /q C:\\",
      "rd /s /q c:\\P\\APP",
      "rd /s /q C:\\p\\app\\ ",
      "del %USERPROFILE%\\foo.txt",
      "cd /d C:\\Temp && rd /s /q x",
      "echo $(Remove-Item -Recurse .)",
      "Remove-Item -Path=C:\\p\\app -Recurse",
      "del C:\\*.*",
      "del \\\\server\\share\\*.*",
    ])("asks for %s", (command) => {
      expect(massDeleteCheck(run(command), winCtx).hit).toBe(true);
    });

    it.each([
      "del a.txt b.txt",
      "del src\\*.log",
      "rd /s /q .\\dist",
      "Remove-Item -Recurse -Force build",
      "cd src && rd /s /q build",
      "cd /d C:\\p\\app\\src && del *.log",
      "del ..foo",
    ])("approves %s", (command) => {
      expect(massDeleteCheck(run(command), winCtx).hit).toBe(false);
    });

    it.each(["rmdir /s/q", "rmdir /s /q"])(
      "treats POSIX %s as path, not CMD switches",
      (command) => {
        expect(massDeleteCheck(run(command), ctx).hit).toBe(true);
      },
    );

    it("checks Windows delete toolCall targets case-insensitively", () => {
      const del = (p: string): ToolCallInfo => ({ kind: "delete", title: "Delete", paths: [p] });
      expect(massDeleteCheck(del("c:\\P\\App"), winCtx).hit).toBe(true);
      expect(massDeleteCheck(del("c:\\P\\App\\a.ts"), winCtx).hit).toBe(false);
      expect(massDeleteCheck(del("C:\\p\\app\\..foo"), winCtx).hit).toBe(false);
    });

    const psEncode = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

    it.each([
      "cmd /c rd /s /q .",
      'cmd.exe /d /s /c "rd /s /q C:\\p\\app"',
      'cmd.exe /c "del /s /q src\\*.*"',
      'cmd /c "rd /s /q ." 2>&1',
      'cmd /s /c "echo ok" & rd /s /q "."',
      "cmd /c cd .. && rd /s /q app",
      "%COMSPEC% /c rd /s /q .",
      'powershell -NoProfile -Command "Remove-Item -Recurse -Force ..\\other"',
      'powershell -Command "Remove-Item -Recurse -Force ." -Verbose',
      'powershell -NoProfile -Command "rd /s /q ." -ErrorAction SilentlyContinue',
      'powershell.exe -Command "Remove-Item -Path C:\\p\\app -Recurse"',
      'pwsh -c "ri -r -fo *"',
      "powershell -Command Set-Location ..; Remove-Item -Recurse app",
      "pwsh -Command { rd /s /q . }",
      'pwsh -Command "if ($true) { Remove-Item -Recurse -Force . }"',
      'pwsh -Command "{ Set-Location ..; Remove-Item app }"',
      'pwsh -Command "{ trash . }"',
      `powershell -EncodedCommand ${psEncode("Remove-Item -Recurse -Force .")}`,
      `pwsh -ec ${psEncode("rd /s /q C:\\p\\app")}`,
      `pwsh -EncodedCommand ${psEncode("Remove-Item -Recurse build")} -WorkingDirectory ..`,
      `pwsh -EncodedCommand ${psEncode("Remove-Item -Recurse .")} -WorkingDirectory C:\\p\\app`,
      "powershell -EncodedCommand not-valid-base64!",
      "powershell -EncodedCommand",
      "powershell -Command -",
      "pwsh -c -",
      "powershell -",
      "powershell -File -",
      "Get-Content cmds.txt | powershell -NoProfile",
      'powershell -NoProfile -Command "Get-ChildItem -Recurse | Remove-Item -Force"',
      "Get-ChildItem -Recurse | Remove-Item -ErrorAction SilentlyContinue",
      "Get-ChildItem -Recurse | Remove-Item -ErrorA SilentlyContinue",
      "Get-ChildItem .. | Remove-Item -Filter *.log",
      "Remove-Item -Path ('.')",
      "Remove-Item -Recurse -Force ., build",
      "Remove-Item -Path src\\a.txt,..\\other",
      "Remove-Item -Path 'src\\a.txt','..\\other'",
      "Remove-Item @('.', '..')",
      "Set-Location -Path ..; Remove-Item -Recurse build",
      "Set-Location -Path C:\\Temp\\missing; Remove-Item -Recurse *",
      "sl ..; Remove-Item -Recurse app",
      "Push-Location ..; Remove-Item -Recurse app",
      "Pop-Location; Remove-Item -Recurse build",
      "cmd /c powershell -Command cmd /c powershell -Command cmd /c rd /s /q dist",
      "rd/s/q .",
      "del /f/s/q *.*",
      "rd /s /q C:\\tmp\\important",
      'cmd.exe /d/s/c "rd /s /q ."',
      'cmd /s/c "rd /s /q ."',
      'cmd/c "rd /s /q ."',
      'powershell.exe /c "Remove-Item -Recurse -Force ."',
      `powershell.exe /ec ${psEncode("Remove-Item -Recurse -Force .")}`,
      'powershell.exe /NoProfile /Command "Remove-Item -Recurse -Force ."',
      "Get-ChildItem -Recurse | rm -ErrorAction SilentlyContinue",
      "Get-ChildItem .. | del -Filter *.log",
      "Remove-Item -Recurse -Force build,('.')",
      "Remove-Item -Recurse -Force @(('.'))",
      'cmd /c "(rd /s /q .)"',
      'cmd /c "(cd .. && rd /s /q app)"',
      'cmd /c "cd.. && rd /s /q app"',
      'cmd /c "cd\\ && rd /s /q app"',
      'cmd /c "D: && rd /s /q app"',
      'cmd /c "call rd /s /q ."',
      "powershell -Command \"iex 'Remove-Item -Recurse -Force .'\"",
      'iex "Remove-Item -Recurse -Force ."',
      'cmd /c "cd" .. & rd /s /q app',
      'powershell -NoProfile -Command "Set-Location" ..; Remove-Item -Recurse -Force app',
    ])("asks for wrapped or PowerShell/cmd mass delete: %s", (command) => {
      expect(massDeleteCheck(run(command), winCtx).hit).toBe(true);
    });

    it.each([
      'cmd /c "del a.txt b.txt"',
      'cmd.exe /d /s /c "cd /d C:\\p\\app\\src && del *.log"',
      'cmd /c "rd /s /q .\\dist"',
      'cmd /s /c "echo ok" & echo done',
      'powershell -NoProfile -Command "Remove-Item -Recurse -Force build"',
      'powershell -Exec Bypass -Command "Write-Output ok"',
      'pwsh -CommandWithArgs "Write-Output ok"',
      'pwsh -c "Remove-Item a.txt"',
      "pwsh -Command { Write-Output ok }",
      "pwsh -Command \"Write-Output '{ Remove-Item . }'\"",
      "pwsh -File build.ps1",
      `powershell -EncodedCommand ${psEncode("Write-Output ok")}`,
      `pwsh -e ${psEncode("Write-Output ok")}`,
      `pwsh -EncodedCommand ${psEncode("Remove-Item -Recurse .")} -WorkingDirectory C:\\p\\app\\sub`,
      "Set-Location -Path src; Remove-Item -Recurse build",
      "Set-Location .. || Remove-Item -Recurse build",
      "Remove-Item -LiteralPath 'logs,..,archive'",
      "Remove-Item @('build', 'dist')",
      "rd /s/q dist",
      "Remove-Item -Path src -Filter *.log -Recurse",
      'cmd /c "cd && rd /s /q dist"',
      'cmd /c "echo y | del a.txt"',
      'cmd /c "call rd /s /q dist"',
      "powershell -Command \"iex 'Write-Output ok'\"",
      "Remove-Item -LiteralPath 'logs,(1).txt'",
      "pwsh /tmp/build.ps1",
    ])("approves wrapped or narrow Windows command: %s", (command) => {
      expect(massDeleteCheck(run(command), winCtx).hit).toBe(false);
    });
  });
});
