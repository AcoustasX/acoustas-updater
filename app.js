/**
 * Acoustas AC650 Firmware Updater
 * 
 * Uses the Web Serial API and esptool-js to flash ESP32-S3 firmware
 * directly from the browser via USB.
 * 
 * Partition layout (ESP32-S3, 4MB flash):
 *   0x00000  bootloader.bin
 *   0x0A000  partition-table.bin
 *   0x0B000  storage (4KB) - serial (4 bytes) + config (4 bytes)
 *   0x0C000  ota_data_initial.bin
 *   0x80000  AC650.bin (firmware)
 */

// ─── Configuration ───────────────────────────────────────────────
const FIRMWARE_VERSION = '1.6.2';
const ADMIN_PASSWORD = 'Acoustas2026!';  // Change this to your desired password
const BAUD_RATE = 921600;

// ESP32-S3 flash offsets:
const FLASH_OFFSETS = {
    bootloader: 0x00000,
    partitionTable: 0x0A000,
    storage: 0x0B000,
    otaData: 0x0C000,
    firmware: 0x80000,
};

// Firmware binary paths:
const FIRMWARE_FILES = {
    bootloader: 'firmware/bootloader.bin',
    partitionTable: 'firmware/partition-table.bin',
    otaData: 'firmware/ota_data_initial.bin',
    firmware: 'firmware/AC650.bin',
};

// ─── State ───────────────────────────────────────────────────────
let selectedConfig = null;
let selectedName = '';
let isAdmin = false;
let espTool = null;
let transport = null;
let isConnected = false;

// ─── DOM Elements ────────────────────────────────────────────────
const ampCards = document.querySelectorAll('.amp-card');
const connectBtn = document.getElementById('connectBtn');
const flashBtn = document.getElementById('flashBtn');
const resetBtn = document.getElementById('resetBtn');
const retryBtn = document.getElementById('retryBtn');
const adminToggle = document.getElementById('adminToggle');
const adminModal = document.getElementById('adminModal');
const adminPassword = document.getElementById('adminPassword');
const adminSubmit = document.getElementById('adminSubmit');
const adminCancel = document.getElementById('adminCancel');
const adminError = document.getElementById('adminError');
const serialSection = document.getElementById('serialSection');
const serialInput = document.getElementById('serialInput');
const connectionStatus = document.getElementById('connectionStatus');
const statusDot = connectionStatus.querySelector('.status-dot');
const statusText = connectionStatus.querySelector('.status-text');
const flashAmpName = document.getElementById('flashAmpName');
const flashConfigValue = document.getElementById('flashConfigValue');
const flashSerialRow = document.getElementById('flashSerialRow');
const flashSerialValue = document.getElementById('flashSerialValue');
const flashContent = document.getElementById('flashContent');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const successSection = document.getElementById('successSection');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const postStepApp = document.getElementById('postStepApp');
const successNotePreserved = document.getElementById('successNotePreserved');
const successNoteErased = document.getElementById('successNoteErased');
const logPanel = document.getElementById('logPanel');
const logOutput = document.getElementById('logOutput');
const logToggle = document.getElementById('logToggle');
const logClose = document.getElementById('logClose');

// ─── Logging ─────────────────────────────────────────────────────
function log(msg) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(line);
    logOutput.textContent += line + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
}

// ─── esptool-js Loader ──────────────────────────────────────────
// We dynamically import esptool-js from CDN
let ESPLoader, Transport;

async function loadEsptoolJS() {
    if (ESPLoader && Transport) return;
    log('Loading esptool-js library...');
    try {
        const mod = await import('https://unpkg.com/esptool-js@0.5.4/bundle.js');
        ESPLoader = mod.ESPLoader;
        Transport = mod.Transport;
        log('esptool-js loaded successfully');
    } catch (err) {
        log(`Failed to load esptool-js: ${err.message}`);
        throw new Error('Failed to load flashing library. Please check your internet connection.');
    }
}

// ─── Amp Selection ───────────────────────────────────────────────
ampCards.forEach(card => {
    card.addEventListener('click', () => {
        ampCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedConfig = parseInt(card.dataset.config, 10);
        selectedName = card.dataset.name;
        log(`Selected: ${selectedName} (config=${selectedConfig})`);
        updateUI();
    });
});

