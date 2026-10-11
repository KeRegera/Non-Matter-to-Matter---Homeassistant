# Changelog

## 1.1.2

- Behoben: Absturz, wenn Port 8099 bereits von einem anderen Add-on belegt ist. Home Assistant weist der
  Web-Oberfläche (Ingress) jetzt automatisch einen freien Port zu.
- Ein Fehler der Web-Oberfläche beendet die Matter-Bridge nicht mehr.

## 1.1.1

- Behoben: Start schlug fehl, wenn Port 5540 bereits belegt ist (z. B. durch das Matter-Server-Add-on).
  Die Bridge weicht jetzt automatisch auf den nächsten freien Port aus (5541, 5542, …) und meldet das im Log.

## 1.1.0

- Neu: Kameras als Matter-1.5-Kamera mit Live-Video (H.264) und Ton (Opus) über WebRTC sowie Schnappschüssen
  - Quelle: RTSP-Adresse der Kamera oder automatisch der Stream von Home Assistant
  - Beide WebRTC-Abläufe (Controller- und Kamera-Angebot), ICE-Kandidaten, STUN/TURN-Server des Controllers
- Neu: `event`-Entitäten (Türklingeln, Taster) als Matter-Taster mit Einfach-, Doppel- und Langdruck
- Neu: Option `matter_tcp` (Matter über TCP für große Nachrichten)
- ffmpeg ist jetzt Teil des Add-on-Images

## 1.0.0

- Erste Version: Matter-Bridge für Home-Assistant-Entitäten
- Lichter mit Ein/Aus, Helligkeit, Farbtemperatur, Farbe (HS und XY) und Übergangszeiten
- Rollläden/Jalousien/Tore mit Position und Lamellenneigung, Schlösser mit Öffnen-Funktion
- Thermostate (Heizen, Kühlen, Auto, Trocknen, Lüften) mit Sollwerten, Lüfterstufen und Luftfeuchte, Warmwasserbereiter
- Ventilatoren und Luftreiniger mit Stufen, Auto, Oszillation, Richtung und Wind-Modi
- Saugroboter, Ventile, Lautsprecher, Auswahlen, Alarmanlagen
- Sensoren: Temperatur, Luftfeuchte, Helligkeit, Luftdruck, Durchfluss, Luftqualität (CO₂, CO, Feinstaub, VOC, NO₂, O₃, Formaldehyd, Radon, AQI), Kontakt, Bewegung/Präsenz, Wasserleck, Frost, Regen, Rauch, CO
- Web-Oberfläche (Ingress) mit QR-Code, Geräteauswahl, Typ-Überschreibung und eigenen Namen
