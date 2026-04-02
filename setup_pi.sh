#!/bin/bash
# =============================================================================
# Knobelstatz Pi Setup Script
# Führe dieses Script auf dem Pi aus: bash ~/knobelstatz/setup_pi.sh
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
info "Installiere Node.js, hostapd und dnsmasq..."
sudo apt update -y
sudo apt install -y nodejs npm hostapd dnsmasq

# hostapd beim Boot deaktivieren (wird vom wifi-check.sh gesteuert)
sudo systemctl disable hostapd

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
# 4. hostapd konfigurieren
# =============================================================================
info "Konfiguriere hostapd (WLAN-Hotspot)..."
sudo tee /etc/hostapd/hostapd.conf > /dev/null <<EOF
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
EOF

# Pfad zur Konfigurationsdatei setzen (Debian-Standard)
sudo sed -i 's|^#DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# =============================================================================
# 5. dnsmasq konfigurieren
# =============================================================================
info "Konfiguriere dnsmasq (DHCP für Hotspot)..."

# Nur hinzufügen, wenn noch nicht vorhanden
if ! grep -q "dhcp-range=192.168.4" /etc/dnsmasq.conf; then
    sudo tee -a /etc/dnsmasq.conf > /dev/null <<EOF

# Knobelstatz Hotspot
interface=wlan0
dhcp-range=192.168.4.2,192.168.4.20,255.255.255.0,24h
EOF
fi

# =============================================================================
# 6. Statische IP für Hotspot-Modus (dhcpcd)
# =============================================================================
info "Konfiguriere statische IP für Hotspot-Modus..."

if ! grep -q "# Knobelstatz Hotspot" /etc/dhcpcd.conf; then
    sudo tee -a /etc/dhcpcd.conf > /dev/null <<EOF

# Knobelstatz Hotspot
interface=wlan0
static ip_address=192.168.4.1/24
nohook wpa_supplicant
EOF
fi

# =============================================================================
# 7. WiFi-Fallback-Script erstellen
# =============================================================================
info "Erstelle WiFi-Fallback-Script..."
sudo tee /usr/local/bin/wifi-check.sh > /dev/null <<'EOF'
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
EOF

sudo chmod +x /usr/local/bin/wifi-check.sh

# =============================================================================
# 8. WiFi-Fallback als systemd-Service
# =============================================================================
info "Richte WiFi-Fallback-Service ein..."
sudo tee /etc/systemd/system/wifi-check.service > /dev/null <<EOF
[Unit]
Description=WiFi Check - Hotspot Fallback
After=network.target

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
echo "  Hotspot Adresse:     http://192.168.4.1:8080"
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
