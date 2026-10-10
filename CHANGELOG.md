# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **Agent version back to 0.3.5**: the agent had no changes in 0.3.6, so installed agents no longer get an update offer. Agents that were already updated to 0.3.6 keep running and are not offered a "downgrade": the UI now offers an agent update only when the installed version is older than the server's (before, any difference counted).

### Fixed

- **Old UI after an update (e.g. SSH menu missing in 0.3.6)**: `index.html` was served without a cache header, so browsers kept the previous release's page and scripts while the version label (loaded from the API) already showed the new version. The page is now always revalidated (`Cache-Control: no-cache`). After updating to this version, reload once with Ctrl+F5.

## [0.3.6] - 2026-10-10

### Added

- **SSH terminal in the browser** (new menu entry "SSH"): open shells on your devices from GravityLAN – like an integrated PuTTY, also on phones. Several sessions side by side in tabs, sessions stay open while you switch between Terminal, Keys and Known hosts. Device cards with an SSH service get a terminal button.
- **SSH key store**: import private keys (OpenSSH/PEM: Ed25519, ECDSA, RSA, optionally with passphrase) or generate a new Ed25519 key and copy its public half to `authorized_keys`. Keys are stored encrypted (key file `data/ssh_vault.key` or `GRAVITYLAN_VAULT_KEY`) and never sent back to the browser.
- **Saved connections**: device or host, user, port and login by key, stored password (encrypted) or "ask every time".
- **Host key check**: on the first connection the server's fingerprint is shown for confirmation; if it changes later the connection is blocked until the old entry is removed under "Known hosts".
- Settings via environment: `GRAVITYLAN_SSH_IDLE_TIMEOUT_MINUTES` (default 30, 0 = never), `GRAVITYLAN_SSH_MAX_SESSIONS` (default 10), `GRAVITYLAN_VAULT_KEY`.
- Demo backend: the SSH terminal connects to a built-in fake shell, so it can be tried without touching any real host.

### Security

- Read-only API tokens cannot use any `/api/ssh` route, and only browser sessions can open a terminal. SSH keys and connection secrets are not part of the JSON backup (see `docs/adr/002-ssh-keystore.md`).

### Changed

- **Agent version 0.3.6**: Version bump alongside the server release; the agent itself has no functional changes. Installed agents show an update notice in the UI.

### Fixed

- **Devices flapping offline/online (e.g. Docker containers on Unraid ipvlan)**: a single missed ping or ARP reply no longer marks a device offline. It now takes 3 consecutive failed checks (configurable under Settings → Network scan → "Offline after", 1–20) before the device goes offline and the `device.offline` webhook fires; any successful check, agent heartbeat or Docker sync resets the counter. Before counting a miss, the quick scan also tries a TCP handshake on ports 22/80/443/8080/8443, so containers that drop ICMP but serve TCP stay online.
- **SSH login with a private key failed for agent deploy and package updates**: with paramiko 4+ (5.0 is installed) the key loader referenced the removed DSA key class and raised before even trying the key. Ed25519, ECDSA and RSA keys work again, and encrypted keys with a passphrase are recognised.

## [0.3.5] - 2026-09-26

### Changed — UI redesign

