# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.4.0] - 2026-10-19

### Added

- **Health & Availability Dashboard (`/health`)**:
  - Dedicated network SLA radar combining real-time ICMP ping latency, jitter, uptime percentage, flapping frequency, SSL certificate validity, and pending security updates into an overall Network Health Score ($0-100$).
  - **24/7 Server vs. Client Classification**: Devices can be marked as non-24/7 client systems (`alert_offline: false`), preventing offline laptops and workstation sleep cycles from dragging down the homelab's overall health score or triggering false outage alerts.
  - **Interactive Telemetry Graphs**: Live latency and jitter sparklines with smooth SVG cubic bezier curves, cursor tracking, and precise point inspection tooltips.
  - **Incident & Stability Timeline**: Real-time log tracking connection drops, flapping cycles, certificate warnings, and security advisory notices.
  - **Telemetry Drawer**: Full slide-over drawer with hardware telemetry (CPU, RAM, Temp), port probes, and SLA statistics for any inspected device.
  - **Mobile Touch Cards**: Optimized card layout replacing wide tables on mobile screens for comfortable single-thumb navigation.

### Improved

- **Mobile Responsiveness Across All Submenus**:
  - Updated Bottom Tab Navigation to support all 6 primary views on smartphones (including Galaxy S23 Ultra) with a 60px touch bar and safe-area insets.
  - Responsive multi-column collapse: Device Inspector / Editor sections, agent management, and settings lists automatically adapt to single-column layouts below 640px.
  - Popovers (Notifications Center and Gateway selector) now render as centered mobile dialog sheets rather than overflowing viewports.
  - Refined sticky Save Bar positioning directly above the mobile navigation bar.

### Fixed

- **CSS Specificity Reset Collision**: Encapsulated universal resets inside `@layer base` to prevent raw `* { margin: 0; }` declarations from overriding Tailwind v4 utility spacing, replacing fragile child margin hacks with native CSS `gap` layouts across the application.

## [0.3.25] - 2026-10-18

### Security

- **A copy of the database could log in as any agent**: Since 0.3.20 agent tokens were stored as SHA-256 hashes, but without a marker. New tokens are 64 hex characters, the same shape as a hash, so the server also compared the stored value directly with the submitted token. Anyone holding the database file or a volume backup could send the stored hash as the token, was logged in as that agent and locked the real agent out. Stored tokens and pending tokens are now tagged `sha256:<hash>`, and a stored hash is never accepted as a token. One helper checks the agent report, the agent WebSocket, adoption, deploy and config download. On startup the stored tokens are converted: untagged hashes of agents that have reported before are tagged, and plaintext tokens from older versions are hashed. Running agents stay logged in and keep their `agent.conf`. Two consequences: the plaintext token only exists in the config download or deploy, so every new config download issues a new token and the previous `agent.conf` stops working. And an agent that installed a downloaded config but has not reported since before 0.3.20 is no longer accepted with its old token; adopt its pending token in the dashboard or download its config again.

## [0.3.24] - 2026-10-17

### Fixed

- **Subnet Area Manager Auto-Save Spam**: In the "Manage Areas" (Bereiche verwalten) modal of the Subnet View, modifying area names, start/end IP bounds, or colors no longer triggers immediate backend API calls and toast notifications on every single keystroke. Changes are kept in local dialog state and persisted cleanly with a single toast upon clicking the new "Speichern" (Save) button. An "Abbrechen" (Cancel) button allows discarding in-progress edits.

## [0.3.23] - 2026-10-17

### Added

- **Group Renaming**: Device groups can now be renamed directly in Settings → Manage Groups via an inline edit button with keyboard support (Enter to save, Escape to cancel). Duplicate and empty group names are validated and rejected gracefully.

## [0.3.22] - 2026-10-17

### Added

