const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { initializeDatabase } = require('../database/db');
const { handleMessage, handlePaymentScreenshot } = require('../controllers/messageController');

// Initialize database
initializeDatabase();

// Cleanup stale lock files before initialization
const sessionPath = path.join(__dirname, '../.wwebjs_auth/session');
const lockFiles = ['chrome-lock', 'SingletonLock', '.chrome-lock'];
lockFiles.forEach(lockFile => {
    const lockPath = path.join(sessionPath, lockFile);
    try {
        if (fs.existsSync(lockPath)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            console.log(`Cleaned up stale lock file: ${lockFile}`);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
});

// Create WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: config.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--disable-popup-blocking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-service-autorun',
            '--password-store=basic',
            '--use-mock-keychain'
        ],
        timeout: 90000,
        slowMo: 100
    }
});

// QR Code generation for login
client.on('qr', (qr) => {
    console.log('\n========================================');
    console.log('Scan the QR code below to login to WhatsApp:');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
});

// Ready event
client.on('ready', () => {
    console.log('\n========================================');
    console.log('✅ WhatsApp Bot is Ready!');
    console.log('========================================\n');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
});

// Disconnected event
client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
});

// Message event handler
client.on('message', async (msg) => {
    const sender = msg.from;

    // Check if number is in allowed list
    // if (!config.ALLOWED_NUMBERS.includes(sender)) {
    //     console.log(`[BLOCKED] Message from unauthorized number: ${sender}`);
    //     return;
    // }

    console.log(`[MESSAGE] From: ${sender}, Type: ${msg.type}`);

    try {
        // Handle image messages (payment screenshots)
        if (msg.hasMedia && msg.type === 'image') {
            const media = await msg.downloadMedia();
            if (media) {
                await handlePaymentScreenshot(sender, media, client);
            }
        }
        // Handle text messages (product queries)
        else if (msg.type === 'chat') {
            const messageText = msg.body.trim();
            if (messageText) {
                await handleMessage(sender, messageText, client);
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
        // Don't try to send error message as it may cause cascading errors
        try {
            await client.sendMessage(sender, '⚠️ An error occurred. Please try again later.');
        } catch (sendError) {
            console.error('Failed to send error message:', sendError.message);
        }
    }
});

// Initialize client
async function initializeClientWithRetry(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`\n[Attempt ${attempt}/${maxRetries}] Initializing WhatsApp client...`);
            await client.initialize();
            console.log('✅ Client initialized successfully!');
            return;
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed: ${error.message}`);
            
            // Cleanup on error
            try {
                await client.destroy();
            } catch (e) {
                // Ignore cleanup errors
            }
            
            if (attempt === maxRetries) {
                console.error('\n❌ Failed to initialize client after all retries');
                
                // Provide diagnostic guidance
                if (error.message.includes('Navigating frame was detached')) {
                    console.error('\n⚠️  Frame detachment during navigation');
                    console.error('   This may indicate Chrome process instability');
                    console.error('\n   Suggestions:');
                    console.error('   1. Verify Chrome installation: /usr/bin/google-chrome-stable --version');
                    console.error('   2. Check for Chrome crashes: dmesg | grep -i chrome');
                    console.error('   3. Ensure sufficient disk space: df -h');
                    console.error('   4. Try clearing Chrome cache: rm -rf ~/.config/google-chrome/Default/Cache');
                } else if (error.message.includes('Execution context was destroyed')) {
                    console.error('\n⚠️  Chrome crashed during initialization');
                    console.error('   Possible causes: Missing dependencies, memory issues, permissions');
                }
                process.exit(1);
            }
            
            // Wait before retrying with exponential backoff
            const waitTime = Math.pow(2, attempt - 1) * 2000;
            console.log(`Waiting ${waitTime}ms before retry...\n`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}

initializeClientWithRetry();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down bot...');
    try {
        await client.destroy();
    } catch (e) {
        console.error('Error during shutdown:', e.message);
    }
    process.exit(0);
});

module.exports = client;
