# Plan: Multi-VLAN Scanning & Setup Robustness (v0.3.5+)

## Kontext & Problemstellung
Aus dem Feedback/Testing (Screenshot) gehen zwei zentrale Punkte hervor:
1. **Initial-Setup / First-Run Stolpersteine:**
   - Password-Speicherung / Auto-Login im Setup-Wizard wirkt instabil oder gibt bei Fehlern unzureichendes Feedback.
   - Host-Auto-Adoption filtert Geräte weg, die nicht im lokalen Interface-Subnetz liegen oder keine Standard-Ports offen haben.
2. **Multi-VLAN-Architektur & MAC-Adressen-Problem (L2 vs. L3):**
   - Beim Scannen entfernter Subnetze/VLANs über Routing/Firewall gehen Layer-2-Informationen (MAC-Adresse, Vendor-OUI, DHCP-Bindung) systembedingt verloren.
   - Frage aus der Praxis: *"Wie am schlausten andere VLANs scannen? Zweite NIC? Agent?"*

---

## Architektur-Optionen für Multi-VLAN / Cross-Subnet MAC-Erkennung

| Ansatz | Wie es funktioniert | Vorteile | Nachteile / Aufwand |
|---|---|---|---|
| **Option A: Remote Scanner Probe / Agent** *(Empfohlen für verteilte Netze)* | Ein leichtgewichtiger GravityLAN-Worker (oder Erweiterung des bestehenden Linux-Agenten) läuft in den Ziel-VLANs und meldet lokale L2-ARP/Nmap-Ergebnisse per mTLS/WebSocket. | Vollwertige L2-Daten (MAC, Vendor, MDNS), keine Firewall-Löcher oder Trunking nötig. | Erfordert mindestens ein Gerät/LXC pro VLAN. |
| **Option B: Multi-Interface / Docker Macvlan / 802.1Q Trunk** *(Empfohlen für Homelab-Server/Unraid)* | Der GravityLAN-Container wird an mehrere Docker-Netzwerke (`macvlan` auf z. B. `eth0.10`, `eth0.20`) angebunden. | Nativ, extrem schnell, direkte ARP-Scans vom Container aus ohne zusätzliche Software. | Host muss 802.1Q VLAN Trunking unterstützen; Docker Compose Konfiguration komplexer. |
| **Option C: Router / Firewall ARP-Table Integration (API/SNMP)** | GravityLAN liest zyklisch die ARP-/DHCP-Tabellen vom Router/Firewall (pfSense, OPNsense, UniFi, Mikrotik) aus. | Deckt ALLE Subnetze zentral ab, keine Agents oder VLAN-NICs am Container nötig. | Router-spezifische Connectors (SNMP v2/v3 oder REST-APIs). |

---

## Phase 1: Analyse & Absicherung Setup-Wizard (Kurzfristig / P0)
- [ ] **Fehlerbehandlung `SetupWizard`:** Fehler bei `completeSetup` und `login` explizit im UI anzeigen (nicht nur in der Browser-Konsole).
- [ ] **Locking & Race-Conditions:** Sicherstellen, dass das gehashte Passwort atomar gespeichert und sofort verifiziert wird, bevor ein Redirect erfolgt.
- [ ] **Subnet-Adoption im Setup:** Wenn der Nutzer im Setup ein geroutetes Subnetz scannt, darf `_adoptable_in_physical_network` diese Hosts nicht stillschweigend verwerfen.

## Phase 2: Multi-Subnet & MAC-Fallback Verbesserungen (Mittelfristig / P1)
- [ ] **Warnung im Dashboard bei gerouteten Subnetzen:** Im Subnet-Viewer kennzeichnen, wenn ein Subnetz geroutet (L3) gescannt wird ("Keine MAC-Erkennung über Router-Grenzen hinweg").
- [ ] **Gateway-MAC-Deduplizierung:** Verhindern, dass allen Hosts im gerouteten Subnetz fälschlicherweise die Router-MAC zugeordnet wird.
- [ ] **Docker-Compose Template für VLAN-Trunking:** Bereitstellung einer erprobten `docker-compose.macvlan-multi.yml` Dokumentation für Unraid/Linux.

## Phase 3: Router-Integration & Remote Scanner (Langfristig / P2)
- [ ] **SNMP / Router ARP Importer:** Service zur Abfrage der globalen ARP-Tabelle von OPNsense / pfSense / UniFi.
- [ ] **Agent Scanning Capability:** Option im Linux-Agenten, optional als passiver / aktiver L2-Sensor für sein eigenes Subnetz zu fungieren.

## Verifikationskriterien
- [ ] Setup-Wizard lässt sich mit neuem Passwort fehlerfrei abschließen und loggt den User verlässlich ein.
- [ ] Geroutete IP-Scans erzeugen saubere Geräteinträge ohne Gateway-MAC-Konflikte.
- [ ] Automatisierte Backend-Tests für Subnet-Adoption und Multi-Subnet-Scans erfolgreich.
