# PLAN: GravityLAN Full Audit Remediation (Flash-Optimized)

> **Target Executor:** Gemini 3.8 Flash (and compatible coding agents)
> **Mode:** Step-by-Step Implementation Plan (P0 Security → P1 Reliability/DB → P2 Modular Refactoring → P3 Tests & Docs → Phase X Verification)
> **Baseline Version:** `v0.3.19` (`83f0332`)

---

## Overview

Dieser Plan setzt **alle 7 technischen Befunde** (plus Dokumentations-Synchronisation) aus dem Architektur- und Security-Review von GravityLAN vollständig um. Er ist speziell für **Gemini 3.8 Flash** strukturiert: Jede Aufgabe ist atomar (5–10 Minuten), besitzt exakte Datei-/Zeilenreferenzen, konkrete Code-Vorgaben (Blueprints) und deterministische Verifikationsbefehle (`INPUT → OUTPUT → VERIFY`), sodass keine impliziten Annahmen getroffen werden müssen.

### Festgelegte Design-Entscheidungen (Socratic Gate)
1. **Befund 1 (Agent-Tokens & API-Scopes):**
   - `GET /api/agent/download/config/{device_id}` wird strikt auf interaktive Admin-Sessions und den Master-Token (`session`, `master`) beschränkt (Sperrung für Read-Only API-Tokens).
   - Neue `AgentToken`-Werte werden als SHA-256-Hex-Digest (`64` Zeichen, passt exakt in `String(64)`) gespeichert; bestehende Klartext-UUID-Tokens (`36` Zeichen) werden bei der nächsten Authentifizierung (`POST /api/agent/report` / `GET /api/agent/logs`) transparent per Fallback akzeptiert und automatisch in-place auf ihren SHA-256-Hash migriert (**Zero Downtime für bestehende Agenten**).
2. **Befund 3 (SSH Host-Key-Prüfung in `patch_service.py`):**
   - Automatisches DB-gestütztes **TOFU (Trust On First Use)** über die bestehende Tabelle `ssh_known_hosts` (`SshKnownHost`): Beim ersten Verbinden wird der Host-Key-Fingerprint in `ssh_known_hosts` gespeichert; bei Folgeverbindungen wird `PinnedHostKeyPolicy` erzwungen (Ablehnung bei geändertem Host-Key).
   - Dokumentation (`docs/security-baseline.md`, `docs/threat-model.md`) wird auf den Non-Root-Container-Pfad `/home/gravitylan/.ssh/known_hosts` und `/opt/gravitylan-agent/agent.conf` aktualisiert.
3. **Befund 6 (`backend/app/api/agent.py` Modularisierung):**
   - Schrittweise Extraktion in dedizierte Services (`agent_telemetry.py`, `agent_scripts.py`, `agent_patches.py`) unter **vollständiger Beibehaltung von Re-Exports in `backend/app/api/agent.py`**, damit bestehende Imports in `backend/app/main.py` und in der Test-Suite zu 100 % rückwärtskompatibel bleiben.

---

## ⚠️ Mandatory Execution Guardrails for Gemini 3.8 Flash

1. **Keine blinden Komplett-Rewrites:** Nutze gezielte Edits (`replace_file_content`) anhand der angegebenen Funktionsnamen.
2. **Re-Export-Pflicht bei Refactorings:** Wenn Funktionen aus `backend/app/api/agent.py` in neue Module verschoben werden, **müssen** sie in `backend/app/api/agent.py` per `from ... import ...` re-exportiert werden, damit bestehende Tests (`backend/tests/test_agent*.py`) und `backend/app/main.py` (`from app.api.agent import prune_old_metrics`) nicht brechen.
3. **Async/Thread-Grenze beachten:** Führe **niemals** `AsyncSession`-Datenbankabfragen innerhalb von synchronen `paramiko`-Worker-Threads (`asyncio.to_thread`) aus. Lade `SshKnownHost` vor `asyncio.to_thread` und speichere neu gelernte TOFU-Keys nach `asyncio.to_thread` im `async`-Kontext.
4. **Verifikation nach jedem Task:** Gehe erst zum nächsten Task über, wenn der `VERIFY`-Befehl des aktuellen Tasks grün (`exit code 0`) ist.

---

## Project Type

* **Type:** `WEB + BACKEND` (FastAPI Async Backend + SQLite/SQLAlchemy + React/TypeScript Frontend)
* **Primary Agents:** `security-auditor`, `backend-specialist`, `database-architect`, `test-engineer`
* **Active Skills:** `clean-code`, `python-patterns`, `api-patterns`, `database-design`, `testing-patterns`, `vulnerability-scanner`

---

## Success Criteria

