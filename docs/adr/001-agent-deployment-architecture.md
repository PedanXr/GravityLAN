# ADR-001: Agent Deployment Architecture

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Backend Team
**Technical Story:** GravityLAN Agent Deployment via SSH

## Context

GravityLAN deploys a Python-based monitoring agent (`gravitylan-agent.py`) to remote Linux hosts via SSH. The deployment process must:

1. **Connect securely** — SSH with key or password, configurable strict host key checking
2. **Support diverse platforms** — systemd (most Linux), Synology rc.d (Synology NAS), nohup fallback (Unraid, containers, restricted systems)
3. **Be idempotent** — Re-running deployment upgrades agent, config, and service without manual cleanup
4. **Never persist credentials** — SSH passwords/keys are runtime-only, never stored (one exception since 2026-10-15:
   deploy and removal may use a saved *key* connection of the SSH terminal, see ADR-002 decision 9)
5. **Surface failures visibly** — Errors appear in UI (Agents tab), not silent logs

Prior to v0.3.4, `agent_deployer.py` was a 655-line monolith with duplicated SSH connection logic, nested conditionals, and no architectural governance (ungoverned_hotspot).

## Decision

We establish a **layered architecture** for agent deployment:

### 1. Public API (Stable)
```python
async def deploy_agent(*, host_ip, ssh_user, ssh_password, ssh_key, ssh_port, server_url, device_id) -> tuple[bool, str, str]
async def remove_agent(*, host_ip, ssh_user, ssh_password, ssh_key, ssh_port) -> tuple[bool, str]
```
- **Never change signatures** — called by `app/api/agent.py` and `tests/test_security.py`
- Versioned via `LATEST_AGENT_VERSION` constant

### 2. Orchestration Layer (`deploy_agent` / `remove_agent`)
- Thin coordinators calling phased helpers
- Each phase: **setup → deploy → verify → fallback**
- Error handling: specific paramiko exceptions first, broad `except Exception` last (intentional, logs + user-friendly message)

### 3. Shared SSH Infrastructure (Stable, Reusable)
| Helper | Responsibility |
|--------|----------------|
| `_build_ssh_client()` | Host key policy from settings |
| `_build_connect_kwargs()` | Credentials → paramiko kwargs + validation |
| `_connect_with_gateway_fallback()` | Direct connect → Docker bridge gateway retry |

### 4. Execution Abstraction (`_RemoteRunner` class)
- Encapsulates sudo logic, command batching, timeout handling
- Single `_exec_impl()` for all remote commands
- Testable via paramiko mocks

### 5. Platform Detection & Service Management
- `_probe_platform()` → `(has_systemd, has_syno_rc)`
- `_install_systemd_service()`, `_install_syno_rc()` — isolated, swappable
- Nohup fallback (`_nohup_fallback`) as last resort

### 6. Constants (Single Source of Truth)
```
REMOTE_BASE_DIR = "/opt/gravitylan-agent"
REMOTE_AGENT_PATH = f"{REMOTE_BASE_DIR}/gravitylan-agent.py"
REMOTE_CONFIG_PATH = f"{REMOTE_BASE_DIR}/agent.conf"
REMOTE_SERVICE_PATH = "/etc/systemd/system/gravitylan-agent.service"
```

## Consequences

### Positive
- **Churn reduction**: Public API frozen; internal helpers stable; future changes isolated to phases
- **Testability**: `_RemoteRunner`, `_build_connect_kwargs`, `_probe_platform` unit-testable with mocks
- **Governance**: ADR exists → `ungoverned_hotspot` resolved
- **co_change_scatter reduction**: SSH helpers no longer duplicated in `deploy_agent`/`remove_agent`

### Negative
- More files/functions to navigate (mitigated by clear naming)
- `_RemoteRunner` adds abstraction layer (justified by sudo/password complexity)

### Neutral
- Broad `except Exception` retained in orchestration (intentional: user-facing error messages)
- `blocking_sync_in_async` for `open(AGENT_SCRIPT_PATH)` remains (module-load time constant, not hot path)

## Validation

- All 10 security tests pass (`tests/test_security.py`)
- 124 regression tests pass (planner, dashboard, migrations, sync, discovery, security)
- Code health: fixable findings cleared; only historical remain

## Future Changes Requiring ADR Amendment

- New platform support (e.g., OpenRC, launchd) → add installer helper
- SSH protocol change (e.g., SSH certificates) → modify `_build_connect_kwargs`
- Agent protocol change (config schema, RPC) → version bump + migration strategy

## Amendment 1 (2026-09-25): Event loop safety, cleanup scope, manual-install enrollment

- **Worker thread:** paramiko is fully blocking. `deploy_agent` / `remove_agent` keep their async signatures, but their SSH session (`_deploy_agent_blocking` / `_remove_agent_blocking`) runs via `asyncio.to_thread`, and every helper below them is synchronous. Before, a deployment froze the whole server (API, WebSockets, scheduler) for its full duration.
- **Cleanup scope:** the pre-install cleanup only stops `gravitylan-agent` / `homelan-agent` units and processes — never generic names such as `agent.service` or `*agent.py`. `pkill -f` patterns come from `_pkill_pattern_for()` (bracketed first character), so they cannot match and kill the invoking shell.
- **Manual install (`curl | sudo bash`):** `GET /api/agent/download/config/{id}` carries the agent token and requires admin auth or a single-use enrollment code (`POST /api/agent/enroll/{id}`, 30 min TTL, in-memory like sessions). `install-sh` requires a valid code and embeds it; the script redeems it when fetching the config. The agent script and `uninstall-sh` contain no secrets and stay public.

---

**Links:**
- Implementation: `backend/app/services/agent_deployer.py`
- API Consumer: `backend/app/api/agent.py`
- Security Tests: `backend/tests/test_security.py`
- Health Baseline: `repowise` snapshot 24 (2026-08-17)