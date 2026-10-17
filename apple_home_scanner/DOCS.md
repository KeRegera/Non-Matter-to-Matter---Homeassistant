# Apple Home Scanner

Mit dieser App scannst du den QR-Code eines Apple-Home-/HomeKit- oder Matter-Geräts direkt in Home Assistant –
die App erkennt, um welche Art Code es sich handelt, zeigt alle enthaltenen Daten an, wandelt Matter-QR-Codes in
den manuellen Matter-Code um und fügt das Gerät mit einem Klick zu Home Assistant hinzu.

## Einrichtung

1. App starten und **„In Seitenleiste anzeigen“** aktivieren.
2. Seitenleiste → *Apple Home Scanner* öffnen.
3. Code scannen:
   - **Kamera starten** – Live-Scan. Funktioniert nur, wenn Home Assistant über **HTTPS** geöffnet ist
     (z. B. Nabu Casa / Remote-URL) – das ist eine Vorgabe der Browser.
   - **Foto aufnehmen / wählen** – öffnet auf dem iPhone direkt die Kamera und funktioniert auch über
     `http://homeassistant.local:8123`.
   - Oder den Code eintippen bzw. einfügen.

## Welche Codes werden erkannt?

| Code | Beispiel | Woher |
| --- | --- | --- |
| HomeKit-QR-Code | `X-HM://0081YCYEP3QYT` | Etikett auf Gerät, Verpackung oder Anleitung |
| HomeKit-Setup-Code | `841-31-633` | Unter dem QR-Code aufgedruckt |
| Matter-QR-Code | `MT:Y.K9042C00KA0648G00` | Etikett auf Matter-Geräten |
| Matter-Code (11/21 Ziffern) | `3497-011-2332` | Etikett oder Apple Home → *Kopplungsmodus aktivieren* |

## HomeKit-Gerät hinzufügen

Reine HomeKit-Geräte werden über die Integration **HomeKit Device** (HomeKit Controller) eingebunden.

1. Gerät **aus Apple Home entfernen** (Gerät → Einstellungen → *Gerät entfernen*) oder zurücksetzen.
   Ein HomeKit-Gerät kann immer nur mit *einem* System gekoppelt sein.
2. QR-Code scannen → **Gerät im Netzwerk suchen**. Die App vergleicht den Setup-Hash, den das Gerät im Netzwerk
   ankündigt, mit der Setup-ID aus dem QR-Code und markiert das passende Gerät.
3. **Ausgewähltes Gerät koppeln** – der Setup-Code wird automatisch an Home Assistant übergeben.

Bluetooth-Geräte sind in der Netzwerksuche nicht sichtbar. Dafür **Direkt koppeln** wählen: Home Assistant listet
dann alle Geräte, die es selbst gefunden hat (auch per Bluetooth), und du wählst das richtige aus.

## Matter-Gerät hinzufügen

**Gerät ist schon in Apple Home** (empfohlen): Matter erlaubt mehrere Controller gleichzeitig.

1. Home-App → Gerät lange drücken → Einstellungen → ganz unten **Kopplungsmodus aktivieren**.
2. Den angezeigten 11-stelligen Code in die App eingeben.
3. **Zu Home Assistant hinzufügen** – das Gerät bleibt zusätzlich in Apple Home.

**Neues Gerät:** Matter-QR-Code scannen, den Haken „Gerät ist schon im Netzwerk“ entfernen und hinzufügen.
Dafür braucht der Matter-Server Bluetooth und die WLAN- bzw. Thread-Zugangsdaten. Meist ist es einfacher, das
Gerät zuerst in Apple Home einzurichten und dann wie oben zu teilen.

Voraussetzung ist die eingerichtete **Matter**-Integration (mit Matter-Server).

## „Apple-Home-Code in Matter-Code umwandeln“ – was geht und was nicht

- **Matter-QR-Code → Matter-Code:** geht. Die App zeigt den passenden manuellen Code, den du in jede Matter-App
  (Google Home, Alexa, SmartThings …) eintippen kannst.
- **Matter-Gerät in Apple Home → Code für einen weiteren Controller:** geht über *Kopplungsmodus aktivieren*
  (siehe oben). Das ist der offizielle Weg, aus Apple Home einen Matter-Code zu bekommen.
- **HomeKit-Code (`X-HM://`, 8 Ziffern) → Matter-Code:** geht **nicht**. Ein Matter-Code ist kein anderes
  Format desselben Codes – das Gerät selbst muss Matter beherrschen. Lösung: Gerät per HomeKit in Home Assistant
  einbinden und anschließend mit der **Matter Bridge** aus diesem Repository als Matter-Gerät weitergeben
  (z. B. zurück an Apple Home oder an Google Home).

## Optionen

| Option | Beschreibung |
| --- | --- |
| `log_level` | Ausführlichkeit des Logs (`debug`, `info`, `warning`, `error`). |
| `discovery_seconds` | Wie lange im Netzwerk nach HomeKit-Geräten gesucht wird (2–15 Sekunden, Standard 5). |

## Fehlerbehebung

| Meldung | Lösung |
| --- | --- |
| *bereits gekoppelt* / *keinen weiteren Controller* | Gerät in Apple Home entfernen oder zurücksetzen, kurz warten, erneut suchen. |
| *Setup-Code abgelehnt* | Code prüfen. Manche Geräte haben einen anderen Code auf dem Gerät als auf der Verpackung. |
| *nicht im Kopplungsmodus* | Kopplungsmodus am Gerät aktivieren (Herstelleranleitung), z. B. durch Aus- und Einschalten. |
| *Matter-Integration nicht eingerichtet* | Einstellungen → Geräte & Dienste → Integration hinzufügen → **Matter**. |
| Matter: *Kommissionierung fehlgeschlagen* | Kopplungsmodus in Apple Home neu aktivieren (gilt 15 Minuten) und prüfen, ob Home Assistant das Gerät im Netzwerk bzw. Thread-Netz erreicht. |
| Kamera startet nicht | Home Assistant über HTTPS öffnen oder *Foto aufnehmen / wählen* verwenden. |