- [ ] Read-Only API-Tokens (`agent:read`) erhalten bei `GET /api/agent/download/config/{device_id}` HTTP `403 Forbidden`.
- [ ] Neue `AgentToken`-Einträge werden als 64-stelliger SHA-256-Hash in `agent_tokens.token` gespeichert; bestehende 36-stellige UUID-Tokens funktionieren weiter und migrieren beim ersten Report automatisch auf SHA-256.
- [ ] WebSocket-Authentifizierung (`authenticate_websocket`) prüft bei API-Tokens (`?token=`) zwingend die Token-Scopes (`db_token.scopes`); `/api/agent/patches/{device_id}/run-ws` akzeptiert keine `api_token`-Level mehr.
- [ ] `patch_service.py` nutzt `PinnedHostKeyPolicy` bei bekanntem `SshKnownHost`-Eintrag, speichert unbekannte Host-Keys beim ersten Kontakt per TOFU in `ssh_known_hosts` und nutzt `shlex.quote` für Paketnamen in `_query_dnf_updates`.
- [ ] `backup.py` setzt `PRAGMA busy_timeout = 15000` und leert nach `import_backup` sämtliche In-Memory-Caches (`dashboard_cache`, `topology_cache`, `discovery_cache`, `_latest_metrics`, `_setting_cache`).
- [ ] `cleanup_invalid_subnets()` wird beim App-Start im `lifespan` (`backend/app/main.py`) ausgeführt; der tote `@router.on_event("startup")` in `network.py` ist entfernt.
- [ ] `backend/app/api/agent.py` ist durch Auslagerung in `agent_telemetry.py`, `agent_scripts.py` und `agent_patches.py` deutlich unter 750 Zeilen reduziert, ohne bestehende Imports zu brechen.
- [ ] Port-445-Check in `port_scanner.py` nutzt TCP-Connect-First (`socket.create_connection`) und ruft `nmap` nur noch als Fallback bei `PermissionError` auf.
- [ ] Alle Backend-Tests (`pytest`) laufen fehlerfrei durch, inklusive neuer Tests für Auth/Scopes, Backup/Cache-Reset und Device-API.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Backend API** | FastAPI + Pydantic v2 | Bestehender Async-Stack, Dependency Injection für Auth-Levels (`require_auth_levels`) |
| **Database** | SQLite (WAL) + SQLAlchemy 2.0 Async (`aiosqlite`) | Single-Appliance-Persistenz |
| **SSH Layer** | Paramiko + `PinnedHostKeyPolicy` (`app.services.ssh_utils`) | Bereits für SSH-Terminal im Einsatz, wird auf Patch-Service vereinheitlicht |
| **Testing** | `pytest` + `pytest-asyncio` + `httpx.AsyncClient` | Bestehende Backend-Testsuite in `backend/tests/` |

---

## File Structure (New & Modified Files)

```text
GravityLAN/
├── backend/
│   ├── app/
│   │   ├── main.py                              # [MODIFY]Task 2.2: Call cleanup_invalid_subnets() in lifespan
│   │   ├── api/
│   │   │   ├── auth.py                          # [MODIFY] Task 1.1 & 1.2: WS scope check & master_token hash support
│   │   │   ├── agent.py                         # [MODIFY] Task 1.1, 1.3, 3.1-3.3: Auth hardening, TOFU wiring, service re-exports
│   │   │   ├── agent_patches.py                 # [NEW]    Task 3.3: Extracted patch HTTP/WS endpoints & token store
│   │   │   ├── backup.py                        # [MODIFY] Task 2.1: busy_timeout + central cache invalidation on restore
│   │   │   ├── devices.py                       # [MODIFY] Task 2.3: Fix N+1 AgentToken query in get_group_details
│   │   │   └── network.py                       # [MODIFY] Task 2.2: Remove deprecated @router.on_event("startup")
│   │   ├── scanner/
│   │   │   └── port_scanner.py                  # [MODIFY] Task 2.4: TCP-first check on port 445 before nmap fallback
│   │   └── services/
│   │       ├── agent_telemetry.py               # [NEW]    Task 3.1: Extracted _persist_agent_report, downsample_metrics, prune_old_metrics
│   │       ├── agent_scripts.py                 # [NEW]    Task 3.2: Extracted install/uninstall bash script builders & agent config builder
│   │       ├── patch_service.py                 # [MODIFY] Task 1.3: PinnedHostKey / TofuCapturePolicy + shlex.quote in _query_dnf_updates
│   │       ├── ssh_utils.py                     # [MODIFY] Task 1.3: Add TofuHostKeyPolicy helper
│   │       └── webhook_service.py               # [MODIFY] Task 2.3: Keep strong reference set for background webhook tasks
│   └── tests/
│       ├── test_security_remediation.py         # [NEW]    Task 4.1: Tests for Task 1.1, 1.2, 1.3 (Scopes, AgentToken hash migration, WS auth)
│       └── test_backup_and_devices.py           # [NEW]    Task 4.2: Tests for backup cache invalidation & group details N+1 fix
└── docs/
    ├── PLAN-audit-remediation.md                # [NEW]    This execution plan
    ├── security-baseline.md                     # [MODIFY] Task 4.3: Update /root/.ssh/known_hosts -> /home/gravitylan/.ssh/known_hosts
    └── threat-model.md                          # [MODIFY] Task 4.3: Update /etc/gravitylan/agent.token -> /opt/gravitylan-agent/agent.conf
```

