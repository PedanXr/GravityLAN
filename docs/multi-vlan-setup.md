# Multi-VLAN and routed subnets

[English](#english) · [Deutsch](#deutsch)

## English

GravityLAN can scan subnets it only reaches through a router, such as your other VLANs: it finds the hosts there, their names and their open services. What a scan through a router cannot deliver is the MAC address, and with it the vendor. This guide explains why and shows the ways to get them.

### Why MAC addresses go missing behind a router

- MAC addresses are resolved with ARP, and ARP only works inside one broadcast domain, that is one subnet or VLAN.
- A router forwards packets between subnets and puts its own MAC address into every frame it sends on. When GravityLAN sits in `192.168.1.0/24` and scans `192.168.20.0/24`, no ARP reply from a host in `192.168.20.0/24` ever reaches it.
- So a routed host has no MAC address at all, or, if the router answers ARP on behalf of the other subnet (proxy ARP), every routed host seems to have the router's MAC address.

GravityLAN guards against the second case: when the ARP entry of a routed address carries a MAC address that also belongs to an address in one of its own subnets (usually the gateway), or one that shows up in several /24 networks, GravityLAN drops it for that routed address instead of storing the router's MAC address.

On the **IP addresses** page a badge on every subnet shows how GravityLAN reaches it: **L2 Direct (&lt;interface&gt;)** through one of its own interfaces, **L3 Routed** through a router, or **L2 Probe (&lt;device&gt;)** through an agent inside it.

| Option | How GravityLAN gets the MAC addresses | Status |
|---|---|---|
| [A: one container interface per VLAN](#option-a-one-container-interface-per-vlan-macvlan) | The container joins every VLAN through macvlan and resolves MAC addresses itself. | Available: [`docker-compose.multi-vlan.yml`](../docker-compose.multi-vlan.yml) |
| [B: agent as layer-2 probe](#option-b-agent-as-layer-2-probe) | A Linux host with the GravityLAN agent inside the VLAN reports its ARP table. | Available: agent 0.3.8 or newer |
| [C: the router's ARP table](#option-c-the-routers-arp-table-outlook) | GravityLAN reads the ARP table of the router that connects all VLANs. | Planned, not available yet |

### Option A: one container interface per VLAN (macvlan)

The container joins each VLAN through its own macvlan network and gets an address in each of them. Every VLAN is then directly attached, so GravityLAN resolves MAC addresses there itself. This needs a Docker host whose network port carries the VLANs tagged (802.1Q trunk on the switch port).

#### Prepare the host

Debian, Ubuntu and other Linux hosts: create one VLAN interface per VLAN on the physical interface, here VLAN 20 on `eth0`:

```bash
sudo modprobe 8021q
sudo ip link add link eth0 name eth0.20 type vlan id 20
sudo ip link set dev eth0.20 up
```

These commands do not survive a reboot. To keep the VLAN interfaces, add them to your distribution's network configuration (`/etc/network/interfaces`, netplan or systemd-networkd).

Unraid: under **Settings → Network Settings** set *Enable VLANs* to *Yes* and add the VLAN numbers. With bridging switched on (the default) the VLAN interfaces are called `br0.10`, `br0.20` and so on.

#### Start the container

The template [`docker-compose.multi-vlan.yml`](../docker-compose.multi-vlan.yml) has three VLANs: main, IoT and server. Put your values into a `.env` file next to it:

```bash
VLAN_MAIN_IFACE=eth0.10
VLAN_MAIN_SUBNET=192.168.10.0/24
VLAN_MAIN_GATEWAY=192.168.10.1
GRAVITYLAN_MAIN_IP=192.168.10.250

VLAN_IOT_IFACE=eth0.20
VLAN_IOT_SUBNET=192.168.20.0/24
VLAN_IOT_GATEWAY=192.168.20.1
GRAVITYLAN_IOT_IP=192.168.20.250

VLAN_SERVER_IFACE=eth0.30
VLAN_SERVER_SUBNET=192.168.30.0/24
VLAN_SERVER_GATEWAY=192.168.30.1
GRAVITYLAN_SERVER_IP=192.168.30.250
```

Each `GRAVITYLAN_*_IP` must be a free address outside your DHCP range. For fewer VLANs, delete the network both under `services.gravitylan.networks` and under the top-level `networks`; for more, copy a block in both places. Then start it:

```bash
docker compose -f docker-compose.multi-vlan.yml up -d
```

The web interface answers on port 8000 of each of these addresses, for example `http://192.168.10.250:8000`; macvlan needs no port mapping. The template keeps its data in `./data` like the other compose files, so an existing installation moves over with its database when you stop the old container and start this one from the same folder.

#### What GravityLAN does with it

- **Scanning:** GravityLAN reads the container's interfaces itself, and every VLAN becomes one of its local subnets. If **Settings → Network scan → Subnets to scan** is empty, scans cover all of them without further setup. If you have entered subnets there, only those are scanned, so add the new VLAN subnets.
- **IP addresses page:** the setup wizard of a new installation adds every detected subnet there. An existing installation does not get them automatically: add each VLAN subnet with **Add Subnet**. It then shows **L2 Direct (&lt;interface&gt;)**.

#### Pitfalls

- **The Docker host cannot reach the container.** Macvlan keeps the host and its macvlan containers apart: the web interface is reachable from every other device, but not from the Docker host itself, and an agent on the Docker host cannot report to GravityLAN through these addresses. That takes an extra macvlan interface on the host.
- **One macvlan network per parent interface.** Docker refuses a second macvlan network on an interface that already has one ("already using parent interface"). Unraid, for example, creates one for every VLAN enabled in its Docker settings. Use that existing network in the compose file (`external: true`) instead of creating a new one.
- **172.x addresses on `eth0`.** GravityLAN takes an interface named `eth0` with an address starting with `172.` for the Docker bridge and ignores it. If a VLAN in that range ends up on `eth0`, it is shown as **L3 Routed** and only scanned when it is listed under **Subnets to scan**.

### Option B: agent as layer-2 probe

When the GravityLAN host cannot join a VLAN (no tagged port, a separate building or site), a Linux host inside that VLAN that runs the GravityLAN agent can supply the MAC addresses instead: a Raspberry Pi, a VM or an LXC container with an address in that VLAN.

#### Requirements

- The host is a device in GravityLAN with the agent installed (device editor, **Agent** tab), agent 0.3.8 or newer. The active sweep described below came with agent 0.3.9.
- The host has an address in the VLAN you want to see. The agent only sees the subnets it is attached to, so you need one probe per VLAN.
- Nothing else has to be opened: the agent uses the same connection to GravityLAN as for its metrics.

#### Switch it on

In the device editor's **Agent** tab, under **Agent Configuration**, set **L2 Subnet Scanner (Probe)** to **Activated** and save. The agent picks the setting up with its next report.

#### What the agent does

- Once a minute it sweeps each of its own IPv4 subnets with at most 512 addresses (`/23` to `/30`): it sends one small UDP packet to every address, which makes its kernel resolve that address via ARP, plus one broadcast ping. Larger subnets are not swept; for those it reports only what is already in its ARP cache.
- With every report it reads its neighbour table (`/proc/net/arp` and `ip neigh`) and sends the IP and MAC pairs along with its metrics. There is no nmap, no port scan and no extra connection.

#### What GravityLAN does with it

- A device on the dashboard with one of these IP addresses gets the reported MAC address (a different stored one is replaced), its vendor if none is set yet, and is marked online.
- An unknown IP address becomes a discovered host with MAC address and vendor. It shows up on the **IP addresses** page, in the address map and under **Recent Findings**; its address tile can add it to the dashboard.
- On the **IP addresses** page a subnet that contains the probe's address and is not directly attached to GravityLAN shows **L2 Probe (&lt;device&gt;)**. The subnet has to be listed there.

### Option C: the router's ARP table (outlook)

**Not available yet.** In many homelabs one firewall or router (OPNsense, pfSense, UniFi, MikroTik and others) is the gateway of every VLAN, so its ARP table and DHCP leases already hold every active IP and MAC pair. A connector that reads them regularly over SNMP or the router's API is planned for 0.4.0. Until then, use option A or B.

## Deutsch

GravityLAN kann Subnetze scannen, die es nur über einen Router erreicht, etwa deine anderen VLANs: Es findet dort die Hosts, ihre Namen und ihre offenen Dienste. Was ein Scan über einen Router nicht liefern kann, ist die MAC-Adresse und damit der Hersteller. Diese Anleitung erklärt, warum, und zeigt die Wege, wie GravityLAN sie trotzdem bekommt.

### Warum MAC-Adressen hinter einem Router fehlen

- MAC-Adressen werden per ARP aufgelöst, und ARP funktioniert nur innerhalb einer Broadcast-Domäne, also eines Subnetzes oder VLANs.
- Ein Router leitet Pakete zwischen Subnetzen weiter und setzt in jeden weitergeleiteten Frame seine eigene MAC-Adresse. Steht GravityLAN in `192.168.1.0/24` und scannt `192.168.20.0/24`, erreicht es keine einzige ARP-Antwort eines Hosts aus `192.168.20.0/24`.
- Ein gerouteter Host hat deshalb gar keine MAC-Adresse, oder, wenn der Router stellvertretend für das andere Subnetz auf ARP antwortet (Proxy-ARP), scheinen alle gerouteten Hosts die MAC-Adresse des Routers zu haben.

Den zweiten Fall fängt GravityLAN ab: Trägt der ARP-Eintrag einer gerouteten Adresse eine MAC-Adresse, die auch zu einer Adresse in einem seiner eigenen Subnetze gehört (meist dem Gateway), oder eine, die in mehreren /24-Netzen auftaucht, verwirft GravityLAN sie für diese geroutete Adresse, statt die MAC-Adresse des Routers zu speichern.

Auf der Seite **IP-Adressen** zeigt ein Badge an jedem Subnetz, wie GravityLAN es erreicht: **L2 Direkt (&lt;Schnittstelle&gt;)** über eine eigene Schnittstelle, **L3 Geroutet** über einen Router oder **L2 Probe (&lt;Gerät&gt;)** über einen Agenten darin.

| Weg | Wie GravityLAN an die MAC-Adressen kommt | Stand |
|---|---|---|
| [A: eine Container-Schnittstelle pro VLAN](#weg-a-eine-container-schnittstelle-pro-vlan-macvlan) | Der Container hängt per Macvlan in jedem VLAN und löst MAC-Adressen selbst auf. | Verfügbar: [`docker-compose.multi-vlan.yml`](../docker-compose.multi-vlan.yml) |
| [B: Agent als Layer-2-Probe](#weg-b-agent-als-layer-2-probe) | Ein Linux-Host mit GravityLAN-Agent im VLAN meldet seine ARP-Tabelle. | Verfügbar: Agent 0.3.8 oder neuer |
| [C: ARP-Tabelle des Routers](#weg-c-arp-tabelle-des-routers-ausblick) | GravityLAN liest die ARP-Tabelle des Routers, der alle VLANs verbindet. | Geplant, noch nicht verfügbar |

### Weg A: eine Container-Schnittstelle pro VLAN (Macvlan)

Der Container hängt über je ein eigenes Macvlan-Netz in jedem VLAN und bekommt in jedem eine eigene Adresse. Jedes VLAN ist damit direkt angebunden, GravityLAN löst die MAC-Adressen dort selbst auf. Voraussetzung ist ein Docker-Host, an dessen Netzwerkanschluss die VLANs getaggt ankommen (802.1Q-Trunk am Switch-Port).

#### Host vorbereiten

Debian, Ubuntu und andere Linux-Hosts: pro VLAN eine VLAN-Schnittstelle auf der physischen Schnittstelle anlegen, hier VLAN 20 auf `eth0`:

```bash
sudo modprobe 8021q
sudo ip link add link eth0 name eth0.20 type vlan id 20
sudo ip link set dev eth0.20 up
```

Diese Befehle überstehen keinen Neustart. Damit die VLAN-Schnittstellen bleiben, gehören sie in die Netzwerkkonfiguration deiner Distribution (`/etc/network/interfaces`, netplan oder systemd-networkd).

Unraid: unter **Settings → Network Settings** *Enable VLANs* auf *Yes* stellen und die VLAN-Nummern eintragen. Mit eingeschaltetem Bridging (Standard) heißen die VLAN-Schnittstellen `br0.10`, `br0.20` usw.

#### Container starten

Die Vorlage [`docker-compose.multi-vlan.yml`](../docker-compose.multi-vlan.yml) hat drei VLANs: Main, IoT und Server. Deine Werte kommen in eine `.env`-Datei daneben:

```bash
VLAN_MAIN_IFACE=eth0.10
VLAN_MAIN_SUBNET=192.168.10.0/24
VLAN_MAIN_GATEWAY=192.168.10.1
GRAVITYLAN_MAIN_IP=192.168.10.250

VLAN_IOT_IFACE=eth0.20
VLAN_IOT_SUBNET=192.168.20.0/24
VLAN_IOT_GATEWAY=192.168.20.1
GRAVITYLAN_IOT_IP=192.168.20.250

VLAN_SERVER_IFACE=eth0.30
VLAN_SERVER_SUBNET=192.168.30.0/24
VLAN_SERVER_GATEWAY=192.168.30.1
GRAVITYLAN_SERVER_IP=192.168.30.250
```

Jede `GRAVITYLAN_*_IP` muss eine freie Adresse außerhalb deines DHCP-Bereichs sein. Für weniger VLANs das Netz sowohl unter `services.gravitylan.networks` als auch unter dem obersten `networks` löschen, für mehr an beiden Stellen einen Block kopieren. Dann starten:

```bash
docker compose -f docker-compose.multi-vlan.yml up -d
```

Die Weboberfläche antwortet auf Port 8000 jeder dieser Adressen, zum Beispiel `http://192.168.10.250:8000`; Macvlan braucht keine Portfreigabe. Die Vorlage legt ihre Daten wie die anderen Compose-Dateien in `./data` ab. Eine bestehende Installation zieht deshalb mit ihrer Datenbank um, wenn du den alten Container stoppst und diesen aus demselben Ordner startest.

#### Was GravityLAN daraus macht

- **Scannen:** GravityLAN liest die Schnittstellen des Containers selbst aus, jedes VLAN wird zu einem seiner lokalen Subnetze. Ist **Einstellungen → Netzwerk-Scan → Zu scannende Subnetze** leer, erfassen die Scans alle davon, ohne weitere Einstellung. Stehen dort Subnetze, wird nur diese Liste gescannt; dann die neuen VLAN-Subnetze dort ergänzen.
- **Seite IP-Adressen:** Der Einrichtungsassistent einer neuen Installation trägt dort jedes erkannte Subnetz ein. Eine bestehende Installation bekommt sie nicht automatisch: jedes VLAN-Subnetz mit **Subnetz hinzufügen** anlegen. Es zeigt dann **L2 Direkt (&lt;Schnittstelle&gt;)**.

#### Stolperfallen

- **Der Docker-Host erreicht den Container nicht.** Macvlan trennt den Host von seinen Macvlan-Containern: Die Weboberfläche ist von jedem anderen Gerät erreichbar, aber nicht vom Docker-Host selbst, und ein Agent auf dem Docker-Host kann über diese Adressen nicht an GravityLAN melden. Dafür braucht der Host eine zusätzliche eigene Macvlan-Schnittstelle.
- **Ein Macvlan-Netz pro Eltern-Schnittstelle.** Docker lehnt ein zweites Macvlan-Netz auf einer Schnittstelle ab, die schon eines hat („already using parent interface“). Unraid zum Beispiel legt für jedes in seinen Docker-Einstellungen aktivierte VLAN eines an. Dann dieses vorhandene Netz in der Compose-Datei verwenden (`external: true`), statt ein neues anzulegen.
- **172.x-Adressen auf `eth0`.** GravityLAN hält eine Schnittstelle namens `eth0` mit einer Adresse, die mit `172.` beginnt, für die Docker-Bridge und ignoriert sie. Landet ein VLAN aus diesem Bereich auf `eth0`, erscheint es als **L3 Geroutet** und wird nur gescannt, wenn es unter **Zu scannende Subnetze** steht.

### Weg B: Agent als Layer-2-Probe

Kann der GravityLAN-Host einem VLAN nicht beitreten (kein getaggter Port, anderes Gebäude oder anderer Standort), kann ein Linux-Host in diesem VLAN mit GravityLAN-Agent die MAC-Adressen liefern: ein Raspberry Pi, eine VM oder ein LXC-Container mit einer Adresse im VLAN.

#### Voraussetzungen

- Der Host ist ein Gerät in GravityLAN mit installiertem Agenten (Geräte-Editor, Tab **Agent**), Agent 0.3.8 oder neuer. Den unten beschriebenen aktiven Durchlauf gibt es seit Agent 0.3.9.
- Der Host hat eine Adresse in dem VLAN, das du sehen willst. Der Agent sieht nur die Subnetze, in denen er selbst hängt; pro VLAN braucht es also eine Probe.
- Freigeben musst du sonst nichts: Der Agent nutzt dieselbe Verbindung zu GravityLAN wie für seine Metriken.

#### Einschalten

Im Tab **Agent** des Geräte-Editors unter **Agent-Konfiguration** **L2 Subnetz-Scanner (Probe)** auf **Aktiviert** stellen und speichern. Der Agent übernimmt die Einstellung mit seiner nächsten Meldung.

#### Was der Agent macht

- Einmal pro Minute geht er jedes seiner eigenen IPv4-Subnetze mit höchstens 512 Adressen durch (`/23` bis `/30`): Er schickt an jede Adresse ein kleines UDP-Paket, wodurch sein Kernel die Adresse per ARP auflöst, und dazu einen Broadcast-Ping. Größere Subnetze geht er nicht durch; für sie meldet er nur, was ohnehin in seinem ARP-Cache steht.
- Mit jeder Meldung liest er seine Nachbartabelle (`/proc/net/arp` und `ip neigh`) und schickt die IP-MAC-Paare mit seinen Metriken mit. Es gibt kein nmap, keinen Portscan und keine zusätzliche Verbindung.

#### Was GravityLAN daraus macht

- Ein Gerät im Dashboard mit einer dieser IP-Adressen bekommt die gemeldete MAC-Adresse (eine andere gespeicherte wird ersetzt), den Hersteller, falls noch keiner gesetzt ist, und wird als online markiert.
- Eine unbekannte IP-Adresse wird zu einem gefundenen Host mit MAC-Adresse und Hersteller. Er erscheint auf der Seite **IP-Adressen**, in der Adresskarte und unter **Aktuelle Funde**; über seine Adresskachel lässt er sich ins Dashboard übernehmen.
- Auf der Seite **IP-Adressen** zeigt ein Subnetz, das die Adresse der Probe enthält und nicht direkt an GravityLAN hängt, **L2 Probe (&lt;Gerät&gt;)**. Das Subnetz muss dort angelegt sein.

### Weg C: ARP-Tabelle des Routers (Ausblick)

**Noch nicht verfügbar.** In vielen Homelabs ist eine Firewall bzw. ein Router (OPNsense, pfSense, UniFi, MikroTik u. a.) das Gateway aller VLANs; ihre ARP-Tabelle und DHCP-Leases enthalten deshalb schon jedes aktive IP-MAC-Paar. Ein Konnektor, der sie regelmäßig per SNMP oder über die API des Routers ausliest, ist für 0.4.0 geplant. Bis dahin Weg A oder B nutzen.