// ─── Admin Mode ──────────────────────────────────────────────────
adminToggle.addEventListener('click', () => {
    if (isAdmin) {
        isAdmin = false;
        adminToggle.classList.remove('active');
        serialSection.classList.add('hidden');
        flashSerialRow.classList.add('hidden');
        log('Admin mode disabled');
        updateUI();
        return;
    }
    adminModal.classList.remove('hidden');
    adminPassword.value = '';
    adminError.classList.add('hidden');
    adminPassword.focus();
});

adminSubmit.addEventListener('click', tryAdminLogin);
adminPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryAdminLogin();
});

adminCancel.addEventListener('click', () => {
    adminModal.classList.add('hidden');
});

// Close modal on backdrop click
adminModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    adminModal.classList.add('hidden');
});

function tryAdminLogin() {
    if (adminPassword.value === ADMIN_PASSWORD) {
        isAdmin = true;
        adminToggle.classList.add('active');
        serialSection.classList.remove('hidden');
        adminModal.classList.add('hidden');
        log('Admin mode enabled');
        updateUI();
    } else {
        adminError.classList.remove('hidden');
        adminPassword.value = '';
        adminPassword.focus();
    }
}

// ─── Connect ─────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
    if (isConnected) {
        // Disconnect
        try {
            if (transport) {
                await transport.disconnect();
            }
        } catch (e) {
            log(`Disconnect warning: ${e.message}`);
        }
        isConnected = false;
        espTool = null;
        transport = null;
        updateConnectionStatus(false);
        updateUI();
        return;
    }

    try {
        await loadEsptoolJS();

        log('Requesting serial port...');
        const port = await navigator.serial.requestPort({
            filters: [
                { usbVendorId: 0x303A }, // Espressif USB VID for ESP32-S3
            ]
        });
        log('Port selected');

        transport = new Transport(port, true);

        const loaderOptions = {
            transport,
            baudrate: BAUD_RATE,
            romBaudrate: 115200,
            terminal: {
                clean() { },
                writeLine(data) { log(data); },
                write(data) { /* partial line */ },
            },
        };

        espTool = new ESPLoader(loaderOptions);
        log('Connecting to ESP32...');
        const chip = await espTool.main();
        log(`Connected: ${chip}`);

        isConnected = true;
        updateConnectionStatus(true, chip);
        updateUI();
    } catch (err) {
        log(`Connection failed: ${err.message}`);
        isConnected = false;
        updateConnectionStatus(false);
        updateUI();

        if (err.name === 'NotFoundError') {
            // User cancelled the port picker
            return;
        }
        showError(`Failed to connect: ${err.message}`);
    }
});

