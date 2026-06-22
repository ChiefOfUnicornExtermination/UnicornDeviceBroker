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

## Troubleshooting

### ESP32 can't connect to MQTT broker

- Check firewall: `gcloud compute firewall-rules list`
- Check Mosquitto: `sudo systemctl status mosquitto` on the instance
- Try test connection: `telnet 35.xxx.xxx.xxx 1883`

### Cloud Run service times out

- Check MQTT_BROKER environment variable in Cloud Run settings
- Check logs: `gcloud run logs read smart-device-server`

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
