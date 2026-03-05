const { all, get } = require('../database/db');

/**
 * Get products with pagination
 */
async function getProductsPage(pageNumber = 1, pageSize = 5) {
    const offset = (pageNumber - 1) * pageSize;
    const products = await all(
        `SELECT * FROM products WHERE is_active = 1 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
        [pageSize, offset]
    );
    
    const countResult = await get('SELECT COUNT(*) as total FROM products WHERE is_active = 1');
    const totalPages = Math.ceil(countResult.total / pageSize);
    
    return {
        products,
        page: pageNumber,
        totalPages,
        totalProducts: countResult.total
    };
}

/**
 * Get orders with pagination
 */
async function getOrdersPage(pageNumber = 1, pageSize = 5) {
    const offset = (pageNumber - 1) * pageSize;
    const orders = await all(
        `SELECT o.*, p.title as product_title 
         FROM orders o
         JOIN products p ON o.product_id = p.id
         ORDER BY o.created_at DESC 
         LIMIT ? OFFSET ?`,
        [pageSize, offset]
    );
    
    const countResult = await get('SELECT COUNT(*) as total FROM orders');
    const totalPages = Math.ceil(countResult.total / pageSize);
    
    return {
        orders,
        page: pageNumber,
        totalPages,
        totalOrders: countResult.total
    };
}

/**
 * Get last 5 transactions
 */
async function getLastTransactions(limit = 5) {
    return await all(
        `SELECT o.id, o.user_phone, o.created_at, o.payment_amount, 
                o.status, p.title
         FROM orders o
         JOIN products p ON o.product_id = p.id
         WHERE o.status = 'COMPLETED'
         ORDER BY o.created_at DESC 
         LIMIT ?`,
        [limit]
    );
}

/**
 * Get today's total earnings
 */
async function getTodayEarnings() {
    const today = new Date().toISOString().split('T')[0];
    const result = await get(
        `SELECT COUNT(*) as completed_orders, 
                COALESCE(SUM(CAST(payment_amount as REAL)), 0) as total_revenue
         FROM orders 
         WHERE status = 'COMPLETED' AND DATE(created_at) = ?`,
        [today]
    );
    return result;
}

/**
 * Get unverified payments
 */
async function getUnverifiedPayments() {
    return await all(
        `SELECT id, user_phone, product_id, created_at
         FROM orders 
         WHERE status = 'PAYMENT_VERIFICATION'
         ORDER BY created_at DESC`
    );
}

/**
 * Get product-wise collection
 */
async function getProductWiseCollection() {
    return await all(
        `SELECT p.title, p.product_code, p.price, 
                COUNT(o.id) as total_sales,
                COALESCE(SUM(CAST(o.payment_amount as REAL)), 0) as total_revenue,
                COUNT(CASE WHEN o.status = 'COMPLETED' THEN 1 END) as successful_sales
         FROM products p
         LEFT JOIN orders o ON p.id = o.product_id AND o.status = 'COMPLETED'
         GROUP BY p.id
         ORDER BY total_revenue DESC`
    );
}

/**
 * Format products for display
 */
function formatProductsList(productsData) {
    let msg = `📦 *PRODUCTS* (Page ${productsData.page}/${productsData.totalPages})\n\n`;
    
    productsData.products.forEach((p, idx) => {
        msg += `${idx + 1}. *${p.product_code}* - ${p.title}\n`;
        msg += `   💰 ₹${p.price}\n`;
    });
    
    msg += `\n📄 Total Products: ${productsData.totalProducts}`;
    if (productsData.totalPages > 1) {
        msg += `\n\nReply: "products ${productsData.page + 1}" for next page`;
    }
    return msg;
}

/**
 * Format orders for display
 */
function formatOrdersList(ordersData) {
    let msg = `📋 *ORDERS* (Page ${ordersData.page}/${ordersData.totalPages})\n\n`;
    
    ordersData.orders.forEach((o, idx) => {
        msg += `${idx + 1}. Order ID: ${o.id}\n`;
        msg += `   User: ${o.user_phone}\n`;
        msg += `   Product: ${o.product_title}\n`;
        msg += `   Status: ${o.status}\n`;
        msg += `   Date: ${o.created_at}\n\n`;
    });
    
    msg += `📊 Total Orders: ${ordersData.totalOrders}`;
    if (ordersData.totalPages > 1) {
        msg += `\n\nReply: "orders ${ordersData.page + 1}" for next page`;
    }
    return msg;
}

/**
 * Format transactions for display
 */
function formatTransactionsList(transactions) {
    let msg = `💳 *LAST 5 TRANSACTIONS*\n\n`;
    
    transactions.forEach((t, idx) => {
        const date = new Date(t.created_at).toLocaleString('en-IN');
        msg += `${idx + 1}. *${t.product_title}*\n`;
        msg += `   Amount: ₹${t.payment_amount}\n`;
        msg += `   User: ${t.user_phone}\n`;
        msg += `   Date: ${date}\n\n`;
    });
    
    return msg;
}

/**
 * Format earnings for display
 */
function formatEarnings(earnings) {
    return `💹 *TODAY'S EARNINGS*\n\n` +
           `✅ Completed Orders: ${earnings.completed_orders}\n` +
           `💰 Total Revenue: ₹${earnings.total_revenue}\n\n` +
           `Date: ${new Date().toLocaleDateString('en-IN')}`;
}

/**
 * Format unverified payments
 */
function formatUnverifiedPayments(payments) {
    if (payments.length === 0) {
        return '✅ No unverified payments!';
    }
    
    let msg = `⏳ *UNVERIFIED PAYMENTS (${payments.length})*\n\n`;
    
    payments.forEach((p, idx) => {
        const date = new Date(p.created_at).toLocaleString('en-IN');
        msg += `${idx + 1}. Order ID: ${p.id}\n`;
        msg += `   User: ${p.user_phone}\n`;
        msg += `   Date: ${date}\n\n`;
    });
    
    return msg;
}

/**
 * Format product-wise collection
 */
function formatProductCollection(collections) {
    let msg = `📊 *PRODUCT-WISE COLLECTION*\n\n`;
    
    collections.forEach((c, idx) => {
        msg += `${idx + 1}. *${c.title}* (${c.product_code})\n`;
        msg += `   Price: ₹${c.price}\n`;
        msg += `   Sales: ${c.successful_sales}/${c.total_sales}\n`;
        msg += `   Revenue: ₹${c.total_revenue}\n\n`;
    });
    
    return msg;
}

module.exports = {
    getProductsPage,
    getOrdersPage,
    getLastTransactions,
    getTodayEarnings,
    getUnverifiedPayments,
    getProductWiseCollection,
    formatProductsList,
    formatOrdersList,
    formatTransactionsList,
    formatEarnings,
    formatUnverifiedPayments,
    formatProductCollection
};
