# Raspberry Pi Setup – Knobelstatz Server

## Voraussetzungen
- Raspberry Pi Zero 2 W
- Raspberry Pi OS (Debian-basiert)
- Benutzer: `bueffel`
- Heimnetzwerk: `Burrow`

---

## 1. Dateien auf den Pi übertragen (von Windows)

```bash
# Verzeichnis auf dem Pi anlegen
ssh bueffel@knobelserver "mkdir -p ~/knobelstatz"

# Dateien kopieren
scp -r "C:/Users/afuchs/Desktop/Claude Onboarding/public" bueffel@knobelserver:~/knobelstatz/
scp "C:/Users/afuchs/Desktop/Claude Onboarding/server.js" bueffel@knobelserver:~/knobelstatz/
scp "C:/Users/afuchs/Desktop/Claude Onboarding/package.json" bueffel@knobelserver:~/knobelstatz/
```

---

## 2. Node.js installieren

```bash
sudo apt install nodejs npm -y
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

### Hotspot-Software installieren

```bash
sudo apt install hostapd dnsmasq -y
sudo systemctl disable hostapd
```

### hostapd konfigurieren

```bash
sudo truncate -s 0 /etc/hostapd/hostapd.conf
sudo nano /etc/hostapd/hostapd.conf
```

Inhalt:
```
interface=wlan0
driver=nl80211
ssid=Knobelstatz
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=Knobel123
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
```

### dnsmasq konfigurieren

```bash
sudo nano /etc/dnsmasq.conf
```

Am Ende anfügen:
```
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h
```

### Statische IP für Hotspot-Modus

```bash
sudo nano /etc/dhcpcd.conf
```

Am Ende anfügen:
```
interface=wlan0
static ip_address=192.168.4.1/24
nohook wpa_supplicant
```

### Fallback-Skript erstellen

```bash
sudo truncate -s 0 /usr/local/bin/wifi-check.sh
sudo nano /usr/local/bin/wifi-check.sh
```

Inhalt:
```bash
#!/bin/bash

SSID="Burrow"

if iwlist wlan0 scan | grep -q "$SSID"; then
    systemctl stop hostapd
    systemctl start wpa_supplicant
else
    systemctl stop wpa_supplicant
    ip addr flush dev wlan0
    systemctl start hostapd
fi
```

```bash
sudo chmod +x /usr/local/bin/wifi-check.sh
```

### Fallback als Autostart-Service einrichten

```bash
sudo nano /etc/systemd/system/wifi-check.service
```

Inhalt:
```ini
[Unit]
Description=WiFi Check - Hotspot Fallback
After=network.target

[Service]
ExecStart=/usr/local/bin/wifi-check.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
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

## Ergebnis

| Situation | Verhalten |
|-----------|-----------|
| `Burrow` erreichbar | Pi verbindet sich mit Heimnetzwerk, App auf `http://knobelserver:8080` |
| `Burrow` nicht erreichbar | Pi öffnet WLAN `Knobelstatz` (Passwort: `Knobel123`), App auf `http://192.168.4.1:8080` |
