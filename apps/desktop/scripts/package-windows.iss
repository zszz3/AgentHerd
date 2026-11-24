; Internal PR candidate. The app, host and agents run from real files in a per-user directory.
[Setup]
AppId=com.agentherd.desktop.internal
AppName=AgentHerd
AppVersion={#AppVersion}
AppPublisher=AgentHerd
DefaultDirName={localappdata}\Programs\AgentHerd
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
OutputBaseFilename=AgentHerd-Setup-x64
Compression=lzma2/fast
SolidCompression=yes
UninstallDisplayIcon={app}\AgentHerd.exe

[Files]
Source: "{#ImageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\AgentHerd"; Filename: "{app}\AgentHerd.exe"; WorkingDir: "{app}"

; No uninstall cleanup outside the installer-owned files. Owner settings, sessions and keys remain.
