const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// JWT Configuration
// ─────────────────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('ERROR: JWT_SECRET environment variable not set in production!');
  process.exit(1);
}

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
// Database
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

async function testDatabase() {
  try {
    const conn = await dbPool.getConnection();
    await conn.query('SELECT 1');
    conn.release();
    console.log('✓ Database connected successfully');
  } catch (err) {
    console.error('✗ DATABASE CONNECTION FAILED:', err.message);
  }
}
setTimeout(() => testDatabase(), 1000);

async function ensureProvisionTable() {
  try {
    const conn = await dbPool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS provision_sessions (
        id VARCHAR(36) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        claimed_device_id VARCHAR(64) DEFAULT NULL,
        status ENUM('active','claimed','expired') DEFAULT 'active',
        INDEX (status),
        INDEX (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    conn.release();
    console.log('✓ provision_sessions table ready');
  } catch (err) {
    console.error('Failed to ensure provision_sessions table:', err.message);
  }
}
setTimeout(() => ensureProvisionTable(), 1500);

// ─────────────────────────────────────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────────────────────────────────────

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_CLIENT_ID = 'rest-bridge-' + Math.random().toString(16).substr(2, 8);

const deviceState = {};
const pendingStatusWaiters = new Map();

function waitForStatus(deviceId, type, expectedValue, timeoutMs = 5000) {
  const key = `${deviceId}:${type}`;
  return new Promise((resolve, reject) => {
    const entry = { expected: expectedValue, resolve, reject };
    if (!pendingStatusWaiters.has(key)) pendingStatusWaiters.set(key, []);
    pendingStatusWaiters.get(key).push(entry);
    entry.timeoutId = setTimeout(() => {
      const arr = pendingStatusWaiters.get(key) || [];
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) pendingStatusWaiters.delete(key);
      reject(new Error('timeout waiting for device status'));
    }, timeoutMs);
  });
}

const mqttClient = mqtt.connect({
  protocol: 'mqtt',
  host: MQTT_HOST,
  port: MQTT_PORT,
  clientId: MQTT_CLIENT_ID,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
  family: 4,
});

mqttClient.on('connect', () => {
  console.log('✓ Connected to MQTT broker');
  mqttClient.subscribe('device-+/light/status');
  mqttClient.subscribe('device-+/motor/status');
  mqttClient.subscribe('device-+/rgb/status');
  mqttClient.subscribe('device-+/online');
});

mqttClient.on('message', async (topic, message) => {
  const payload = message.toString();
  const parts = topic.split('/');
  const deviceId = parts[0];
  if (!deviceState[deviceId]) deviceState[deviceId] = {};

  if (parts.length === 2 && parts[1] === 'online') {
    deviceState[deviceId].online = (payload === 'online');
    if (payload === 'online') deviceState[deviceId].lastSeen = new Date().toISOString();
    return;
  }
  if (parts.length !== 3) return;

  const type = parts[1];
  deviceState[deviceId][type] = payload;
  deviceState[deviceId].lastSeen = new Date().toISOString();

  const key = `${deviceId}:${type}`;
  const waiters = pendingStatusWaiters.get(key) || [];
  for (const w of waiters.slice()) {
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

  try {
    const conn = await dbPool.getConnection();
    await conn.query('INSERT INTO device_logs (device_id, action) VALUES (?, ?)', [deviceId, `${type}_${payload}`]);
    conn.release();
  } catch (err) {
    console.error('Failed to log device action:', err.message);
  }
});

mqttClient.on('error', (err) => console.error('MQTT error:', err.message));

// ─────────────────────────────────────────────────────────────────────────────
// API root
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'Smart Device REST API' }));

// ─────────────────────────────────────────────────────────────────────────────
// Debug
// ─────────────────────────────────────────────────────────────────────────────

