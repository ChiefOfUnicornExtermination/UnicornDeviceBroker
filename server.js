const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const mariadb = require('mariadb');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// Database Configuration
// ─────────────────────────────────────────────────────────────────────────────

const dbPool = mariadb.createPool({
 host: process.env.DB_HOST || 'localhost',
 user: process.env.DB_USER || 'smartdevice',
 password: process.env.DB_PASSWORD || 'password',
 database: 'smartdevice',
 waitForConnections: true,
 connectionLimit: 10,
 queueLimit: 0
});

// ─────────────────────────────────────────────────────────────────────────────
// MQTT Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_CLIENT_ID = 'rest-bridge-' + Math.random().toString(16).substr(2, 8);

// ─────────────────────────────────────────────────────────────────────────────
// Device State (in-memory cache per device)
// ─────────────────────────────────────────────────────────────────────────────

const deviceState = {}; // { "device-AA:BB:CC:DD:EE:FF": { light: "off", motor: "stopped" } }

// Pending waiters for command confirmation: key => [{ expected, resolve, reject, timeoutId }, ...]
const pendingStatusWaiters = new Map();

function waitForStatus(deviceId, type, expectedValue, timeoutMs = 5000) {
  const key = `${deviceId}:${type}`;
  return new Promise((resolve, reject) => {
    const entry = { expected: expectedValue, resolve, reject };
    if (!pendingStatusWaiters.has(key)) pendingStatusWaiters.set(key, []);
    pendingStatusWaiters.get(key).push(entry);

    // timeout
    entry.timeoutId = setTimeout(() => {
      // remove from array
      const arr = pendingStatusWaiters.get(key) || [];
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) pendingStatusWaiters.delete(key);
      reject(new Error('timeout waiting for device status'));
    }, timeoutMs);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// MQTT Client Setup
// ─────────────────────────────────────────────────────────────────────────────

const mqttOptions = {
 protocol: 'mqtt',
 host: MQTT_HOST,
 port: MQTT_PORT,
 clientId: MQTT_CLIENT_ID,
 clean: true,
 connectTimeout: 4000,
 reconnectPeriod: 1000,
 family: 4,  // Force IPv4
};

const mqttClient = mqtt.connect(mqttOptions);

mqttClient.on('connect', () => {
 console.log('✓ Connected to MQTT broker');
  
 // Subscribe to all device status topics (user-+/device-+/light/status, etc.)
 mqttClient.subscribe('user-+/device-+/light/status', (err) => {
   if (err) console.error('Failed to subscribe to light status:', err);
 });
  
 mqttClient.subscribe('user-+/device-+/motor/status', (err) => {
   if (err) console.error('Failed to subscribe to motor status:', err);
 });
});

mqttClient.on('message', async (topic, message) => {
 const payload = message.toString();
 console.log(`[MQTT RX] ${topic} → ${payload}`);
  
 // Parse topic: user-{userId}/device-{deviceId}/light/status
 const parts = topic.split('/');
 if (parts.length === 4) {
   const userDevicePart = parts[0]; // "user-123"
   const devicePart = parts[1];      // "device-abc"
   const type = parts[2];            // "light" or "motor"
    
   const deviceId = `${devicePart}`;
    
 // Update in-memory cache
   if (!deviceState[deviceId]) {
     deviceState[deviceId] = {};
   }
   deviceState[deviceId][type] = payload;

   // Resolve any pending waiters for this device/type
   try {
     const key = `${deviceId}:${type}`;
     const waiters = pendingStatusWaiters.get(key) || [];
     for (const w of waiters.slice()) {
       if (!w) continue;
       if (w.expected === null || String(w.expected) === String(payload)) {
         clearTimeout(w.timeoutId);
         try { w.resolve(payload); } catch (_) {}
         // remove from array
         const arr = pendingStatusWaiters.get(key) || [];
         const idx = arr.indexOf(w);
         if (idx !== -1) arr.splice(idx, 1);
       }
     }
     // cleanup empty
     if (pendingStatusWaiters.has(key) && pendingStatusWaiters.get(key).length === 0) {
       pendingStatusWaiters.delete(key);
     }
   } catch (e) {
     console.error('Error resolving waiters:', e.message);
   }
    
   // Log to database
   try {
     const conn = await dbPool.getConnection();
     await conn.query(
       'INSERT INTO device_logs (device_id, action) VALUES (?, ?)',
       [deviceId, `${type}_${payload}`]
     );
     conn.release();
   } catch (err) {
     console.error('Failed to log device action:', err.message);
   }
 }
});

mqttClient.on('error', (err) => {
 console.error('MQTT error:', err.message);
});

mqttClient.on('disconnect', () => {
 console.log('✗ Disconnected from MQTT broker');
});

// ─────────────────────────────────────────────────────────────────────────────
// REST API Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
 res.json({ status: 'ok', broker: `${MQTT_HOST}:${MQTT_PORT}` });
});

