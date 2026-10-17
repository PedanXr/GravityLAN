# GravityLAN — Threat Model & Security Trade-offs

This document details the threat modeling, potential attack vectors, security compromises, and mitigations designed into the GravityLAN architecture.

---

## 1. Threat Scenarios & Mitigations

### Threat A: Rogue Agent Telemetry Spoofing
*   **Attack Vector**: An attacker on the local network discovers the agent reporting API endpoints and attempts to send spoofed telemetry data (CPU/RAM spikes) or register fake devices.
*   **Mitigation**: GravityLAN enforces strong, unique cryptographically-random tokens for each remote agent (`AgentToken`). Reports must include both the specific device ID and the secret agent token. Telemetry ingestion validates the token-device relationship before committing any metric data to SQLite.
*   **Trade-off**: The agent's token is stored in `/opt/gravitylan-agent/agent.conf` (`chmod 600`) on the monitored host. Access to this file is restricted to root, but local privilege escalation on the target machine could compromise the token.

### Threat B: SSH Man-in-the-Middle (MITM) during Deployment
*   **Attack Vector**: An attacker performs ARP spoofing or DNS hijacking on the local subnet to intercept the admin's remote deployment connection, capturing the target host's credentials or deploying a malicious system daemon.
*   **Mitigation**:
    *   GravityLAN supports an opt-in SSH Strict Mode (`GRAVITYLAN_SSH_STRICT_MODE=True`). Under Strict Mode, the Paramiko client loads system known hosts from `/home/gravitylan/.ssh/known_hosts` (inside Docker container) and enforces `RejectPolicy` for unknown host keys. Additionally, DB-backed TOFU pinning in the SQLite table `ssh_known_hosts` protects against host key changes during patch operations.
    *   Deployments use local script delivery via secure SCP rather than heredoc shell piping, isolating password delivery from script execution.
*   **Trade-off**: When Strict Mode is active, admins must seed host keys in the server's `/home/gravitylan/.ssh/known_hosts` file (either via mount or container shell) or confirm them via the SSH terminal. In dynamic DHCP homelabs, this adds configuration overhead.


### Threat C: Local Database Exposure
*   **Attack Vector**: An unauthorized user with direct shell access to the host server reads the SQLite database, extracting agent credentials, master API tokens, or system inventories.
*   **Mitigation**: The SQLite file is stored within a protected Docker volume (`/app/data`) restricted to the container run-time.
*   **Trade-off**: If the underlying host is compromised or Docker socket permissions are insecure, the SQLite database can be directly read. GravityLAN does not encrypt local inventories on disk, assuming host-level storage security.

---

## 2. Security Trade-off Matrix

| Feature | Homelab/Default Mode | Hardened / Strict Mode | Trade-off Impact |
| :--- | :--- | :--- | :--- |
| **SSH Key Policy** | `WarningPolicy` (Auto-accept new keys, log mismatch warning) | `RejectPolicy` (Strict matching against loaded `known_hosts`) | WarningPolicy is highly convenient but vulnerable to MITM. Strict mode shields against MITM but requires manual pre-seeding of keys. |
| **CORS Origins** | Strict Origin Isolation (Production) / Configurable List | Custom whitelist only | Limits public web dashboard access unless explicitly permitted by the administrator. |
| **SQLite Retention** | Configurable Retention (Default 30 days) | Compact historical retention | Keeps databases small and highly performance-optimized, at the cost of losing historical time-series metric tracking for deep retroactive analysis. |
