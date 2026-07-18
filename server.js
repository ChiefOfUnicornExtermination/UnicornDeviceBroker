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
 queueLimit: 0,
 enableKeepAlive: true,
 idleTimeout: 60000
});

// Test database connection at startup
async function testDatabase() {
 try {
   const conn = await dbPool.getConnection();
   await conn.query('SELECT 1');
   conn.release();
   console.log('✓ Database connected successfully');
 } catch (err) {
   console.error('✗ DATABASE CONNECTION FAILED:', err.message);
   console.error('  DB_HOST=' + (process.env.DB_HOST || 'localhost'));
   console.error('  DB_USER=' + (process.env.DB_USER || 'smartdevice'));
   console.error('  Ensure MariaDB/MySQL is running and accessible');
   // Don't exit—let server try to start anyway, healthcheck will show status
 }
}

setTimeout(() => testDatabase(), 1000);

// ─────────────────────────────────────────────────────────────────────────────
// MQTT Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_CLIENT_ID = 'rest-bridge-' + Math.random().toString(16).substr(2, 8);

// ─────────────────────────────────────────────────────────────────────────────
// Device State (in-memory cache per device)
// ─────────────────────────────────────────────────────────────────────────────

const deviceState = {}; // { "device-AA:BB:CC:DD:EE:FF": { light: "off", motor: "stopped", online: false, lastSeen: null } }

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
  
 // Subscribe to all device status topics
 mqttClient.subscribe('user-+/device-+/light/status', (err) => {
   if (err) console.error('Failed to subscribe to light status:', err);
 });
 mqttClient.subscribe('user-+/device-+/motor/status', (err) => {
   if (err) console.error('Failed to subscribe to motor status:', err);
 });
 // Subscribe to online/offline presence (LWT)
 mqttClient.subscribe('user-+/device-+/online', (err) => {
   if (err) console.error('Failed to subscribe to online status:', err);
 });
});