- **Calmer, clearer interface**: graphite surfaces with a single blue accent; green/amber/red only for state; text contrast raised to WCAG AA; IBM Plex Sans/Mono bundled locally (no Google Fonts request).
- **Navigation**: clear names (Overview, IP addresses, Topology, Agents, Logs, Settings), the text logo with the version next to it, a bottom tab bar on phones; the logs page is a regular page in the menu.
- **Overview**: device cards show status, IP, role (Host/VM/Docker) and labeled CPU/RAM/disk/temperature meters; services are neutral chips, all of them clickable (the chip row wraps, and scrolls if a card is too short); phones always use the list view.
- **Device editor**: opens as a side panel with the device's network path (e.g. Proxmox › Docker VM), keyboard- and screen-reader-friendly (focus handling, Escape, arrow keys for tabs); full screen on phones.
- **Agents, login, IP grid, topology**: restyled; agent KPIs show real values only (removed decorative fake trend lines); all texts translated — 41 missing translation keys added.
- **Settings**: each section explains itself on the left with its controls on the right (stacked on phones); units sit inside the fields; one save bar appears only while there are unsaved changes (instead of two save buttons); language is a switch; the manual agent server URL is visible again; live logs open as a regular page; errors show as notifications instead of browser alerts.
- **Setup wizard**: text logo, step indicator, back buttons and a language switch; no emojis or gradients; full-width buttons on phones.
- **Agents page**: the 1000px table became a list that turns into cards on phones; the expanded view (telemetry, updates, SSH access, package list, live output) is restyled and translated; calm 24-hour availability bars; a decorative "Status: OPTIMAL" tile and a hard-coded interval were removed.
- **Agent Update Center**: every device can show its one-line installer to update the agent by hand on the host (fresh single-use code, copy button); failed SSH updates show their reason in the row.
- **Phones**: an edge-to-edge app bar with brand and page title, a compact IP map instead of screen-wide tiles, subnet tabs that run edge to edge under the app bar, an icon-only overview toolbar, and the topology map (with smaller zoom buttons) fits above the tab bar.
- **Device editor**: footer with delete on the left and Cancel/Save on the right.
- **Device editor, Agent tab**: SSH access and the manual install/uninstall commands are restyled like the rest of the app; the install command is the same component as in the Update Center (fresh single-use code, copy button).

### Added

- **Demo backend for UI work** (`scripts/dev_demo.py`): demo data and simulated agents, no scans, no SSH, separate database. `--fresh` starts like a new install (empty throw-away database) to work on the setup wizard.

### Security

- **Agent tokens were downloadable without login**: `GET /api/agent/download/config/{id}` now requires admin auth or a single-use enrollment code. Previously anyone on the LAN could enumerate device ids and collect every agent token (and create new ones). The manual install command in the Agent tab now carries a one-time code (valid 30 minutes, usable once); commands copied before this update no longer work — copy a fresh one.
- **Setup mode opened every admin route**: Until the first-run setup is completed (fresh install or after a factory reset), only the routes the setup wizard needs are reachable. Backup export/import, settings, device management and agent deployment are closed (403) instead of being open to anyone.
- **Docker image shipped local development files**: `.dockerignore` patterns only matched the repository root, so `COPY backend/ .` also copied SQLite WAL/SHM files from a local development database (device inventory), a Windows virtualenv, tool caches, tests and scratch scripts into the image. Patterns now apply to nested paths and all database side files are excluded; the image shrinks from 536 MB to 295 MB.

### Fixed