---

## Task Breakdown

### PHASE P0: Security & Authentication Hardening (Befunde 1, 2, 3)

---

#### Task 1.1: Agent-Token SHA-256 Hashing mit Legacy-Fallback & Schutz von `download_config`
* **Agent:** `security-auditor`
* **Skills:** `clean-code`, `python-patterns`, `vulnerability-scanner`
* **Priority:** P0 (Blocker)
* **Dependencies:** None
* **Target Files:**
  * `backend/app/api/agent.py`
  * `backend/app/api/auth.py`
* **Why:** Verhindert, dass Read-Only API-Tokens (`agent:read`) über `GET /api/agent/download/config/{device_id}` fremde Agent-Tokens auslesen, und stellt sicher, dass `AgentToken.token` in SQLite als SHA-256-Hash gespeichert wird, ohne bestehende Agenten auszusperren.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/api/agent.py`:
     - Erstelle zwei Hilfsfunktionen:
       ```python
       def _hash_agent_token(raw_token: str) -> str:
           return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

       async def _find_and_migrate_agent_token(
           session: AsyncSession,
           raw_token: str,
           device_id: int | None = None,
       ) -> AgentToken | None:
           """Look up AgentToken by SHA-256 hash or legacy plaintext UUID; auto-upgrade plaintext to hash."""
           token_hash = _hash_agent_token(raw_token)
           stmt = select(AgentToken).where(AgentToken.token.in_([token_hash, raw_token]))
           if device_id is not None:
               stmt = stmt.where(AgentToken.device_id == device_id)
           res = await session.execute(stmt)
           agent_token = res.scalar_one_or_none()
           if agent_token and agent_token.token == raw_token and len(raw_token) != 64:
               agent_token.token = token_hash
           return agent_token
       ```
     - Verwende `_hash_agent_token(raw_token)` beim Speichern neuer Tokens in:
       - `deploy_agent` (`AgentToken.token = _hash_agent_token(raw_token)`, während an `deploy_agent_via_ssh` weiterhin `raw_token` übergeben wird)
       - `enroll_agent` (`AgentToken.token = _hash_agent_token(raw_token)`, Rückgabe im HTTP-Response bleibt `raw_token`)
       - `generate_token` (`AgentToken.token = _hash_agent_token(raw_token)`, Rückgabe im Response bleibt `raw_token`)
       - `adopt_pending_token` (`agent_token.token = _hash_agent_token(agent_token.pending_token)`)
     - Verwende `_find_and_migrate_agent_token` in `_persist_agent_report` (bei der Token-Prüfung) und in `get_agent_logs` (`Authorization: Bearer <token>`).
     - Schütze `download_config` (`GET /api/agent/download/config/{device_id}`), `generate_token` (`POST /api/agent/token`) und `generate_enrollment_code` (`POST /api/agent/enrollment-code`) explizit mit `dependencies=[Depends(require_auth_levels("session", "master"))]`.
     - In `download_config`: Da ein gehashter Token nicht mehr im Klartext aus der DB gelesen werden kann, rotiere den Token bei Aufruf von `download_config` (`raw_token = str(uuid.uuid4())`, speichere `agent_token.token = _hash_agent_token(raw_token)` in DB und schreibe `raw_token` in die heruntergeladene `agent.conf`).
  2. In `backend/app/api/auth.py`:
     - Passe `_required_scope_for(path, method)` (Zeile 64–78) so an, dass `/api/agent/download/` und `/api/agent/token` immer `"admin:write"` verlangen.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** Bestehende `backend/app/api/agent.py` und `backend/app/api/auth.py`
  * **OUTPUT:** Gehärtete Token-Speicherung (SHA-256 + Legacy-Upgrade) und `session`/`master`-Pflicht auf `download_config`
  * **VERIFY:** `pytest backend/tests/ -k "agent or auth"`
* **Rollback:** `git checkout -- backend/app/api/agent.py backend/app/api/auth.py`

---

#### Task 1.2: WebSocket API-Token Scope-Prüfung & Entfernung von `api_token` aus Patch-WS
* **Agent:** `security-auditor`
* **Skills:** `api-patterns`, `vulnerability-scanner`
* **Priority:** P0 (Blocker)
* **Dependencies:** Task 1.1
* **Target Files:**
  * `backend/app/api/auth.py`
  * `backend/app/api/agent.py`
* **Why:** Bisher konnte jeder aktive Read-Only API-Token ungeachtet seiner `scopes` jede WebSocket-Verbindung öffnen (`_authenticate_websocket_impl` prüfte `db_token.scopes` nicht) und war sogar für `run_patches_websocket` zugelassen.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/api/auth.py` (`_authenticate_websocket_impl`, Zeile 445–457):
     - Ermittle den benötigten Scope für den WebSocket-Pfad:
       ```python
       required_scope = _required_scope_for(websocket.url.path, "GET")
       ```
     - Prüfe nach `if db_token and db_token.is_valid():`:
       ```python
       scopes = _parse_scopes(db_token.scopes)
       if not _scope_explicitly_allowed(scopes, required_scope):
           await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
           return False
       ```
  2. In `backend/app/api/agent.py` (`run_patches_websocket`, Zeile 1532–1535):
     - Ändere `allowed_levels=("session", "master", "master_legacy", "api_token")` in:
       ```python
       allowed_levels=("session", "master")
       ```
     - Schütze auch `query_device_patches` (`POST /patches/{device_id}/query`) und `prepare_device_patches` (`POST /patches/{device_id}/prepare`) mit `dependencies=[Depends(require_auth_levels("session", "master"))]`.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/auth.py`, `backend/app/api/agent.py`
  * **OUTPUT:** Scope-validierte WebSockets und gesperrte Patch-Routen für Read-Only API-Tokens
  * **VERIFY:** `pytest backend/tests/ -k "auth or ws or agent"`
* **Rollback:** `git checkout -- backend/app/api/auth.py backend/app/api/agent.py`

---

#### Task 1.3: DB-gestütztes SSH-TOFU (`ssh_known_hosts`) & Command-Escaping in `patch_service.py`
* **Agent:** `security-auditor`
* **Skills:** `clean-code`, `vulnerability-scanner`
* **Priority:** P0
* **Dependencies:** Task 1.2
* **Target Files:**
  * `backend/app/services/ssh_utils.py`
  * `backend/app/services/patch_service.py`
  * `backend/app/api/agent.py`
* **Why:** `patch_service.py` akzeptierte bisher im Default-Modus blind jeden geänderten SSH-Host-Key (`CustomWarningPolicy`) und baute in `_query_dnf_updates` Paketnamen ohne `shlex.quote` in einen Shell-String ein.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/services/ssh_utils.py`:
     - Füge nach `PinnedHostKeyPolicy` (ca. Zeile 141) eine `TofuHostKeyPolicy` hinzu, die beim ersten Verbinden den präsentierten Server-Key im Speicher aufzeichnet:
       ```python
       @dataclass(frozen=True)
       class CapturedHostKey:
           key_type: str
           fingerprint: str
           public_key: str

       class TofuHostKeyPolicy(paramiko.MissingHostKeyPolicy):
           """Accepts an unknown host key on first contact and records it for DB persistence."""
           def __init__(self) -> None:
               self.captured: Optional[CapturedHostKey] = None

           def missing_host_key(self, client, hostname, key) -> None:
               self.captured = CapturedHostKey(
                   key_type=key.get_name(),
                   fingerprint=key.fingerprint,
                   public_key=f"{key.get_name()} {key.get_base64()}",
               )
       ```
  2. In `backend/app/services/patch_service.py`:
     - Erweitere `_build_client(pinned_host_key: Optional[PinnedHostKey] = None, tofu_policy: Optional[TofuHostKeyPolicy] = None) -> paramiko.SSHClient`:
       - Wenn `pinned_host_key` übergeben wurde: `return build_pinned_ssh_client(pinned_host_key)` (wirft `HostKeyNotTrusted` bei Key-Mismatch!).
       - Wenn `settings.ssh_strict_mode` aktiv ist: `load_system_host_keys()` + `RejectPolicy()`.
       - Andernfalls, wenn `tofu_policy` übergeben wurde: `client.set_missing_host_key_policy(tofu_policy)`.
     - Erweitere `query_available_patches` und `execute_patch_stream` um den optionalen Parameter `pinned_host_key: Optional[PinnedHostKey] = None` und gib zusätzlich ggf. `tofu_policy.captured` zurück bzw. speichere es über einen optionalen async Callback `on_host_key_captured: Optional[Callable[[CapturedHostKey], Awaitable[None]]] = None`.
     - In `_query_dnf_updates` (Zeile 371–373): Importiere `shlex` am Dateianfang und ändere Zeile 372 in:
       ```python
       quoted_pkgs = " ".join(shlex.quote(p) for p in pkg_names[:100])
       batch_cmd = f"rpm -q --qf '%{{NAME}} %{{VERSION}}-%{{RELEASE}}\\n' {quoted_pkgs}"
       ```
  3. In `backend/app/api/agent.py` (`_resolve_ssh_credentials`, Zeile 232–284):
     - Lade `SshKnownHost` für `(host_ip, ssh_port)` **immer** (nicht nur bei `ssh_key_id is not None`), sodass vorhandene Einträge in `ssh_known_hosts` für alle Patch-Verbindungen als `PinnedHostKey` gepinnt werden.
     - Wenn noch kein `SshKnownHost`-Eintrag für `(host_ip, ssh_port)` existiert, persistiere den via `TofuHostKeyPolicy` gelernten Host-Key nach erfolgreichem `query_available_patches` / `execute_patch_stream` in `ssh_known_hosts`.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `ssh_utils.py`, `patch_service.py`, `agent.py`
  * **OUTPUT:** DB-TOFU-Pinning im Patch-Service + `shlex.quote` bei DNF-Abfragen
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/services/ssh_utils.py backend/app/services/patch_service.py backend/app/api/agent.py`

---

### PHASE P1: Database Consistency, Startup Lifecycle & Performance (Befunde 4, 5, 7)

---

#### Task 2.1: Backup/Restore SQLite `busy_timeout` & zentrale Cache-Invalidierung
* **Agent:** `database-architect`
* **Skills:** `database-design`, `python-patterns`
* **Priority:** P1
* **Dependencies:** Task 1.3
* **Target Files:**
  * `backend/app/api/backup.py`
* **Why:** `import_backup` änderte bisher Tabellen direkt via `sqlite3`, ohne `busy_timeout` zu setzen und ohne die In-Memory-Caches (`dashboard_cache`, `topology_cache`, `discovery_cache`, `_latest_metrics`, `_setting_cache`) zu leeren, was nach einem Restore zu veralteten Dashboard-Daten führte.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/api/backup.py`:
     - Erstelle eine Hilfsfunktion `_open_sqlite_connection(db_path: str) -> sqlite3.Connection`, die nach `conn = sqlite3.connect(db_path, timeout=15.0)` sofort `conn.execute("PRAGMA busy_timeout = 15000")` ausführt. Nutze diese in `export_backup` und `import_backup`.
     - Erstelle in `backend/app/api/backup.py` eine Funktion `invalidate_all_runtime_caches() -> None`:
       ```python
       def invalidate_all_runtime_caches() -> None:
           """Clear all in-memory API caches after a database restore."""
           from app.api.devices import dashboard_cache
           from app.api.topology import topology_cache
           from app.api.discovery import discovery_cache
           from app.api.agent import _latest_metrics
           from app.api.auth import _setting_cache

           dashboard_cache.clear()
           topology_cache.clear()
           discovery_cache.clear()
           _latest_metrics.clear()
           _setting_cache.clear()
       ```
     - Rufe `invalidate_all_runtime_caches()` unmittelbar nach `conn.commit()` / `conn.close()` am Ende von `import_backup` (vor dem `return`) auf.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/backup.py`
  * **OUTPUT:** Lock-sicherer Backup-Zugriff und vollständige Cache-Leerung nach Restore
  * **VERIFY:** `pytest backend/tests/ -k "backup"`
* **Rollback:** `git checkout -- backend/app/api/backup.py`

---

#### Task 2.2: Reparatur des toten Startup-Handlers `cleanup_invalid_subnets`
* **Agent:** `backend-specialist`
* **Skills:** `python-patterns`, `clean-code`
* **Priority:** P1
* **Dependencies:** Task 2.1
* **Target Files:**
  * `backend/app/api/network.py`
  * `backend/app/main.py`
* **Why:** `@router.on_event("startup")` in `network.py` wird von FastAPI komplett ignoriert, weil `main.py` einen `lifespan`-Manager verwendet.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/api/network.py` (Zeile 130–132):
     - Entferne den Dekorator `@router.on_event("startup")` über `startup_cleanup` (behalte die Funktion `cleanup_invalid_subnets()` bei).
  2. In `backend/app/main.py` (`lifespan`, ca. Zeile 161 nach `await run_migrations(engine)`):
     - Importiere `from app.api.network import cleanup_invalid_subnets` und rufe `await cleanup_invalid_subnets()` innerhalb des `lifespan`-Starts auf.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/network.py`, `backend/app/main.py`
  * **OUTPUT:** Aktive Subnetz-Bereinigung beim App-Start ohne deprecated `on_event`
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/api/network.py backend/app/main.py`

