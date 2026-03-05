const { get, all, run } = require('../database/db');

/**
 * Create a new order
 */
async function createOrder(userPhone, productId) {
    const result = await run(
        `INSERT INTO orders (user_phone, product_id, status)
         VALUES (?, ?, 'PRODUCT_SELECTED')`,
        [userPhone, productId]
    );
    return result.lastID;
}

/**
 * Get order by ID
 */
async function getOrderById(orderId) {
    return await get('SELECT * FROM orders WHERE id = ?', [orderId]);
}

/**
 * Get pending orders for user
 */
async function getPendingOrderForUser(userPhone) {
    return await get(
        `SELECT o.* FROM orders o
         WHERE o.user_phone = ? AND o.status IN ('PRODUCT_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_VERIFICATION')
         ORDER BY o.created_at DESC LIMIT 1`,
        [userPhone]
    );
}

/**
 * Get all orders for user
 */
async function getUserOrders(userPhone) {
    return await all(
        'SELECT * FROM orders WHERE user_phone = ? ORDER BY created_at DESC',
        [userPhone]
    );
}

/**
 * Update order status
 */
async function updateOrderStatus(orderId, status) {
    await run(
        'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, orderId]
    );
}

/**
 * Record payment screenshot
 */
async function recordPaymentScreenshot(orderId, screenshotPath) {
    await run(
        'UPDATE orders SET payment_screenshot_path = ?, status = ? WHERE id = ?',
        [screenshotPath, 'PAYMENT_VERIFICATION', orderId]
    );
}

/**
 * Mark payment as verified
 */
async function markPaymentVerified(orderId, amount, transactionId) {
    await run(
        `UPDATE orders 
         SET payment_verified = 1, payment_amount = ?, payment_transaction_id = ?, 
             status = 'COMPLETED', verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [amount, transactionId, orderId]
    );
}

/**
 * Mark order as failed
 */
async function markOrderFailed(orderId) {
    await run(
        'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['FAILED', orderId]
    );
}

/**
 * Get completed orders count (for analytics)
 */
async function getCompletedOrdersCount(date = null) {
    if (date) {
        return await get(
            `SELECT COUNT(*) as count FROM orders 
             WHERE status = 'COMPLETED' AND DATE(created_at) = ?`,
            [date]
        );
    }
    return await get('SELECT COUNT(*) as count FROM orders WHERE status = ?', ['COMPLETED']);
}

/**
 * Get total revenue (for analytics)
 */
async function getTotalRevenue(date = null) {
    let query = 'SELECT SUM(CAST(payment_amount as REAL)) as total FROM orders WHERE status = ?';
    let params = ['COMPLETED'];

    if (date) {
        query += ' AND DATE(created_at) = ?';
        params.push(date);
    }

    const result = await get(query, params);
    return result.total || 0;
}

module.exports = {
    createOrder,
    getOrderById,
    getPendingOrderForUser,
    getUserOrders,
    updateOrderStatus,
    recordPaymentScreenshot,
    markPaymentVerified,
    markOrderFailed,
    getCompletedOrdersCount,
    getTotalRevenue
};
