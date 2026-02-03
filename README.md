# nexowatt-knx (ioBroker Adapter)

⚡️ **NexoWatt KNX** ist ein *Clean‑Room* ioBroker‑Adapter, der eine **KNXnet/IP**‑Schnittstelle (IP Interface / IP Router) mit ioBroker verbindet – ohne Lizenzmechanik im Adapter selbst.

> Hinweis: Dieses Projekt implementiert die KNX‑Kommunikation neu (keine Code-Übernahme aus dem hochgeladenen Adapter). Du musst trotzdem die **KNX/ETS**-Lizenz- und Produktbedingungen deiner Installation einhalten.

## Features

- KNXnet/IP **Tunneling** über das npm‑Paket `knx`
- Optionaler **ETS‑Import** aus `.knxproj` über `ets_proj_parser` (MIT)
- Automatische Anlage von ioBroker‑Objekten/States für Gruppenadressen
- Bidirektional:
  - Telegramme vom Bus → State‑Updates
  - `setState` → KNX Write (oder Read trigger, wenn nicht writebar)
- Option: `GroupValueRead` beim Start (State-Refresh)
- Rate‑Limiting über `minimumDelayMs`

## Konfiguration (Admin)

### Verbindung
- **KNX/IP gateway IP**: IP deines KNX/IP Interfaces (Port i.d.R. 3671)
- **Local interface**: optional – lokale IP, falls mehrere Netzwerkkarten
- **Physical address**: optional – z.B. `1.1.250`
- **Local echo**: hilfreich, um eigene Writes wieder als Event zu sehen

### ETS Import
1. In ioBroker Admin → **Dateien** → Ordner **nexowatt-knx** → `.knxproj` hochladen
2. Im Adapter setzen: **ETS project file** (Dateiname)
3. **Import on start** aktivieren
4. Adapter neu starten

> Große ETS Projekte können beim Import merklich dauern.

### Manuelle Datenpunkte
Für schnelle Tests oder kleine Installationen kannst du GAs manuell hinzufügen.

## States / Objektstruktur
- `info.connection` (boolean) – Verbindungsstatus
- `ga.*` – automatisch erzeugte Datenpunkte

Jeder GA‑State speichert Metadaten in `native`:
- `ga` (z.B. `1/2/3`)
- `dpt` (z.B. `1.001`)
- `flags` (`readFlag`, `writeFlag`, `transmitFlag`)

## Entwicklung / Installation

```bash
cd /opt/iobroker
npm install /pfad/zum/iobroker.nexowatt-knx
# oder für lokale Entwicklung:
cd /opt/iobroker/node_modules
ln -s /pfad/zum/repo iobroker.nexowatt-knx
```

## Lizenz
MIT
