# Security Policy

GravityLAN is designed as a **homelab tool**. Its primary goal is to provide visibility and management capabilities for your personal, trusted network. 

## Trust Model

By design, GravityLAN assumes it is running in a **friendly network environment**. 

- **Internal Access**: The web interface and APIs are secured via token authentication, but they are not hardened against targeted, advanced attacks typically seen on the public internet.
- **Remote Access**: Do not expose GravityLAN directly to the public internet (e.g., via port forwarding). If you need remote access, use a secure VPN (like WireGuard or Tailscale) or a properly configured reverse proxy with additional authentication layers (like Authelia or Authentik).

## Docker Privileges

The GravityLAN Docker container requires specific capabilities to function correctly:
- `NET_RAW` and `NET_ADMIN`: Required for the underlying `nmap` process to perform high-speed, raw-socket network scans and OS detection.
- By default, the `Dockerfile` uses `setcap` to grant these capabilities specifically to the `nmap` binary, allowing the FastAPI application to run as a non-root user (`gravitylan`).

## Admin Login

- The admin password is stored as an Argon2 hash; signing in sets an `httpOnly` session cookie (7 days).
- Change it under **Settings → Access**. The current password must be entered, only a logged-in browser session can do this (not API or master tokens), and every other session is logged out.
- The generic settings endpoint (`POST /api/settings`) rejects the password and the master token, so they cannot be overwritten without the current password.

## Agent Deployment

The GravityLAN Agent deployment feature uses SSH to install the monitoring script on remote hosts.
- SSH credentials (passwords or private keys) entered for a deployment or package update are used in memory for that request only.
- **They are not stored in the database or written to disk.**
- Unknown host keys are accepted with a warning by default (homelab convenience). Set `GRAVITYLAN_SSH_STRICT_MODE=true` to reject them, or deploy the agent manually with the provided install script.

## SSH Terminal

The browser SSH terminal is the one place where GravityLAN stores SSH credentials, on purpose (see [docs/adr/002-ssh-keystore.md](docs/adr/002-ssh-keystore.md)):
- Private keys, passphrases and saved passwords are encrypted (Fernet) with `data/ssh_vault.key` or `GRAVITYLAN_VAULT_KEY` and never sent back to the browser. Whoever controls the server or its data directory controls these keys; keep the vault key out of the data volume if that matters to you.
- Only logged-in browser sessions can open shells; read-only API tokens and the master token cannot.
- Host keys are checked on first use and a changed key blocks the connection.
- Use the terminal over HTTPS: over plain HTTP, keystrokes (including passwords typed into the shell) cross the network unencrypted.

## Reporting a Vulnerability

If you discover a security vulnerability that affects the isolation or safety of the host system, please open an issue in the repository or contact the maintainer directly.
