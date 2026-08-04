const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Serve UI on root for devices.* domain; otherwise respond with a simple API root message
app.get('/', (req, res) => {
  const host = (req.headers.host || '').split(':')[0] || '';
  console.log(`[HTTP] GET /  Host: ${host}`);
  try {
    if (host && host.startsWith('devices.')) {
      console.log('[HTTP] Serving UI for devices domain');
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  } catch (e) {
    console.error('[HTTP] Error while serving UI:', e.message);
    // ignore and fall through to JSON response
  }
  console.log('[HTTP] Serving API JSON at root');
  return res.json({ message: 'Smart Device REST API' });
});

// Serve static assets (JS/CSS) from /public
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// JWT Configuration
// ─────────────────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('ERROR: JWT_SECRET environment variable not set in production!');
  process.exit(1);
}

// Middleware: verify JWT token from Authorization header
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

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
 mqttClient.subscribe('device-+/light/status', (err) => {
   if (err) console.error('Failed to subscribe to light status:', err);
 });
 mqttClient.subscribe('device-+/motor/status', (err) => {
   if (err) console.error('Failed to subscribe to motor status:', err);
 });
 // Subscribe to online/offline presence (LWT)
 mqttClient.subscribe('device-+/online', (err) => {
   if (err) console.error('Failed to subscribe to online status:', err);
 });
});

