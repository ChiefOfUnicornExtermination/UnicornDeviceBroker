const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// MQTT Configuration
// ─────────────────────────────────────────────────────────────────────────────

// For local testing, use: mqtt://localhost:1883
// For Google Cloud, we'll set up a managed broker (see DEPLOYMENT.md)
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const MQTT_CLIENT_ID = 'rest-bridge-' + Math.random().toString(16).substr(2, 8);

// ─────────────────────────────────────────────────────────────────────────────
// Device State (in-memory cache)
// ─────────────────────────────────────────────────────────────────────────────

const deviceState = {
  light: 'off',
  motor: 'stopped'
};

// ─────────────────────────────────────────────────────────────────────────────
// MQTT Client Setup
// ─────────────────────────────────────────────────────────────────────────────

const mqttOptions = {
  clientId: MQTT_CLIENT_ID,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
};

const client = mqtt.connect(MQTT_BROKER, mqttOptions);

client.on('connect', () => {
  console.log('✓ Connected to MQTT broker');
  
  // Subscribe to device status updates
  client.subscribe('smartdevice/light/status', (err) => {
    if (err) console.error('Failed to subscribe to light/status:', err);
  });
  
  client.subscribe('smartdevice/motor/status', (err) => {
    if (err) console.error('Failed to subscribe to motor/status:', err);
  });
});

client.on('message', (topic, message) => {
  const payload = message.toString();
  console.log(`[MQTT RX] ${topic} → ${payload}`);
  
  if (topic === 'smartdevice/light/status') {
    deviceState.light = payload;
  } else if (topic === 'smartdevice/motor/status') {
    deviceState.motor = payload;
  }
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
});

client.on('disconnect', () => {
  console.log('✗ Disconnected from MQTT broker');
});

// ─────────────────────────────────────────────────────────────────────────────
// REST API Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', broker: MQTT_BROKER });
});

// Get all device status
app.get('/status', (req, res) => {
  res.json({
    device: 'smart_device',
    light: deviceState.light,
    motor: deviceState.motor,
    timestamp: new Date().toISOString()
  });
});

// ─── Light Control ────────────────────────────────────────────────────────────

app.post('/light/on', (req, res) => {
  console.log('[API] POST /light/on');
  client.publish('smartdevice/light/command', 'on', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to publish MQTT message' });
    }
    deviceState.light = 'on';
    res.json({ status: 'ok', light: 'on' });
  });
});

app.post('/light/off', (req, res) => {
  console.log('[API] POST /light/off');
  client.publish('smartdevice/light/command', 'off', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to publish MQTT message' });
    }
    deviceState.light = 'off';
    res.json({ status: 'ok', light: 'off' });
  });
});

app.get('/light/status', (req, res) => {
  res.json({ light: deviceState.light });
});

// ─── Motor Control ────────────────────────────────────────────────────────────

app.post('/motor/run', (req, res) => {
  console.log('[API] POST /motor/run');
  client.publish('smartdevice/motor/command', 'run', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to publish MQTT message' });
    }
    deviceState.motor = 'running';
    res.json({ status: 'ok', motor: 'running' });
  });
});

app.post('/motor/stop', (req, res) => {
  console.log('[API] POST /motor/stop');
  client.publish('smartdevice/motor/command', 'stop', (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to publish MQTT message' });
    }
    deviceState.motor = 'stopped';
    res.json({ status: 'ok', motor: 'stopped' });
  });
});

app.get('/motor/status', (req, res) => {
  res.json({ motor: deviceState.motor });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'endpoint not found' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server Start
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n--- Smart Device REST-MQTT Bridge ---`);
  console.log(`🚀 REST Server listening on port ${PORT}`);
  console.log(`📡 MQTT Broker: ${MQTT_BROKER}`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  POST   http://localhost:${PORT}/light/on`);
  console.log(`  POST   http://localhost:${PORT}/light/off`);
  console.log(`  GET    http://localhost:${PORT}/light/status`);
  console.log(`  POST   http://localhost:${PORT}/motor/run`);
  console.log(`  POST   http://localhost:${PORT}/motor/stop`);
  console.log(`  GET    http://localhost:${PORT}/motor/status`);
  console.log(`  GET    http://localhost:${PORT}/status`);
  console.log(`  GET    http://localhost:${PORT}/health\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  client.end();
  process.exit(0);
});
