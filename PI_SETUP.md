# Raspberry Pi Setup – Knobelstatz Server

## Voraussetzungen
- Raspberry Pi Zero 2 W
- Raspberry Pi OS (Debian-basiert)
- Benutzer: `bueffel`
- Heimnetzwerk: `Burrow`

---

## 1. Repo auf den Pi klonen

```bash
# Auf dem Pi einloggen
ssh bueffel@knobelserver.local

# Repo klonen (falls noch nicht vorhanden)
cd ~/knobelstatz
git init
git remote add origin https://github.com/lxthunder/knobeln.git
git fetch
git add -A && git checkout -f rundenmodus
npm install
```

---

## 2. Pakete installieren

```bash
sudo apt install -y git nodejs npm
```

---

## 3. Node-Abhängigkeiten installieren

```bash
cd ~/knobelstatz
npm install
```

---

## 4. Knobelstatz als Autostart-Service einrichten

```bash
sudo nano /etc/systemd/system/knobelstatz.service
```

Inhalt:
```ini
[Unit]
Description=Knobelstatz Server
After=network.target

[Service]
User=bueffel
WorkingDirectory=/home/bueffel/knobelstatz
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable knobelstatz
sudo systemctl start knobelstatz
```

Server läuft auf Port **8080**: `http://knobelserver:8080`

---

## 5. Hotspot-Fallback einrichten

Der Pi verbindet sich mit dem Heimnetzwerk `Burrow`. Ist dieses nicht erreichbar, öffnet er automatisch einen eigenen WLAN-Hotspot.

**Hinweis:** Der Hotspot wird vollständig über NetworkManager verwaltet. hostapd und dnsmasq werden installiert aber deaktiviert, da sie mit NetworkManager kollidieren.

### Konflikte deaktivieren

```bash
sudo systemctl stop dnsmasq && sudo systemctl disable dnsmasq
sudo systemctl stop hostapd && sudo systemctl disable hostapd
```

### Hotspot-Profil erstellen

```bash
sudo nmcli con add type wifi ifname wlan0 con-name Hotspot autoconnect no ssid Knobelstatz mode ap
sudo nmcli con modify Hotspot 802-11-wireless.band bg ipv4.method shared
```

Kein Passwort — offenes Netzwerk.

### Fallback-Skript erstellen

```bash
sudo tee /usr/local/bin/wifi-check.sh > /dev/null <<'EOF'
#!/bin/bash
SSID="Burrow"
sleep 5
if nmcli dev wifi list | grep -q "$SSID"; then
    nmcli con down Hotspot 2>/dev/null
    nmcli dev wifi connect "$SSID" 2>/dev/null
else
    nmcli con up Hotspot
fi
EOF
sudo chmod +x /usr/local/bin/wifi-check.sh
```

### Fallback als Autostart-Service einrichten

```bash
sudo tee /etc/systemd/system/wifi-check.service > /dev/null <<'EOF'
[Unit]
Description=WiFi Check - Hotspot Fallback
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
ExecStart=/usr/local/bin/wifi-check.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable wifi-check
sudo systemctl start wifi-check
```

---

## 6. SD-Karte spiegeln (Backup)

Nachdem alles läuft, sollte die SD-Karte gesichert werden – SD-Karten sind der häufigste Ausfallpunkt beim Pi.

### Option A – Image direkt vom Pi erstellen (Pi bleibt an)

```bash
sudo dd if=/dev/mmcblk0 bs=4M status=progress | gzip > ~/knobelstatz_backup.img.gz
```

Das Image per SCP auf Windows kopieren:
```bash
scp bueffel@knobelserver:~/knobelstatz_backup.img.gz "C:/Users/afuchs/Desktop/"
```

### Option B – Image auf Windows erstellen (Pi ausschalten)

```bash
sudo shutdown -h now
```

SD-Karte rausnehmen und mit **Win32DiskImager** oder **Raspberry Pi Imager** als `.img` sichern.

### Wiederherstellen

```bash
gunzip -c knobelstatz_backup.img.gz | sudo dd of=/dev/mmcblk0 bs=4M status=progress
```

---

## 7. SD-Karte schreibschützen (Read-Only Overlay)

Verhindert, dass der Pi auf die SD-Karte schreibt – schützt vor Datenverlust bei Stromausfall.  
**Hinweis:** Die `Knobel.txt` Datenbank kann danach nicht mehr aktualisiert werden.

```bash
ssh bueffel@knobelserver.local
sudo raspi-config
```

Im Menü navigieren (Pfeiltasten + Enter):  
**Performance Options → Overlay File System → Enable → Yes**

Pi neu starten:
```bash
sudo reboot
```

---

## 8. Updates einspielen

Wenn der Code auf GitHub geändert wurde, auf dem Pi aktualisieren:

```bash
ssh bueffel@knobelserver.local
cd ~/knobelstatz && git pull origin rundenmodus && sudo systemctl restart knobelstatz
```

Der Server startet automatisch neu und lädt die neue Version.

---

## Ergebnis

| Situation | Verhalten |
|-----------|-----------|
| `Burrow` erreichbar | Pi verbindet sich mit Heimnetzwerk, App auf `http://knobelserver.local:8080` |
| `Burrow` nicht erreichbar | Pi öffnet WLAN `Knobelstatz` (kein Passwort), App auf `http://10.42.0.1:8080` |
