; The Windows installer, built with Inno Setup 6 by packaging\windows\build.ps1:
;   ISCC /DAppVersion=<version> /DPayloadDir=<staged app folder> /DProjectDir=<repo> installer.iss
;
; It installs for the current user only (no administrator rights) into the same folder every
; earlier version used, so Claude Desktop and Codex registrations keep working across
; updates, and it registers a normal uninstaller under Settings > Apps. Connections,
; passwords and certificates live in %LOCALAPPDATA%\SAP MCP Desktop Bridge, which neither
; installing nor uninstalling touches.
;
; Silent install: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART. Exit code 0 means success and 10
; means the app is installed but Claude Desktop or ChatGPT/Codex could not be connected; the
; reason is in %TEMP%\sap-mcp-bridge-install-error.log and in the app. /MERGETASKS=!clients
; installs without connecting the clients.

#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef PayloadDir
  #error Pass /DPayloadDir=<staged app folder>
#endif
#ifndef ProjectDir
  #error Pass /DProjectDir=<repository folder>
#endif

#define AppName "SAP MCP Desktop Bridge"
#define ManagerName "SAP MCP Connection Manager"
; The publisher Windows shows (Settings > Apps, file details); also set on the app's
; executable in packaging/build-desktop.py. The copyright follows LICENSE.
#define Publisher "Muhammad Abdullah"
#define CopyrightHolder "SAP MCP Desktop Bridge contributors"
#define RepoUrl "https://github.com/Muhammad-Abdullah333/SAP-MCP-Bridge"

