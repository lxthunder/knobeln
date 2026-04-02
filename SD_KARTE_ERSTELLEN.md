# SD-Karte für Knobelstatz Pi erstellen

## Voraussetzungen

- MicroSD-Karte (empfohlen: mind. 8 GB, Class 10)
- SD-Kartenleser (oder USB-Adapter)
- Windows-PC
- **Raspberry Pi Imager** → https://www.raspberrypi.com/software/

---

## 1. Raspberry Pi Imager installieren

Raspberry Pi Imager von der offiziellen Seite herunterladen und installieren.

---

## 2. OS auswählen und flashen

1. Raspberry Pi Imager starten
2. **"Raspberry Pi Device"** wählen → `Raspberry Pi Zero 2 W`
3. **"Operating System"** wählen → `Raspberry Pi OS (other)` → `Raspberry Pi OS Lite (64-bit)`
   - Lite = ohne Desktop, spart Ressourcen
4. **"Storage"** wählen → deine MicroSD-Karte

5. Auf **"Next"** klicken – es erscheint die Frage nach den **OS-Einstellungen** → `Einstellungen bearbeiten`

---

## 3. OS-Einstellungen konfigurieren (wichtig!)

Im Tab **"Allgemein":**

| Einstellung | Wert |
|---|---|
| Hostname | `knobelserver` |
| Benutzername | `bueffel` |
| Passwort | *(selbst wählen)* |
| WLAN SSID | `Burrow` |
| WLAN Passwort | *(Heimnetz-Passwort)* |
| WLAN Land | `DE` |
| Zeitzone | `Europe/Berlin` |
| Tastaturlayout | `de` |

Im Tab **"Dienste":**

- **SSH aktivieren** → `Passwortauthentifizierung verwenden`

Einstellungen speichern, dann **"Ja"** → flashen starten.

---

## 4. SD-Karte einsetzen & Pi starten

1. MicroSD-Karte in den Pi Zero 2 W einsetzen
2. Pi mit Strom versorgen (Micro-USB)
3. Ca. 60–90 Sekunden warten bis der Pi hochgefahren ist

---

## 5. Verbindung testen

```bash
# Von Windows aus (PowerShell oder CMD):
ssh bueffel@knobelserver.local
```

> Falls `knobelserver.local` nicht erreichbar ist, kurz warten (mDNS braucht einen Moment)
> oder die IP-Adresse des Pi im Router nachschlagen.

---

## 6. Weiter mit dem Software-Setup

Sobald SSH funktioniert, weiter mit **`PI_SETUP.md`** – oder direkt das Setup-Script übertragen und ausführen:

```bash
# Dateien auf den Pi kopieren (von Windows):
scp -r "C:/Users/afuchs/Desktop/Claude Onboarding/public" bueffel@knobelserver:~/knobelstatz/
scp "C:/Users/afuchs/Desktop/Claude Onboarding/server.js" bueffel@knobelserver:~/knobelstatz/
scp "C:/Users/afuchs/Desktop/Claude Onboarding/package.json" bueffel@knobelserver:~/knobelstatz/
scp "C:/Users/afuchs/Desktop/Claude Onboarding/setup_pi.sh" bueffel@knobelserver:~/knobelstatz/

# Setup auf dem Pi ausführen:
ssh bueffel@knobelserver "bash ~/knobelstatz/setup_pi.sh"
```

---

## 7. SD-Karte sichern (nach dem Setup)

Sobald alles eingerichtet ist → **`PI_SETUP.md` Abschnitt 6** für Backup-Anleitung.
