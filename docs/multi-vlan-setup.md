# Multi-VLAN & Cross-Subnet Scanning Guide

Dieses Dokument beschreibt die Ursachen für fehlende MAC-Adressen beim Scannen entfernter Subnetze (VLANs) und stellt die drei Lösungsarchitekturen für GravityLAN vor.

---

## 1. Das Problem: Warum fehlen MAC-Adressen über Firewall-Grenzen?

- **Layer 2 (Data Link Layer):** ARP (Address Resolution Protocol) und MAC-Adressen existieren ausschließlich innerhalb einer lokalen Broadcast-Domäne (Subnetz).
- **Layer 3 (Network Layer):** Sobald Datenverkehr über einen Router oder eine Firewall geroutet wird, ersetzt der Router die Quell- und Ziel-MAC im Ethernet-Frame durch seine eigene Schnittstellen-MAC.
- **Konsequenz für Scanner:**
  - Wird ein Subnetz geroutet gescannt (z. B. aus dem LAN `192.168.1.0/24` in das IoT-Netz `192.168.20.0/24`), empfängt der Host keine echten ARP-Antworten der IoT-Geräte.
  - Entweder bleibt die MAC `None`, oder (bei Proxy-ARP) alle entfernten Geräte melden fälschlicherweise die MAC des Routers.

GravityLAN filtert geteilte Router-MACs bei gerouteten Subnetzen automatisch heraus, um Fehlzuordnungen zu verhindern. Um dennoch echte Hardware-MACs zu erfassen, gibt es drei Lösungswege.

---

## 2. Option A: Multi-VLAN Macvlan (Direkter Layer-2-Zugriff)

Der GravityLAN-Container wird über Docker Macvlan an mehrere VLANs gleichzeitig angebunden. Der Container erhält in jedem VLAN eine eigene virtuelle IP und kann native ARP-Broadcasts senden.

### Linux / Debian / Ubuntu Host-Vorbereitung (802.1Q)
Erstelle die VLAN-Subinterfaces auf dem Docker-Host:
```bash
# 802.1q Modul laden
sudo modprobe 8021q

# VLAN 20 (IoT) an physikalischem Interface eth0 erstellen
sudo ip link add link eth0 name eth0.20 type vlan id 20
sudo ip link set dev eth0.20 up
```

### Unraid Host-Vorbereitung
1. Unter **Settings → Network Settings**: *Enable VLANs: Yes*.
2. Die VLAN-Bridges heißen standardmäßig `br0.10`, `br0.20` usw.

### Docker Compose Einsatz
Nutze die bereitgestellte Vorlage [`docker-compose.multi-vlan.yml`](file:///docker-compose.multi-vlan.yml):
```bash
docker compose -f docker-compose.multi-vlan.yml up -d
```
GravityLAN erkennt alle angebundenen Interfaces automatisch. Im Setup-Assistenten wählst du sie als Scan-Subnetze aus; kommt ein VLAN später dazu, bietet **Einstellungen → Scan-Subnetze** es unter „Auf diesem Host erkannt, aber nicht gescannt“ mit einem Klick an. Jedes Scan-Subnetz wird gescannt und bekommt einen eigenen Tab im Netzwerk-Planer.

Geroutete Netze ohne eigenes Interface (Option B und C) trägst du ebenfalls unter **Einstellungen → Scan-Subnetze** oder im Netzwerk-Planer über „Subnetz hinzufügen“ ein. Beides schreibt in dieselbe Liste.

---

## 3. Option B: GravityLAN Agent als Remote Subnet Probe

Wenn keine direkte VLAN-Trunk-Anbindung an den Docker-Host möglich oder gewünscht ist (z. B. strikte physikalische Trennung oder entfernte Standorte):

1. Ein Raspberry Pi oder ein kleiner LXC-Container wird im Ziel-VLAN platziert.
2. Der GravityLAN-Agent wird auf dem Zielgerät installiert:
   - Der Agent scannt lokal mit Layer-2-Rechten (ARP / nmap).
   - Die Ergebnisse werden über verschlüsselte WebSockets/mTLS an den GravityLAN-Master übermittelt.
3. Der Master übernimmt die gemeldeten Geräte inklusive echter MAC-Adresse, Vendor und Status.

---

## 4. Option C: Router / Firewall ARP-Table Integration

Große Homelabs und Firmennetze verwalten alle VLANs zentral auf einer Firewall (z. B. OPNsense, pfSense, UniFi Dream Machine oder Mikrotik).

- **Vorteil:** Da die Firewall das Default-Gateway aller VLANs ist, befindet sich jede aktive IP-zu-MAC-Zuordnung bereits in der ARP- bzw. DHCP-Lease-Tabelle der Firewall.
- **Ausblick (v0.4.0):** Ein geplanter SNMP- / API-Konnektor ermöglicht das automatische periodische Auslesen der globalen Router-ARP-Tabelle.
