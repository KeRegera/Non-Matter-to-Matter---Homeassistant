# Changelog

## 1.0.0

- Erste Version
- QR-Codes scannen per Kamera (HTTPS / Home-Assistant-App) oder per Foto (funktioniert überall), Codes eintippen
- Erkennt HomeKit-QR-Codes (`X-HM://…`), 8-stellige HomeKit-Codes, Matter-QR-Codes (`MT:…`) und
  11-/21-stellige Matter-Codes (z. B. aus Apple Home „Kopplungsmodus aktivieren“)
- Umwandlung Matter-QR-Code → manueller Matter-Code, Anzeige aller enthaltenen Daten (Kategorie, Setup-ID,
  Verbindungsarten, VID/PID, Discriminator, Setup-PIN)
- HomeKit-Geräte über die Integration „HomeKit Device“ (HomeKit Controller) koppeln; das passende Gerät wird
  anhand des Setup-Hashes automatisch im Netzwerk gefunden
- Matter-Geräte über die Matter-Integration hinzufügen (auch als zusätzlicher Controller neben Apple Home)
