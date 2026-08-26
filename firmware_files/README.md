# Firmware Files for OTA Updates

Place compiled firmware binaries here before deploying to Cloud Run.

## How to add a new firmware version

1. In Arduino IDE, increase `FIRMWARE_VERSION` constant (e.g. `1` → `2`)
2. Click: `Sketch` → `Export Compiled Binary`
3. Find the `.bin` file in your sketch folder (e.g. `smart_device.ino.bin`)
4. Copy it here as `latest.bin`:
   ```
   server/firmware_files/latest.bin
   ```
5. Redeploy to Cloud Run with the new version number:
   ```bash
   gcloud run deploy smart-device-server \
     --source . \
     --set-env-vars FIRMWARE_VERSION=2
   ```

## Important

- This folder is baked into the Docker image — do NOT put here sensitive files
- `latest.bin` is the only file devices download; old versions are not kept here
- The `FIRMWARE_VERSION` environment variable controls what version number devices see
- Devices only update when server version > their compiled-in version
