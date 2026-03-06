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

    // 3. Check time window (20 minutes) — uses AI-extracted paymentDateTime
    const paymentDT = aiResult.paymentDateTime;
    if (paymentDT && paymentDT !== 'Not found') {
        const isRecent = isPaymentRecent(paymentDT);
        console.log(`⏱️  Payment datetime: "${paymentDT}" → recent: ${isRecent}`);
        if (!isRecent) {
            validation.errors.push('❌ Payment is too old. Must be within the last 20 minutes.');
            return validation;
        }
    } else {
        console.log('⏱️  No payment datetime found in image — skipping time check');
    }

    // 4. Verification Logic
    const session = await get('SELECT id, product_price FROM user_session WHERE user_phone = ?', [userPhone]);
    const expectedAmount = session ? session.product_price : aiResult.productPrice;
    const sessionId = session ? session.id.toString() : '';
    const rawText = aiResult.rawText || '';

    const amountMatches = parseFloat(resolvedAmount) === parseFloat(expectedAmount);

    // ── Name Match ────────────────────────────────────────────────────
    // Check AI-extracted field first, then fall back to rawText scan.
    // rawText is safe for name (specific multi-char string, not a short number).
    const firstName = config.RECIPIENT_NAME.split(' ')[0].toUpperCase();
    const aiNameMatch = aiResult.recipientName &&
        aiResult.recipientName !== 'Not found' &&
        aiResult.recipientName.toUpperCase().includes(firstName);
    const rawNameMatch = rawText.toUpperCase().includes(firstName);
    const nameMatches = aiNameMatch || rawNameMatch;

    // ── UPI Match ─────────────────────────────────────────────────────
    const expectedUPI = config.RECIPIENT_UPI.toLowerCase().replace(/\s/g, '');
    const aiUpiMatch = aiResult.recipientUPI &&
        aiResult.recipientUPI !== 'Not found' &&
        aiResult.recipientUPI.toLowerCase().replace(/\s/g, '') === expectedUPI;
    const rawUpiMatch = rawText.toLowerCase().includes(expectedUPI);
    const upiMatches = aiUpiMatch || rawUpiMatch;

    // ── Session ID Match ──────────────────────────────────────────────
    // Use regex "(ID: X)" or "ID: X" so single-digit IDs like "4" don't
    // match trivially in long text — only when wrapped in the ID format.
    const idRegex = new RegExp(`\\(\\s*ID[:\\s]+${sessionId}\\s*\\)|\\bID[:\\s]+${sessionId}\\b`, 'i');
    const aiNoteMatch = aiResult.transactionNote &&
        aiResult.transactionNote !== 'Not found' &&
        aiResult.transactionNote.includes(sessionId);
    const rawNoteMatch = sessionId && idRegex.test(rawText);
    const noteContainsSessionId = aiNoteMatch || rawNoteMatch;

    // ── 4 Rules ───────────────────────────────────────────────────────
    const rule1 = nameMatches && noteContainsSessionId && amountMatches;
    const rule2 = upiMatches && amountMatches;
    const rule3 = noteContainsSessionId && amountMatches;
    const rule4 = nameMatches && amountMatches;

    console.log(`\n🔍 PAYMENT VALIDATION:`);
    console.log(`   Expected ₹${expectedAmount}  |  Resolved ₹${resolvedAmount}  |  match: ${amountMatches}`);
    console.log(`   Name match  : AI="${aiResult.recipientName}"  raw="${rawNameMatch}"  → ${nameMatches}`);
    console.log(`   UPI  match  : AI="${aiResult.recipientUPI}"   raw="${rawUpiMatch}"   → ${upiMatches}`);
    console.log(`   ID   match  : AI="${aiResult.transactionNote}" raw="${rawNoteMatch}" → ${noteContainsSessionId}`);
    console.log(`   Rule1(Name+ID+Amt):${rule1}  Rule2(UPI+Amt):${rule2}  Rule3(ID+Amt):${rule3}  Rule4(Name+Amt):${rule4}\n`);

    // FINAL VERDICT
    if (rule1 || rule2 || rule3 || rule4) {
        validation.isValid = true;
        await run(
            'INSERT INTO payment_verification_logs (user_phone, transaction_id, amount) VALUES (?, ?, ?)',
            [userPhone, transactionId, resolvedAmount]
        );
    } else {
        if (!amountMatches) {
            validation.errors.push(`Amount mismatch. Expected ₹${expectedAmount} but found ₹${resolvedAmount}.`);
        } else if (!nameMatches && !upiMatches) {
            validation.errors.push(`We couldn't match the recipient details. Please make sure you paid to the correct account.`);
        } else {
            validation.errors.push(`Payment verification incomplete. Please ensure the payment was made to the correct account.`);
        }
    }

    validation.transactionId = transactionId;
    return validation;
}