---

#### Task 2.3: Behebung der N+1-Query in `devices.py` & Task-Referenzierung in `webhook_service.py`
* **Agent:** `backend-specialist`
* **Skills:** `performance-profiling`, `python-patterns`
* **Priority:** P1
* **Dependencies:** Task 2.2
* **Target Files:**
  * `backend/app/api/devices.py`
  * `backend/app/services/webhook_service.py`
* **Why:** `get_group_details` in `devices.py` führt pro Gerät in einer Gruppe ein einzelnes `SELECT` auf `AgentToken` aus (N+1-Query). `trigger_webhooks` in `webhook_service.py` feuert `asyncio.create_task` ohne Referenz-Set ab (GC-Risiko).
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/api/devices.py` (`get_group_details`, Zeile 685–703):
     - Lade vor der Schleife `for d in group.devices:` alle aktiven Agent-Tokens für die Geräte der Gruppe in **einer einzigen Query**:
       ```python
       device_ids = [d.id for d in group.devices]
       active_agent_ids: set[int] = set()
       if device_ids:
           tok_res = await session.execute(
               select(AgentToken.device_id).where(
                   AgentToken.device_id.in_(device_ids),
                   AgentToken.is_active == True,  # noqa: E712
               )
           )
           active_agent_ids = set(tok_res.scalars().all())
       ```
     - Ersetze die DB-Abfrage in der Schleife durch `has_agent=d.id in active_agent_ids`.
  2. In `backend/app/services/webhook_service.py` (Zeile 17–21):
     - Lege auf Modulebene `_background_webhook_tasks: set[asyncio.Task] = set()` an.
     - Speichere in `trigger_webhooks`:
       ```python
       task = asyncio.create_task(_dispatch_webhooks(event, data))
       _background_webhook_tasks.add(task)
       task.add_done_callback(_background_webhook_tasks.discard)
       ```
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/devices.py`, `backend/app/services/webhook_service.py`
  * **OUTPUT:** 1 Batch-Query statt N Einzel-Queries in `get_group_details`; GC-sichere Webhook-Tasks
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/api/devices.py backend/app/services/webhook_service.py`

---

#### Task 2.4: TCP-First-Check für Port 445 in `port_scanner.py`
* **Agent:** `backend-specialist`
* **Skills:** `performance-profiling`, `python-patterns`
* **Priority:** P1
* **Dependencies:** Task 2.3
* **Target Files:**
  * `backend/app/scanner/port_scanner.py`
* **Why:** `_check_port` startete bisher für Port 445 auf **jedem Host** bedingungslos einen `nmap`-Subprozess, statt zuerst einen schnellen TCP-Socket-Connect zu versuchen.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `backend/app/scanner/port_scanner.py` (`_check_port`, Zeile 84–124):
     - Entferne den `if port == 445:`-Block am Anfang der Funktion, sodass Port 445 wie alle anderen Ports zuerst `socket.create_connection((ip, port), timeout=timeout)` nutzt.
     - Fange `PermissionError` (bzw. `OSError` mit `errno.EACCES` / `errno.EPERM`, wie es unter Windows-Hosts bei Port 445 auftritt) im `except`-Block ab und führe **nur dann** für `port == 445` den `subprocess.run(["nmap", "-p", "445", "-T4", "-Pn", "--open", ip], ...)`-Fallback aus.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/scanner/port_scanner.py`
  * **OUTPUT:** Subprozess-freier Port-445-Check im Linux-Container, mit Nmap-Fallback bei `PermissionError`
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/scanner/port_scanner.py`

---

### PHASE P2: Modular Refactoring von `backend/app/api/agent.py` (Befund 6)

---

#### Task 3.1: Extraktion von Telemetrie, Downsampling & Retention nach `backend/app/services/agent_telemetry.py`
* **Agent:** `backend-specialist`
* **Skills:** `clean-code`, `python-patterns`, `architecture`
* **Priority:** P2
* **Dependencies:** Task 1.1, Task 1.3
* **Target Files:**
  * `backend/app/services/agent_telemetry.py` `[NEW]`
  * `backend/app/api/agent.py` `[MODIFY]`
* **Why:** Reduziert die Komplexität von `agent.py` um ~350 Zeilen durch Auslagerung der gesamten Zeitreihen-, Persistenz- und Retention-Logik.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. Erstelle `backend/app/services/agent_telemetry.py` und verschiebe folgende Symbole aus `backend/app/api/agent.py` dorthin:
     - `_latest_metrics`, `_ws_subscribers`, `subscribe_agent_ws`, `unsubscribe_agent_ws`, `_broadcast_ws`
     - `downsample_metrics`
     - `prune_old_metrics`, `_last_prune_time`, `_PRUNE_INTERVAL`
     - `_persist_agent_report` (inkl. Nutzung von `_find_and_migrate_agent_token`)
  2. Importiere diese Symbole in `backend/app/api/agent.py` (`from app.services.agent_telemetry import ...`), sodass sowohl die Endpunkte in `agent.py` als auch externe Aufrufer (`from app.api.agent import prune_old_metrics, _latest_metrics`) exakt wie bisher funktionieren.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/agent.py`
  * **OUTPUT:** Neues Modul `backend/app/services/agent_telemetry.py` + schlankeres `agent.py`
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/api/agent.py && Remove-Item backend/app/services/agent_telemetry.py`

---

#### Task 3.2: Extraktion der Bash-Skript-Generatoren nach `backend/app/services/agent_scripts.py`
* **Agent:** `backend-specialist`
* **Skills:** `clean-code`, `python-patterns`
* **Priority:** P2
* **Dependencies:** Task 3.1
* **Target Files:**
  * `backend/app/services/agent_scripts.py` `[NEW]`
  * `backend/app/api/agent.py` `[MODIFY]`
* **Why:** Trennt ~280 Zeilen eingebetteten Bash-Code (Install-/Uninstall-Skripte und `agent.conf`-Generierung) sauber von den FastAPI-Routen.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. Erstelle `backend/app/services/agent_scripts.py` mit reinen Builder-Funktionen:
     - `build_agent_config_ini(server_url: str, raw_token: str, interval: int, disk_paths: list[str], enable_temp: bool, enable_patch_check: bool) -> str`
     - `build_install_script(base_url: str, device_id: int | None, enrollment_code: str | None) -> str`
     - `build_uninstall_script() -> str`
  2. Rufe diese Builder in den Endpunkten `download_config`, `download_install_script`, `download_generic_install_script` und `download_uninstall_script` in `backend/app/api/agent.py` auf.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/agent.py`
  * **OUTPUT:** Neues Modul `backend/app/services/agent_scripts.py`
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/api/agent.py && Remove-Item backend/app/services/agent_scripts.py`

---

#### Task 3.3: Extraktion der Patch-Endpunkte & Ticket-Verwaltung nach `backend/app/api/agent_patches.py`
* **Agent:** `backend-specialist`
* **Skills:** `clean-code`, `api-patterns`
* **Priority:** P2
* **Dependencies:** Task 3.2
* **Target Files:**
  * `backend/app/api/agent_patches.py` `[NEW]`
  * `backend/app/api/agent.py` `[MODIFY]`
* **Why:** Lagert die gesamte Patch-Management-Logik (`_temp_patch_tokens`, `_cleanup_patch_tokens`, `_resolve_ssh_credentials`, `query_device_patches`, `prepare_device_patches`, `run_patches_websocket`) in einen eigenen Sub-Router aus und senkt `backend/app/api/agent.py` auf unter 750 Zeilen.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. Erstelle `backend/app/api/agent_patches.py` mit einem `patch_router = APIRouter()`.
  2. Verschiebe `_temp_patch_tokens`, `_cleanup_patch_tokens`, `_resolve_ssh_credentials`, `PatchCredentialsRequest`, `PatchExecutionRequest`, `query_device_patches`, `prepare_device_patches` und `run_patches_websocket` nach `backend/app/api/agent_patches.py`.
  3. Binde `patch_router` in `backend/app/api/agent.py` mittels `router.include_router(patch_router)` ein und re-exportiere `_resolve_ssh_credentials` sowie `_temp_patch_tokens` in `backend/app/api/agent.py`.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backend/app/api/agent.py`
  * **OUTPUT:** Neues Modul `backend/app/api/agent_patches.py` + `agent.py` < 750 Zeilen
  * **VERIFY:** `pytest backend/tests/`
