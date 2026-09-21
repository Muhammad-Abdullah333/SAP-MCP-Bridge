# SAP MCP Connection Manager

Connect an AI assistant to your SAP system, with a safety policy you control.

SAP MCP Connection Manager keeps your SAP connections in one place and makes them available to **Claude Desktop** and **Codex (ChatGPT)** through a local [MCP](https://modelcontextprotocol.io) server. The AI can then read and work with ABAP development objects through the same development interface (ADT) that Eclipse uses. Every request is checked against the safety policy you set for that connection before it reaches SAP.

Windows 10 and 11.

## Install

1. Download `SAP-MCP-Desktop-Bridge-<version>-Windows-Setup.exe` from [Releases](../../releases).
2. Run it. It installs for your Windows user only, needs no administrator rights, and opens the manager when it finishes.
3. Windows may show a SmartScreen notice the first time. Choose **More info → Run anyway**.

**You don't need to install Node.js or anything else.** The installer includes its own Node.js runtime, the desktop shell and the MCP server. The only other things you need are:

- **Claude Desktop** or **Codex**, installed. A ChatGPT browser session alone can't use a local connector.
- **An SAP account with ADT access**, a reachable HTTPS address, and your company's CA certificate if its servers use a private one.

To update, run a newer installer. Your connections, passwords and certificates are kept.

## Set up a connection

1. Open **SAP MCP Connection Manager** from the Start menu.
2. Click **+ New** and enter the connection name, SAP client, HTTPS address and your user and password. The **Setup Guide** (top right) shows how to find the address and export a CA certificate.
3. Choose the **safety policy** (see below). A new connection starts as *Read only*.
4. Click **Create connection**, then **Configure MCP clients**. Claude Desktop and Codex are detected and set up for you, and their existing configuration is backed up first.
5. Fully quit and reopen Claude Desktop or Codex.

**Test through MCP** and **Full diagnostics** start the connection exactly as your AI client will, and tell you where it fails.

With more than one connection, the one marked **Default system** is used whenever a request doesn't name a system. Only one connection can be the default.

## Safety policy

Each connection answers two questions.

**What may it change?**
- **Read only**: nothing can be changed.
- **Custom can be changed, standard is read only**: changes are confined to the customer namespace (`Z*`, `Y*`, `$*` and `/namespace/` packages). Choosing this also denies the debugger, abapGit and running ABAP snippets or classes.
- **Standard and custom can both be changed**: changes are allowed wherever your SAP account is authorised.

**What data may it read?**
- **Tables only**: it can open a table you name, and can't write its own SQL.
- **Tables and its own SQL queries**: it can also write SQL that joins and filters across tables.

Lists of packages, transports, tables and tools narrow this further. Entries go one per line and accept the wildcards `*` and `?`, and a denial always wins over an allowance. The form shows a Low, Medium or High rating worked out from the whole policy. It also names anything the chosen level does **not** cover, with the list entry that closes it.

The policy is enforced by the MCP server itself, before a request reaches SAP, so telling the AI to ignore it has no effect. It is a safeguard, not a replacement for SAP authorisations: everything the AI does runs as your SAP user.

## What it can't do

- **Smartforms, Adobe Forms and SAPscript can't be edited by the AI.** They're built in SAP GUI (SMARTFORMS, SFP, SE71), and ADT doesn't offer them. Make form changes manually; the AI can still help with the code around a form, such as its print program.
- **Workflow definitions, LSMW projects and other SAP GUI-only tools** aren't reachable either.

## Your data

- Everything stays on your computer. The manager runs a small local service that only this computer can reach.
- It connects to your SAP system, and to the sign-in service you configured if you use browser SSO or OAuth. A few optional SAP tools fetch public reference material, such as SAP's API release information, but only when used. Nothing else reaches out.
- Connections and certificates are kept in `%LOCALAPPDATA%\SAP MCP Desktop Bridge`. Passwords are encrypted with Windows DPAPI, so only your Windows account can read them.
- **Encrypted backup** exports your connections, passwords and certificates, protected by a passphrase you choose. It can be opened on another computer with that passphrase, so treat both with care.

## Uninstall

Close the manager, then run:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\SAP MCP Desktop Bridge\Uninstall.ps1"
```

This removes the app and its Start-menu shortcut. Your connections and saved passwords are kept, in case you reinstall. Delete `%LOCALAPPDATA%\SAP MCP Desktop Bridge` to remove them as well. Also remove the `SAP-Bridge` entry from Claude Desktop's and Codex's MCP settings.

## Building from source

The source is in `src` (manager, desktop shell and MCP host), `packaging` (installer and build scripts) and `test`. `packaging/vendor-patch` holds our patched copy of the MCP server's policy engine. It's kept as the file it replaces, which is why it sits under a `node_modules` path. No dependencies are committed.

- **Tests:** run `npm test` with Node.js 24. The end-to-end policy test runs the real MCP server when the pinned base package is unpacked into `build/base-payload/`, and skips otherwise.
- **Installer:** `packaging\windows\build.ps1 -BasePackage <pinned base package> -Python python -Output <folder>`. The base package holds the pinned Node.js runtime and the MCP server's dependencies. The Electron archives go in `build/downloads` and are checked against the official checksums. Neither is kept in this repository.
- **Checking a build:** `python packaging/windows/verify-release.py <output folder>` checks the built installer against this source.

## License

MIT, see [LICENSE](LICENSE). Bundled components keep their own licenses, listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
