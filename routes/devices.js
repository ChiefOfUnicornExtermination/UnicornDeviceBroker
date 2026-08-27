const express = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function generateClaimCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST /devices/register  — called by firmware on boot
router.post('/register', async (req, res) => {
  const { device_id, name } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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
    await conn.query(
      'INSERT INTO devices (id, user_id, name, type, claim_code) VALUES (?, NULL, ?, ?, ?)',
      [device_id, name || device_id, 'penlightwaver', claim_code]
    );
    conn.release();
    console.log(`[REGISTER] New device: ${device_id} (claim: ${claim_code})`);
    res.json({ registered: true, already_existed: false, device_id, claim_code });
  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /devices/claim  — user claims device by code
router.post('/claim', authMiddleware, async (req, res) => {
  const { claim_code } = req.body;
  const user_id = req.user.user_id;
  const normalizedCode = (claim_code || '').replace(/-/g, '').toUpperCase().trim();
  if (!normalizedCode || normalizedCode.length !== 6) return res.status(400).json({ error: 'claim_code must be 6 characters' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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

// GET /devices/mine  — list all devices belonging to logged-in user
router.get('/mine', authMiddleware, async (req, res) => {
  const db = req.app.locals.db;
  const deviceState = req.app.locals.deviceState;
  try {
    const conn = await db.getConnection();
    const devices = await conn.query('SELECT id, name, type, created_at FROM devices WHERE user_id = ?', [req.user.user_id]);
    conn.release();
    const result = devices.map(d => {
      const state = deviceState[d.id] || {};
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        created_at: d.created_at,
        online: state.online === true,
        light: state.light || 'unknown',
        motor: state.motor || 'unknown',
        rgb: state.rgb || 'off',
        last_seen: state.lastSeen || null
      };
    });
    res.json({ devices: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/:deviceId/status
router.get('/:deviceId/status', async (req, res) => {
  const { deviceId } = req.params;
  const db = req.app.locals.db;
  const deviceState = req.app.locals.deviceState;
  try {
    const conn = await db.getConnection();
    const device = await conn.query('SELECT * FROM devices WHERE id = ?', [deviceId]);
    conn.release();
    if (!device.length) return res.status(404).json({ error: 'Device not found' });
    const state = deviceState[deviceId] || {};
    res.json({
      device_id: deviceId,
      device_name: device[0].name,
      online: state.online === true,
      light: state.light || 'unknown',
      motor: state.motor || 'unknown',
      rgb: state.rgb || 'off',
      last_seen: state.lastSeen || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Control helpers
function mqttCommand(req, res, deviceId, topic, payload, type, expectedVal) {
  const mqttClient = req.app.locals.mqttClient;
  const deviceState = req.app.locals.deviceState;
  mqttClient.publish(topic, payload, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to publish MQTT message' });
    if (!deviceState[deviceId]) deviceState[deviceId] = {};
    deviceState[deviceId][type] = expectedVal;
    res.json({ status: 'ok', device_id: deviceId, [type]: expectedVal });
  });
}

router.post('/:deviceId/light/on',   (req, res) => { const {deviceId} = req.params; mqttCommand(req, res, deviceId, `${deviceId}/light/command`, 'on',   'light', 'on'); });
router.post('/:deviceId/light/off',  (req, res) => { const {deviceId} = req.params; mqttCommand(req, res, deviceId, `${deviceId}/light/command`, 'off',  'light', 'off'); });
router.post('/:deviceId/motor/run',  (req, res) => { const {deviceId} = req.params; mqttCommand(req, res, deviceId, `${deviceId}/motor/command`, 'run',  'motor', 'running'); });
router.post('/:deviceId/motor/stop', (req, res) => { const {deviceId} = req.params; mqttCommand(req, res, deviceId, `${deviceId}/motor/command`, 'stop', 'motor', 'stopped'); });

router.post('/:deviceId/rgb', (req, res) => {
  const { deviceId } = req.params;
  const { color } = req.body;
  if (!color) return res.status(400).json({ error: 'color is required' });
  mqttCommand(req, res, deviceId, `${deviceId}/rgb/command`, color, 'rgb', color);
});

router.get('/:deviceId/light/status', (req, res) => { const s = req.app.locals.deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, light: s.light || 'unknown' }); });
router.get('/:deviceId/motor/status', (req, res) => { const s = req.app.locals.deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, motor: s.motor || 'unknown' }); });
router.get('/:deviceId/rgb/status',   (req, res) => { const s = req.app.locals.deviceState[req.params.deviceId] || {}; res.json({ device_id: req.params.deviceId, rgb: s.rgb || 'off' }); });

// PATCH /devices/:deviceId/name  — rename device
router.patch('/:deviceId/name', authMiddleware, async (req, res) => {
  const { deviceId } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const result = await conn.query(
      'UPDATE devices SET name = ? WHERE id = ? AND user_id = ?',
      [name.trim(), deviceId, req.user.user_id]
    );
    conn.release();
    if (Number(result.affectedRows) === 0) return res.status(404).json({ error: 'Device not found or not yours' });
    res.json({ success: true, device_id: deviceId, name: name.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
