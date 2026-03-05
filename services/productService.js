const { get, all, run } = require('../database/db');

/**
 * Find product by code, keyword, or partial match
 */
async function findProduct(query) {
    if (!query || query.trim() === '') {
        return null;
    }

    const searchQuery = query.toLowerCase().trim();

    // Try exact product code match first
    let product = await get('SELECT * FROM products WHERE LOWER(product_code) = ? AND is_active = 1', [searchQuery]);
    if (product) return product;

    // Try keyword match (case-insensitive)
    product = await get('SELECT * FROM products WHERE LOWER(keywords) LIKE ? AND is_active = 1', [`%${searchQuery}%`]);
    if (product) return product;

    // Try title/description partial match
    product = await get('SELECT * FROM products WHERE (LOWER(title) LIKE ? OR LOWER(description) LIKE ?) AND is_active = 1',
        [`%${searchQuery}%`, `%${searchQuery}%`]);

    return product;
}

/**
 * Get product by ID
 */
async function getProductById(productId) {
    return await get('SELECT * FROM products WHERE id = ?', [productId]);
}

/**
 * Get product by code
 */
async function getProductByCode(productCode) {
    return await get('SELECT * FROM products WHERE LOWER(product_code) = ? AND is_active = 1', [productCode.toLowerCase()]);
}

/**
 * Get all active products
 */
async function getAllProducts() {
    return await all('SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC');
}

/**
 * Create a new product
 */
async function createProduct(productCode, title, description, price, paymentQrImage, deliveryLink, keywords) {
    const result = await run(
        `INSERT INTO products (product_code, title, description, price, payment_qr_image, delivery_link, keywords)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [productCode, title, description, price, paymentQrImage, deliveryLink, keywords]
    );
    return result.lastID;
}

/**
 * Update product
 */
async function updateProduct(productId, updates) {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = ?`);
        values.push(value);
    }
    values.push(productId);

    const query = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
    await run(query, values);
}

/**
 * Delete product (deactivate)
 */
async function deleteProduct(productId) {
    await run('UPDATE products SET is_active = 0 WHERE id = ?', [productId]);
}

/**
 * Add Product (Convenience wrapper)
 */
async function addProduct(productCode, title, description, price, paymentQrImage, deliveryLink, keywords) {
    const kw = keywords || title.toLowerCase();
    return await createProduct(productCode, title, description, price, paymentQrImage || '', deliveryLink || '', kw);
}

/**
 * Format product details for WhatsApp message
 */
function formatProductMessage(product) {
    return `🛍️ *${product.title}*\n\n` +
        `💰 Price: ₹${product.price}\n\n` +
        `📝 ${product.description}\n\n` +
        `To purchase, scan the QR code below and complete the payment.\n` +
        `After payment, send the screenshot here.`;
}

module.exports = {
    findProduct,
    getProductById,
    getProductByCode,
    getAllProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    addProduct,
    formatProductMessage
};
