const { get, run, all } = require('../database/db');
const { verifyWithAI } = require('./aiService');
const config = require('../config/env');

/**
 * Verify payment from screenshot
 */
async function verifyPaymentScreenshot(ocrText) {
    try {
        const verification = await verifyWithAI(ocrText);
        return verification;
    } catch (error) {
        console.error('Error verifying payment with AI:', error);
        return {
            amount: 'Not found',
            transactionId: 'Not found',
            timeAgo: 'Not found',
            isVerified: false,
            reason: 'Error processing screenshot'
        };
    }
}

/**
 * Strict payment validation
 * Checks:
 * 1. Scenario A: RECIPIENT_NAME matches AND unique Session ID found in description
 * 2. Scenario B: RECIPIENT_UPI matches AND amount matches exactly
 * 3. Payment must be within 20 minutes
 * 4. Transaction ID must not have been processed before
 */
async function strictPaymentValidation(aiResult, userPhone) {
    const validation = {
        isValid: false,
        errors: [],
        amount: aiResult.amount,
        transactionId: aiResult.transactionId
    };

    // 1. Amount — AI result first, OCR numeric fallback
    //    AI sometimes says 'Not found' for garbled text even though OCR got it right.
    let resolvedAmount = aiResult.amount;
    if (!resolvedAmount || resolvedAmount === 'Not found') {
        if (aiResult.ocrAmount != null) {
            resolvedAmount = String(aiResult.ocrAmount);
            console.log(`⚠️  AI missed amount — using OCR fallback: ${resolvedAmount}`);
        }
    }
    // Strip any ₹ / Rs prefix so parseFloat works cleanly
    resolvedAmount = resolvedAmount ? resolvedAmount.replace(/[^\d.]/g, '') : null;
    validation.amount = resolvedAmount;

    if (!resolvedAmount || resolvedAmount === '') {
        validation.errors.push('❌ Payment amount not found');
        return validation;
    }

    // 2. Transaction ID
    const transactionId = (aiResult.transactionId && aiResult.transactionId !== 'Not found')
        ? aiResult.transactionId
        : `MANUAL_${Date.now()}`;

    // 3. Check for duplicate transaction
    if (aiResult.transactionId && aiResult.transactionId !== 'Not found') {
        const isDuplicate = await get('SELECT id FROM payment_verification_logs WHERE transaction_id = ?', [aiResult.transactionId]);
        if (isDuplicate) {
            validation.errors.push('❌ This transaction has already been processed and used.');
            return validation;
        }
    }

    // 3. Check time window (20 minutes)
    if (aiResult.timeAgo && aiResult.timeAgo !== 'Not found') {
        const isRecent = isPaymentRecent(aiResult.timeAgo);
        if (!isRecent) {
            validation.errors.push('❌ Payment is too old. It must be within the last 20 minutes.');
            return validation;
        }
    }

    // 4. Verification Logic
    const session = await get('SELECT id, product_price FROM user_session WHERE user_phone = ?', [userPhone]);
    const expectedAmount = session ? session.product_price : aiResult.productPrice;
    const sessionId = session ? session.id.toString() : '';

    let scenarioAMatch = false;
    let scenarioBMatch = false;

    // SCENARIO A: Name Match + Session ID in Note/Description
    const nameMatches = aiResult.recipientName &&
        aiResult.recipientName.toUpperCase().includes(config.RECIPIENT_NAME.split(' ')[0].toUpperCase());

    // Check if AI extracted Note contains the unique session ID or if OCR Raw text contains it
    const noteContainsSessionId = (aiResult.transactionNote && aiResult.transactionNote.includes(sessionId)) ||
        (sessionId && aiResult.rawText && aiResult.rawText.includes(sessionId));

    if (nameMatches && noteContainsSessionId) {
        scenarioAMatch = true;
    }

    // SCENARIO B: UPI Match + Amount Match
    const upiMatches = aiResult.recipientUPI && aiResult.recipientUPI.toLowerCase() === config.RECIPIENT_UPI.toLowerCase();
    const amountMatches = parseFloat(resolvedAmount) === parseFloat(expectedAmount);

    if (upiMatches && amountMatches) {
        scenarioBMatch = true;
    }

    // FINAL VERDICT
    if (scenarioAMatch || scenarioBMatch) {
        // Double check amount
        if (parseFloat(resolvedAmount) === parseFloat(expectedAmount)) {
            validation.isValid = true;
            await run(
                'INSERT INTO payment_verification_logs (user_phone, transaction_id, amount) VALUES (?, ?, ?)',
                [userPhone, transactionId, resolvedAmount]
            );
        } else {
            validation.errors.push(`❌ Amount mismatch. Expected ₹${expectedAmount}, found ₹${resolvedAmount}`);
        }
    } else {
        if (!nameMatches && !upiMatches) {
            validation.errors.push(`❌ Payment recipient does not match ${config.RECIPIENT_NAME} or ${config.RECIPIENT_UPI}`);
        } else if (nameMatches && !noteContainsSessionId) {
            validation.errors.push(`❌ Unique Payment ID (${sessionId}) not found in payment description/note`);
        } else if (upiMatches && !amountMatches) {
            validation.errors.push(`❌ Amount mismatch. Expected ₹${expectedAmount}, found ₹${resolvedAmount}`);
        }
    }

    validation.transactionId = transactionId;
    return validation;
}

