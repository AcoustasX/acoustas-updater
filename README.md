# Acoustas AC650 Firmware Updater

A browser-based firmware flasher for the Acoustas AC650 amplifier, hosted at **[update.acoustas.com](https://update.acoustas.com)**.

Uses the **Web Serial API** and **esptool-js** to flash ESP32-S3 firmware directly from Chrome or Edge — no desktop software required.

---

## When This Is Used

The Acoustas mobile app (iOS/Android) performs OTA firmware updates for devices running **v1.4.12 or newer**. For devices on firmware **below v1.4.12**, OTA is not supported and a one-time USB flash is required. The app detects this and directs users to `update.acoustas.com`.

| Firmware Version | Update Method |
|---|---|
| ≥ 1.4.12 | In-app OTA (automatic) |
| < 1.4.12 | USB via this web flasher |

After the one-time USB update, all future updates can be done through the app.

---

## Current Firmware

| Item | Value |
|---|---|
| **Firmware version** | `1.6.0` |
| **Firmware binary** | `firmware/AC650.bin` (1,228,784 bytes) |
| **Source binary** | `AC650_20260220_v1.6.0.bin` |
| **Target chip** | ESP32-S3 |
| **Flash size** | 4 MB |
| **Baud rate** | 921,600 |

### Supporting Binaries

These are shared across firmware versions and do not need to change when updating the firmware:

| File | Size | Purpose |
|---|---|---|
| `firmware/bootloader.bin` | 27,440 B | ESP32-S3 bootloader |
| `firmware/partition-table.bin` | 3,072 B | Flash partition layout |
| `firmware/ota_data_initial.bin` | 8,192 B | OTA boot selector (points to ota_0) |

---

## Partition Layout

```
Address     Size      Partition
─────────────────────────────────────────
0x00000               Bootloader
0x0A000               Partition Table
0x0B000     4 KB      Storage (serial + config)
0x0C000     8 KB      OTA Data
0x80000               Firmware (ota_0)
```

### Storage Partition (0x0B000)

A 4 KB custom partition that stores amplifier identity:

| Offset | Size | Field | Description |
|---|---|---|---|
| 0x00 | 4 bytes | Serial Number | Little-endian int32 |
| 0x04 | 4 bytes | Config ID | Little-endian int32 |
| 0x08+ | — | Unused | Filled with 0xFF |

**Config IDs** (maps to amplifier model):

| ID | Amplifier |
|---|---|
| 0 | AC650 Black (Original) |
| 1 | AC650 Black (v2) |
| 2 | AC650 White |

---

## Flash Modes

### Default: Targeted Update (preserves Wi-Fi)

Writes **all 5 partitions** without erasing the full flash. The NVS partition (which stores Wi-Fi credentials and provisioning data) is not touched because `eraseAll` is set to `false` and we don't write to the NVS address range.

**Partitions written:** Bootloader → Partition Table → Storage → OTA Data → Firmware

**Result:** Firmware is updated, Wi-Fi credentials and provisioning data are preserved.

### Full Erase (opt-in checkbox)

Calls `eraseFlash()` first to wipe the entire 4 MB flash, then writes all 5 partitions.

**Result:** Clean slate — device will need to be re-provisioned via the app.

**When to use:** Troubleshooting, corrupted NVS, or when the device needs a complete reset.

---

## How It Works

### User Flow

1. **Before You Begin** — User opens the amp (4× M3 bolts), connects micro USB and power
2. **Step 1: Select Amplifier** — User picks their amp model (sets config ID)
3. **Step 2: Connect** — Clicks Connect, selects "USB JTAG/serial debug unit" from browser popup
4. **Step 3: Flash** — Clicks Flash, firmware is written (~30 seconds)
5. **Post-Flash** — User disconnects USB, unplugs power, reassembles, powers back on

### Technical Flow

```
Browser                              ESP32-S3
  │                                     │
  ├── Web Serial API ──────────────────►│ USB JTAG/serial
  │                                     │
  ├── esptool-js: connect @ 921600 ────►│ Bootloader mode
  │                                     │
  ├── [Full Erase only] eraseFlash() ──►│ Wipe 4MB
  │                                     │
  ├── writeFlash(bootloader, 0x00000) ─►│
  ├── writeFlash(partTable,  0x0A000) ─►│
  ├── writeFlash(storage,    0x0B000) ─►│
  ├── writeFlash(otaData,    0x0C000) ─►│
  ├── writeFlash(firmware,   0x80000) ─►│
  │                                     │
  ├── hardReset() ─────────────────────►│ (no effect on native USB)
  │                                     │
  └── Show "power cycle" instructions   │
```

> **Note:** The ESP32-S3's native USB CDC does not support hardware reset via RTS/DTR signals. A physical power cycle is required after flashing.

---

## Admin Mode

Click the lock icon in the top-right corner and enter the admin password to enable:

- **Serial number input** — Sets the serial number in the storage partition
- **Admin password** — Stored in `app.js` as `ADMIN_PASSWORD`

Admin mode is for factory provisioning. Regular customers do not need it.

---

## Updating the Firmware

To update the firmware binary for a new release:

1. Copy the new firmware `.bin` file to `firmware/AC650.bin` (replacing the existing one)
2. Update `FIRMWARE_VERSION` in `app.js` (line 16)
3. Commit and push to GitHub — the site auto-deploys via GitHub Pages

```bash
cp /path/to/AC650_YYYYMMDD_vX.Y.Z.bin firmware/AC650.bin
# Edit app.js line 16: const FIRMWARE_VERSION = 'X.Y.Z';
git add -A && git commit -m "Update firmware to vX.Y.Z" && git push
```

The bootloader, partition table, and OTA data binaries generally do not change between firmware versions.

---

## Hosting

| Item | Value |
|---|---|
| **Repository** | [AcoustasX/acoustas-updater](https://github.com/AcoustasX/acoustas-updater) |
| **Hosting** | GitHub Pages (auto-deploy from `main`) |
| **Custom Domain** | `update.acoustas.com` (CNAME → `acoustasx.github.io`) |
| **DNS** | AWS Route 53 — CNAME record on `acoustas.com` hosted zone |
| **SSL** | Auto-provisioned by GitHub Pages (Let's Encrypt) |

---

## File Structure

```
AcoustasUpdater/
├── index.html              # Main page
├── app.js                  # Flash logic, UI, esptool-js integration
├── style.css               # Dark theme styling
├── CNAME                   # Custom domain config
├── .nojekyll               # Bypass Jekyll processing
├── firmware/
│   ├── AC650.bin           # Main firmware (v1.6.0)
│   ├── bootloader.bin      # ESP32-S3 bootloader
│   ├── partition-table.bin # Flash partition layout
│   └── ota_data_initial.bin # OTA boot selector
└── images/
    ├── acoustas_ac650_black.png
    ├── acoustas_ac650_black_v2.png
    └── acoustas_ac650_white.png
```

---

## App Integration

The Acoustas Flutter app (`firmware_update_dialog.dart`) checks the device firmware version on connection:

- **`globals.dart`** defines `minOtaFirmwareVersion = '1.4.12'`
- If device firmware < 1.4.12, the dialog shows a message directing users to `https://update.acoustas.com`
- If device firmware ≥ 1.4.12, normal in-app OTA update is offered

---

## Browser Requirements

- **Google Chrome** or **Microsoft Edge** (Web Serial API support required)
- **HTTPS** required (Web Serial is only available in secure contexts)
- Mobile browsers are **not supported** (no Web Serial API)

---

## Troubleshooting

| Issue | Solution |
|---|---|
| "Web Serial not supported" | Use Chrome or Edge. Make sure you're on HTTPS. |
| No device in serial picker | Check USB cable is connected. Try a different USB port. |
| Flash fails mid-write | Power cycle the amp, reconnect USB, try again. |
| Amp freezes after flash | Normal — unplug power cord, wait 10 seconds, plug back in. |
| Amp doesn't connect to Wi-Fi after update | Default mode preserves Wi-Fi. If Full Erase was used, re-provision via the app. |
