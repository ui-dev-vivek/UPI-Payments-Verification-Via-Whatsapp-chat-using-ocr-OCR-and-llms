const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'bot.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database at', dbPath);
    }
});

/**
 * Initialize database tables
 */
function initializeDatabase() {
    db.serialize(() => {
        // Products table
        db.run(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_code TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                price REAL NOT NULL,
                payment_qr_image TEXT,
                delivery_link TEXT,
                keywords TEXT,
                is_active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) console.error('Error creating products table:', err);
            else console.log('Products table ready');
        });

        // Orders table
        db.run(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_phone TEXT NOT NULL,
                product_id INTEGER NOT NULL,
                status TEXT DEFAULT 'NEW_USER',
                payment_screenshot_path TEXT,
                payment_verified BOOLEAN DEFAULT 0,
                payment_amount TEXT,
                payment_transaction_id TEXT,
                verified_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )
        `, (err) => {
            if (err) console.error('Error creating orders table:', err);
            else console.log('Orders table ready');
        });

        // Messages table (for conversation context)
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_phone TEXT NOT NULL,
                message TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) console.error('Error creating messages table:', err);
            else console.log('Messages table ready');
        });

        // User state tracking
        db.run(`
            CREATE TABLE IF NOT EXISTS user_state (
                user_phone TEXT PRIMARY KEY,
                current_state TEXT DEFAULT 'NEW_USER',
                current_product_id INTEGER,
                pending_order_id INTEGER,
                reminder_sent_at DATETIME,
                last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (current_product_id) REFERENCES products(id),
                FOREIGN KEY (pending_order_id) REFERENCES orders(id)
            )
        `, (err) => {
            if (err) console.error('Error creating user_state table:', err);
            else console.log('User state table ready');
        });

        // User session table (one session = one product = one payment)
        db.run(`
            CREATE TABLE IF NOT EXISTS user_session (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_phone TEXT UNIQUE NOT NULL,
                product_id INTEGER NOT NULL,
                product_code TEXT NOT NULL,
                product_price REAL NOT NULL,
                ocr_text TEXT,
                ocr_amount TEXT,
                status TEXT DEFAULT 'WAITING_PAYMENT',
                session_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                payment_screenshot_path TEXT,
                FOREIGN KEY (product_id) REFERENCES products(id)
            )
        `, (err) => {
            if (err) console.error('Error creating user_session table:', err);
            else console.log('User session table ready');
        });

        // Payment logs to prevent duplicate transactions
        db.run(`
            CREATE TABLE IF NOT EXISTS payment_verification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_phone TEXT NOT NULL,
                transaction_id TEXT UNIQUE NOT NULL,
                amount REAL NOT NULL,
                verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if (err) console.error('Error creating payment_verification_logs table:', err);
            else console.log('Payment verification logs table ready');
        });

        // Analytics table
        db.run(`
            CREATE TABLE IF NOT EXISTS analytics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT,
                total_orders INTEGER DEFAULT 0,
                successful_payments INTEGER DEFAULT 0,
                failed_payments INTEGER DEFAULT 0,
                total_revenue REAL DEFAULT 0,
                UNIQUE(date)
            )
        `, (err) => {
            if (err) console.error('Error creating analytics table:', err);
            else console.log('Analytics table ready');
        });
    });
}

/**
 * Helper function to run queries with promises
 */
function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

/**
 * Helper function to get a single row
 */
function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

/**
 * Helper function to get all rows
 */
function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

module.exports = {
    db,
    initializeDatabase,
    run,
    get,
    all
};
