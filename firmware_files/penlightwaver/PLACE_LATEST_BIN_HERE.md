# Place firmware binary here

Upload your compiled `.bin` file as `latest.bin` in this folder.

## Steps

1. In Arduino IDE: `Sketch` → `Export Compiled Binary`
2. Find `smart_device.ino.bin` in your sketch folder
3. Upload it here on GitHub.com as `latest.bin`
4. Update `versions.json` in the parent folder — bump the `penlightwaver` number
5. Redeploy Cloud Run (just commit — Cloud Build will pick it up automatically)

## Current version

See `../versions.json` → `"penlightwaver": 1`
