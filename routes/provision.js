const express = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /provision/status/:sessionId
router.get('/status/:sessionId', authMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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

// POST /provision/start
router.post('/start', authMiddleware, async (req, res) => {
  const user_id = req.user.user_id;
  const ttlSeconds = (req.body && req.body.ttl) ? parseInt(req.body.ttl) : 10;
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    await conn.query("UPDATE provision_sessions SET status = 'expired' WHERE status = 'active' AND expires_at <= NOW()");
    const active = await conn.query("SELECT * FROM provision_sessions WHERE status = 'active' LIMIT 1");
    if (active.length > 0) { conn.release(); return res.status(409).json({ error: 'Another provisioning session is already active. Try again later.' }); }
    const sessionId = crypto.randomUUID();
    const expiresSql = new Date(Date.now() + ttlSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await conn.query('INSERT INTO provision_sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [sessionId, user_id, expiresSql]);
    conn.release();
    console.log(`[PROVISION] User ${user_id} started session ${sessionId} (TTL ${ttlSeconds}s)`);
    return res.json({ session_id: sessionId, expires_at: expiresSql, ttl_seconds: ttlSeconds });
  } catch (err) {
    console.error('[PROVISION] Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /provision/announce  — called by firmware (no auth)
router.post('/announce', async (req, res) => {
  const { device_id } = req.body;
  let { session_id } = req.body || {};
  if (!device_id) return res.status(400).json({ error: 'device_id is required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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

module.exports = router;
