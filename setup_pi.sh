#!/bin/bash
# =============================================================================
# Knobelstatz Pi Setup Script
#
# Vorbereitung (einmalig, auf dem Pi):
#   cd ~/knobelstatz
#   git init
#   git remote add origin https://github.com/lxthunder/knobeln.git
#   git fetch
#   git add -A && git checkout -f rundenmodus
#
# Dann dieses Script ausführen:
#   bash ~/knobelstatz/setup_pi.sh
#
# Updates einspielen (nach Code-Änderungen):
#   cd ~/knobelstatz && git pull origin rundenmodus && sudo systemctl restart knobelstatz
# =============================================================================

set -e  # Bei Fehler abbrechen

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- Prüfungen ---
[[ $EUID -eq 0 ]] && error "Nicht als root ausführen. Starte als 'bueffel' ohne sudo."
[[ "$(whoami)" != "bueffel" ]] && warn "Benutzer ist nicht 'bueffel' – Pfade könnten abweichen."

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
info "Arbeitsverzeichnis: $INSTALL_DIR"

# =============================================================================
# 1. System-Updates & Pakete installieren
# =============================================================================
info "Installiere Node.js, hostapd und i2c-tools..."
sudo apt update -y
sudo apt install -y nodejs npm hostapd i2c-tools

# dnsmasq deaktivieren – kollidiert mit NetworkManager's internem DHCP für Hotspot
sudo systemctl stop dnsmasq 2>/dev/null || true
sudo systemctl disable dnsmasq 2>/dev/null || true

# hostapd deaktivieren – kollidiert mit NetworkManager's AP-Modus
sudo systemctl stop hostapd 2>/dev/null || true
sudo systemctl disable hostapd 2>/dev/null || true

# =============================================================================
# 2. Node-Abhängigkeiten installieren
# =============================================================================
info "Installiere npm-Pakete..."
cd "$INSTALL_DIR"
npm install

# =============================================================================
# 3. Knobelstatz systemd-Service
# =============================================================================
info "Richte Knobelstatz-Service ein..."
sudo tee /etc/systemd/system/knobelstatz.service > /dev/null <<EOF
[Unit]
Description=Knobelstatz Server
After=network.target

[Service]
User=bueffel
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable knobelstatz
sudo systemctl start knobelstatz
info "Knobelstatz-Service läuft."

# =============================================================================
# 4. NetworkManager Hotspot-Profil erstellen
# =============================================================================
info "Erstelle NetworkManager Hotspot-Profil..."

# Altes Profil entfernen falls vorhanden
nmcli con delete Hotspot 2>/dev/null || true

sudo nmcli con add type wifi ifname wlan0 con-name Hotspot autoconnect no ssid Knobelstatz mode ap
sudo nmcli con modify Hotspot 802-11-wireless.band bg ipv4.method shared wifi-sec.key-mgmt wpa-psk wifi-sec.psk "Knobel123"

# =============================================================================
# 5. WiFi-Fallback-Script erstellen
# =============================================================================
info "Erstelle WiFi-Fallback-Script..."
sudo tee /usr/local/bin/wifi-check.sh > /dev/null <<'EOF'
#!/bin/bash

SSID="Burrow"

# Warten bis NetworkManager bereit ist
sleep 5

if nmcli dev wifi list | grep -q "$SSID"; then
    nmcli con down Hotspot 2>/dev/null
    nmcli dev wifi connect "$SSID" 2>/dev/null
else
    nmcli con up Hotspot
fi
EOF

sudo chmod +x /usr/local/bin/wifi-check.sh

# =============================================================================
# 6. WiFi-Fallback als systemd-Service
# =============================================================================
info "Richte WiFi-Fallback-Service ein..."
sudo tee /etc/systemd/system/wifi-check.service > /dev/null <<EOF
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

# =============================================================================
# Zusammenfassung
# =============================================================================
echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}  Setup abgeschlossen!${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo "  Knobelstatz-Server:  http://knobelserver:8080"
echo "  Hotspot SSID:        Knobelstatz"
echo "  Hotspot Passwort:    Knobel123"
echo "  Hotspot Adresse:     http://10.42.0.1:8080"
echo ""
echo "  Service-Status prüfen:"
echo "    sudo systemctl status knobelstatz"
echo "    sudo systemctl status wifi-check"
echo ""
echo -e "${YELLOW}=============================================${NC}"
echo -e "${YELLOW}  EMPFEHLUNG: SD-Karte jetzt spiegeln!${NC}"
echo -e "${YELLOW}=============================================${NC}"
echo ""
echo "  Der Pi ist vollständig eingerichtet – jetzt ist der ideale"
echo "  Zeitpunkt, ein Backup-Image der SD-Karte zu erstellen."
echo ""
echo "  Option A – Image direkt vom Pi (Pi bleibt an):"
echo "    sudo dd if=/dev/mmcblk0 bs=4M status=progress | gzip > ~/knobelstatz_backup.img.gz"
echo ""
echo "  Option B – Auf Windows mit Win32DiskImager / Raspberry Pi Imager:"
echo "    Pi herunterfahren:  sudo shutdown -h now"
echo "    SD-Karte rausnehmen und auf Windows-PC als Image sichern."
echo ""
echo "  Wiederherstellen (falls nötig):"
echo "    gunzip -c knobelstatz_backup.img.gz | sudo dd of=/dev/mmcblk0 bs=4M status=progress"
echo ""