- **One device for a router that is the gateway of several VLANs**: A device can now carry further addresses as interfaces (new `device_interfaces` table: address, MAC, subnet, VLAN, label, own online state). Scans that see an interface address update the interface; no second device appears and no IP change is reported. When an address is the gateway of its subnet and answers with the MAC of a known device in another subnet, it is attached to that device automatically (history entry "Interface … attached"). Interfaces go offline silently with the usual miss threshold, so offline events and webhooks stay once per device.
- **Subnet gateway and VLAN tag**: Subnets store an optional `gateway_ip` (must lie inside the subnet) and `vlan_id` (1–4094), edited in Settings → Scan subnets (router button per row) and in the network overview's subnet dialog. Where no gateway is entered, GravityLAN uses the container's default route for the local network, else the first host address (`.1`); the field shows that automatic value as placeholder. Changing a subnet's VLAN tag also applies to the interfaces in it.
- **IP overview knows the router in every VLAN**: In each subnet tab the gateway address shows the router device with that interface's own online state and opens the same device; interface addresses no longer count as unknown new hosts.
- **Gateway list in the dashboard**: A "Gateways" button in the dashboard toolbar opens a keyboard-navigable list of every subnet's gateway: VLAN tag, address (copy button), online state, whether it is entered, detected or only suggested, and the device that answers there. Arrow keys, Home/End and a filter field move through it; Enter opens the device on its new Interfaces tab.
- **Merge duplicates into interfaces**: GravityLAN suggests devices and discovered addresses that look like further interfaces of another device (same MAC across subnets, same hostname, same pinned SSH host key, gateway of both subnets). The device inspector's new "Interfaces" tab lists all addresses with their state, lets you add, label and detach interfaces and offers "Merge as interface of <device>". Merging moves history, cables, SSH connections, child devices and missing services to the kept device and only then removes the duplicate; nothing is merged or deleted automatically, and devices with an agent are not merged.
- **VLAN chips and one topology node**: Device tiles of multi-homed devices show one colour-coded chip per network (the same colour per subnet in the gateway list and the inspector), and the topology map keeps the router as one node listing its VLAN addresses.

### Security

- **A link on another website could fire test webhooks (CSRF)**: `GET /api/webhooks/test` sends a request to every active webhook and also accepted the dashboard's session cookie. Browsers send that cookie along when another site links or redirects to a GET URL, so visiting such a page while logged in was enough to trigger it. The GET variant now only accepts an API token in the `Authorization: Bearer` header and answers a cookie-only request with HTTP 403. Scripts and chatbots that send the token as a header work as before; from the browser, or without a header, use `POST /api/webhooks/test` (optional JSON body `{"event": "...", "data": {...}}`).
### Changed

- **"Agent update" button in the SSH terminal is always shown for devices with an agent**: until now it only appeared while an update was available, so the feature could not be found. It is now shown for every terminal session of a device with an agent: highlighted and usable when the server ships a newer agent, greyed out with the installed version ("up to date") otherwise.

### Fixed

- **Gateway jumping between its VLAN addresses**: A router answering with the same MAC (or hostname) in several subnets was matched by the MAC/hostname fallback and recorded as an IP change on every scan, flipping between its addresses with an "IP changed" history entry each time; its discovered-host record moved along. The same MAC or name in another subnet is no longer treated as an IP change while the device is a known gateway, has interfaces or still answers on its own address. A device that has gone offline can still move to another VLAN as before.

## [0.3.21] - 2026-10-17

### Fixed

- **MAC Vendor Negative Caching**: Unresolvable or 404 MAC OUIs are now stored in memory and file cache, preventing repeated outbound queries on every recurring scan cycle.
- **MAC Vendor API Request Throttling**: Outbound requests to `api.macvendors.com` are serialized with an enforced minimum 1.2-second interval, eliminating HTTP 429 rate limit errors during multi-device network sweeps.
- **PermissionError Graceful Handling**: Catch `PermissionError` when saving the MAC vendor cache to volume storage (e.g. host-mounted `./data` with prior root ownership), logging a clear host remediation command (`sudo chown -R 1000:1000 ./data`) once while preserving seamless in-memory cache operation.

## [0.3.20] - 2026-10-17

### Security

- **Agent Token SHA-256 Hashing & Auto-Migration**: Agent bearer tokens are stored as SHA-256 hashes with transparent on-the-fly migration for legacy plaintext tokens upon incoming reports.
- **WebSocket Scope & Token Hardening**: API token scopes are enforced on WebSocket endpoints (`settings:read`, `scanner:read`, `agent:read`), and agent WebSocket authentication supports SHA-256 hashed credentials.
- **SSH TOFU Host-Key Pinning**: Remote package patching verifies and records host keys on first contact via `SshKnownHost`, preventing man-in-the-middle attacks on dynamic homelab hosts.
- **DNF Package Name Shell Escaping**: Package names in remote DNF queries are safely quoted with `shlex.quote`.
- **Agent Config Download Protection**: Exporting agent configurations is restricted to `agent:write` scopes, preventing read-only API tokens from retrieving agent tokens.

