# Privacy policy

SAP MCP Connection Manager runs entirely on your computer. It has no accounts, no analytics and no telemetry, and the project receives no data from it.

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## What it stores on your computer

All of it is kept in `%LOCALAPPDATA%\SAP MCP Desktop Bridge`, readable only by your Windows account:

- **Connection settings:** name, SAP address, client, user name, language, safety policy and CA certificate.
- **Passwords and other secrets,** encrypted with Windows DPAPI so that only your Windows account can decrypt them.
- **An activity log** of what you did in the manager, with secrets removed. It's capped in size and you can clear it at any time from the Logs tab.
- **The result of the last client setup,** and the manager's own preferences, such as the theme.

To make your connections available to your AI client, it also edits **Claude Desktop's and Codex's MCP configuration files**, backing each one up first.

## What it sends, and where

- **To your SAP system:** the requests your AI client makes through it, and your own tests and diagnostics, signed in with the credentials you saved.
- **To the sign-in service you configured,** if a connection uses browser SSO or OAuth.
- **Public reference material,** such as SAP's API release information from GitHub, but only when an AI client uses a tool that needs it.

Nothing is sent to the project or to anyone else.

Your AI client is a separate program. What SAP returns to Claude Desktop or Codex is handled by that client and its AI provider under their own privacy terms, like anything else you share with it. The safety policy of each connection limits what the AI can reach in the first place.

## Encrypted backups

A backup is created only when you choose **Export encrypted backup**. It contains your connections, passwords and certificates, protected by the passphrase you choose, and is saved where you put it.

## Removing your data

Uninstalling keeps your connections so that a reinstall finds them. To remove everything, delete `%LOCALAPPDATA%\SAP MCP Desktop Bridge` after uninstalling, and remove the `SAP-Bridge` entry from Claude Desktop's and Codex's MCP settings.

## Questions

Open an issue at https://github.com/Muhammad-Abdullah333/SAP-MCP-Bridge/issues.
