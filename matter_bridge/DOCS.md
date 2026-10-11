# Matter Bridge

Dieses Add-on macht beliebige Home-Assistant-Entitäten – also auch Zigbee-, Z-Wave-, WLAN-, Cloud- oder
selbstgebaute Geräte ohne Matter-Unterstützung – als **Matter-Geräte** verfügbar. Sie können dann direkt in
Apple Home, Google Home, Amazon Alexa, Samsung SmartThings oder jedem anderen Matter-Controller gesteuert werden.

Home Assistant bleibt dabei die Zentrale: Jeder Befehl aus dem Matter-Controller wird als Dienstaufruf an
Home Assistant weitergegeben, und jede Zustandsänderung in Home Assistant wird sofort an Matter gemeldet.

## Einrichtung

1. Add-on starten und **„In Seitenleiste anzeigen“** aktivieren.
2. Die Web-Oberfläche öffnen (Seitenleiste → *Matter Bridge*).
3. Geräte auswählen, die bereitgestellt werden sollen (siehe unten).
4. Den angezeigten **QR-Code** mit der Home-App deines Controllers scannen
   (Apple Home: *Gerät hinzufügen*, Google Home: *Gerät einrichten → Matter*, Alexa: *Gerät hinzufügen → Matter*).
   Alternativ den 11-stelligen Kopplungscode eingeben.

> Der Controller meldet ein „nicht zertifiziertes Gerät“. Das ist normal für selbst betriebene Bridges –
> einfach „Trotzdem hinzufügen“ wählen.

Weitere Controller (z. B. zusätzlich Google Home) werden über die Freigabe-/Kopplungsmodus-Funktion des ersten
Controllers hinzugefügt (Apple Home: Gerät → *Kopplungsmodus aktivieren*).

## Geräte auswählen

Es gibt drei Wege, Entitäten bereitzustellen – sie lassen sich kombinieren:

| Weg | Beschreibung |
| --- | --- |
| **Web-Oberfläche** | Pro Entität *An*, *Aus* oder *Auto* wählen. Hier kann auch der Matter-Gerätetyp überschrieben und ein eigener Name vergeben werden. |
| **Label** | Entitäten oder Geräte mit dem Label `matter` (Option `include_labels`) werden automatisch bereitgestellt. |
| **Domain** | Alle Entitäten der Domains aus `include_domains` (z. B. `light`, `cover`) werden automatisch bereitgestellt. |

Einstellungen in der Web-Oberfläche haben immer Vorrang.

## Unterstützte Geräte und Funktionen

Der Matter-Gerätetyp und dessen Funktionen werden automatisch aus den Fähigkeiten der Entität bestimmt.

| Home Assistant | Matter-Gerät | Unterstützte Funktionen |
| --- | --- | --- |
| `light` | Ein/Aus-, dimmbares, Farbtemperatur- oder Farblicht | Ein/Aus, Helligkeit, Dimmen in Schritten, Farbtemperatur, Farbe (Farbton/Sättigung und XY), Übergangszeiten, Farbschleife (falls Effekt vorhanden) |
| `switch`, `input_boolean`, `automation`, `siren`, `humidifier`, `group`, `remote` | Steckdose (oder Licht) | Ein/Aus |
| `scene`, `script`, `button`, `input_button` | Steckdose (Taster) | Auslösen; schaltet sich danach selbst wieder aus |
| `cover` | Fensterabdeckung | Öffnen, Schließen, Stopp, Position, Lamellenneigung; Typ nach Geräteklasse (Markise, Vorhang, Rollladen, Jalousie) |
| `lock` | Türschloss | Sperren, Entsperren, Entsperren mit Zeitlimit, Öffnen/Entriegeln, PIN-Code |
| `climate` | Thermostat | Modi Aus/Heizen/Kühlen/Auto/Trocknen/Lüften, Soll- und Isttemperatur, Heiz-/Kühl-Sollwert im Auto-Modus, Heiz-/Kühlstatus, Lüfterstufen, Luftfeuchte |
| `water_heater` | Thermostat (Heizen) | Ein/Aus, Solltemperatur, Isttemperatur |
| `fan` | Ventilator oder Luftreiniger | Ein/Aus, Prozent und Stufen, Low/Medium/High, Auto, Oszillation, Drehrichtung, Schlaf-/Natur-Wind |
| `vacuum` | Saugroboter | Start, Pause, Fortsetzen, Stopp, Zurück zur Basis, Saugstufen, Betriebszustand (Reinigen, Laden, Angedockt, Fehler) |
| `valve` | Wasserventil | Öffnen, Schließen, Position |
| `media_player` | Lautsprecher | Ein/Aus (bzw. Stummschalten), Lautstärke |
| `select`, `input_select`, `alarm_control_panel` | Moduswahl | Option wählen; Alarmanlage scharf/unscharf (optional mit Code) |
| `sensor` | Temperatur-, Feuchte-, Helligkeits-, Luftdruck-, Durchfluss- oder Luftqualitätssensor | Messwerte inkl. Einheitenumrechnung (°F, inHg, L/min …); Luftqualität für CO₂, CO, PM1, PM2.5, PM10, VOC, NO₂, O₃, Formaldehyd, Radon und AQI |
| `binary_sensor` | Kontakt-, Bewegungs-, Wasserleck-, Frost-, Rauch- oder CO-Melder | Zustand je nach Geräteklasse |
| `person`, `device_tracker` | Präsenzmelder | Zuhause / abwesend |
| `event` (z. B. Türklingel, Taster) | Taster | Einfach-, Doppel- und Langdruck als Matter-Ereignisse |
| `camera` | Kamera (Matter 1.5) | Live-Video (H.264) und Ton (Opus) über WebRTC, Schnappschüsse; siehe unten |