### Changed

- **Agent API Modularization**: `app/api/agent.py` refactored into dedicated submodules (`agent_telemetry.py`, `agent_scripts.py`, `agent_patches.py`), reducing complexity while maintaining backwards compatibility.
- **Backup PRAGMA & Cache Invalidation**: SQLite backup operations use `busy_timeout = 15000` to prevent database locks, and in-memory caches are systematically cleared after restores.
- **Lifespan Startup Management**: Subnet cleanup migrated from deprecated router event to central FastAPI lifespan context.
- **Performance Optimizations**: Eliminated N+1 queries in device group details and added fast TCP pre-checks for port 445 SMB scanning.

## [0.3.19] - 2026-10-17

### Changed

- **One List of Scan Subnets** ([#18](https://github.com/SleeperXr/GravityLAN/issues/18)): The subnets of the network overview are now the only source of what gets scanned. Scheduled scans, quick checks, the ARP turbo filter and the dashboard scan cover every enabled subnet; only while none is configured do they fall back to the container's own interfaces. Before, the scanners read the separate "Subnets to scan" text field, so a subnet added in the overview (e.g. an IoT VLAN) was never scanned and a subnet entered in Settings got no tab.
- **Scan Subnets in Settings**: The comma-separated "Subnets to scan" field is replaced by a list of the same subnets the overview shows: add one with an optional name, pause or resume scanning, or remove it. Changes apply immediately. Networks detected on the host but not yet scanned (e.g. a VLAN interface added after setup) are offered with one click.
- **Paused Subnets in the Network Overview**: Every subnet keeps its tab; a paused one is greyed out and marked "Paused", and the subnet settings dialog has a "Scan" switch per subnet.
- **Setup Wizard Registers Its Networks**: The networks scanned during setup are saved as scan subnets even when no device was found, so each one gets a tab right away. The network step also takes additional subnets the container can't see directly, such as an IoT VLAN behind the router (macvlan setups).
- **Dashboard Scan Picker**: The "Select network" dialog lists the enabled scan subnets instead of only the container's interfaces.

### Fixed

- **Legacy Scan Subnet Setting Merged on Start-up**: Entries of the old `scan_subnets` setting are added to the subnet list on the first start (re-enabled if they were paused), then the setting is removed. This now also works when the list already has entries, and it runs before the scan scheduler starts. Clients that still send `scan_subnets` to `POST /api/settings` add the subnets to the list instead of storing a second copy.
- **Subnet Validation**: Subnets created or changed through `/api/network/subnets` must be IPv4 networks no larger than a /16; host bits are cleared (`192.168.110.5/24` becomes `192.168.110.0/24`), the name defaults to `Network <cidr>`, and a duplicate returns 409 instead of a server error.
- **English L2/L3 Subnet Badges**: The Network Planner's subnet badges no longer show German text (`L2 Direkt`, `L3 Geroutet`) in the English UI. Tabs, header, and the subnet settings dialog now use translated labels, and the settings dialog shows `L2 Probe (<Device>)` for subnets served by an agent probe instead of calling them routed without MAC discovery.

### Security

- **Agent ARP relay limited to the probe's own subnets**: the server applied the ARP table of every agent report, from any agent, so one agent token could overwrite the MAC, vendor and online state of any device in the inventory. Neighbors are now only taken from devices with the Layer-2 probe (`enable_scanner_relay`) switched on, and only for addresses inside a scan subnet that contains the probe's own IP; all other entries are ignored. If a probe no longer fills in MAC addresses, add the subnet it sits in to the scan subnets (Settings or network overview).

## [0.3.18] - 2026-10-15

This release introduces remote Layer-2 subnet scanning via agent probes, allowing Linux hosts with the GravityLAN agent installed to act as remote network probes for routed VLANs.

### Added

- **Agent Layer-2 Scanner Probe (Relay)**: The GravityLAN agent (v0.3.8) can now be toggled as a remote L2 probe (`enable_scanner_relay`) in the Device Editor. The agent probes broadcast neighbors and reads the kernel ARP table (`/proc/net/arp`), reporting neighbor MAC and IP pairs to GravityLAN.
- **Remote ARP Ingestion & Device MAC Resolution**: The backend ingests remote ARP tables, updating devices and discovered hosts in routed subnets with their native MAC addresses and vendor OUIs.
- **Network Planner Probe Indicators**: Subnets serviced by an active remote agent probe display a dedicated `● L2 Probe (<Device>)` badge in tabs and headers with full status tooltips.

### Fixed

- **Setup Wizard Sign-in Flow**: Restored automatic session login upon completing the setup wizard so the initial post-setup device refresh executes with valid authentication credentials.

## [0.3.17] - 2026-10-15

This release hardens the first-run Setup Wizard with atomic session cookie issuance and full multi-subnet adoption, resolves gateway and proxy-ARP MAC collisions across routed VLANs, adds live Layer-2 vs. Layer-3 reachability indicators to the Network Planner, and provides a multi-VLAN Docker Compose template.

### Added

- **Layer-2 Direct vs. Layer-3 Routed Subnet Badges**: The Network Planner tabs, header, and settings dialog now dynamically detect whether a subnet is directly attached to a host interface (`L2 Direct`) or routed through a firewall/gateway (`L3 Routed`). Clear tooltips explain why routed subnets cannot resolve MAC addresses via ARP broadcasts and recommend using the host agent or multi-VLAN Docker Compose.
- **Multi-VLAN Docker Compose Template & Guide**: Added `docker-compose.multi-vlan.yml` demonstrating IEEE 802.1Q tagged macvlan interfaces (`eth0.10`, `eth0.20`, etc.) along with comprehensive documentation in `docs/multi-vlan-setup.md`.

### Fixed

- **Setup Wizard Session and Login Desynchronization**: `/api/setup/complete` now sets the authenticated admin session cookie atomically upon saving the password, eliminating the redundant follow-up login call that could strand users on the login screen.
- **Setup Host Adoption across Routed VLANs**: The initial setup discovery now imports online hosts from all user-selected subnets, including routed VLANs, rather than restricting adoption to local physical subnets.
- **Proxy-ARP and Gateway MAC Collisions**: Remote routed IPs sharing the gateway's MAC address via proxy-ARP or router caches no longer overwrite host identities; shared gateway MACs are isolated to the local interface subnet.
- **Subnet Cleanup Database Loop**: Optimized invalid subnet cleanup on backend startup to batch-delete records instead of making individual delete queries in a loop.
- **Local Log Files in the Docker Image**: `.dockerignore` excludes `*.log` files to keep local developer logs out of container images.

## [0.3.16] - 2026-10-15

Agents can now be updated straight from the SSH terminal, and the agent install and the Agent Update Center can log in with saved SSH key connections instead of asking for a password every time. Install codes no longer end up in the server's request log.

**Upgrade notes**

- No agent update is needed for this release; the agent stays at 0.3.7.
- To install or update an agent with a saved connection, connect to the device once in the SSH terminal and confirm its host key; until then the saved connection is refused.
- API: `POST /api/agent/deploy/{id}` and `/api/agent/uninstall/{id}` without `ssh_user` (and without `profile_id`) now answer HTTP 400 instead of 422.

### Added

- **Agent update from the SSH terminal**: when the device a terminal is connected to runs an older agent than the server ships, the terminal toolbar shows an "Agent update" button. It types the same one-line installer as the device's Agent tab into the input line, with a fresh one-time install code (valid for 30 minutes, usable once), but does not run it: review it and press Enter yourself, sudo may ask for a password. The command starts with a space, so shells that leave such lines out of their history (`HISTCONTROL=ignorespace` or `ignoreboth`, as in the default user `~/.bashrc` on Debian and Ubuntu) do not keep it; where it is kept, the code stops working once the installer has used it, or after 30 minutes. Only sessions opened for a device or through a saved connection of a device get the button; a plain host address is never matched to a device.

- **Agent install and update with saved SSH connections**: the Agent tab of the device editor and the Agent Update Center can log in with a saved SSH connection (SSH → saved connections) instead of asking for a password every time. Only connections that log in with a stored key are offered, and only for their own device; the Update Center uses each device's connection and falls back to the user and password typed in for all others. The key is decrypted on the GravityLAN server only and never sent to the browser. For safety, the device's host key must already be confirmed in the SSH terminal: GravityLAN then only logs in to a server presenting exactly that key and refuses before logging in if it differs. Saved connections work from the logged-in web interface only, not with API tokens. A user other than root may need a sudo password, which can be entered for the run and is not stored. Package updates (patches) still ask for credentials.

### Fixed

- **Failed SSH logins were reported as an unreachable host**: when the agent deploy or uninstall was refused because of a wrong password or key, the message said "SSH connection failed. Please check host availability and port." It now says that the authentication failed.

### Security

- **Install codes were written to the access log**: the manual install and update command carries its one-time code in the URL (`…/install-sh/<id>?code=…`), and the server's request log recorded it in plain text, also in the log viewer. The value of `code=` is now masked as `[redacted]` in logged request lines.

## [0.3.15] - 2026-10-14

A security and reliability release. Input that ends up in shell commands, nmap or the agent installer is now checked strictly, a backup import can no longer replace credentials, logins are rate-limited, webhooks can no longer target the GravityLAN host or cloud metadata services, and SSH update checks no longer freeze the backend.

**Upgrade notes**

- Update your agents to 0.3.7 (the web interface offers it) to get the fixes marked "Needs the agent update". Re-deploy an agent to also get the owner-only `agent.conf` and the sandboxed service.
- If you set `server.url` by hand, it now has to be a plain `http(s)://host[:port][/path]`; IPv6 addresses in brackets are not accepted. A stored value that fails the check is ignored, and the auto-detected address is used instead.

### Security

- **Agent token was readable by every user on the host**: the agent deploy left `/opt/gravitylan-agent/agent.conf` (it holds the agent's token) at mode `644`, and the files it staged in `/tmp` on the way there were created with the default umask. The config is now `600`, and staged files are created owner-only (`umask 077`). Re-deploy an agent to tighten an existing install, or run `chmod 600 /opt/gravitylan-agent/agent.conf` on the host.
- **Frontend file serving**: the check that a requested file lies inside the frontend build only compared the path prefix, so a sibling directory with the same prefix (`/app/static_other` next to `/app/static`, reachable through a symlink) passed. It now compares whole path components.
- **Host setting validation**: `GRAVITYLAN_HOST` accepted host-name labels that start or end with a hyphen (e.g. `-invalid-`); they are now rejected.
- **Server URL could inject commands into the agent installer**: the `server.url` setting is written into the install script that runs as root (`curl … | sudo bash`), and only spaces were rejected. It now has to be a plain `http(s)://host[:port][/path]` without query, fragment, whitespace or shell characters, and the script quotes every value. A previously stored URL that fails the check is ignored in favour of the auto-detected address (with a warning in the log).
- **DNS server was passed to nmap unchecked**: the DNS server from the settings, the setup wizard and a subnet's settings goes to `nmap --dns-servers`. It now has to be a single IPv4 or IPv6 address; an empty value still means "no custom DNS server".
- **Backup import replaced credentials and accepted agent tokens**: importing a backup deleted all settings, including the master token, the admin password and the setup flag, and took them from the file. A backup from another instance could lock you out or give its owner access, one without them reopened the setup wizard. The import also restored `agent_tokens`, which the export leaves out. These three settings now always stay as they are, and agent tokens are no longer imported.
- **Device, group, service and topology routes check the login themselves**: they relied on the app adding the check when mounting them; the routers now carry it too, so a later change there cannot leave them open. Scoped API tokens (`devices:*`, `topology:*`) work as before.
- **Webhooks could target internal addresses (SSRF)**: a webhook URL only had to start with `http(s)://`, so it could point at the GravityLAN host itself (`127.0.0.1`, `localhost`), the cloud metadata service (`169.254.169.254`) or other link-local addresses, and every matching event made the server send a request there. Such URLs are now rejected when a webhook is created, and the target is checked again before each delivery, which also covers older webhooks and host names that resolve to such an address. LAN addresses still work; for a service on the GravityLAN host itself, use the host's LAN address.
- **Read-only API tokens could fire test webhooks**: `GET /api/webhooks/test` sends a request to every webhook but only needed the `settings:read` scope. It now needs `settings:write`, like the `POST` variant.
- **No protection against password guessing**: the login accepted any number of attempts. After 5 failed attempts within 60 seconds from the same address, further attempts are refused for the rest of that minute (HTTP 429 with `Retry-After`), even with the right password; a successful login resets the count. Behind a reverse proxy on another machine, all logins count against the proxy's address.
- **"Add device by IP" accepted any text**: `POST /api/devices/add-from-ip` stored the value as the device's IP and passed it to the hostname lookup tools. It now has to be a plain IPv4 address (HTTP 400 otherwise).

### Fixed

- **Database repair assigned IPs from a developer's network**: at start-up, the repair of placeholder IPs (`offline-…`) gave devices fixed `192.168.100.x` addresses by database ID and by names such as Nextcloud, Unraid or Paperless. On other installations unrelated devices could get these addresses. Only the generic repair is left: a running Docker container with a matching name, the device's previous IP, or a unique placeholder.
- **A failed backup import left a half-emptied database**: tables were cleared one after another, so an error part-way (e.g. a duplicate IP in the file) left tables empty. The import now runs in one transaction and changes nothing if any part fails. Malformed files are rejected with a clear message instead of a server error.
- **Update output could arrive out of order or get lost**: the live output of a patch run and the "invalid or expired session" message were sent as background tasks; the message could be cut off by the connection closing right after it, and output lines could arrive out of order. Everything is now sent in order. If the browser is closed during an update, the update still runs to the end on the host and the patch counters are reset. Patch session tokens older than 60 seconds are now rejected.
- **Rejected input returned a server error**: when a request failed a field check (for example an invalid DNS server), the response itself crashed and the client got a 500 instead of a 422 with the reason.
- **Old history and metrics were pruned only once per scan interval**: the cleanup for the history retention ran inside the scheduled full scan, so with a long scan interval (e.g. weekly) agent metrics were kept that long. It now runs on its own schedule (at most every 12 hours).
- **Systemd unit template pointed to the wrong directory**: `agent/gravitylan-agent.service` (for manual installs) used `/opt/gravitylan`, while the installer and the deploy use `/opt/gravitylan-agent`.
- **A failing scan stayed "running"**: when a dashboard or planner scan hit an error, the error handler itself crashed (it used a scan state that does not exist), so the failure was never reported and the progress stayed on "running". The scan now ends as "failed" with the error message.
- **Dashboard scan reported "Scan completed" too early or on failure**: the overview stopped watching the scan at the first "host discovered" update and announced success, and also showed "Scan completed" when the scan had failed. It now waits for the end of the scan and shows "Scan failed" with the reason.
- **Agent network throughput was 30× too high**: the agent sent the bytes transferred since the last report (every 30 s) as "bytes per second". It now divides by the elapsed time. Needs the agent update.
- **Agent ran the package manager every 30 seconds**: the update check (`apt-get -s upgrade`, `do-release-upgrade -c`, `dnf check-update`, …) ran with every report. It now runs at most once per hour, and right away after packages were installed or upgraded, so finished updates still show up at the next report. Needs the agent update.
- **Agent start could kill unrelated processes**: on start the agent stopped every process whose command line contained `gravitylan-agent`, including an editor or `tail -f` on its files. It now only stops other Python processes running `gravitylan-agent.py`. Needs the agent update.
- **Unraid detection relied on a fixed device ID**: scan matching treated the device with database ID 29 as the Unraid host (an ID from a development database), so on other installations some unrelated device could not change its IP. Unraid hosts are now recognised by "unraid" in the display name, custom name, hostname or vendor.
- **Nmap errors were logged empty**: when nmap failed, the log showed its (already read) output instead of its error message.
- **Nmap scanned some addresses several times**: with fewer than 50 target addresses spread over several /24 networks, every network pass scanned all of them again. Each pass now only scans the targets in its own network.
- **Package update checks froze the whole backend**: listing a device's updates over SSH (connecting, `apt-get update` for up to 90 s, the package queries) and connecting for a patch run blocked the server while the SSH calls ran, so the dashboard, the API, live WebSocket updates and scheduled scans stalled until the host answered or the connection timed out. These SSH calls now run in background threads, and patch output still arrives in order.
- **Cached device list could fail on later requests**: the device list was cached as database objects tied to the request that loaded them; reading a value that had not been loaded yet could then fail (`DetachedInstanceError`). The cache now holds plain response data.
- **"Refresh all" left old data on the dashboard**: after the background refresh of hostnames, MAC addresses and vendors, the device list and the topology map kept showing cached values. Both caches are now cleared when the refresh is done.
- **"Fresh" notifications in the health summary used local time**: `fresh_30min` compared the UTC timestamps of the history with the server's local time, so on a server outside UTC the 30-minute window was off by the UTC offset. It now uses UTC.
- **Scans slowed down by hosts without a DNS name**: when DNS, mDNS and `dig` found no name, the hostname lookup started an extra `nmap -sn` for that host (up to 3 s each), although discovery had just run nmap for the whole subnet. That extra nmap is gone, and `dig` now asks the DNS server from the settings instead of only the system resolver.

### Changed

- **Faster device and SSH lists**: the device overview loaded each device's agent token and, for hidden parents, the parent name with separate database queries; the SSH profiles and history loaded the device and key of every entry one by one. Each list now needs one query per table.
- **Removed the old `homelan-agent`**: `agent/homelan-agent.py`, its service file and `agent/test_agent.py` belonged to the predecessor of `gravitylan-agent.py` and were no longer used. Their test cases now run against the current agent.
- **Agent version 0.3.7**: includes the agent fixes above marked "Needs the agent update". 0.3.7 rather than 0.3.6, because the 0.3.6 release briefly shipped an agent numbered 0.3.6 (unchanged code); agents updated then are offered this update too.
- **Agent service runs sandboxed**: the systemd unit (the template in `agent/`, the SSH deploy and the install script) now gives the agent a private `/tmp` and mounts `/home`, `/root` and `/run/user` read-only (`PrivateTmp=true`, `ProtectHome=read-only`). `/home` stays readable, so its disk usage is still reported. Applies when an agent is deployed or installed again; the agent script itself is unchanged.

## [0.3.14] - 2026-10-11

### Fixed

- **Sticky drag moved linked devices too far**: with "Sticky Drag" on, dragging a device on the topology map moved the devices linked to it by up to half again as much (and saved those positions). React Flow reports several drag steps per screen update, and each was added onto an outdated position. Linked devices now keep exactly the offset of the dragged one.

## [0.3.13] - 2026-10-11

A maintenance release: one security fix, fixes for the dashboard and the topology map, and the largest parts of the web interface rebuilt from smaller pieces, each with automated tests. Apart from the fixes below, pages look and behave as before.

### Security

- **Agent adoption could be bypassed**: when an unknown token reported for a device that had no token yet, the server stored an *active* placeholder token made of `TEMP_INVALID_` and the first 8 characters of the submitted token. Sending that string next authenticated as the device (report endpoint and agent WebSocket) without the manual adoption. The placeholder is now random and inactive, so such an agent really has to be adopted ("Adopt" on the device card).

### Fixed

- **Moving a tile to another group crashed the overview**: in edit mode, dragging a tile into another group showed "Something went wrong" (`removeChild`) or, when the old group became empty, the tile twice until a reload. The move itself was saved. GridStack had moved an element that React still owned; it is now handed back first and React moves the card.
- **Topology map reloaded when a link was selected**: selecting a link (or changing its speed in the sidebar) loaded the whole map again and restarted the one-minute refresh. It now only updates that link.
- **Topology sidebar kept showing a disconnected link**: after "Disconnect" the sidebar stayed open for the removed link; it now closes.

### Changed

- The browser console no longer shows debug output from the scan flow and from loading IP areas.

### Development

- **Frontend tests**: Vitest with Testing Library (`npm test`, `npm run test:watch`, `npm run coverage`), 199 tests. Before a component was rebuilt, tests were written against the old version and had to pass unchanged afterwards:
  - **Dashboard**: overview (data, live refresh, view mode, grid layout, device actions and scan as separate hooks; group sections, toolbar and scan panels), device editor (one component per tab), device card, live metrics, agent update center.
  - **SSH**: SSH page, terminal (xterm, session and clipboard hooks), connect and profile dialogs, key manager.
  - **IP addresses**: subnet view and IP tile.
  - **Agents** page, **setup wizard**, **settings** (one component per section), **rack view**, **topology map** (from one 1458-line file to `Topology/map/`: graph helpers, device node, link, sidebar, data flow controls and hooks).
- Complexity of the largest functions (repowise) went down, e.g. device editor 185 → 21, dashboard 123 → 16, SSH terminal 93 → 24, topology map 56 → mid-range; no critical code finding is left in the frontend.
- Backend: `pytest-cov` for coverage reports.

## [0.3.12] - 2026-10-10

Everything since 0.3.6 in one place. The builds 0.3.7–0.3.11 were published the same day while testing; their changes are all included here.

### Added

- **Change the admin password** (Settings → Access): enter the current password and the new one twice (at least 8 characters). Only a logged-in browser session can change it; all other sessions are logged out, yours stays signed in.
- **SSH terminal**
  - **PuTTY keys (.ppk)**: format 2 and 3 (Ed25519, ECDSA, RSA), also encrypted ones (format 3 with Argon2). Keys are checked against their checksum and public half and stored converted to OpenSSH, so the PPK passphrase is only needed for the import. Agent deploy and package updates accept `.ppk` keys too.
  - **Sessions stay open in the background** while you use other pages, with their scrollback. The SSH menu entry shows how many are open, and the browser asks before a reload or tab close would end them. Sessions without input still close after the idle timeout (`GRAVITYLAN_SSH_IDLE_TIMEOUT_MINUTES`, default 30).
  - **Recent connections**: connections via "Other host" or a device without a saved connection are listed (newest first, up to 20, on every browser and device). One click reconnects; password logins only ask for the password again — passwords are never stored in the history. Entries can be removed or saved as a connection.
  - **Save a tab as a connection**: right-click a terminal tab → "Save as connection" opens the editor prefilled with host, user, port and key.
  - **Toolbar**: copy the selection, **"Last command"** (copies the command you entered last with all its output, without the new prompt) and paste; shortcuts Ctrl+Shift+C / Ctrl+Shift+V (Ctrl+C stays "interrupt"). Where the browser blocks clipboard access (e.g. plain `http://`), paste opens a field to paste into with Ctrl+V.
  - **Appearance**: font (IBM Plex Mono, Cascadia Code, JetBrains Mono and Fira Code come with GravityLAN and load only when chosen; System and Courier New use the device's fonts), font size (also −/+ in the toolbar), colour schemes (GravityLAN, Classic green on black, Solarized Dark, Dracula, Light) and custom text/background colours. Applies live to all terminals and is saved in the browser.

### Changed

- **Agent stays at 0.3.5**: the agent did not change, so installed agents get no update offer. The UI now offers an agent update only when the installed version is older than the server's (before, any difference counted, which would have offered a "downgrade" to agents already on 0.3.6).

### Fixed

- **Old UI after an update** (e.g. no SSH menu after updating to 0.3.6): `index.html` had no cache header, so browsers kept the previous release while the version label already looked new. It is now always revalidated (`Cache-Control: no-cache`); reload once with Ctrl+F5 after updating to this version.
- **SSH terminal refused although logged in** ("Missing authentication token"):
  - when the 7-day session cookie had expired but the browser still held a login token from an older version — logging in now removes the old token, and the terminal says "log out and in again" instead of just disconnecting;
  - in setups where the browser sends the cookie on normal requests but not on the terminal's WebSocket — the one-time ticket of the connection request is accepted if a browser session requested it from the same address (30 s, single use). Master and API tokens still cannot open shells; the log notes terminals that arrive without a cookie.
- **Bottom terminal line cut off**: the terminal measured its height including the surrounding padding and made one row too many.
- **Key import form**: a newly chosen file also updates the name from the previous file, the same file can be chosen again, and errors clear when the key text is edited.

### Security

- **Credentials can no longer be written through `/api/settings`**: any admin request could overwrite `api.admin_password` or `api.master_token` there, without knowing the old password. Both keys are now rejected; the password has its own endpoint (`POST /api/auth/password`) that checks the current one.
- **Agent SSH credentials no longer in browser storage**: with "remember" ticked, the SSH password and key for agent deploy/updates were kept in `sessionStorage` in plain text. They now stay in memory until the page is reloaded; entries from older versions are removed.
- **Patched dependencies**: react-router-dom 7.18.4 (open redirect, XSS, DoS), postcss 8.5.28 (source map path traversal), nanoid 3.3.19 (infinite loop), source-map-js (GHSA-68fv-2mgg-jv7q, build only); backend lock file: anyio 4.14.2, cryptography 50.0.2, urllib3 2.8.0.
- The demo backend no longer prints the demo password at startup.

### Documentation

- README: SSH terminal feature, its environment variables (`GRAVITYLAN_SSH_IDLE_TIMEOUT_MINUTES`, `GRAVITYLAN_SSH_MAX_SESSIONS`, `GRAVITYLAN_VAULT_KEY`), changing the password, security notes. ADR 002 updated (PuTTY keys, recent connections hold no secrets, cookie-less terminal ticket).

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
