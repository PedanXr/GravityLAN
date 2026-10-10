# ADR-002: Browser SSH Terminal and Encrypted Key Store

**Status:** Accepted
**Date:** 2026-10-04
**Deciders:** Project owner
**Technical Story:** "Integrated PuTTY" – open SSH sessions to inventoried devices from the GravityLAN UI, with stored private keys

## Context

GravityLAN already talks SSH to devices (agent deploy, package updates), but only with credentials typed in per action
(ADR-001: "never persist credentials"). Users want a terminal in the UI that opens a shell on a device in one click,
using their own private keys – which only works if keys are stored somewhere.

Options considered:

- **A – encrypted key store on the server** (chosen): keys, passphrases and optional passwords are kept in the database,
  encrypted; one click connects.
- **B – per-session upload only**: nothing stored, the key is uploaded for each session. Safer at rest, but the
  "one click to my server" goal is lost.

The connection is made by the GravityLAN server, not the browser: browsers cannot speak SSH, and this way the terminal
also works from a phone without the key ever being on that phone.

## Decision

1. **Scope of ADR-001's rule**: agent deploy and patching keep runtime-only credentials. Only the SSH terminal feature
   stores secrets, and only in the dedicated tables `ssh_keys` and `ssh_profiles`.
2. **Encryption at rest** (`app/services/secret_vault.py`): Fernet (AES-128-CBC + HMAC-SHA256) from `cryptography`,
   already a paramiko dependency. The key comes from `GRAVITYLAN_VAULT_KEY`, otherwise from `<data_dir>/ssh_vault.key`,
   generated on first use with mode 0600.
3. **Secrets never leave the backend**: the API returns key name, type, fingerprint and public key only; private keys,
   passphrases and passwords are write-only. 422 responses cannot echo them (secret fields have no Pydantic constraints and
   every request field has a default).
4. **Not in the JSON backup**: the SSH tables are not exported. A backup holding ciphertext without its key is useless,
   and one holding both would be a second copy of every private key. Back up `ssh_vault.key` separately if wanted.
5. **Host keys: trust on first use** (`ssh_known_hosts`, one key per host:port). The handshake runs on a bare
   `paramiko.Transport`, so the host key is checked *before* any credential is sent. Unknown keys are shown with their
   fingerprint and must be confirmed; a changed key blocks the connection until the old entry is removed in the UI.
6. **Session hand-off**: `POST /api/ssh/sessions/prepare` resolves and decrypts credentials into a one-shot ticket
   (30 s, in memory); `WS /api/ssh/terminal?ticket=…` consumes it. No secret travels in a URL.
7. **Who may open shells**: browser sessions only. Read-only API tokens get 403 on every `/api/ssh` route and cannot open
   the terminal WebSocket; master tokens cannot open the WebSocket either.
8. **Limits and audit**: at most `GRAVITYLAN_SSH_MAX_SESSIONS` (10) concurrent sessions, idle sessions closed after
   `GRAVITYLAN_SSH_IDLE_TIMEOUT_MINUTES` (30, 0 = never). Opening/closing a session and trusting/removing host keys are
   logged (user, host, port, duration) – never terminal content.

## Consequences

- Whoever controls the GravityLAN server (or its data directory) controls the stored keys. This is the accepted price of
  option A; keeping `ssh_vault.key` out of the data volume (`GRAVITYLAN_VAULT_KEY` from a Docker secret) reduces it.
- Losing `ssh_vault.key` makes stored keys unreadable; they have to be imported again.
- Keyboard-interactive 2FA beyond a password prompt is not supported yet.
- PuTTY `.ppk` keys (format 2 and 3) are read by `app/services/ppk.py` and stored converted to OpenSSH, because paramiko
  cannot read them; the PPK passphrase is only needed for the import.