mqttClient.on('message', async (topic, message) => {
 const payload = message.toString();
 console.log(`[MQTT RX] ${topic} → ${payload}`);

 // Topics: device-{id}/online  OR  device-{id}/light/status  OR  device-{id}/motor/status
 const parts = topic.split('/');
 const deviceId = parts[0];  // "device-AA:BB:CC:DD:EE:FF"

 if (!deviceState[deviceId]) deviceState[deviceId] = {};

 // Handle presence (online/offline): device-xxx/online (2 parts)
 if (parts.length === 2 && parts[1] === 'online') {
   deviceState[deviceId].online = (payload === 'online');
   if (payload === 'online') deviceState[deviceId].lastSeen = new Date().toISOString();
   console.log(`[PRESENCE] ${deviceId} is now ${payload}`);
   return;
 }

 // Status updates: device-xxx/light/status or device-xxx/motor/status (3 parts)
 if (parts.length !== 3) return;
 const type = parts[1];  // "light" or "motor"

 // Update in-memory cache
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

// Generates a short, human-friendly claim code (6 chars, no confusing chars)
function generateClaimCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0,O,1,I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

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
      let claimCode = existing[0].claim_code;
      if (!claimCode) {
        // Backfill claim code for devices registered before this feature existed
        claimCode = generateClaimCode();
        await conn.query('UPDATE devices SET claim_code = ? WHERE id = ?', [claimCode, device_id]);
      }
      conn.release();
      console.log(`[REGISTER] Device already registered: ${device_id} (claim: ${claimCode})`);
      return res.json({ registered: false, already_existed: true, device_id, claim_code: claimCode });
    }

    // Insert new device with no user (user_id = NULL, claimed later)
    const claim_code = generateClaimCode();
    await conn.query(
      'INSERT INTO devices (id, user_id, name, type, claim_code) VALUES (?, NULL, ?, ?, ?)',
      [device_id, name || device_id, 'smart_device', claim_code]
    );
    conn.release();

    console.log(`[REGISTER] New device registered: ${device_id} (claim: ${claim_code})`);
    res.json({ registered: true, already_existed: false, device_id, claim_code });
  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// POST /auth/signup — create a new user account
// body: { email: "user@example.com", password: "secret123" }
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const conn = await dbPool.getConnection();
    
    // Check if user already exists
    const existing = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      conn.release();
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password and insert user (synchronous bcryptjs)
    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await conn.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email, passwordHash]
    );
    conn.release();

    console.log(`[AUTH] New user registered: ${email}`);

    res.status(201).json({
      message: 'Account created successfully',
      user_id: result.insertId,
      email: email
    });
  } catch (err) {
    console.error('[AUTH] Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /auth/login — authenticate and get JWT token
// body: { email: "user@example.com", password: "secret123" }
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const conn = await dbPool.getConnection();
    const users = await conn.query('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
    conn.release();

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];
    const passwordMatch = bcrypt.compareSync(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token (valid for 7 days)
    const token = jwt.sign(
      { user_id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`[AUTH] User logged in: ${email}`);

    res.json({
      message: 'Login successful',
      token: token,
      user_id: user.id,
      email: user.email
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/verify — check if token is valid
app.post('/auth/verify', authMiddleware, (req, res) => {
  res.json({
    message: 'Token is valid',
    user_id: req.user.user_id,
    email: req.user.email
  });
});

// Device claiming — links a registered device to a user account
// POST /devices/claim  body: { claim_code: "ABC123" or "ABC-123" }
// Requires: Authorization: Bearer {jwt_token}
app.post('/devices/claim', authMiddleware, async (req, res) => {
  const { claim_code } = req.body;
  const user_id = req.user.user_id;
  const normalizedCode = (claim_code || '').replace(/-/g, '').toUpperCase().trim();

  if (!normalizedCode || normalizedCode.length !== 6) {
    return res.status(400).json({ error: 'claim_code must be 6 characters (e.g. "ABC123" or "ABC-123")' });
  }

  try {
    const conn = await dbPool.getConnection();
    const devices = await conn.query('SELECT * FROM devices WHERE claim_code = ?', [normalizedCode]);

    if (!devices.length) {
      conn.release();
      return res.status(404).json({ error: 'No device found with that claim code' });
    }

    const device = devices[0];
    await conn.query('UPDATE devices SET user_id = ? WHERE claim_code = ?', [user_id, normalizedCode]);
    conn.release();

    console.log(`[CLAIM] Device ${device.id} claimed by user ${user_id}`);
    res.json({ success: true, device_id: device.id, user_id: user_id });
  } catch (err) {
    console.error('[CLAIM] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// OTA Firmware Update Endpoints
// Each hardware variant has its own subfolder:
//   /firmware/penlightwaver/latest.bin
//   /firmware/tabletopwaver/latest.bin  ← future
//
// Devices send their DEVICE_TYPE in the URL path, so they never get the
// wrong firmware even if all device types are deployed at the same time.
// ─────────────────────────────────────────────────────────────────────────────

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || '/firmware';

// Firmware version is stored per device type in a versions.json file.
// Format: { "penlightwaver": 1, "tabletopwaver": 1 }
// Falls back to FIRMWARE_VERSION env var for backward compat.
function getFirmwareVersion(deviceType) {
  const versionsPath = path.join(FIRMWARE_DIR, 'versions.json');
  if (fs.existsSync(versionsPath)) {
    try {
      const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
      if (versions[deviceType] !== undefined) return versions[deviceType];
    } catch (e) { /* fall through */ }
  }
  return parseInt(process.env.FIRMWARE_VERSION || '1');
}

// GET /firmware/:deviceType/version — device checks this on every boot
// e.g. GET /firmware/penlightwaver/version  →  {"version": 2}
app.get('/firmware/:deviceType/version', (req, res) => {
  const { deviceType } = req.params;
  const version = getFirmwareVersion(deviceType);
  console.log(`[OTA] Version check: ${deviceType} → v${version}`);
  res.json({ version });
});

// GET /firmware/:deviceType/latest.bin — device downloads new firmware here
app.get('/firmware/:deviceType/latest.bin', (req, res) => {
  const { deviceType } = req.params;
  const binPath = path.join(FIRMWARE_DIR, deviceType, 'latest.bin');
  if (!fs.existsSync(binPath)) {
    console.error(`[OTA] Firmware not found: ${binPath}`);
    return res.status(404).json({ error: `No firmware found for device type: ${deviceType}` });
  }
  console.log(`[OTA] Serving firmware to ${deviceType} device`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(binPath);
});

// GET /firmware/info — human-readable status for all device types
app.get('/firmware/info', (req, res) => {
  const versionsPath = path.join(FIRMWARE_DIR, 'versions.json');
  let versions = {};
  if (fs.existsSync(versionsPath)) {
    try { versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8')); } catch (e) {}
  }

  const deviceTypes = fs.existsSync(FIRMWARE_DIR)
    ? fs.readdirSync(FIRMWARE_DIR).filter(f =>
        fs.statSync(path.join(FIRMWARE_DIR, f)).isDirectory())
    : [];

  const info = deviceTypes.map(dt => {
    const binPath = path.join(FIRMWARE_DIR, dt, 'latest.bin');
    const exists = fs.existsSync(binPath);
    return {
      device_type: dt,
      version: versions[dt] ?? null,
      firmware_file_exists: exists,
      firmware_size_bytes: exists ? fs.statSync(binPath).size : null
    };
  });

  res.json({ firmware_dir: FIRMWARE_DIR, device_types: info });
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
    
   const topic = `${deviceId}/light/command`;
    
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
    
   const topic = `${deviceId}/light/command`;
    
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
    
   const topic = `${deviceId}/motor/command`;
    
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
    
   const topic = `${deviceId}/motor/command`;
    
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
 console.log(`\n  Authentication:`);
 console.log(`  POST   /auth/signup                           (body: {email, password})`);
 console.log(`  POST   /auth/login                            (body: {email, password})`);
 console.log(`  POST   /auth/verify                           (requires auth header)`);
 console.log(`\n  Device Management:`);
 console.log(`  GET    /health`);
 console.log(`  GET    /devices/:deviceId/status              (requires auth)`);
 console.log(`  POST   /devices/:deviceId/light/on            (requires auth)`);
 console.log(`  POST   /devices/:deviceId/light/off           (requires auth)`);
 console.log(`  GET    /devices/:deviceId/light/status        (requires auth)`);
 console.log(`  POST   /devices/:deviceId/motor/run           (requires auth)`);
 console.log(`  POST   /devices/:deviceId/motor/stop          (requires auth)`);
 console.log(`  GET    /devices/:deviceId/motor/status        (requires auth)`);
 console.log(`  POST   /devices/claim                         (body: {claim_code}, requires auth)`);
 console.log(`\n  Firmware Updates:`);
 console.log(`  GET    /firmware/penlightwaver/version`);
 console.log(`  GET    /firmware/penlightwaver/latest.bin`);
 console.log(`  GET    /firmware/info\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
 console.log('\nShutting down...');
 mqttClient.end();
 process.exit(0);
});
