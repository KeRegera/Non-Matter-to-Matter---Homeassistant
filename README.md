# Non-Matter to Matter – Home Assistant Add-ons

Dieses Repository enthält zwei Apps (Add-ons):

| App | Zweck |
| --- | --- |
| **Matter Bridge** | Stellt beliebige Home-Assistant-Geräte als Matter-Geräte bereit |
| **Apple Home Scanner** | Scannt Apple-Home-/HomeKit-/Matter-QR-Codes, wandelt Matter-Codes um und fügt Geräte direkt zu Home Assistant hinzu ([Anleitung](apple_home_scanner/DOCS.md)) |

## Matter Bridge

Ein Home-Assistant-OS-Add-on, das **beliebige Home-Assistant-Geräte als Matter-Geräte bereitstellt** – inklusive
der jeweiligen Gerätefunktionen (Helligkeit, Farbe, Farbtemperatur, Position, Neigung, Thermostatmodi,
Lüfterstufen, Saugroboter-Steuerung, Sensorwerte, Türklingeln und Kameras mit Live-Bild nach Matter 1.5 …). So lassen sich Zigbee-, Z-Wave-, WLAN- oder Cloud-Geräte
in Apple Home, Google Home, Amazon Alexa oder SmartThings nutzen.

## Installation

1. In Home Assistant **Einstellungen → Add-ons → Add-on-Store** öffnen.
2. Oben rechts **⋮ → Repositories** wählen und diese URL hinzufügen:
   `https://github.com/KeRegera/Non-Matter-to-Matter---Homeassistant`
3. Das Add-on **Matter Bridge** (bzw. **Apple Home Scanner**) installieren und starten.
4. Die Web-Oberfläche öffnen, Geräte auswählen und den QR-Code mit der Controller-App scannen.

Die ausführliche Anleitung mit allen unterstützten Gerätetypen steht in
[`matter_bridge/DOCS.md`](matter_bridge/DOCS.md).

## Aufbau

```
repository.yaml            Add-on-Repository-Beschreibung
apple_home_scanner/        App „Apple Home Scanner“ (QR-Scanner, HomeKit-/Matter-Kopplung)
matter_bridge/
  config.yaml              Add-on-Konfiguration (Host-Netzwerk, Ingress, Optionen)
  Dockerfile, build.yaml   Image-Build auf Basis der Home-Assistant-Base-Images
  app/
    src/ha/                Home-Assistant-WebSocket-Client
    src/matter/bridge.ts   Matter-Server (matter.js), Aggregator und Geräteverwaltung
    src/matter/mappers.ts  Zuordnung HA-Entität → Matter-Gerätetyp und -Funktionen
    src/matter/behaviors.ts Matter-Cluster, die Befehle an Home Assistant weiterleiten
    src/camera/            Matter-Kamera: Stream-Verwaltung, WebRTC (werift) und ffmpeg-Anbindung
    src/web/               Ingress-Web-Oberfläche (Geräteauswahl, QR-Code)
    test/mock-ha.mjs       Simulierter Home-Assistant-Server für lokale Tests
```

## Entwicklung

```bash
cd matter_bridge/app
npm install
npm run build

# Simulierten Home Assistant starten und die Bridge damit verbinden
node test/mock-ha.mjs 18123 &
mkdir -p /tmp/bridge-data
echo '{"include_domains":["light","switch","cover","climate","fan","sensor","binary_sensor"]}' > /tmp/bridge-data/options.json
DATA_DIR=/tmp/bridge-data HA_URL=ws://localhost:18123 HA_TOKEN=test INGRESS_PORT=8099 UI_ALLOW_ALL=1 npm start
```

Die Web-Oberfläche ist dann unter http://localhost:8099 erreichbar.
