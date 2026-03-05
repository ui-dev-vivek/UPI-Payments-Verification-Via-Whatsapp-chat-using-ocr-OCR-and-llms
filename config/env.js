require('dotenv').config();

module.exports = {
    // WhatsApp Config
    ALLOWED_NUMBERS: (process.env.ALLOWED_NUMBERS || '').split(',').map(n => n.trim() + '@c.us'),
    ADMIN_NUMBER: (process.env.ADMIN_NUMBER || '') + '@c.us',
    
    // API Keys
    GROQ_KEY: process.env.GROQ_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama3-70b-8192',
    
    // Puppeteer
    PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
    
    // Server
    PORT: process.env.PORT || 3000,
    
    // Payment verification
    RECIPIENT_NAME: process.env.RECIPIENT_NAME || 'VIVEK KUMAR YADAV',
    RECIPIENT_UPI: process.env.RECIPIENT_UPI || '9026196359@fam',
    
    // Timeouts (in milliseconds)
    PAYMENT_REMINDER_TIMEOUT: 10 * 60 * 1000, // 10 minutes
    ORDER_EXPIRY_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours
};