/**
 * Check if a payment datetime string (extracted by AI) is within the last 20 minutes.
 * Handles:
 *   - "06/03/2026 11:30 PM"  (full date + 12h)
 *   - "2026-03-06 23:30"     (full date + 24h)
 *   - "Mar 6 2026 11:30"     (verbose + 24h)
 *   - "11:30 PM" / "23:30"   (time only → assume today)
 *   - "just now", "2 mins ago", "3 minutes ago"
 *   - "6 Mar, 11:30 PM"
 */
function isPaymentRecent(rawDateTime) {
    if (!rawDateTime) return false;
    const text = rawDateTime.trim();

    // ── Relative strings ─────────────────────────────────────────
    const lower = text.toLowerCase();
    if (/just\s*now|sekand|second/.test(lower)) return true;
    const relMin = lower.match(/(\d+)\s*min/);
    if (relMin) return parseInt(relMin[1]) <= 20;
    if (/\d+\s*hour|\d+\s*hr|\d+\s*day/.test(lower)) return false;

    const now = new Date();

    // ── Helper: build a Date from hours, minutes, optional am/pm, optional date ─
    const buildDate = (h, m, ampm, dateMs) => {
        let hour = parseInt(h);
        const min = parseInt(m);
        if (ampm) {
            const isPM = /pm/i.test(ampm);
            if (isPM && hour < 12) hour += 12;
            if (!isPM && hour === 12) hour = 0;
        }
        const base = dateMs ? new Date(dateMs) : new Date(now);
        base.setHours(hour, min, 0, 0);
        return base;
    };

    const withinWindow = (d) => {
        if (!d || isNaN(d)) return false;
        const diffMin = (now - d) / 60000;
        // Allow -2 to +20 min (slight clock skew tolerance)
        return diffMin >= -2 && diffMin <= 20;
    };

    // ── Try: DD/MM/YYYY HH:MM [AM|PM] ─  or  YYYY-MM-DD HH:MM ───
    const fullDT = text.match(
        /(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i
    );
    if (fullDT) {
        const [, d, mo, yr, h, m, ap] = fullDT;
        const ms = new Date(`${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`).getTime();
        if (!isNaN(ms)) return withinWindow(buildDate(h, m, ap, ms));
    }

    // YYYY-MM-DD HH:MM
    const isoFull = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (isoFull) {
        const [, yr, mo, d, h, m, ap] = isoFull;
        const ms = new Date(`${yr}-${mo}-${d}`).getTime();
        if (!isNaN(ms)) return withinWindow(buildDate(h, m, ap, ms));
    }

    // ── "Mar 6 2026 11:30 PM" or "6 Mar 2026 11:30" ───────────────
    const verboseDT = text.match(
        /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i
    ) || text.match(
        /([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i
    );
    if (verboseDT) {
        const parsed = new Date(text);
        if (!isNaN(parsed)) return withinWindow(parsed);
    }

    // ── "6 Mar, 11:30 PM" — day+month+time (assume current year) ─
    const dmTime = text.match(
        /(\d{1,2})\s+([A-Za-z]{3,9})[,\s]+(\d{1,2}):(\d{2})\s*(am|pm)?/i
    );
    if (dmTime) {
        const [, d, mon, h, m, ap] = dmTime;
        const ms = new Date(`${d} ${mon} ${now.getFullYear()}`).getTime();
        if (!isNaN(ms)) return withinWindow(buildDate(h, m, ap, ms));
    }

    // ── Time-only: "11:30 PM" / "23:30" — assume today ───────────
    const timeOnly = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (timeOnly) {
        const [, h, m, ap] = timeOnly;
        const d = buildDate(h, m, ap, null);
        // If result is in the future by more than 2 min, assume it was yesterday
        if (d > now && (d - now) / 60000 > 2) d.setDate(d.getDate() - 1);
        return withinWindow(d);
    }

    // Could not parse — don't block, log and pass
    console.warn('⚠️  Could not parse payment datetime:', rawDateTime);
    return true;
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