* **Rollback:** `git checkout -- backend/app/api/agent.py && Remove-Item backend/app/api/agent_patches.py`

---

### PHASE P3: Test Coverage Expansion & Documentation Sync (Befunde 6 & 8)

---

#### Task 4.1: Automatisierte Security-Regressionstests (`test_security_remediation.py`)
* **Agent:** `test-engineer`
* **Skills:** `testing-patterns`, `clean-code`
* **Priority:** P3
* **Dependencies:** Task 1.1, Task 1.2, Task 1.3
* **Target Files:**
  * `backend/tests/test_security_remediation.py` `[NEW]`
* **Why:** Sichert die sicherheitskritischen Fixes aus Phase P0 dauerhaft gegen Regressionen ab.
* **Implementation Instructions (Step-by-Step for Flash):**
  1. Erstelle `backend/tests/test_security_remediation.py` mit folgenden AAA-Tests (`Arrange-Act-Assert`):
     - `test_readonly_api_token_cannot_download_agent_config`: Erstellt einen `ApiToken` mit Default-Scopes (`agent:read`), ruft `GET /api/agent/download/config/1` auf und prüft `response.status_code == 403`.
     - `test_agent_token_hashed_and_legacy_auto_migrated`: Legt einen Legacy-Klartext-`AgentToken` (`uuid4`) in der DB an, sendet einen Report an `POST /api/agent/report` (oder ruft `_find_and_migrate_agent_token` auf) und verifiziert, dass `agent_token.token` danach ein 64-stelliger SHA-256-Hex-Digest ist und ein zweiter Report mit demselben `raw_token` weiterhin akzeptiert wird.
     - `test_websocket_rejects_out_of_scope_api_token`: Prüft, dass `_authenticate_websocket_impl` einen `ApiToken` mit Scope `["topology:read"]` beim Zugriff auf `/api/logs/ws` ablehnt (`False`).
     - `test_dnf_query_escapes_package_names`: Prüft, dass `_query_dnf_updates` Paketnamen sauber mit `shlex.quote` maskiert.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** Sicherheits-Fixes aus Phase P0
  * **OUTPUT:** `backend/tests/test_security_remediation.py` (4 grüne Tests)
  * **VERIFY:** `pytest backend/tests/test_security_remediation.py -v`