// ─── Flash ───────────────────────────────────────────────────────
flashBtn.addEventListener('click', async () => {
    if (!espTool || !isConnected || selectedConfig === null) return;

    const fullErase = document.getElementById('fullEraseCheck').checked;

    // Hide flash content, show progress
    flashContent.classList.add('hidden');
    progressSection.classList.remove('hidden');
    successSection.classList.add('hidden');
    errorSection.classList.add('hidden');

    try {
        // 1. Load firmware files
        setProgress(0, 'Loading firmware files...');
        log('Loading firmware binaries...');

        if (fullErase) {
            // Full erase mode: load all binaries
            log('Mode: FULL ERASE - all settings will be reset');
            const [bootloaderData, partTableData, otaDataData, firmwareData] = await Promise.all([
                fetchBinary(FIRMWARE_FILES.bootloader),
                fetchBinary(FIRMWARE_FILES.partitionTable),
                fetchBinary(FIRMWARE_FILES.otaData),
                fetchBinary(FIRMWARE_FILES.firmware),
            ]);

            log(`Loaded: bootloader=${bootloaderData.length}B, partTable=${partTableData.length}B, otaData=${otaDataData.length}B, firmware=${firmwareData.length}B`);
            setProgress(10, 'Preparing storage partition...');

            // Generate storage partition
            const storageData = generateStoragePartition(
                isAdmin ? (parseInt(serialInput.value, 10) || 0) : 0,
                selectedConfig
            );
            log(`Storage partition: serial=${isAdmin ? serialInput.value : '0'}, config=${selectedConfig}`);

            // Erase entire flash
            setProgress(15, 'Erasing flash (full)...');
            log('Erasing entire flash...');
            try {
                await espTool.eraseFlash();
                log('Flash erased');
            } catch (e) {
                log(`Erase warning: ${e.message} - continuing...`);
            }
            setProgress(25, 'Writing firmware...');

            // Write all partitions
            const fileArray = [
                { data: binaryToEspFormat(bootloaderData), address: FLASH_OFFSETS.bootloader },
                { data: binaryToEspFormat(partTableData), address: FLASH_OFFSETS.partitionTable },
                { data: binaryToEspFormat(storageData), address: FLASH_OFFSETS.storage },
                { data: binaryToEspFormat(otaDataData), address: FLASH_OFFSETS.otaData },
                { data: binaryToEspFormat(firmwareData), address: FLASH_OFFSETS.firmware },
            ];

            log('Writing all partitions to flash...');
            await espTool.writeFlash({
                fileArray,
                flashSize: '4MB',
                flashMode: 'dio',
                flashFreq: '80m',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    const labels = ['Bootloader', 'Partition Table', 'Storage', 'OTA Data', 'Firmware'];
                    const baseProgress = 25;
                    const perFileWeight = [5, 2, 1, 2, 60];
                    let cumWeight = 0;
                    for (let i = 0; i < fileIndex; i++) cumWeight += perFileWeight[i];
                    const fileProgress = (written / total) * perFileWeight[fileIndex];
                    const totalProgress = Math.min(95, baseProgress + cumWeight + fileProgress);
                    setProgress(totalProgress, `Writing ${labels[fileIndex]}...`);
                },
            });

        } else {
            // Targeted mode: write all partitions WITHOUT erasing full flash
            // This preserves NVS (Wi-Fi credentials, provisioning data)
            log('Mode: TARGETED UPDATE - preserving Wi-Fi and provisioning data');
            const [bootloaderData, partTableData, otaDataData, firmwareData] = await Promise.all([
                fetchBinary(FIRMWARE_FILES.bootloader),
                fetchBinary(FIRMWARE_FILES.partitionTable),
                fetchBinary(FIRMWARE_FILES.otaData),
                fetchBinary(FIRMWARE_FILES.firmware),
            ]);

            log(`Loaded: bootloader=${bootloaderData.length}B, partTable=${partTableData.length}B, otaData=${otaDataData.length}B, firmware=${firmwareData.length}B`);
            setProgress(10, 'Preparing storage partition...');

            // Generate storage partition
            const storageData = generateStoragePartition(
                isAdmin ? (parseInt(serialInput.value, 10) || 0) : 0,
                selectedConfig
            );
            log(`Storage partition: serial=${isAdmin ? serialInput.value : '0'}, config=${selectedConfig}`);

            setProgress(20, 'Writing firmware...');

            // Write all partitions (only sectors written are erased, NVS untouched)
            const fileArray = [
                { data: binaryToEspFormat(bootloaderData), address: FLASH_OFFSETS.bootloader },
                { data: binaryToEspFormat(partTableData), address: FLASH_OFFSETS.partitionTable },
                { data: binaryToEspFormat(storageData), address: FLASH_OFFSETS.storage },
                { data: binaryToEspFormat(otaDataData), address: FLASH_OFFSETS.otaData },
                { data: binaryToEspFormat(firmwareData), address: FLASH_OFFSETS.firmware },
            ];

            log('Writing all partitions (no full erase)...');
            await espTool.writeFlash({
                fileArray,
                flashSize: '4MB',
                flashMode: 'dio',
                flashFreq: '80m',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    const labels = ['Bootloader', 'Partition Table', 'Storage', 'OTA Data', 'Firmware'];
                    const baseProgress = 20;
                    const perFileWeight = [5, 2, 1, 2, 65];
                    let cumWeight = 0;
                    for (let i = 0; i < fileIndex; i++) cumWeight += perFileWeight[i];
                    const fileProgress = (written / total) * perFileWeight[fileIndex];
                    const totalProgress = Math.min(95, baseProgress + cumWeight + fileProgress);
                    setProgress(totalProgress, `Writing ${labels[fileIndex]}...`);
                },
            });
        }

        log('All partitions written successfully');
        setProgress(95, 'Resetting device...');

        // Hard reset
        try {
            await espTool.hardReset();
            log('Device reset');
        } catch (e) {
            log(`Reset note: ${e.message}`);
        }

        setProgress(100, 'Complete!');

        // Show success with conditional content based on erase mode
        setTimeout(() => {
            progressSection.classList.add('hidden');
            const didFullErase = fullEraseCheck.checked;
            if (didFullErase) {
                postStepApp.classList.remove('hidden');
                successNotePreserved.classList.add('hidden');
                successNoteErased.classList.remove('hidden');
            } else {
                postStepApp.classList.add('hidden');
                successNotePreserved.classList.remove('hidden');
                successNoteErased.classList.add('hidden');
            }
            successSection.classList.remove('hidden');
        }, 500);

        log('🎉 Firmware update complete!');

        // Disconnect
        isConnected = false;
        espTool = null;
        try {
            if (transport) await transport.disconnect();
        } catch (e) { /* ignore */ }
        transport = null;
        updateConnectionStatus(false);

    } catch (err) {
        log(`Flash failed: ${err.message}`);
        progressSection.classList.add('hidden');
        showError(err.message);

        // Try to disconnect cleanly
        isConnected = false;
        espTool = null;
        try {
            if (transport) await transport.disconnect();
        } catch (e) { /* ignore */ }
        transport = null;
        updateConnectionStatus(false);
    }
});

