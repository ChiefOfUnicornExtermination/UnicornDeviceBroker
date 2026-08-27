const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /auth/signup
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
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

// POST /auth/verify  — confirm token still valid
router.post('/verify', require('../middleware/auth').authMiddleware, (req, res) => {
  res.json({ message: 'Token is valid', user_id: req.user.user_id, email: req.user.email });
});

module.exports = router;
