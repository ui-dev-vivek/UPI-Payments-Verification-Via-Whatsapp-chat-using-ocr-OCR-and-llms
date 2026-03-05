const { get, run, all } = require('../database/db');

/**
 * Add product to user's cart
 */
async function addToCart(userPhone, productId) {
    // Remove existing cart item if any
    await run('DELETE FROM user_cart WHERE user_phone = ?', [userPhone]);
    
    // Add new item
    const result = await run(
        `INSERT INTO user_cart (user_phone, product_id, confirmation_pending)
         VALUES (?, ?, 1)`,
        [userPhone, productId]
    );
    return result.lastID;
}

/**
 * Get user's current cart
 */
async function getUserCart(userPhone) {
    return await get(
        `SELECT c.*, p.title, p.price, p.description, p.delivery_link, p.product_code
         FROM user_cart c
         JOIN products p ON c.product_id = p.id
         WHERE c.user_phone = ?`,
        [userPhone]
    );
}

/**
 * Confirm cart (ready for payment)
 */
async function confirmCart(userPhone) {
    await run(
        'UPDATE user_cart SET confirmation_pending = 0 WHERE user_phone = ?',
        [userPhone]
    );
}

/**
 * Clear user's cart
 */
async function clearCart(userPhone) {
    await run('DELETE FROM user_cart WHERE user_phone = ?', [userPhone]);
}

/**
 * Check if user has pending cart
 */
async function hasPendingCart(userPhone) {
    const cart = await get(
        'SELECT * FROM user_cart WHERE user_phone = ? AND confirmation_pending = 1',
        [userPhone]
    );
    return !!cart;
}

module.exports = {
    addToCart,
    getUserCart,
    confirmCart,
    clearCart,
    hasPendingCart
};