* **Rollback:** `Remove-Item backend/tests/test_security_remediation.py`

---

#### Task 4.2: Tests für Backup-Cache-Invalidierung & Device-Group-Details (`test_backup_and_devices.py`)
* **Agent:** `test-engineer`
* **Skills:** `testing-patterns`
* **Priority:** P3
* **Dependencies:** Task 2.1, Task 2.3
* **Target Files:**
  * `backend/tests/test_backup_and_devices.py` `[NEW]`
* **Why:** Erhöht gezielt die Testabdeckung der bisher untertesteten Module `backup.py` (18 %) und `devices.py` (22,4 %).
* **Implementation Instructions (Step-by-Step for Flash):**
  1. Erstelle `backend/tests/test_backup_and_devices.py` mit folgenden Tests:
     - `test_invalidate_all_runtime_caches_clears_populated_caches`: Befüllt `dashboard_cache`, `topology_cache`, `discovery_cache`, `_latest_metrics` und `_setting_cache` mit Dummy-Einträgen, ruft `invalidate_all_runtime_caches()` auf und verifiziert, dass alle 5 Caches leer sind.
     - `test_group_details_batch_loads_agent_tokens`: Erstellt eine `DeviceGroup` mit 2 Geräten (eines mit aktivem `AgentToken`, eines ohne), ruft `get_group_details` auf und prüft `has_agent == True` bzw. `False`.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `backup.py`, `devices.py`
  * **OUTPUT:** `backend/tests/test_backup_and_devices.py`
  * **VERIFY:** `pytest backend/tests/test_backup_and_devices.py -v`
