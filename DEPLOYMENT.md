# Deployment Guide

## Architecture

```
User (Postman/App)
  ↓ HTTP/REST
Google Cloud Run (server.js)
  ↓ MQTT Publish/Subscribe
MQTT Broker (Mosquitto on Cloud Compute Engine)
  ↓ MQTT
ESP32 Device (firmware)
```

---

## Step 1: Set Up MQTT Broker on Google Cloud Compute Engine

### 1.1 Create a Compute Engine Instance

```bash
gcloud compute instances create mqtt-broker \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-11 \
  --image-project=debian-cloud
```

### 1.2 SSH into the instance

```bash
gcloud compute ssh mqtt-broker --zone=us-central1-a
```

### 1.3 Install Mosquitto MQTT Broker

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients

# Start the broker
sudo systemctl start mosquitto
sudo systemctl enable mosquitto

# Check status
sudo systemctl status mosquitto
```

### 1.4 Configure Firewall

```bash
gcloud compute firewall-rules create allow-mqtt \
  --allow=tcp:1883 \
  --source-ranges=0.0.0.0/0 \
  --description="Allow MQTT connections"
```

### 1.5 Get the instance's external IP

```bash
gcloud compute instances describe mqtt-broker --zone=us-central1-a | grep natIP
```

Write down this IP, e.g., `35.xxx.xxx.xxx` — this is your `MQTT_BROKER`.

---

## Step 2: Deploy REST Server to Google Cloud Run

### 2.1 Authenticate with Google Cloud

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 2.2 Update MQTT broker address

Edit `.env`:
```
MQTT_BROKER=mqtt://35.xxx.xxx.xxx:1883
PORT=8080
```

### 2.3 Deploy to Cloud Run

```bash
cd server/

# Create .dockerignore (optional but recommended)
echo "node_modules" > .dockerignore

# Deploy
gcloud run deploy smart-device-server \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

The output will show your Cloud Run URL:
```
Service URL: https://smart-device-server-xxxxx.a.run.app
```

### 2.4 Test the REST API

```bash
# Replace with your actual URL
curl https://smart-device-server-xxxxx.a.run.app/health
```

You should get:
```json
{"status":"ok","broker":"mqtt://35.xxx.xxx.xxx:1883"}
```

---

## Step 3: Update ESP32 Firmware

Use the MQTT firmware provided in `firmware_mqtt.ino`.

Key things to update:
```cpp
const char* WIFI_SSID = "Your_2.4GHz_WiFi";
const char* WIFI_PASSWORD = "Your_Password";
const char* MQTT_BROKER = "mqtt://35.xxx.xxx.xxx";  // Your Compute Engine IP
```

Then upload to ESP32 as usual.

---

## Step 4: Test End-to-End

### 4.1 Test with Postman

1. Open Postman
2. Create a new POST request to: `https://smart-device-server-xxxxx.a.run.app/light/on`
3. Send → ESP32's LED should turn on
4. Check logs: `gcloud run logs read smart-device-server`

### 4.2 Monitor MQTT messages (optional)

From your Compute Engine instance:
```bash
# Subscribe to all smartdevice topics
mosquitto_sub -h localhost -t "smartdevice/#"
```

---

## Step 5: OTA Firmware Updates

### 5.1 How it works

Every time the ESP32 boots and connects to WiFi, it calls:
```
GET https://api.unicornextermination.info/firmware/version
```
Response: `{"version": 2}`

If the server version is higher than the number in `FIRMWARE_VERSION` constant in the firmware,
the device automatically downloads and flashes the new firmware:
```
GET https://api.unicornextermination.info/firmware/latest.bin
```
Then reboots. No USB cable needed.

### 5.2 Workflow to release a firmware update

**Step 1: Compile the new firmware in Arduino IDE**
1. Open Arduino IDE
2. Increase `FIRMWARE_VERSION` number (e.g. 1 → 2)
3. Click: `Sketch` → `Export Compiled Binary`
4. This creates a `.bin` file in your sketch folder
   (e.g. `smart_device.ino.bin`)

**Step 2: Upload the .bin file to Cloud Run**

Option A — Upload directly to the running container (quick test):
```bash
# Copy the .bin file into the running container
gcloud run services describe smart-device-server --format='value(status.url)'
# Then use Cloud Run SSH or rebuild (Option B is cleaner)
```

Option B — Rebuild and redeploy with firmware included (recommended):
```bash
# Copy your compiled .bin into the server folder
cp path/to/smart_device.ino.bin server/firmware_files/latest.bin

# Update the version number in Dockerfile (or use env var)
# ENV FIRMWARE_VERSION=2

# Redeploy
cd server/
gcloud run deploy smart-device-server \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars FIRMWARE_VERSION=2
```

**Step 3: Verify the update was uploaded**
```bash
curl https://api.unicornextermination.info/firmware/info
```
Expected:
```json
{
  "current_version": 2,
  "firmware_file_exists": true,
  "firmware_path": "/firmware/latest.bin",
  "firmware_size_bytes": 847362
}
```

**Step 4: Test on one device first**
- Reset your ESP32
- Watch Serial Monitor — you should see:
  ```
  [OTA] Checking for firmware update...
  [OTA] Current version: 1
  [OTA] Server version: 2
  [OTA] Update available! Downloading v2...
  [OTA] Update successful! Rebooting...
  ```
- After reboot, Serial Monitor shows version 2

### 5.3 Store .bin files properly for Cloud Run

Cloud Run containers are stateless — files you copy in won't survive a restart.
Best practice: store `.bin` files inside the Docker image itself.

Create this folder structure:
```
server/
  server.js
  Dockerfile
  package.json
  firmware_files/
    latest.bin    ← compiled from Arduino IDE
```

Update Dockerfile to copy firmware files:
```dockerfile
# Copy firmware files for OTA
COPY firmware_files/ /firmware/
```

Then the `.bin` file is baked into the container image and survives restarts.

### 5.4 Environment variables for Cloud Run

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRMWARE_VERSION` | `1` | Version number to report to devices |
| `FIRMWARE_DIR` | `/firmware` | Where `.bin` files are stored |

Update version when deploying:
```bash
gcloud run deploy smart-device-server \
  --set-env-vars FIRMWARE_VERSION=2
```

---

## Troubleshooting

### ESP32 can't connect to MQTT broker

- Check firewall: `gcloud compute firewall-rules list`
- Check Mosquitto: `sudo systemctl status mosquitto` on the instance
- Try test connection: `telnet 35.xxx.xxx.xxx 1883`

### Cloud Run service times out

- Check MQTT_BROKER environment variable in Cloud Run settings
- Check logs: `gcloud run logs read smart-device-server`

### OTA update fails

- Check `/firmware/info` endpoint — is `firmware_file_exists: true`?
- Check device serial log for the exact error message
- Make sure FIRMWARE_VERSION env var on server > version compiled into device

### Domain mapping (optional)

Once working, map your domain (unicornextermination.info) to Cloud Run:
```bash
gcloud run domain-mappings create \
  --service smart-device-server \
  --domain unicornextermination.info \
  --platform managed \
  --region us-central1
```

Then configure DNS CNAME with your domain registrar.

---

## Cost Estimate (Google Cloud)

- **Compute Engine** (mqtt-broker): ~$5-10/month (e2-micro)
- **Cloud Run**: Free tier (2 million requests/month, includes this project)
- **Total**: ~$5-10/month

---

## Next Steps

Once this is working:
1. Add authentication (OAuth or API keys)
2. Build a mobile app with Bluetooth provisioning
3. Add database to store device history

