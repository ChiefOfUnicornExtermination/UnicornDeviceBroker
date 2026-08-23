# MySQL Database Setup

## Installation on Debian (Compute Engine)

### 1. Install MySQL Server
```bash
sudo apt-get update
sudo apt-get install mysql-server -y

# Start MySQL
sudo systemctl start mysql
sudo systemctl enable mysql
```

### 2. Secure MySQL
```bash
sudo mysql_secure_installation
# Answer questions (set root password, remove anonymous user, etc.)
```

### 3. Create Database & Tables
```bash
# Login as root
sudo mysql -u root -p

# Then execute these SQL commands:
```

```sql
CREATE DATABASE smartdevice;
USE smartdevice;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nicovideo_user_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE devices (
  id VARCHAR(50) PRIMARY KEY,
  user_id INT NULL,
  name VARCHAR(255),
  type VARCHAR(50),
  claim_code VARCHAR(8) NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(50) NOT NULL,
  action VARCHAR(100),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE,
  INDEX(device_id),
  INDEX(timestamp)
);
```

### 4. Create Application User
```sql
CREATE USER 'smartdevice'@'localhost' IDENTIFIED BY 'AzTLCFkidp0JXC';
GRANT ALL PRIVILEGES ON smartdevice.* TO 'smartdevice'@'localhost';

-- If API server is on Cloud Run (different IP):
CREATE USER 'smartdevice'@'%' IDENTIFIED BY 'AzTLCFkidp0JXC';
GRANT ALL PRIVILEGES ON smartdevice.* TO 'smartdevice'@'%';

FLUSH PRIVILEGES;
```

### 5. Verify Connection
```bash
mysql -u smartdevice -p -h localhost smartdevice
```

---

## Cloud Run Environment Variables

Set these in Cloud Run deployment:

```bash
gcloud run deploy unicorndevicebroker \
  --source . \
  --region asia-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars \
  MQTT_HOST=mqtt.unicornextermination.info,\
  MQTT_PORT=1883,\
  DB_HOST=34.85.7.99,\
  DB_USER=smartdevice,\
  DB_PASSWORD=your_secure_password
```

**Note:** Replace `34.85.7.99` with your Compute Engine's external IP.

---

## Testing Database Connection

From your local machine (with Node.js installed):

```bash
npm install mysql2
node -e "
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: 'YOUR_COMPUTE_ENGINE_IP',
  user: 'smartdevice',
  password: 'your_secure_password',
  database: 'smartdevice'
});

pool.getConnection().then(conn => {
  console.log('✓ Connected to MySQL!');
  conn.release();
  pool.end();
}).catch(err => {
  console.error('✗ Connection failed:', err.message);
  pool.end();
});
"
```

---

## Migrating an Existing Database

If you already have the `devices` table from a previous setup, run these SQL commands to update it:

```sql
-- Allow user_id to be NULL (unclaimed devices)
ALTER TABLE devices MODIFY user_id INT NULL;

-- Add claim code column for device linking
ALTER TABLE devices ADD COLUMN claim_code VARCHAR(8) NULL UNIQUE;

-- Verify
DESCRIBE devices;
```

---

## Adding Test Data

```sql
-- Insert test user
INSERT INTO users (email) VALUES ('user@example.com');

-- Insert test device (replace device-ID with actual MAC address)
INSERT INTO devices (id, user_id, name, type) 
VALUES ('device-AA:BB:CC:DD:EE:FF', 1, 'Living Room Light', 'light');

-- Verify
SELECT * FROM devices;
```

---

## Troubleshooting

**MySQL not accepting external connections?**
- Check: `sudo netstat -tlnp | grep mysql` (should show listening on 0.0.0.0:3306)
- If only 127.0.0.1, edit `/etc/mysql/mysql.conf.d/mysqld.cnf`:
  - Find `bind-address = 127.0.0.1`
  - Change to `bind-address = 0.0.0.0`
  - Restart: `sudo systemctl restart mysql`

**Permission denied for remote user?**
- User must be created with `'smartdevice'@'%'` not `'smartdevice'@'localhost'`
- Restart MySQL after grant: `sudo systemctl restart mysql`

**Cloud Run can't reach Compute Engine?**
- Verify both are in same VPC or have firewall rules allowing access
- Check Cloud Run logs: `gcloud run logs read unicorndevicebroker`