Über die Web-Oberfläche lassen sich weitere Kombinationen wählen, zum Beispiel:

- einen Schalter als **Licht** oder **Ventil** darstellen,
- einen Ventilator, ein Rollo, ein Licht oder eine `input_number` als **dimmbare Steckdose**,
- Licht-Effekte, Klima-Presets, Medienquellen oder Saugstufen als **Moduswahl**,
- einen Binärsensor als beliebigen anderen Sensortyp.

Wird eine Entität vorübergehend `unavailable`, meldet die Bridge sie in Matter als „nicht erreichbar“ und behält
ihre Funktionen bei. Ändern sich die Fähigkeiten einer Entität (z. B. neue Farbmodi), wird das Matter-Gerät
automatisch neu aufgebaut.

## Kameras (Matter 1.5)

Kameras werden als **Matter-Kamera** bereitgestellt: Live-Bild mit Ton über WebRTC und Schnappschüsse.

> **Wichtig:** Matter-Kameras sind neu. Stand Mitte 2026 zeigt nur **SmartThings** sie an; **Apple Home,
> Google Home und Alexa** haben die Unterstützung angekündigt, aber noch nicht freigeschaltet. Die Kamera
> erscheint dort erst nach einem entsprechenden Update der Controller.
> Wer das Live-Bild **jetzt schon in Apple Home** möchte, nutzt zusätzlich die Integration *HomeKit Bridge*
> von Home Assistant (Modus „Accessory“).

**Einrichtung am Beispiel Tapo C-/TC-Kameras (z. B. TC70):**

1. In der Tapo-App unter *Kameraeinstellungen → Erweiterte Einstellungen → Kamera-Konto* Benutzer und
   Passwort anlegen.
2. In der Web-Oberfläche der Bridge bei der `camera.…`-Entität die RTSP-Adresse eintragen, z. B.
   `rtsp://BENUTZER:PASSWORT@192.168.1.50:554/stream1` (`stream2` = geringere Auflösung, weniger Last).
   Ohne Eintrag verwendet die Bridge den Stream von Home Assistant (HLS, etwas mehr Verzögerung).
   Zum Entfernen einer gespeicherten Adresse `-` eingeben.
3. Bewegungs-/Personenerkennung (`binary_sensor`), Privatsphäre-Modus (`switch`) und Sirene (`siren`) der
   Kamera können zusätzlich als eigene Matter-Geräte bereitgestellt werden.

Technik: Die Bridge liest den Kamerastream mit ffmpeg, übernimmt H.264 ohne Neukodierung (andere Codecs werden
nach H.264 umgewandelt) und kodiert den Ton nach Opus. ffmpeg läuft nur, solange jemand zuschaut. Für
Schnappschüsse wird Matter über TCP benötigt (Option `matter_tcp`, standardmäßig aktiv).

## Optionen

| Option | Beschreibung |
| --- | --- |
| `log_level` | `debug`, `info`, `warning` oder `error` |
| `bridge_name` | Name der Bridge in der Controller-App |
| `port` | UDP-Port für Matter (Standard `5540`) |
| `passcode` / `discriminator` | Optional feste Kopplungsdaten; ohne Angabe werden sichere Werte erzeugt und gespeichert |
| `network_interface` | Optional: mDNS nur auf dieser Netzwerkschnittstelle ankündigen |
| `include_domains` | Domains, deren Entitäten automatisch bereitgestellt werden |
| `include_labels` | Labels, deren Entitäten/Geräte automatisch bereitgestellt werden (Standard: `matter`) |
| `exclude_entities` | Entitäten, die nie automatisch bereitgestellt werden |
| `exclude_hidden` | Versteckte sowie Konfigurations-/Diagnose-Entitäten bei Domain-Regeln ignorieren |
| `matter_tcp` | Matter über TCP für große Nachrichten (Kamera-Schnappschüsse); nur bei Problemen abschalten |

## Voraussetzungen und Hinweise

- **IPv6** muss im Heimnetz aktiv sein (Matter nutzt IPv6 und mDNS). Das Add-on läuft im Host-Netzwerk.
- Der Matter-Controller (Apple TV/HomePod, Google Nest, Echo usw.) muss sich im selben Netzwerk befinden.
- Ist Port 5540 bereits belegt (z. B. durch das offizielle *Matter Server*-Add-on), weicht die Bridge automatisch
  auf den nächsten freien Port aus. Der tatsächlich genutzte Port steht in der Web-Oberfläche; fest einstellen
  lässt er sich unter `port`.
- Nicht jeder Controller unterstützt jeden Gerätetyp: Apple Home zeigt z. B. keine Lautsprecher und Moduswahlen
  an, Google Home und SmartThings dagegen schon.
- Das stufenlose „Dimmen halten“ (Matter *Move/Stop*) wird als Übergang zum Minimum bzw. Maximum umgesetzt, da
  Home Assistant laufende Übergänge nicht anhalten kann.
- Codes für Schlösser und Alarmanlagen werden im Add-on-Datenverzeichnis gespeichert. Eine über Matter
  bereitgestellte Alarmanlage kann von jedem verbundenen Controller entschärft werden – nur bewusst freigeben.
- **Alle Kopplungen entfernen** in der Web-Oberfläche setzt die Bridge zurück; sie muss danach in allen
  Controllern neu hinzugefügt werden.