- **Manual agent install failed on Unraid** (and other hosts without systemd): the installer always wrote a systemd unit, so on Unraid it stopped after removing the old agent (`/etc/systemd/system/...: No such file or directory`). It now checks Python and the init system before touching the old installation, uses systemd, Synology rc.d or a background start, and on Unraid keeps a copy on the flash drive that starts from `/boot/config/go` after a reboot (Unraid runs from RAM). The uninstaller removes all of it again.
- **SSH agent update crashed on hosts without systemd** ("not enough values to unpack"): the background-start fallback returned no token, so the deploy endpoint failed and the running agent was reported as a token mismatch. On Unraid, SSH deploys now also keep the agent on the flash drive and start it from `/boot/config/go`, like the manual installer.
- **Updates with a sudo user (not root)**: refreshing the package list used `sudo -n`, which refuses before a password can be sent ("a password is required"); the upgrade itself only answered a sudo prompt that appeared within 0.5 s and ran environment settings and `$(...)` of the command outside sudo. The whole command now runs as root via `sudo sh -c`, and the password is sent whenever the prompt shows up.
- **Topology device settings**: the "device mode" switches (WLAN client, access point) were pushed out of the side panel by a clashing class name, and hidden checkboxes weren't reachable by keyboard.
- **Package updates aborted right away** ("'Channel' object has no attribute 'get_exit_status'"): the SSH exit code was read with a method paramiko doesn't have, so every upgrade run and every apt cache refresh failed. The tests' mocks accepted any attribute; they now use paramiko's real channel API.
- **Hosts behind a shared MAC failed to sync on every scan** ("Multiple rows were found when one or none was required"): with ipvlan containers several records share the host's MAC; the IP match is now kept in that case. The error log names the host.
- **Rack view crashed** (`e.filter is not a function`): the topology page loaded devices without the API client's token and passed an error response on as the device list. The rack view also showed every device as offline (it read a field that doesn't exist).
- **Settings page scrolled twice** (window and content area): hidden form labels stretched the page.
- **Phone app bar scrolled away** and sat 16 px too low: the content area was a scroll container that never scrolled, so it captured the sticky bar. The bar now stays at the top on every page.
- **Setup wizard**: clicking a network's checkbox itself did nothing (it toggled twice); a failed or cancelled scan left the wizard stuck on "Scanning…" with no way on; if saving the setup failed it still jumped to the dashboard. After finishing, the wizard now signs in with the new password, so it ends in the dashboard instead of the login screen — and the initial device refresh actually runs (it was always rejected before, without a session).
- **Unstyled settings and delete buttons**: `.card`, `.btn-danger` and `.btn-sm` were used but never defined, so settings sections had no card surface and delete buttons had no style.
- **Frontend typecheck**: fixed the 8 remaining TypeScript errors; CI now runs `npm run typecheck`. The agent patching tab shows the package manager and major-upgrade hint from the latest update check (they were fetched but never displayed).
- **Agent deployment froze the whole server**: SSH deploy/uninstall ran blocking paramiko calls on the event loop, so API, WebSockets and the scan scheduler stalled for the whole deployment. They now run in a worker thread.
- **Agent cleanup hit unrelated software on target hosts**: The pre-install/uninstall cleanup stopped and disabled any `agent.service` and killed every process whose command line contained `agent.py`. It now only touches GravityLAN's own agents, and its `pkill` pattern no longer kills the invoking shell (which could abort deployments as `root`).
- **Manual installer wiped the old agent before downloading**: The install script now downloads the agent and config first and only replaces the existing installation once both succeeded.
- **Python client was not installable**: `pip install ./gravitylan_api` failed (missing README, package discovery found nothing). The package layout is now mapped explicitly and the client has its own README.
- **Frontend: React was not a declared dependency**: `react` and `react-dom` were only pulled in as peer dependencies of other packages; they are now listed in `frontend/package.json`. Package versions (`frontend/package.json`, `backend/pyproject.toml`) are synced with `VERSION` again (they were still on 0.3.2).
- **CI: lint and agent test failures**: Removed an unused `global` declaration that newer flake8 reports as F824, and made `test_orchestrator_collect_all` deterministic — it no longer runs the real package manager on Linux runners.

### Added

- **Agent enrollment codes**: New `POST /api/agent/enroll/{device_id}` (admin) issues single-use codes for the manual installer. The Agent tab shows the code's expiry time and a "New code" button.

### Changed

- **Agent version 0.3.5**: Version bump alongside the server release; the agent itself has no functional changes. Installed agents show an update notice in the UI.
- **Documentation**: README rewritten for the current feature set (verified configuration table, agent install options, Python client, compose variants). ADR-001 amended for the deployment changes above.

## [0.3.4] - 2026-08-17

### Fixed

- **Agent: Stale package lists hid available updates**: The agent now refreshes the package cache (`apt-get update`, with a stale-cache check and at most once per hour) before counting available patches. Previously, newly installed agents never showed open updates until the cache was refreshed manually.
- **Backend: apt-get update over SSH hung forever**: Rewrote the cache-refresh step in `patch_service.py` to use a PTY with a continuous read loop (no more full-buffer deadlock), send the SSH password only when sudo actually asks for it, fail fast when no password is available, and enforce a 90-second deadline. Failures now surface as a visible error in the Agents tab instead of an endless hang.

### Added

- **Agent OS display**: Agents report their installed OS (parsed from `/etc/os-release`). The server stores it per agent token (new auto-migrated `os_*` columns) and the Agents view shows it as a badge next to the agent version.

### Refactored (Code Health)