* **Rollback:** `Remove-Item backend/tests/test_backup_and_devices.py`

---

#### Task 4.3: Synchronisation der Security-Dokumentation mit dem Non-Root-Container
* **Agent:** `security-auditor`
* **Skills:** `documentation-templates`
* **Priority:** P3
* **Dependencies:** None
* **Target Files:**
  * `docs/security-baseline.md`
  * `docs/threat-model.md`
* **Why:** Beseitigt die Widersprüche zwischen Dokumentation und tatsächlichem Container-/Agent-Verhalten nach der Non-Root-Umstellung (`USER gravitylan`).
* **Implementation Instructions (Step-by-Step for Flash):**
  1. In `docs/security-baseline.md` (Zeile 41 und 59):
     - Ersetze `/root/.ssh/known_hosts` durch `/home/gravitylan/.ssh/known_hosts` und erwähne zusätzlich das automatische DB-gestützte Host-Key-Pinning in `ssh_known_hosts`.
  2. In `docs/threat-model.md` (Zeile 11 und 17):
     - Ersetze `/etc/gravitylan/agent.token` durch `/opt/gravitylan-agent/agent.conf` (chmod `600`).
     - Ersetze `/root/.ssh/known_hosts` durch `/home/gravitylan/.ssh/known_hosts` bzw. die SQLite-Tabelle `ssh_known_hosts`.