[Setup]
AppId={{617F7CBA-3930-4F96-865D-CB8035F2A406}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
AppCopyright=Copyright (c) 2026 {#CopyrightHolder}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#Publisher}
VersionInfoDescription={#AppName} installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=yes
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DisableReadyPage=yes
SetupIconFile={#ProjectDir}\assets\bridge.ico
UninstallDisplayIcon={app}\assets\bridge.ico
UninstallDisplayName={#AppName}
WizardStyle=modern
; build.ps1 -Quick passes a faster setting for local test builds; releases use the default.
#ifndef Compression
  #define Compression "lzma2/max"
#endif
Compression={#Compression}
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupMutex=SapMcpDesktopBridgeInstaller
; An update replaces files that the manager, or an MCP server Claude Desktop or Codex
; started, may have open. PrepareToInstall closes those programs first, and only programs
; running from the install folder; nothing reopens them. Restart Manager stays off: run
; as administrator it tries to stop whatever else has a file open, including Windows
; services that briefly read a new executable, and stopping one can hang setup.
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "clients"; Description: "Connect Claude Desktop and ChatGPT/Codex to the Bridge (their current settings are backed up first)"

[InstallDelete]
; Folders replaced as a whole, so files dropped from a newer version do not linger.
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\vendor"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\LICENSES"
; Launchers and scripts that versions before 1.0.2 installed.
Type: files; Name: "{app}\Launch Manager.vbs"
Type: files; Name: "{app}\SAP MCP Desktop Bridge.cmd"
Type: files; Name: "{app}\Uninstall.ps1"
Type: files; Name: "{app}\Rollback.ps1"
Type: files; Name: "{userprograms}\{#AppName}.lnk"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#ManagerName}"; Filename: "{app}\desktop\{#ManagerName}.exe"; WorkingDir: "{app}"; IconFilename: "{app}\assets\bridge.ico"; Comment: "{#ManagerName} - manage Bridge connections and certificates"; AppUserModelID: "com.sap-mcp.desktop-bridge"

[Run]
Filename: "{app}\desktop\{#ManagerName}.exe"; Description: "Open {#ManagerName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  ClientSetupFailed = 10;

var
  CustomExitCode: Integer;
  FinishNote: String;

{ Versions before 1.0.2 kept the previous installation next to the new one, as
  "<app>.old-<id>", and could leave "<app>.failed-<id>" or "<app>.replaced-<id>" behind.
  They are earlier copies of this app only; nothing of the person's is kept in them. }
procedure RemoveEarlierCopies(const Suffix: String);
var
  FindRec: TFindRec;
  Parent: String;
begin
  Parent := ExtractFileDir(ExpandConstant('{app}'));
  if FindFirst(ExpandConstant('{app}') + Suffix + '*', FindRec) then
  try
    repeat
      if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
      begin
        Log('Removing earlier copy: ' + FindRec.Name);
        DelTree(AddBackslash(Parent) + FindRec.Name, True, True, True);
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Closes programs running from the install folder, and nothing else: the manager and any
  Bridge MCP server that Claude Desktop or Codex started. They hold files an update
  replaces. Restart Manager alone cannot be relied on for this: when any process it may
  not touch (such as a Windows service reading the new executable) has a file open, it
  gives up on all of them. Returns how many were still running. }
function CloseRunningCopies(Terminate: Boolean): Integer;
var
  Locator, Service, Processes, Process: Variant;
  Prefix, Path: String;
  I, Id: Integer;
begin
  Result := 0;
  Prefix := Lowercase(AddBackslash(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    { Only the two programs the app ships; reading every process's path is slow. }
    Processes := Service.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process ' +
                                   'WHERE Name = ''node.exe'' OR Name = ''{#ManagerName}.exe''');
    for I := 0 to Processes.Count - 1 do
      { Each on its own: closing the manager also ends its helper processes, which
        then no longer exist by the time the loop reaches them. }
      try
        Process := Processes.ItemIndex(I);
        if not VarIsNull(Process.ExecutablePath) then
        begin
          Path := Process.ExecutablePath;
          if Pos(Prefix, Lowercase(Path)) = 1 then
          begin
            Result := Result + 1;
            if Terminate then
            begin
              Id := Process.ProcessId;
              Log('Closing ' + Path + ' (process ' + IntToStr(Id) + ').');
              Process.Terminate();
            end;
          end;
        end;
      except
        Log('A running copy had already closed: ' + GetExceptionMessage);
      end;
  except
    Log('Could not check for running copies: ' + GetExceptionMessage);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Attempt: Integer;
begin
  Result := '';
  if CloseRunningCopies(True) = 0 then
    exit;
  for Attempt := 1 to 20 do
  begin
    Sleep(500);
    if CloseRunningCopies(Attempt mod 4 = 0) = 0 then
      exit;
  end;
  Result := '{#ManagerName} or a Bridge MCP server is still running and could not be closed. ' +
            'Close Claude Desktop, Codex and {#ManagerName}, then run Setup again.';
end;

procedure ConnectClients;
var
  ResultCode: Integer;
  SummaryFile, Message, Reason: String;
  Summary: AnsiString;
begin
  WizardForm.StatusLabel.Caption := 'Connecting Claude Desktop and ChatGPT/Codex...';
  { configure-cli changes the client settings as one transaction: if any client fails,
    every client's settings are put back exactly as they were. Its summary says, in plain
    language, what went wrong and how to fix it (src/client-advice.js). }
  SummaryFile := ExpandConstant('{tmp}\client-setup-summary.txt');
  if not Exec(ExpandConstant('{app}\runtime\node.exe'),
              AddQuotes(ExpandConstant('{app}\src\configure-cli.js')) + ' --transactional --summary ' + AddQuotes(SummaryFile),
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;
  if ResultCode = 0 then
  begin
    Log('Client setup completed.');
    FinishNote := 'If Claude Desktop or Codex is open, quit it completely and reopen it to load the Bridge. ' +
                  'Closing the Claude Desktop window can leave it running in the system tray.';
    exit;
  end;
  if ResultCode = 2 then
  begin
    FinishNote := 'Claude Desktop and Codex were not found on this computer. After you install one of them, ' +
                  'open {#ManagerName} and choose Configure MCP clients.';
    Log(FinishNote);
    exit;
  end;
  Log('Client setup failed with exit code ' + IntToStr(ResultCode) + '.');
  CustomExitCode := ClientSetupFailed;
  Reason := '';
  if LoadStringFromFile(SummaryFile, Summary) then
    Reason := Trim(String(Summary));
  if Reason = '' then
    Reason := 'Usually this means a client''s settings file contains a mistake, is read-only or held open by another ' +
              'program (such as OneDrive), or already has a connector named SAP-Bridge that Bridge did not create.';
  StringChangeEx(Reason, #10, #13#10, True);
  Message := '{#AppName} is installed, but Claude Desktop or ChatGPT/Codex could not be connected. ' +
             'Their settings were left exactly as they were.' + #13#10#13#10 + Reason + #13#10#13#10 +
             'Logs in {#ManagerName} show the details, and Troubleshooting in its Setup Guide explains each case.';
  Log(Message);
  SaveStringToFile(AddBackslash(GetTempDir) + 'sap-mcp-bridge-install-error.log',
                   GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '  ' + Message + #13#10, False);
  SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
  FinishNote := 'Claude Desktop or Codex still needs your attention: see the message shown during setup, ' +
                'or Logs in {#ManagerName}.';
end;

{ Adds the outcome of client setup to the last page, above the "Open" checkbox. }
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (FinishNote <> '') then
  begin
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + FinishNote;
    WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
    WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    RemoveEarlierCopies('.old-');
    RemoveEarlierCopies('.failed-');
    RemoveEarlierCopies('.replaced-');
    if WizardIsTaskSelected('clients') then
      ConnectClients;
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := CustomExitCode;
end;