- **Scanner Planner (`planner.py`)**: Split `run_planner_scan` into focused helpers (`_cleanup_devices`, `_cleanup_discovered_hosts`, `_mark_device_offline`, `_load_allowed_networks`, `_parse_subnet_list`). All fixable findings cleared (nested_complexity, complex_method, function_hotspot, untested_hotspot). 17 tests.
- **Dashboard Scanner (`dashboard.py`)**: Refactored `run_dashboard_scan` into a 30-line orchestrator with extracted phases (`_run_discovery_phase`, `_run_health_phase`, `_sync_local_docker_containers`, `_discover_subnet_safely`, `_check_health_batch`). Reuses `_mark_device_offline` from planner. All fixable findings cleared. 7 tests.
- **Database Migrations (`migrations.py`)**: Split `run_migrations` into table-scoped pipeline (`_migrations_by_table`, `_repair_corrupted_devices`, `_repair_corrupted_discovered_hosts`, `_apply_table_migrations`). Deduplicated IP resolution logic. All fixable findings cleared. 8 tests.
- **Agent Deployer (`agent_deployer.py`)**: Introduced `_RemoteRunner` class, shared SSH helpers (`_build_ssh_client`, `_build_connect_kwargs`, `_connect_with_gateway_fallback`), and split `deploy_agent`/`remove_agent` into phased operations. Eliminates dry_violation and reduces nested complexity. All security tests pass.

## [0.3.3] - 2026-08-07

### Fixed

- **ipvlan Container Recognition & Matching**: Refactored device matching logic in `backend/app/scanner/sync.py` to use a fallback chain (MAC+IP exact match -> IP match -> unique MAC match -> Hostname match). Prevents containers sharing the host MAC in `ipvlan` mode from overwriting host IP or misassigning devices.
- **DB IP Field Corruption Removal (`offline-<MAC>`)**: Eliminated the `offline-<MAC>` IP replacement pattern. Conflicting offline devices now retain valid IPs and are flagged with `ip_placeholder=True` and `is_online=False`.
- **Automatic DB Migration**: Added a migration step in `run_migrations` to repair existing production databases corrupted with `offline-` IP placeholders.
- **Unverified IP Flap Suppression**: IP changed `DeviceHistory` logs and notifications are now restricted to verified matches (matching unique MAC), preventing false notification floods for unverified host scans.

## [0.3.2] - 2026-07-17

### Added

- **Linux Package Patching**: Integrated a package patching manager directly into the Agents tab.
  - The Python agent reports update counts passively (without root/sudo privileges) for Debian/Ubuntu (apt) and Fedora/CentOS/RHEL (dnf/yum) hosts.
  - The server queries update details and runs upgrades on-demand over a secure, credential-less temporary SSH channel.
  - Implemented real-time terminal output streaming via WebSockets.
  - Support for reboot requirements detection and major OS release notifications.

### Changed

- **Apt Upgrade Command**: Swapped `apt-get upgrade` with `apt-get dist-upgrade` to ensure proper dependency resolution and support Proxmox VE hosts.

### Fixed

- **Safari CSS Compatibility**: Added `-webkit-backdrop-filter` alongside `backdrop-filter: blur(...)` rules in `index.css` to fix glassmorphism rendering on Safari/iOS.
- **Agent: CPU/RAM 0% Metrics**: Set default `root_path` to `/` for `CPUMetrics` and `RAMMetrics` to ensure system metrics are parsed correctly regardless of agent execution working directory (fixing 0% load reporting inside Docker containers).
- **UI: Terminal Auto-scroll bouncing**: Replaced `scrollIntoView()` on inner terminal elements with direct container `scrollTop` assignment, preventing the entire page viewport from jumping during update progress.


## [0.3.1] - 2026-07-16

### Fixed
- **Scanner: TCP Timeout Hardening**: Increased TCP connect timeout for non-ping-responsive devices from 0.3s to 1.0s in the Dashboard scanner. Devices under CPU load (e.g. UniFi switches) need *more* time for TCP handshakes, not less — the previous value caused false "service down" alerts.
- **Scanner: Bounded Thread Pool**: Replaced the default `ThreadPoolExecutor` in `port_scanner.py` with a dedicated, bounded pool (max 40 workers). Prevents thread exhaustion when scanning many hosts concurrently across batches.
- **Schema: ServiceUpdate Port Validation**: Added `ge=1, le=65535` constraint to `ServiceUpdate.port` field. `ServiceCreate` already had this, but `ServiceUpdate` allowed arbitrary integers which could cause socket errors in the port scanner.