app.get('/debug/db-test', async (req, res) => {
  const result = { config: { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'smartdevice', database: 'smartdevice' }, connection: null, devices: null, error: null };
  try {
    const conn = await dbPool.getConnection();
    result.connection = 'success';
    result.devices = await conn.query('SELECT * FROM devices');
    conn.release();
  } catch (err) {
    result.error = err.message;
  }
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

function generateClaimCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  try {
    const conn = await dbPool.getConnection();
    const existing = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) { conn.release(); return res.status(409).json({ error: 'Email already registered' }); }
    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await conn.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash]);
    conn.release();
    res.status(201).json({ message: 'Account created successfully', user_id: Number(result.insertId), email });
  } catch (err) {
    console.error('[AUTH] Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const conn = await dbPool.getConnection();
    const users = await conn.query('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
    conn.release();
    if (users.length === 0) return res.status(401).json({ error: 'Invalid email or password' });
    const user = users[0];
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    const numericUserId = Number(user.id);
    const token = jwt.sign({ user_id: numericUserId, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, user_id: numericUserId, email: user.email });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/verify', authMiddleware, (req, res) => {
  res.json({ message: 'Token is valid', user_id: req.user.user_id, email: req.user.email });
});

// ─────────────────────────────────────────────────────────────────────────────
// Device Registration & Claim
// ─────────────────────────────────────────────────────────────────────────────

app.post('/devices/register', async (req, res) => {
  const { device_id, name } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });
  try {
    const conn = await dbPool.getConnection();
    const existing = await conn.query('SELECT * FROM devices WHERE id = ?', [device_id]);
    if (existing.length > 0) {
      let claimCode = existing[0].claim_code;
      if (!claimCode) {
        claimCode = generateClaimCode();
        await conn.query('UPDATE devices SET claim_code = ? WHERE id = ?', [claimCode, device_id]);
      }
      conn.release();
      return res.json({ registered: false, already_existed: true, device_id, claim_code: claimCode });
    }
    const claim_code = generateClaimCode();
    await conn.query('INSERT INTO devices (id, user_id, name, type, claim_code) VALUES (?, NULL, ?, ?, ?)', [device_id, name || device_id, 'penlightwaver', claim_code]);
    conn.release();
    console.log(`[REGISTER] New device: ${device_id} (claim: ${claim_code})`);
    res.json({ registered: true, already_existed: false, device_id, claim_code });
  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/devices/claim', authMiddleware, async (req, res) => {
  const { claim_code } = req.body;
  const user_id = req.user.user_id;
  const normalizedCode = (claim_code || '').replace(/-/g, '').toUpperCase().trim();
  if (!normalizedCode || normalizedCode.length !== 6) return res.status(400).json({ error: 'claim_code must be 6 characters' });
  try {
    const conn = await dbPool.getConnection();
    const devices = await conn.query('SELECT * FROM devices WHERE claim_code = ?', [normalizedCode]);
    if (!devices.length) { conn.release(); return res.status(404).json({ error: 'No device found with that claim code' }); }
    const device = devices[0];
    await conn.query('UPDATE devices SET user_id = ? WHERE claim_code = ?', [user_id, normalizedCode]);
    conn.release();
    console.log(`[CLAIM] Device ${device.id} claimed by user ${user_id}`);
    res.json({ success: true, device_id: device.id, user_id });
  } catch (err) {
    console.error('[CLAIM] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning short-window
// ─────────────────────────────────────────────────────────────────────────────

app.get('/provision/status/:sessionId', authMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const conn = await dbPool.getConnection();
    const rows = await conn.query('SELECT * FROM provision_sessions WHERE id = ? LIMIT 1', [sessionId]);
    conn.release();
    if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    const s = rows[0];
    if (Number(s.user_id) !== Number(req.user.user_id)) return res.status(403).json({ error: 'Forbidden' });
    return res.json({ status: s.status, claimed_device_id: s.claimed_device_id || null, expires_at: s.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/provision/start', authMiddleware, async (req, res) => {
  const user_id = req.user.user_id;
  const ttlSeconds = (req.body && req.body.ttl) ? parseInt(req.body.ttl) : 10;
  try {
    const conn = await dbPool.getConnection();
    await conn.query("UPDATE provision_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= NOW()");
    const active = await conn.query("SELECT * FROM provision_sessions WHERE status = 'active' LIMIT 1");
    if (active.length > 0) { conn.release(); return res.status(409).json({ error: 'Another provisioning session is already active. Try again later.' }); }
    const sessionId = crypto.randomUUID();
    const expiresSql = new Date(Date.now() + ttlSeconds * 1000).toISOString().slice(0,19).replace('T',' ');
    await conn.query('INSERT INTO provision_sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [sessionId, user_id, expiresSql]);
    conn.release();
    console.log(`[PROVISION] User ${user_id} started session ${sessionId} (TTL ${ttlSeconds}s)`);
    return res.json({ session_id: sessionId, expires_at: expiresSql, ttl_seconds: ttlSeconds });
  } catch (err) {
    console.error('[PROVISION] Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/provision/announce', async (req, res) => {
  const { device_id } = req.body;
  let { session_id } = req.body || {};
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });
  try {
    const conn = await dbPool.getConnection();
    let session;
    if (session_id) {
      const rows = await conn.query('SELECT * FROM provision_sessions WHERE id = ? AND status = "active" LIMIT 1', [session_id]);
      if (!rows.length) { conn.release(); return res.status(404).json({ error: 'Session not found or not active' }); }
      session = rows[0];
    } else {
      const active = await conn.query('SELECT * FROM provision_sessions WHERE status = "active" AND expires_at > NOW() LIMIT 1');
      if (!active.length) { conn.release(); return res.status(404).json({ error: 'No active provisioning session' }); }
      session = active[0];
      session_id = session.id;
    }
    if (new Date(session.expires_at) < new Date()) {
      await conn.query("UPDATE provision_sessions SET status = 'expired' WHERE id = ?", [session_id]);
      conn.release();
      return res.status(410).json({ error: 'Provisioning session expired' });
    }
    const devices = await conn.query('SELECT * FROM devices WHERE id = ?', [device_id]);
    if (!devices.length) { conn.release(); return res.status(404).json({ error: 'Device not found (must be registered first)' }); }
    if (devices[0].user_id) { conn.release(); return res.status(409).json({ error: 'Device already claimed' }); }
    await conn.query('UPDATE devices SET user_id = ? WHERE id = ?', [session.user_id, device_id]);
    await conn.query("UPDATE provision_sessions SET claimed_device_id = ?, status = 'claimed' WHERE id = ?", [device_id, session_id]);
    conn.release();
    console.log(`[PROVISION] Device ${device_id} claimed by user ${session.user_id} via session ${session_id}`);
    return res.json({ success: true, device_id, user_id: session.user_id, session_id });
  } catch (err) {
    console.error('[PROVISION] Announce error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// OTA Firmware
// ─────────────────────────────────────────────────────────────────────────────

const FIRMWARE_DIR = process.env.FIRMWARE_DIR || '/firmware';

function getFirmwareVersion(deviceType) {
  const versionsPath = path.join(FIRMWARE_DIR, 'versions.json');
  if (fs.existsSync(versionsPath)) {
    try {
      const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
      if (versions[deviceType] !== undefined) return versions[deviceType];
    } catch (e) {}
  }
  return parseInt(process.env.FIRMWARE_VERSION || '1');
}

app.get('/firmware/:deviceType/version', (req, res) => {
  const { deviceType } = req.params;
  const version = getFirmwareVersion(deviceType);
  console.log(`[OTA] Version check: ${deviceType} → v${version}`);
  res.json({ version });
});

app.get('/firmware/:deviceType/latest.bin', (req, res) => {
  const { deviceType } = req.params;
  const binPath = path.join(FIRMWARE_DIR, deviceType, 'latest.bin');
  if (!fs.existsSync(binPath)) return res.status(404).json({ error: `No firmware found for device type: ${deviceType}` });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(binPath);
});

app.get('/firmware/info', (req, res) => {
  const versionsPath = path.join(FIRMWARE_DIR, 'versions.json');
  let versions = {};
  if (fs.existsSync(versionsPath)) { try { versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8')); } catch (e) {} }
  const deviceTypes = fs.existsSync(FIRMWARE_DIR) ? fs.readdirSync(FIRMWARE_DIR).filter(f => fs.statSync(path.join(FIRMWARE_DIR, f)).isDirectory()) : [];
  const info = deviceTypes.map(dt => {
    const binPath = path.join(FIRMWARE_DIR, dt, 'latest.bin');
    const exists = fs.existsSync(binPath);
    return { device_type: dt, version: versions[dt] ?? null, firmware_file_exists: exists, firmware_size_bytes: exists ? fs.statSync(binPath).size : null };
  });
  res.json({ firmware_dir: FIRMWARE_DIR, device_types: info });
});

// ─────────────────────────────────────────────────────────────────────────────
// Device Control
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  let dbStatus = 'ok', dbError = null;
  try { const conn = await dbPool.getConnection(); await conn.query('SELECT 1'); conn.release(); } catch (err) { dbStatus = 'error'; dbError = err.message; }
  res.json({ status: 'ok', mqtt: MQTT_HOST + ':' + MQTT_PORT, database: dbStatus, database_error: dbError });
});

app.get('/devices/:deviceId/status', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const conn = await dbPool.getConnection();
    const device = await conn.query('SELECT * FROM devices WHERE id = ?', [deviceId]);
    conn.release();
    if (!device.length) return res.status(404).json({ error: 'Device not found' });
    const state = deviceState[deviceId] || {};
    res.json({ device_id: deviceId, device_name: device[0].name, online: state.online === true, light: state.light || 'unknown', motor: state.motor || 'unknown', rgb: state.rgb || 'off', last_seen: state.lastSeen || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function mqttCommand(deviceId, topic, payload, type, expectedVal, res) {
  mqttClient.publish(topic, payload, async (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish MQTT message' });
    if (!deviceState[deviceId]) deviceState[deviceId] = {};
    deviceState[deviceId][type] = expectedVal;
    res.json({ status: 'ok', device_id: deviceId, [type]: expectedVal });
  });
}

app.post('/devices/:deviceId/light/on',    async (req, res) => { const {deviceId} = req.params; mqttCommand(deviceId, `${deviceId}/light/command`, 'on',      'light', 'on',      res); });
app.post('/devices/:deviceId/light/off',   async (req, res) => { const {deviceId} = req.params; mqttCommand(deviceId, `${deviceId}/light/command`, 'off',     'light', 'off',     res); });
app.post('/devices/:deviceId/motor/run',   async (req, res) => { const {deviceId} = req.params; mqttCommand(deviceId, `${deviceId}/motor/command`, 'run',     'motor', 'running', res); });
app.post('/devices/:deviceId/motor/stop',  async (req, res) => { const {deviceId} = req.params; mqttCommand(deviceId, `${deviceId}/motor/command`, 'stop',    'motor', 'stopped', res); });

app.post('/devices/:deviceId/rgb', async (req, res) => {
  const { deviceId } = req.params;
  const { color } = req.body;
  if (!color) return res.status(400).json({ error: 'color is required' });
  mqttCommand(deviceId, `${deviceId}/rgb/command`, color, 'rgb', color, res);
});

app.get('/devices/:deviceId/light/status', (req, res) => { const s = deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, light: s.light || 'unknown' }); });
app.get('/devices/:deviceId/motor/status', (req, res) => { const s = deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, motor: s.motor || 'unknown' }); });
app.get('/devices/:deviceId/rgb/status',   (req, res) => { const s = deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, rgb: s.rgb || 'off' }); });

// ─────────────────────────────────────────────────────────────────────────────
// 404 + Start
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'endpoint not found' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n--- Smart Device API ---`);
  console.log(`🚀 Listening on port ${PORT}`);
  console.log(`📡 MQTT: ${MQTT_HOST}:${MQTT_PORT}`);
  console.log(`🗄️  DB:   ${process.env.DB_HOST || 'localhost'}`);
});

process.on('SIGINT', () => { mqttClient.end(); process.exit(0); });