// ─── Reset / Retry ──────────────────────────────────────────────
resetBtn.addEventListener('click', resetAll);
retryBtn.addEventListener('click', resetAll);

function resetAll() {
    selectedConfig = null;
    selectedName = '';
    ampCards.forEach(c => c.classList.remove('selected'));
    flashContent.classList.remove('hidden');
    progressSection.classList.add('hidden');
    successSection.classList.add('hidden');
    errorSection.classList.add('hidden');
    // Reset conditional success elements:
    postStepApp.classList.add('hidden');
    successNotePreserved.classList.remove('hidden');
    successNoteErased.classList.add('hidden');
    updateUI();
}

// ─── Log Panel ──────────────────────────────────────────────────
logToggle.addEventListener('click', () => {
    logPanel.classList.toggle('hidden');
});

logClose.addEventListener('click', () => {
    logPanel.classList.add('hidden');
});

// ─── Helpers ────────────────────────────────────────────────────
async function fetchBinary(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

function generateStoragePartition(serial, config) {
    // 4KB storage partition
    // Byte 0-3: serial number (little-endian int32)
    // Byte 4-7: config (little-endian int32)
    // Rest: 0xFF (erased flash)
    const data = new Uint8Array(4096);
    data.fill(0xFF);

    // Write serial as little-endian int32 at offset 0
    const view = new DataView(data.buffer);
    view.setInt32(0, serial, true); // true = little-endian
    view.setInt32(4, config, true);

    return data;
}

function binaryToEspFormat(data) {
    // esptool-js expects the data as a string of binary characters
    let str = '';
    for (let i = 0; i < data.length; i++) {
        str += String.fromCharCode(data[i]);
    }
    return str;
}

function setProgress(percent, label) {
    progressBar.style.width = `${percent}%`;
    progressPercent.textContent = `${Math.round(percent)}%`;
    if (label) progressLabel.textContent = label;
}

function showError(message) {
    flashContent.classList.add('hidden');
    errorSection.classList.remove('hidden');
    errorMessage.textContent = message;
}

function updateConnectionStatus(connected, chipInfo) {
    if (connected) {
        statusDot.classList.add('connected');
        statusText.textContent = chipInfo ? `Connected (${chipInfo})` : 'Connected';
        connectBtn.textContent = 'Disconnect';
    } else {
        statusDot.classList.remove('connected');
        statusText.textContent = 'Not connected';
        connectBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v6m0 0l3-3m-3 3L9 5"/>
        <rect x="6" y="8" width="12" height="12" rx="2"/>
      </svg>
      Connect via USB
    `;
    }
}

function updateUI() {
    // Connect button
    connectBtn.disabled = selectedConfig === null;

    // Flash button
    flashBtn.disabled = !isConnected || selectedConfig === null;

    // Flash info
    if (selectedConfig !== null) {
        flashAmpName.textContent = selectedName;
        flashConfigValue.textContent = selectedConfig.toString();
    } else {
        flashAmpName.textContent = '-';
        flashConfigValue.textContent = '-';
    }

    // Serial info
    if (isAdmin) {
        flashSerialRow.classList.remove('hidden');
        flashSerialValue.textContent = serialInput.value || '0';
    } else {
        flashSerialRow.classList.add('hidden');
    }
}

// Update flash info when serial input changes
serialInput?.addEventListener('input', updateUI);

// ─── Check Web Serial Support ───────────────────────────────────
if (!('serial' in navigator)) {
    log('⚠ Web Serial API is not supported in this browser.');
    connectBtn.disabled = true;
    document.querySelector('.step-description').innerHTML = `
    <span style="color: var(--danger); font-weight: 600;">
      Your browser does not support Web Serial. 
      Please use Google Chrome or Microsoft Edge.
    </span>
  `;
}

// Init
log(`Acoustas AC650 Firmware Updater v${FIRMWARE_VERSION}`);
log('Ready - select your amplifier to begin.');
updateUI();