mqttClient.on('message', async (topic, message) => {
 const payload = message.toString();
 console.log(`[MQTT RX] ${topic} → ${payload}`);
  
 // Parse topic: user-{userId}/device-{deviceId}/{type}
 const parts = topic.split('/');
 if (parts.length !== 4) return;

 const deviceId = parts[1];  // "device-AA:BB:CC:DD:EE:FF"
 const type = parts[2];      // "light", "motor", or "online"

 if (!deviceState[deviceId]) deviceState[deviceId] = {};

 // Handle presence (online/offline)
 if (type === 'online') {
   deviceState[deviceId].online = (payload === 'online');
   deviceState[deviceId].lastSeen = payload === 'online' ? new Date().toISOString() : deviceState[deviceId].lastSeen;
   console.log(`[PRESENCE] ${deviceId} is now ${payload}`);
   return;
 }

 // Update in-memory cache for light/motor
 deviceState[deviceId][type] = payload;
 deviceState[deviceId].lastSeen = new Date().toISOString();

 // Resolve any pending waiters for this device/type
 try {
   const key = `${deviceId}:${type}`;
   const waiters = pendingStatusWaiters.get(key) || [];
   for (const w of waiters.slice()) {
     if (!w) continue;
     if (w.expected === null || String(w.expected) === String(payload)) {
       clearTimeout(w.timeoutId);
       try { w.resolve(payload); } catch (_) {}
       const arr = pendingStatusWaiters.get(key) || [];
       const idx = arr.indexOf(w);
       if (idx !== -1) arr.splice(idx, 1);
     }
   }
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

// Diagnostic endpoint - test database connection directly
app.get('/debug/db-test', async (req, res) => {
  const result = {
    config: {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'smartdevice',
      database: 'smartdevice'
    },
    connection: null,
    query_test: null,
    devices: null,
    error: null
  };

  try {
    console.log('[DEBUG] Testing database connection to', result.config.host);
    const conn = await dbPool.getConnection();
    result.connection = 'success';
    
    const [row] = await conn.query('SELECT 1 as test, NOW() as time');
    result.query_test = row;

    // Show all devices so we can verify what's actually in the DB
    result.devices = await conn.query('SELECT * FROM devices');
    conn.release();
  } catch (err) {
    result.error = err.message;
    result.error_code = err.code;
  }

  res.json(result);
});

// Device self-registration — called by device on every boot after WiFi connects
// Safe to call multiple times — idempotent (won't create duplicates)
app.post('/devices/register', async (req, res) => {
  const { device_id, name } = req.body;

  if (!device_id) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const conn = await dbPool.getConnection();

    // Check if already registered
    const existing = await conn.query(
      'SELECT * FROM devices WHERE id = ?',
      [device_id]
    );

    if (existing.length > 0) {
      conn.release();
      console.log(`[REGISTER] Device already registered: ${device_id}`);
      return res.json({ registered: false, already_existed: true, device_id });
    }

    // Insert new device with no user (user_id = NULL, claimed later)
    await conn.query(
      'INSERT INTO devices (id, user_id, name, type) VALUES (?, NULL, ?, ?)',
      [device_id, name || device_id, 'smart_device']
    );
    conn.release();

    console.log(`[REGISTER] New device registered: ${device_id}`);
    res.json({ registered: true, already_existed: false, device_id });
  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/health', async (req, res) => {
 let dbStatus = 'ok';
 let dbError = null;
 try {
   const conn = await dbPool.getConnection();
   await conn.query('SELECT 1');
   conn.release();
 } catch (err) {
   dbStatus = 'error';
   dbError = err.message;
 }
  
 res.json({
   status: 'ok',
   mqtt: MQTT_HOST + ':' + MQTT_PORT,
   database: dbStatus,
   database_error: dbError
 });
});

// Get device status
app.get('/devices/:deviceId/status', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const device = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const state = deviceState[deviceId] || {};
   res.json({
     device_id: deviceId,
     device_name: device[0].name,
     online: state.online === true,
     light: state.light || 'unknown',
     motor: state.motor || 'unknown',
     last_seen: state.lastSeen || null,
     timestamp: new Date().toISOString()
   });
 } catch (err) {
   res.status(500).json({ error: err.message });
 }
});

// ─── Light Control ─────────────────────────────────────────────

app.post('/devices/:deviceId/light/on', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const device = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/light/command`;
    
   console.log(`[API] POST /devices/${deviceId}/light/on → publishing to ${topic}`);
   mqttClient.publish(topic, 'on', async (err) => {
     if (err) {
       return res.status(500).json({ error: 'Failed to publish MQTT message' });
     }
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

app.post('/devices/:deviceId/light/off', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const device = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/light/command`;
    
   console.log(`[API] POST /devices/${deviceId}/light/off → publishing to ${topic}`);
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

app.get('/devices/:deviceId/light/status', async (req, res) => {
 const { deviceId } = req.params;
 const state = deviceState[deviceId] || {};
 res.json({ device_id: deviceId, light: state.light || 'unknown' });
});

// ─── Motor Control ─────────────────────────────────────────────

app.post('/devices/:deviceId/motor/run', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const device = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/motor/command`;
    
   console.log(`[API] POST /devices/${deviceId}/motor/run → publishing to ${topic}`);
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

app.post('/devices/:deviceId/motor/stop', async (req, res) => {
 const { deviceId } = req.params;
  
 try {
   const conn = await dbPool.getConnection();
   const device = await conn.query(
     'SELECT * FROM devices WHERE id = ?',
     [deviceId]
   );
   conn.release();
    
   if (!device.length) {
     return res.status(404).json({ error: 'Device not found' });
   }
    
   const userId = device[0].user_id;
   const topic = `user-${userId}/${deviceId}/motor/command`;
    
   console.log(`[API] POST /devices/${deviceId}/motor/stop → publishing to ${topic}`);
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

app.get('/devices/:deviceId/motor/status', async (req, res) => {
 const { deviceId } = req.params;
 const state = deviceState[deviceId] || {};
 res.json({ device_id: deviceId, motor: state.motor || 'unknown' });
});

// Legacy single-device endpoints (REMOVED - use /devices/{deviceId}/* instead)

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
 console.log(`\nAPI Endpoints:`);
 console.log(`  GET    https://api.unicornextermination.info/health`);
 console.log(`  GET    https://api.unicornextermination.info/devices/:deviceId/status`);
 console.log(`  POST   https://api.unicornextermination.info/devices/:deviceId/light/on?wait=1`);
 console.log(`  POST   https://api.unicornextermination.info/devices/:deviceId/light/off?wait=1`);
 console.log(`  GET    https://api.unicornextermination.info/devices/:deviceId/light/status`);
 console.log(`  POST   https://api.unicornextermination.info/devices/:deviceId/motor/run?wait=1`);
 console.log(`  POST   https://api.unicornextermination.info/devices/:deviceId/motor/stop?wait=1`);
 console.log(`  GET    https://api.unicornextermination.info/devices/:deviceId/motor/status\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
 console.log('\nShutting down...');
 mqttClient.end();
 process.exit(0);
});