### Added
- **Scanner Integration Tests**: New `test_scanner_logic.py` with integration tests covering the Planner service guard (PR #7), Dashboard hybrid health-check transitions, and service port validation.

## [0.3.0] - 2026-05-24

### Added
- **Schreibgeschützte API-Token (Read-Only)**: Einführung von Personal Access Tokens (API Keys) für externe Automatisierungen (z.B. Home Assistant) und LLM-Agenten. Diese erlauben ausschließlich sichere GET-Leseanfragen und blockieren alle verändernden Operationen (POST, PUT, DELETE, PATCH).
- **SHA-256 Token-Hashing**: API-Token werden kryptografisch gehasht in der neuen `api_tokens`-Tabelle gespeichert. Der Klartext-Token wird dem Administrator nur einmal bei der Generierung angezeigt.
- **WebSocket-Support**: Unterstützung der API-Token bei Echtzeit-Verbindungen für System-Logs, Agenten-Metriken und den Scanner-Status.
- **UI-Token-Verwaltung**: Hinzufügen einer Verwaltungssektion für API-Token in den Einstellungen mit der Möglichkeit, Token zu generieren, zu benennen und zu widerrufen (revokieren).

## [0.2.5.1] - 2026-05-22

### Security Hardening (CodeQL Fixes)
- **Path Traversal Protection**: Secured SPA catch-all routing in `main.py` using `.resolve()` and directory containment validation via `is_relative_to()`.
- **SSH Key Verification Bypass**: Swapped generic Paramiko WarningPolicy for a `CustomWarningPolicy` subclass to mitigate static CodeQL checks while keeping test assertions compatible.
- **Exception Shielding**: Masked raw exceptions in `agent_deployer.py` to prevent credentials or sensitive details leaking to the client.
- **Data & Log Sanitization**: 
  - Masked MAC addresses in `vendor.py` to log only the OUI portion (`mac[:8]`).
  - Masked IP addresses in `hostname.py` with `mask_ip` to hide host-identifying octets (e.g. `192.168.1.1` -> `192.168.x.x`).
  - Removed IP logging in `sync.py` error logs.
- **CI/CD Token Permissions**: Restrained GitHub Actions permissions globally to `contents: read` in `ci.yml`.

## [0.2.5] - 2026-05-17

### Added
- Added retention-aware historical time ranges for agent metrics (`6h`, `24h`, `7d`, `30d`).
- Added server-side downsampling for longer agent metric history views to keep SQLite-backed installations responsive.
- Added API metadata for metrics history retention and available time ranges.
- Added documentation for metrics history downsampling, retention-aware ranges, and SQLite trade-offs.
- Added regression coverage for metrics history range validation, sparse/offline data handling, retention-aware API behavior, and retention override handling.

### Changed
- Updated the agent metrics UI to show only time ranges supported by the effective retention configuration.
- Added automatic frontend fallback to the largest available range when retention settings reduce available history depth.
- Coupled metrics history range availability to the effective runtime retention value, including database setting overrides.
- Hardened retention value parsing in both the metrics API and scheduler cleanup paths.

### Security Hardening
- **Native Python Healthcheck**: Completely eliminated the `curl` runtime package dependency in the Docker image by replacing it with a secure, lightweight, and native Python-based `HEALTHCHECK` using the standard library `urllib.request`. This significantly reduces the container's attack surface and cuts down on curl/libcurl-related vulnerabilities.
- **Vulnerability Minimization**: Retained only essential runtime binaries and system libraries in the final slim stage (`nmap`, `libcap`, `iputils-ping`, `avahi-utils`, `iproute2`, `dnsutils`) to maintain full local network resolution and scan performance while minimizing CVE count.
- **Docker Hardening Docs**: Created detailed documentation (`docs/container-hardening.md`) detailing multi-stage builds, capability delegation (`setcap`), and trade-offs of runtime updates vs build reproducibility.

### Performance
- Added bucketed aggregation for long-range metric queries to reduce payload size and chart rendering cost.
- Ensured the `DeviceMetrics` compound index (`device_id`, `timestamp`) is created for both new and existing installations during database initialization.

### Fixed
- Prevented the UI from offering historical ranges that exceed retained metrics data.
- Removed fragile numeric parsing for retention overrides by replacing string-digit checks with robust integer parsing and fallback behavior.
- **UI Device Card Memo Caching**: Resolved a custom `React.memo` comparator bug in `DeviceCard.tsx` that prevented the card from re-rendering when the `old_ip` or `has_pending_token` props updated, fixing the issue where the IP change badge `✕` and agent adoption alerts stayed frozen on click.

## [0.2.4] - 2026-05-17

### Security Hardening
- **SSH Strict Mode**: Added an optional SSH strict host key verification toggle (`GRAVITYLAN_SSH_STRICT_MODE`) to prevent Man-in-the-Middle (MITM) attacks during remote agent deployment.
- **Symmetric SSH Policy**: Harmonized host key policies across both agent deployment and removal flows, checking/loading container host keys symmetrically.
- **Docker Mount Guide**: Documented host key seeding and `/root/.ssh/known_hosts` mounting strategies for containerized environments.
- **Sober Documentation**: Rewrote newly added security and threat modeling documentation to replace absolute claims with precise engineering metrics.

### Changed & Improved
- **Cleanup & Pruning**: Consolidated historical metric and event data pruning under `ScanScheduler._clean_old_history`, completely removing duplicate routines in `main.py`.
- **Database Retention**: Added configurable retention via `history_retention_days` and `GRAVITYLAN_HISTORY_RETENTION_DAYS` (default 30 days) with robust validation checks (`1 <= days <= 365`).
- **Throttled DB Operations**: Implemented a 12-hour pruning drossel to limit repetitive SQLite delete operations when scans are disabled.
- **Error Diagnostics**: Added detailed error exceptions and operational guidance when SSH connections fail due to unknown or mismatched host keys in Strict Mode.

### Tests
- **Coverage**: Expanded test suite to cover configuration settings range limits, paramiko host key policies (Strict and Warning), and database pruning logic (all 29 tests passing).

## [0.2.3.2] - 2026-05-16
### Fixed
- **Agent Deployment**: Resolved "Permission denied" errors during manual agent installation by updating the UI to suggest `sudo bash` and adding root privilege checks to the generated `install-sh` and `uninstall-sh` scripts.
- **Installer Safety**: The agent installer now provides clear error messages if run without sufficient privileges.

## [0.2.3.1] - 2026-05-14
### Fixed
- Critical vulnerability in scanner: Added robust input validation and try-except blocks to prevent application crashes when invalid network subnets (e.g., octets > 255) are provided.
- Cleanup Logic: Secured the scanner cleanup phase against malformed IP ranges.

## [0.2.3] - 2026-05-13

### Security Hardening (Critical)
- **API Lockdown**: Enforced strict `Depends(get_current_admin)` authentication on all high-risk endpoints (Backup, Settings, and Scanner APIs) to prevent unauthenticated access and data manipulation.
- **SSH Deployment Security**: Eliminated vulnerable `echo` password piping in `agent_deployer.py`. Deployment now utilizes secure `stdin` piping via Paramiko and is primed for future SSH key-only support.
- **Atomic Setup**: Restructured the Setup Wizard to ensure `setup.complete` and `api.master_token` are committed atomically, preventing unrecoverable states during server initialization.
- **Data Protection**: Excluded sensitive `agent_tokens` from JSON backups and added strict 10MB upload limits to prevent DoS attacks.
- **Validation**: Implemented robust IPv4 validation for manual IP scans to mitigate command injection risks.

### Fixed & Improved
- **Concurrency**: Added `asyncio.Lock()` to `ScanStateManager` for thread-safe scan state management and WebSocket broadcasting.
- **Memory Optimization**: Refactored network discovery loops to prevent redundant function allocations, improving scan performance.
- **Stability**: Fixed a potential `UnboundLocalError` in the agent report handler by properly initializing device mapping variables.
- **Documentation**: Updated hashing service docstrings to accurately reflect the use of Argon2.

## [0.2.2] - 2026-05-13

### Changed
- **UI/UX Nomenclature:** Standardized navigation by renaming "IP Management" to **"Netzwerk-Planer"** (Grid/IP logic) and "Network Planner" to **"Topologie"** (Visual Map/Racks) to resolve user confusion.
- **Frontend Cleanup:** Removed unused Lucide icons and redundant state variables in `SubnetView.tsx` for cleaner code and smaller bundle size.

### Fixed
- **Database Reset:** Enhanced the "Nuclear Option" to include the `app_settings` table, ensuring that "Network Groups" (Bereiche) and the setup state are completely wiped during a reset.
- **Production Sync:** Added a dedicated `docker-compose.unraid.yml` to force local builds and prevent Docker from pulling outdated images from registries.
- **Version Detection:** Improved `version.py` logic to be container-aware, fixing an issue where `v0.2.0` was reported due to missing path resolution in Docker.
- **Security:** Hardened password hashing with Argon2 and improved token security (master tokens are no longer returned in API bodies).

## [0.2.1] - 2026-05-13

### Added
- **Infrastructure Hardening:** Upgraded backend to Python 3.12-slim and implemented a non-root user security model for the container.
- **Central Versioning:** Implemented a single source of truth via root `VERSION` file, with a Python sync script and dynamic API/UI versioning.
- **Security:** Added `SECURITY.md`, `SOUL.md`, `AGENT.md`, and `CONTRIBUTING.md`. Configured conditional `Secure` flag for authentication cookies.
- **CI/CD:** Added GitHub Actions workflow for automated linting and build checks.
- **Docker:** Refactored Compose files into `docker-compose.yml` (Bridge), `docker-compose.macvlan.yml`, and `docker-compose.hostnet.yml` for clearer deployment options.

### Fixed
- **Database:** Resolved critical `sqlite3.OperationalError` by adding missing schema migrations for `agent_tokens` table.
- **Frontend Auth:** Fixed token mismatch between `master_token` and `gravitylan_token` causing 401 Unauthorized errors.
- **WebSockets:** Fixed `token=undefined` issue in WebSocket connections for Scanner, Metrics, and Live Logs.
- **Capabilities:** Properly granted `NET_RAW` and `NET_ADMIN` to the non-root `gravitylan` user via `setcap` on `nmap`.

## [0.2.0] - 2026-05-12

### Added
- **Authentication & Setup:** Added password configuration step to Setup Wizard and backend support. Dashboard authentication is now fully enforced.
- **WebSockets:** Token-gated websockets with fallback allowance during the setup phase.
- **Topology Designer:** Re-enabled dragging and dropping with live API synchronization.
- **Discovered Hosts:** Added a UI Trash button in the Network Planner (SubnetView) to permanently delete stale or offline discovered devices.
- **Database Migrations:** Basic DB migrations package setup.

### Changed
- **Docker Setup:** Unified Docker production configuration by removing redundant folders. Added `HEALTHCHECK` and `DEBUG=false` to the root `Dockerfile`.
- **Resource Management:** Added explicit CPU/RAM resource limits and network capabilities (`NET_RAW`, `NET_ADMIN`) to `docker-compose.yml`.
- **Network Mode:** Switched to standard bridge networking (restored host networking) to prevent MACVLAN DHCP conflicts.
- **Timezones:** Enforced UTC timezone for all `datetime.now()` calls across the backend.
- **Documentation:** Created a bilingual EN/DE `README.md` with updated architecture diagrams and resized screenshots.

### Fixed
- **Security (P0):** Resolved shell injection vulnerabilities in `discovery.py` by switching to `create_subprocess_exec` with array arguments instead of `shell=True`.
- **Security:** Masked master token in API logs.
- **Database Integrity:** Added missing database indices and unique constraints for `TopologyLink`, `Rack`, `DeviceGroup`, and `DeviceHistory` based on the recent security audit.
- **API Validation:** Applied Pydantic validation (`RootModel`) to the Settings API endpoint.
- **Deployment:** Fixed production volumes on unraid to prevent overwriting built assets. Resolved agent script paths for correct download/deploy operations.
- **Setup Wizard:** Resolved an issue where the admin password was not persisting during the initial setup due to API client mismatch.
- **Frontend:** Fixed unused variables and removed `max_ports` from the topology update logic. Fixed a missing icon import (`Trash2`) in `IPTile.tsx`.

### Removed
- Removed old `docker/` configuration folder to establish the root config as the single source of truth.
- Removed obsolete `agent_config` and temporary planning files from the repository.
- Deleted 4 scratch test files (`scratch_*.py`) from the backend root.

---

*(Changes logged from commit `52ec94e0f5da32a9238454da45abc7132bd93159` to present.)*
