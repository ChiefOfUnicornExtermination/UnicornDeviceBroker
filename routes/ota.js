const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
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

// GET /firmware/info
router.get('/info', (req, res) => {
  const versionsPath = path.join(FIRMWARE_DIR, 'versions.json');
  let versions = {};
  if (fs.existsSync(versionsPath)) { try { versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8')); } catch (e) {} }
  const deviceTypes = fs.existsSync(FIRMWARE_DIR)
    ? fs.readdirSync(FIRMWARE_DIR).filter(f => fs.statSync(path.join(FIRMWARE_DIR, f)).isDirectory())
    : [];
  const info = deviceTypes.map(dt => {
    const binPath = path.join(FIRMWARE_DIR, dt, 'latest.bin');
    const exists = fs.existsSync(binPath);
    return { device_type: dt, version: versions[dt] ?? null, firmware_file_exists: exists, firmware_size_bytes: exists ? fs.statSync(binPath).size : null };
  });
  res.json({ firmware_dir: FIRMWARE_DIR, device_types: info });
});

// GET /firmware/:deviceType/version
router.get('/:deviceType/version', (req, res) => {
  const { deviceType } = req.params;
  const version = getFirmwareVersion(deviceType);
  console.log(`[OTA] Version check: ${deviceType} → v${version}`);
  res.json({ version });
});

// GET /firmware/:deviceType/latest.bin
router.get('/:deviceType/latest.bin', (req, res) => {
  const { deviceType } = req.params;
  const binPath = path.join(FIRMWARE_DIR, deviceType, 'latest.bin');
  if (!fs.existsSync(binPath)) return res.status(404).json({ error: `No firmware found for device type: ${deviceType}` });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(binPath);
});

module.exports = router;
