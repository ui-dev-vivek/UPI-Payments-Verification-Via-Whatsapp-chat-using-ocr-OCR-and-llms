const { run, all } = require('../database/db');

/**
 * Save message to conversation history
 */
async function saveMessage(userPhone, message, role = 'user') {
    await run(
        'INSERT INTO messages (user_phone, message, role) VALUES (?, ?, ?)',
        [userPhone, message, role]
    );
}

/**
 * Get conversation history for user (last N messages)
 */
async function getConversationHistory(userPhone, limit = 10) {
    return await all(
        'SELECT * FROM messages WHERE user_phone = ? ORDER BY created_at DESC LIMIT ? ',
        [userPhone, limit]
    );
}

/**
 * Schedule a reminder for payment
 */
async function schedulePaymentReminder(userPhone, orderId, delayMs) {
    return new Promise((resolve) => {
        setTimeout(async () => {
            await saveMessage(
                userPhone,
                `[SYSTEM] Payment reminder scheduled for order ${orderId}`,
                'system'
            );
            resolve(true);
        }, delayMs);
    });
}

/**
 * Send admin notification (logs it)
 */
async function logAdminNotification(adminNumber, message) {
    await saveMessage(
        adminNumber,
        `[ADMIN NOTIFICATION] ${message}`,
        'system'
    );
}

module.exports = {
    saveMessage,
    getConversationHistory,
    schedulePaymentReminder,
    logAdminNotification
};