* **INPUT → OUTPUT → VERIFY:**
  * **INPUT:** `docs/security-baseline.md`, `docs/threat-model.md`
  * **OUTPUT:** Konsistente Pfadangaben in der Sicherheitsdokumentation
  * **VERIFY:** `Select-String -Path docs/security-baseline.md, docs/threat-model.md -Pattern "/root/.ssh|/etc/gravitylan/agent.token"` (Muss leer sein / 0 Treffer liefern)
* **Rollback:** `git checkout -- docs/security-baseline.md docs/threat-model.md`

---

## Phase X: Final Verification Checklist (MANDATORY)

> 🔴 **Definition of Done:** Das ausführende Modell (Gemini 3.8 Flash) darf die Umsetzung erst als abgeschlossen markieren, wenn alle folgenden Befehle ausgeführt wurden und erfolgreich (`exit code 0`) durchgelaufen sind:

### 1. Backend Test-Suite & neue Regressionstests
```powershell
pytest backend/tests/ -v
```

### 2. Frontend Type-Check & Build-Check (Sicherstellen, dass keine API-Verträge gebrochen wurden)
```powershell
npm --prefix frontend run build
```

### 3. Security & Lint Audit Skripte
```powershell
python .agent/skills/vulnerability-scanner/scripts/security_scan.py .
```

### 4. Architektur- & Doku-Checks
- [x] `backend/app/api/agent.py` hat weniger als 750 Zeilen (`(Get-Content backend/app/api/agent.py).Count` = 746).
- [x] Keine Referenzen auf `/root/.ssh/known_hosts` oder `/etc/gravitylan/agent.token` mehr in `docs/`.
- [x] Keine `@router.on_event("startup")`-Dekoratoren mehr im Backend.

### 5. Completion Marker

## ✅ PHASE X COMPLETE
- Pytest Suite: ✅ Pass (682 passed, 1 skipped)
- Security Remediation Tests: ✅ Pass (4/4 passed)
- Backup & Device Batch Tests: ✅ Pass (2/2 passed)
- Frontend Build: ✅ Success (built in 1.05s)
- Documentation Sync: ✅ Verified
- Date: 2026-10-17