// Get device status (multi-device)
app.get('/api/devices/:deviceId/status', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const [device] = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const state = deviceState[deviceId] || { light: 'unknown', motor: 'unknown' };
   res.json({
     device_id: deviceId,
     device_name: device[0].name,
     light: state.light || 'unknown',
     motor: state.motor || 'unknown',
     timestamp: new Date().toISOString()
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// ─── Light Control (Multi-device) ─────────────────────────────────────────────

app.post('/api/devices/:deviceId/light/on', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const [device] = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/light/command`;
    
   console.log(`[API] POST /api/devices/${deviceId}/light/on → publishing to ${topic}`);
   mqttClient.publish(topic, 'on', async (err) => {
     if (err) {
       return res.status(500).json({ error: 'Failed to publish MQTT message' });
     }
     // If caller asked to wait for confirmation
     const wait = (req.query.wait === '1') || (req.body && req.body.wait === true);
     const timeoutMs = (req.body && req.body.timeout) || 5000;
     if (wait) {
       try {
         const val = await waitForStatus(deviceId, 'light', 'on', timeoutMs);
         return res.json({ status: 'ok', device_id: deviceId, light: String(val) });
       } catch (e) {
         return res.status(504).json({ error: 'timeout waiting for device', details: e.message });
       }
     }

     deviceState[deviceId] = deviceState[deviceId] || {};
     deviceState[deviceId].light = 'on';
     res.json({ status: 'ok', device_id: deviceId, light: 'on' });
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

app.post('/api/devices/:deviceId/light/off', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const [device] = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/light/command`;
    
   console.log(`[API] POST /api/devices/${deviceId}/light/off → publishing to ${topic}`);
   mqttClient.publish(topic, 'off', async (err) => {
     if (err) {
       return res.status(500).json({ error: 'Failed to publish MQTT message' });
     }
     const wait = (req.query.wait === '1') || (req.body && req.body.wait === true);
     const timeoutMs = (req.body && req.body.timeout) || 5000;
     if (wait) {
       try {
         const val = await waitForStatus(deviceId, 'light', 'off', timeoutMs);
         return res.json({ status: 'ok', device_id: deviceId, light: String(val) });
       } catch (e) {
         return res.status(504).json({ error: 'timeout waiting for device', details: e.message });
       }
     }

     deviceState[deviceId] = deviceState[deviceId] || {};
     deviceState[deviceId].light = 'off';
     res.json({ status: 'ok', device_id: deviceId, light: 'off' });
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

app.get('/api/devices/:deviceId/light/status', async (req, res) => {
 const { deviceId } = req.params;
 const state = deviceState[deviceId] || {};
 res.json({ device_id: deviceId, light: state.light || 'unknown' });
});

// ─── Motor Control (Multi-device) ─────────────────────────────────────────────

app.post('/api/devices/:deviceId/motor/run', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const [device] = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/motor/command`;
    
   console.log(`[API] POST /api/devices/${deviceId}/motor/run → publishing to ${topic}`);
   mqttClient.publish(topic, 'run', async (err) => {
     if (err) {
       return res.status(500).json({ error: 'Failed to publish MQTT message' });
     }
     const wait = (req.query.wait === '1') || (req.body && req.body.wait === true);
     const timeoutMs = (req.body && req.body.timeout) || 5000;
     if (wait) {
       try {
         const val = await waitForStatus(deviceId, 'motor', 'running', timeoutMs);
         return res.json({ status: 'ok', device_id: deviceId, motor: String(val) });
       } catch (e) {
         return res.status(504).json({ error: 'timeout waiting for device', details: e.message });
       }
     }

     deviceState[deviceId] = deviceState[deviceId] || {};
     deviceState[deviceId].motor = 'running';
     res.json({ status: 'ok', device_id: deviceId, motor: 'running' });
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

app.post('/api/devices/:deviceId/motor/stop', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const [device] = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/motor/command`;
    
   console.log(`[API] POST /api/devices/${deviceId}/motor/stop → publishing to ${topic}`);
   mqttClient.publish(topic, 'stop', async (err) => {
     if (err) {
       return res.status(500).json({ error: 'Failed to publish MQTT message' });
     }
     const wait = (req.query.wait === '1') || (req.body && req.body.wait === true);
     const timeoutMs = (req.body && req.body.timeout) || 5000;
     if (wait) {
       try {
         const val = await waitForStatus(deviceId, 'motor', 'stopped', timeoutMs);
         return res.json({ status: 'ok', device_id: deviceId, motor: String(val) });
       } catch (e) {
         return res.status(504).json({ error: 'timeout waiting for device', details: e.message });
       }
     }

     deviceState[deviceId] = deviceState[deviceId] || {};
     deviceState[deviceId].motor = 'stopped';
     res.json({ status: 'ok', device_id: deviceId, motor: 'stopped' });
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

app.get('/api/devices/:deviceId/motor/status', async (req, res) => {
 const { deviceId } = req.params;
 const state = deviceState[deviceId] || {};
 res.json({ device_id: deviceId, motor: state.motor || 'unknown' });
});

// Legacy single-device endpoints (deprecated, for backward compatibility)
app.post('/light/on', async (req, res) => {
 const topic = 'user-1/device-esp32/light/command';
 console.log('[API] POST /light/on (legacy)');
 mqttClient.publish(topic, 'on', (err) => {
   if (err) return res.status(500).json({ error: 'MQTT failed' });
   res.json({ status: 'ok', light: 'on' });
 });
});

app.post('/light/off', async (req, res) => {
 const topic = 'user-1/device-esp32/light/command';
 console.log('[API] POST /light/off (legacy)');
 mqttClient.publish(topic, 'off', (err) => {
   if (err) return res.status(500).json({ error: 'MQTT failed' });
   res.json({ status: 'ok', light: 'off' });
 });
});

app.post('/motor/run', async (req, res) => {
 const topic = 'user-1/device-esp32/motor/command';
 console.log('[API] POST /motor/run (legacy)');
 mqttClient.publish(topic, 'run', (err) => {
   if (err) return res.status(500).json({ error: 'MQTT failed' });
   res.json({ status: 'ok', motor: 'running' });
 });
});

app.post('/motor/stop', async (req, res) => {
 const topic = 'user-1/device-esp32/motor/command';
 console.log('[API] POST /motor/stop (legacy)');
 mqttClient.publish(topic, 'stop', (err) => {
   if (err) return res.status(500).json({ error: 'MQTT failed' });
   res.json({ status: 'ok', motor: 'stopped' });
 });
});

app.get('/status', async (req, res) => {
 const state = deviceState['device-esp32'] || {};
 res.json({
   device: 'smart_device',
   light: state.light || 'unknown',
   motor: state.motor || 'unknown'
 });
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
 console.log(`\n--- Smart Device REST-MQTT Bridge (Multi-Device) ---`);
 console.log(`🚀 REST Server listening on port ${PORT}`);
 console.log(`📡 MQTT Broker: ${MQTT_HOST}:${MQTT_PORT}`);
 console.log(`🗄️  Database: ${process.env.DB_HOST || 'localhost'}`);
 console.log(`\nAPI Endpoints (Multi-Device):`);
 console.log(`  GET    http://localhost:${PORT}/health`);
 console.log(`  GET    http://localhost:${PORT}/api/devices/:deviceId/status`);
 console.log(`  POST   http://localhost:${PORT}/api/devices/:deviceId/light/on`);
 console.log(`  POST   http://localhost:${PORT}/api/devices/:deviceId/light/off`);
 console.log(`  GET    http://localhost:${PORT}/api/devices/:deviceId/light/status`);
 console.log(`  POST   http://localhost:${PORT}/api/devices/:deviceId/motor/run`);
 console.log(`  POST   http://localhost:${PORT}/api/devices/:deviceId/motor/stop`);
 console.log(`  GET    http://localhost:${PORT}/api/devices/:deviceId/motor/status\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
 console.log('\nShutting down...');
 mqttClient.end();
 process.exit(0);
});
