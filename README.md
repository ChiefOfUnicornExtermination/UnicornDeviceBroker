# Smart Device MQTT Bridge

REST API ↔ MQTT Bridge for controlling smart devices..

## Quick Start (Local Testing)

### Prerequisites

- Node.js 18+ with npm
- Local MQTT broker (Mosquitto)
- ESP32 with updated firmware

### 1. Install Mosquitto (local MQTT broker)

**macOS:**
```bash
brew install mosquitto
brew services start mosquitto
```

**Ubuntu/Debian:**
```bash
sudo apt install mosquitto mosquitto-clients
sudo systemctl start mosquitto
```

**Windows:**
Download from: https://mosquitto.org/download/

### 2. Install Node dependencies

```bash
npm install
```

### 3. Update ESP32 Firmware

1. Open `firmware/smart_device/smart_device_mqtt.ino` in Arduino IDE
2. Update WiFi credentials:
   ```cpp
   const char* WIFI_SSID = "Your_WiFi";
   const char* WIFI_PASSWORD = "Your_Password";
   const char* MQTT_BROKER = "mqtt://192.168.x.x";  // Your computer's IP
   ```
3. Upload to ESP32

### 4. Start the REST server

```bash
npm start
```

You should see:
```
--- Smart Device REST-MQTT Bridge ---
🚀 REST Server listening on port 8080
📡 MQTT Broker: mqtt://localhost:1883

API Endpoints:
  POST   http://localhost:8080/light/on
  POST   http://localhost:8080/light/off
  ...
```

### 5. Test with curl or Postman

```bash
# Turn light on
curl -X POST http://localhost:8080/light/on

# Check status
curl http://localhost:8080/status

# Response should show: {"light":"on","motor":"stopped",...}
```

**If the ESP32's LED turns on** → Everything works! 🎉

---

## Deploying to Google Cloud

See `DEPLOYMENT.md` for step-by-step instructions to deploy to Google Cloud Run + Compute Engine.

---

## Architecture

```
┌─────────────┐
│ Postman/App │
└──────┬──────┘
       │ REST HTTP
       ↓
┌─────────────────────────┐
│  Node.js REST Server    │ (8080)
│  (server.js)            │
└──────┬──────────────────┘
       │ MQTT Publish/Subscribe
       ↓
┌─────────────────────────┐
│   MQTT Broker           │ (1883)
│   (Mosquitto)           │
└──────┬──────────────────┘
       │ MQTT Subscribe
       ↓
┌─────────────────────────┐
│    ESP32 Device         │
│   (smart_device_mqtt)   │
└─────────────────────────┘
```

---

## MQTT Topics

Device subscribes to commands:
- `smartdevice/light/command` → `on` or `off`
- `smartdevice/motor/command` → `run` or `stop`

Device publishes status:
- `smartdevice/light/status` → `on` or `off`
- `smartdevice/motor/status` → `running` or `stopped`

---

## Troubleshooting

### ESP32 won't connect to MQTT

**Check:**
1. WiFi is connected (see Serial Monitor)
2. MQTT broker IP is correct
3. Broker is running: `mosquitto_sub -h localhost -t "smartdevice/#"`

### REST server can't reach MQTT broker

**Error:** `connect ECONNREFUSED 127.0.0.1:1883`

**Fix:** Make sure Mosquitto is running:
```bash
# macOS
brew services start mosquitto

# Linux
sudo systemctl start mosquitto
```

---

## Next Steps

- [ ] Test locally with Postman
- [ ] Deploy to Google Cloud (see DEPLOYMENT.md)
- [ ] Add authentication
- [ ] Build mobile app with BLE provisioning