/**
 * Check if payment time is within acceptable window (20 minutes)
 */
function isPaymentRecent(timeAgoText) {
    const text = timeAgoText.toLowerCase();

    // Parse time ago text
    const minutes = text.match(/(\d+)\s*min/);
    const hours = text.match(/(\d+)\s*hour/);
    const days = text.match(/(\d+)\s*day/);

    if (minutes) {
        return parseInt(minutes[1]) <= 20;
    }
    if (hours) {
        return false; // More than 1 hour ago
    }
    if (days) {
        return false; // More than 1 day ago
    }

    // If it says "just now" or "1 minute ago"
    if (text.includes('just now') || text.includes('second')) {
        return true;
    }

    // NEW: Handle full date formats (e.g., 04/03/2026 or 4 Mar 2026)
    // If the screenshot has a full date that matches today's date, 
    // it's likely recent; AI would still extract time.
    const now = new Date();
    const todayStr = now.toLocaleDateString();
    if (text.includes(todayStr) || text.includes(now.getFullYear().toString())) {
        // If it includes today's date, it's safer, but we still need the time check
    }

    // NEW: Handle time formats like "11:06 PM" or "23:06"
    const timeMatch = text.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
    if (timeMatch) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const ampm = timeMatch[3];

        const paymentDate = new Date(now);

        let adjustedHours = hours;
        if (ampm) {
            const isPM = ampm.toLowerCase() === 'pm';
            if (isPM && hours < 12) adjustedHours += 12;
            if (!isPM && hours === 12) adjustedHours = 0;
        }

        paymentDate.setHours(adjustedHours);
        paymentDate.setMinutes(minutes);
        paymentDate.setSeconds(0);

        // If paymentDate seems to be in the future (e.g., 11:59pm message at 12:05am)
        // Adjust for day boundary if needed, but 20 min window is usually tight.
        const diffMs = now - paymentDate;
        const diffMin = diffMs / (1000 * 60);

        // Allow 20 mins window, and 5 mins "buffer" for slight clock drift
        return diffMin >= -5 && diffMin <= 20;
    }

    return false;
}

/**
 * Log payment verification attempt
 */
async function logPaymentAttempt(userPhone, orderId, isVerified, amount, transactionId) {
    try {
        await run(
            `INSERT INTO messages (user_phone, message, role)
             VALUES (?, ?, 'system')`,
            [userPhone, `Payment verification attempt - Verified: ${isVerified}, Amount: ${amount}, TX: ${transactionId}`, 'system']
        );
    } catch (e) {
        // Silently fail logging if error
    }
}

/**
 * Check if payment was already made for this order (to prevent duplicate processing)
 */
async function isPaymentAlreadyProcessed(orderId) {
    const order = await get('SELECT payment_verified FROM orders WHERE id = ?', [orderId]);
    return order && order.payment_verified === 1;
}

/**
 * Get payment status for order
 */
async function getPaymentStatus(orderId) {
    const order = await get(
        'SELECT status, payment_verified, payment_amount, payment_transaction_id FROM orders WHERE id = ?',
        [orderId]
    );
    return order;
}

module.exports = {
    verifyPaymentScreenshot,
    strictPaymentValidation,
    isPaymentRecent,
    logPaymentAttempt,
    isPaymentAlreadyProcessed,
    getPaymentStatus
};
