require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const config = require('./config/env');

// Import bot
const client = require('./bot/whatsapp');

const app = express();

// View Engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin Routes
const adminRoutes = require('./routes/adminRoutes');
app.use('/admin', adminRoutes);

// Root redirect
app.get('/', (req, res) => res.redirect('/admin/products'));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Bot is running' });
});

// Start server
const port = config.PORT;
app.listen(port, () => {
    console.log(`\n========================================`);
    console.log(`Server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await client.destroy();
    process.exit(0);
});
