const { run, get, all } = require('../database/db');
const { getProductById, getProductByCode } = require('./productService');

/**
 * Create or update user session for a product
 */
async function createSession(userPhone, productCode) {
    try {
        const product = await getProductByCode(productCode);
        if (!product) {
            return { error: `Product ${productCode} not found` };
        }

        // Create/overwrite session
        await run(
            `INSERT OR REPLACE INTO user_session 
            (user_phone, product_id, product_code, product_price, status, session_started_at)
            VALUES (?, ?, ?, ?, 'WAITING_PAYMENT', CURRENT_TIMESTAMP)`,
            [userPhone, product.id, productCode, product.price]
        );

        return { 
            success: true, 
            product: {
                id: product.id,
                code: productCode,
                title: product.title,
                price: product.price,
                description: product.description
            }
        };
    } catch (error) {
        console.error('Error creating session:', error);
        return { error: error.message };
    }
}

/**
 * Get user's current session
 */
async function getSession(userPhone) {
    try {
        const session = await get(
            'SELECT * FROM user_session WHERE user_phone = ?',
            [userPhone]
        );
        
        if (session) {
            const product = await getProductById(session.product_id);
            return {
                ...session,
                product
            };
        }
        return null;
    } catch (error) {
        console.error('Error getting session:', error);
        return null;
    }
}

/**
 * Update session with OCR data
 */
async function updateSessionWithOCR(userPhone, ocrText, ocrAmount) {
    try {
        await run(
            `UPDATE user_session 
            SET ocr_text = ?, ocr_amount = ?
            WHERE user_phone = ?`,
            [ocrText, ocrAmount, userPhone]
        );
        return true;
    } catch (error) {
        console.error('Error updating session with OCR:', error);
        return false;
    }
}

/**
 * Update session with screenshot path
 */
async function updateSessionWithScreenshot(userPhone, screenshotPath) {
    try {
        await run(
            `UPDATE user_session 
            SET payment_screenshot_path = ?
            WHERE user_phone = ?`,
            [screenshotPath, userPhone]
        );
        return true;
    } catch (error) {
        console.error('Error updating session with screenshot:', error);
        return false;
    }
}

/**
 * End/clear session
 */
async function endSession(userPhone) {
    try {
        await run(
            'DELETE FROM user_session WHERE user_phone = ?',
            [userPhone]
        );
        return true;
    } catch (error) {
        console.error('Error ending session:', error);
        return false;
    }
}

/**
 * Check if user has active session
 */
async function hasActiveSession(userPhone) {
    const session = await getSession(userPhone);
    return session !== null;
}

/**
 * Get all active sessions (for admin)
 */
async function getAllActiveSessions() {
    try {
        const sessions = await all(
            `SELECT s.*, p.title, p.price 
            FROM user_session s
            JOIN products p ON s.product_id = p.id
            ORDER BY s.session_started_at DESC`
        );
        return sessions;
    } catch (error) {
        console.error('Error getting active sessions:', error);
        return [];
    }
}

module.exports = {
    createSession,
    getSession,
    updateSessionWithOCR,
    updateSessionWithScreenshot,
    endSession,
    hasActiveSession,
    getAllActiveSessions
};
