# Proxmox VE integration

GravityLAN can read guest names and addresses from one Proxmox VE server or cluster. It only issues GET requests to Proxmox; it cannot start, stop or modify guests.

## Configure

1. Create a dedicated Proxmox user and API token, for example `gravitylan@pve!inventory`.
2. Grant read access to the desired guests. `PVEAuditor` at `/` with propagation provides inventory/configuration access. Current Proxmox versions additionally require `VM.GuestAgent.Audit` on the VMs for `network-get-interfaces`; assign a custom read role containing that privilege. Older versions may require `VM.Monitor` for this API call. Check the API viewer for your installed version. With token privilege separation enabled, both the user and token need the permissions; token permissions cannot exceed the user's permissions.
3. Enable the QEMU Guest Agent in each VM's Proxmox options, install it in the guest OS, and ensure it is running. LXC containers do not need a guest agent.
4. In GravityLAN, open **Settings → Proxmox VE**. Enter the HTTPS origin, for example `https://192.168.1.2:8006`, token ID and token secret, then enable the integration and save.
5. Select **Synchronize now**. GravityLAN also synchronizes every five minutes after its initial setup is complete. Read access to the cluster list alone does not guarantee access to each guest; the result reports skipped guests separately.

The GravityLAN backend must be able to reach the API address. Redirects are not followed, so enter the direct HTTPS API address. No new Python or frontend dependency is required.

## Self-signed certificates

Certificate verification is enabled by default. For a trusted homelab server with a self-signed certificate, select **Ignore self-signed certificates**. This disables certificate-chain and hostname verification only for this Proxmox connection. HTTPS encryption remains enabled, but the server's identity is no longer verified.

## Names and addresses

- Running VMs: read addresses from QEMU Guest Agent `network-get-interfaces`. A stopped VM or one without a readable guest agent is skipped.
- Running LXC containers: read runtime addresses from `/interfaces`, including DHCP addresses. Both older `inet`/`inet6` and newer `ip-addresses` responses are supported.
- Stopped LXC containers: read static `ip`/`ip6` entries from their network configuration. DHCP/automatic addresses cannot be inferred while stopped.
- Loopback, link-local, multicast and unspecified addresses are excluded. Templates are ignored. If two guests report the same address, that address is skipped rather than assigned arbitrarily.
- Match existing dashboard devices by exact IP. Replace placeholder/automatic display names with the Proxmox guest name; preserve custom labels. Imported names appear in discovered hosts and the IP address view too. New guests are not automatically added to the dashboard; use the existing add-device action.
- The import does not mark a guest online or refresh its last successful network-probe timestamp. Proxmox power state is not network reachability. Imported offline entries remain available while the integration is enabled; they are not deleted when a network scan misses them.
- Disabling or removing the connection stops imports; already assigned names remain. Synchronization does not delete devices or merge several addresses into one device.

The token secret is encrypted at rest with GravityLAN's existing vault key and never returned to the browser. Leave the secret field empty when editing settings to retain it. Changing the server address or token ID requires re-entering the secret, to prevent forwarding an existing credential to a different server. **Disconnect** removes the stored connection and encrypted token. Credentials and integration state are excluded from JSON backup export/import; factory reset removes them. Preserve the vault key separately when backing up the database volume.

## Deutsch

Unter **Einstellungen → Proxmox VE** API-Adresse (`https://pve:8006`), Token-ID (`gravitylan@pve!inventory`) und Token-Secret eintragen, die Anbindung aktivieren und speichern. Anschließend **Jetzt synchronisieren** wählen. Danach läuft der Import automatisch alle fünf Minuten.

Für selbstsignierte Zertifikate lässt sich **Selbstsignierte Zertifikate ignorieren** aktivieren. Dadurch entfällt für diese Verbindung auch die Prüfung des Hostnamens. Die Option bleibt standardmäßig ausgeschaltet.

Der Proxmox-Benutzer und – bei aktivierter Privilegientrennung – sein Token benötigen Leserechte auf die Gäste. `PVEAuditor` deckt Inventar und Konfiguration ab. Für VM-Adressen ist auf aktuellen Versionen zusätzlich `VM.GuestAgent.Audit` nötig; ältere Versionen können dafür `VM.Monitor` voraussetzen. Der QEMU Guest Agent muss innerhalb der VM laufen und in Proxmox aktiviert sein. LXC benötigt keinen Agent. Gestoppte LXC können über statische Adressen erkannt werden; DHCP-Adressen gestoppter Gäste sind nicht verfügbar.

Die Zuordnung erfolgt über die IP-Adresse. Eigene Anzeigenamen bleiben erhalten. Neue Gäste erscheinen in den gefundenen Hosts bzw. der IP-Ansicht und können wie bisher zum Dashboard hinzugefügt werden. Ein Import setzt Geräte nicht automatisch auf „online“. Fehlende Leserechte, fehlende Agenten und Adresskonflikte werden als übersprungene Gäste bzw. Konflikte gemeldet.

Das Secret wird verschlüsselt gespeichert. Ein leeres Secret-Feld behält den gespeicherten Wert bei. Zum Entfernen der Zugangsdaten **Verbindung entfernen** wählen. JSON-Backups enthalten keine Proxmox-Zugangsdaten; den Vault-Schlüssel bei einer Sicherung des Datenverzeichnisses separat bewahren.
