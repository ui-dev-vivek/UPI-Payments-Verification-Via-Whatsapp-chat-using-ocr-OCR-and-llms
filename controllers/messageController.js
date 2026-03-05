const { getProductById, getProductByCode, getAllProducts } = require('../services/productService');
const { createSession, getSession, updateSessionWithOCR, updateSessionWithScreenshot, endSession, getAllActiveSessions } = require('../services/sessionService');
const { createOrder, updateOrderStatus, markPaymentVerified } = require('../services/orderService');
const { verifyPaymentScreenshot, strictPaymentValidation, logPaymentAttempt } = require('../services/paymentService');
const { saveMessage } = require('../services/reminderService');
const { processPaymentImage } = require('../services/ocrService');
const config = require('../config/env');
const adminService = require('../services/adminService');
const { formatPaymentMessage, generatePaymentQR } = require('../services/paymentLinkService');
const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const { verifyWithAI, understandUserIntent, generateConversationResponse } = require('../services/aiService');

/**
 * Safely send a message with error handling
 * Prevents cascading errors from WhatsApp API changes
 */
async function safeSendMessage(client, phoneNumber, message) {
    try {
        await client.sendMessage(phoneNumber, message);
    } catch (error) {
        console.error(`Failed to send message to ${phoneNumber}:`, error.message);
        // Don't throw - fail silently to prevent cascading errors
    }
}

/**
 * Send payment QR code as image file
 */
async function sendPaymentQRImage(client, phoneNumber, amount, productTitle, sessionId = '') {
    try {
        const qrData = await generatePaymentQR(amount, `Payment for ${productTitle}`, sessionId);

        if (!qrData || !qrData.qrFilePath) {
            console.error('Failed to generate QR code');
            await safeSendMessage(client, phoneNumber, '⚠️ Could not generate QR code. Please try again.');
            return;
        }

        // Check if file exists
        if (!fs.existsSync(qrData.qrFilePath)) {
            console.error('QR code file not found:', qrData.qrFilePath);
            await safeSendMessage(client, phoneNumber, '⚠️ Could not generate QR code. Please try again.');
            return;
        }

        // Send QR code as media
        const media = MessageMedia.fromFilePath(qrData.qrFilePath);
        const caption = `📱 *Payment QR Code*\n\n` +
            `💰 *Amount: ₹${amount}*\n` +
            `📦 Product: ${productTitle}\n\n` +
            `🔗 *Direct Payment Link:* \n${qrData.shortLink || qrData.upiLink}\n\n` +
            `Scan the QR above or click the link to pay with Any UPI App (GPay, PhonePe, Paytm, etc.)\n\n` +
            `📸 *Important:* After payment, send us the screenshot here.`;

        await client.sendMessage(phoneNumber, media, { caption });

    } catch (error) {
        console.error('Error sending QR image:', error);
        await safeSendMessage(client, phoneNumber, '⚠️ Error sending QR code. Please try again.');
    }
}

/**
 * Check if user is admin
 */
function isAdmin(userPhone) {
    return userPhone === config.ADMIN_NUMBER;
}

/**
 * Get user's conversation state - tracks where they are in the flow
 * States: 'greeting', 'showing_products', 'product_selected', 'confirm_cart', 'awaiting_payment', 'payment_confirmed'
 */
async function getUserState(userPhone) {
    try {
        const session = await getSession(userPhone);
        if (session) {
            return session.conversation_state || 'greeting';
        }
        return 'greeting';
    } catch {
        return 'greeting';
    }
}

/**
 * Format products list for display
 */
function formatProductsList(products) {
    if (!products || products.length === 0) {
        return `📦 No products available at the moment.`;
    }

    let msg = `� *AVAILABLE PRODUCTS*\n\n`;

    products.forEach((product, index) => {
        msg += `${index + 1}. *${product.title}* (${product.product_code})\n`;
        msg += `   💰 ₹${product.price}\n`;
        msg += `   📝 ${product.description}\n\n`;
    });

    msg += `👉 Just reply with the product code (e.g., *P101*) to see more details!`;

    return msg;
}

/**
 * Send greeting message with shop name
 */
async function sendGreeting(client, userPhone) {
    const greetingMsg = `👋 Welcome to ${config.SHOP_NAME}! 😊\n\n` +
        `I'm here to help you find exactly what you need.\n\n` +
        `Just tell me what you're interested in, or let me show you what's available!`;

    await safeSendMessage(client, userPhone, greetingMsg);

    // Send product list
    const products = await getAllProducts();
    const productListMsg = formatProductsList(products);
    await safeSendMessage(client, userPhone, productListMsg);

    await saveMessage(userPhone, greetingMsg + '\n\n' + productListMsg, 'bot');
}

/**
 * Show confirmation for adding to cart
 */
async function sendAddToCartConfirmation(client, userPhone, product) {
    const confirmMsg = `Great choice! 👍\n\n` +
        `${product.title}\n` +
        `Price: ₹${product.price}\n\n` +
        `Would you like to proceed with this product?\n\n` +
        `Just reply: *YES* or *NO*`;

    await safeSendMessage(client, userPhone, confirmMsg);
    await saveMessage(userPhone, confirmMsg, 'bot');
}

/**
 * Parse product code from message (e.g., "product=P101" or just "P101")
 */
function parseProductCode(messageText) {
    const text = messageText.trim().toUpperCase();

    // Check for "product=P101" format
    const productMatch = text.match(/PRODUCT\s*=\s*([A-Z0-9]+)/i);
    if (productMatch) {
        return productMatch[1];
    }

    // Check if it's just a product code (P101, P102, etc.)
    if (/^P\d+$/.test(text)) {
        return text;
    }

    return null;
}

/**
 * Handle incoming message from user
 */
async function handleMessage(userPhone, message, client) {
    try {
        const messageText = message.trim();

        // Save user message
        await saveMessage(userPhone, messageText, 'user');

        // Check if admin
        if (isAdmin(userPhone)) {
            await handleAdminCommand(userPhone, messageText, client);
            return;
        }

        // Get user's current session
        const session = await getSession(userPhone);
        const messageUpper = messageText.toUpperCase();

        // ===== USER HAS ACTIVE SESSION =====
        if (session) {
            // Check if user is responding to "add to cart?" prompt
            if (messageUpper === 'YES' || messageUpper === 'Y') {
                // Confirmed adding to cart - proceed to payment
                const product = await getProductById(session.product_id);

                // Use session ID as unique identifier for description
                const sessionId = session.id || Date.now().toString().slice(-6);

                const paymentMsg = `💳 *PAYMENT REQUIRED*\n\n` +
                    `📦 Product: ${product.title}\n` +
                    `💰 Amount: ₹${session.product_price}\n\n` +
                    `👤 Recipient: ${config.RECIPIENT_NAME}\n` +
                    `UPI: ${config.RECIPIENT_UPI}\n\n` +
                    `🔹 *Payment ID:* ${sessionId}\n\n` +
                    `⚠️ *IMPORTANT:* Please ensure the *Payment ID (${sessionId})* is mentioned in the payment description/note when you pay. This helps us verify your order instantly!\n\n` +
                    `📱 Please scan the QR code below to make the payment.\n` +
                    `Once done, send us the payment screenshot.`;

                await safeSendMessage(client, userPhone, paymentMsg);
                await saveMessage(userPhone, paymentMsg, 'bot');

                // Generate and send QR code as image with specific session ID in description
                await sendPaymentQRImage(client, userPhone, session.product_price, product.title, sessionId);

                return;
            }

            if (messageUpper === 'NO' || messageUpper === 'N') {
                // User rejected add to cart - show products again
                await endSession(userPhone);

                const rejectMsg = `Okay! No problem. Let me show you other options.`;
                await safeSendMessage(client, userPhone, rejectMsg);

                const products = await getAllProducts();
                const productListMsg = formatProductsList(products);
                await safeSendMessage(client, userPhone, productListMsg);
                await saveMessage(userPhone, rejectMsg + '\n\n' + productListMsg, 'bot');

                return;
            }

            // Check if user sent product code while in session (wants to switch product)
            const productCode = parseProductCode(messageText);
            if (productCode) {
                // End current session and start new one
                await endSession(userPhone);
                const result = await createSession(userPhone, productCode);

                if (result.error) {
                    await safeSendMessage(client, userPhone, `❌ ${result.error}\n\nPlease try again.`);
                    return;
                }

                const product = result.product;
                await sendAddToCartConfirmation(client, userPhone, product);
                return;
            }

            // User has active session but sent something else - they're in payment waiting state
            if (!session.product) {
                // Product data missing, end session
                await endSession(userPhone);
                await safeSendMessage(client, userPhone, '❌ Session error. Please start a new session: *product=P101*');
                return;
            }

            const waitMsg = `⏳ Waiting for payment screenshot for *${session.product.title}* (₹${session.product_price}).\n\n` +
                `💡 Send the payment screenshot image or type *cancel* to quit.`;

            await safeSendMessage(client, userPhone, waitMsg);
            return;
        }

        // ===== NO ACTIVE SESSION - USE AI TO UNDERSTAND INTENT =====

        // Check if message is a product code
        const productCode = parseProductCode(messageText);
        if (productCode) {
            const result = await createSession(userPhone, productCode);

            if (result.error) {
                await safeSendMessage(client, userPhone, `❌ ${result.error}\n\nPlease try another product code.`);
                return;
            }

            const product = result.product;
            await sendAddToCartConfirmation(client, userPhone, product);
            return;
        }

        // Use AI to understand user intent
        const intentResult = await understandUserIntent(messageText, 'initial_greeting');

        // If user is showing positive interest
        if (intentResult.isPositive && intentResult.confidence > 0.6) {
            // Show products naturally
            const products = await getAllProducts();

            // Generate AI-powered response
            const aiResponse = await generateConversationResponse(
                messageText,
                products,
                config.SHOP_NAME
            );

            if (aiResponse) {
                await safeSendMessage(client, userPhone, aiResponse);
            }

            // Show product list in formatted way
            const productListMsg = formatProductsList(products);
            await safeSendMessage(client, userPhone, productListMsg);

            const fullMsg = (aiResponse || '') + '\n\n' + productListMsg;
            await saveMessage(userPhone, fullMsg, 'bot');
            return;
        }

        // If user is unclear or asking questions
        if (intentResult.intent === 'asking_question' || intentResult.intent === 'unclear') {
            // AI suggests relevant response
            const clarifyMsg = `${intentResult.suggestion}\n\n` +
                `Let me show you what we have:`;

            await safeSendMessage(client, userPhone, clarifyMsg);

            const products = await getAllProducts();
            const productListMsg = formatProductsList(products);
            await safeSendMessage(client, userPhone, productListMsg);

            const fullMsg = clarifyMsg + '\n\n' + productListMsg;
            await saveMessage(userPhone, fullMsg, 'bot');
            return;
        }

        // Default: Show products with friendly greeting
        const defaultMsg = `Thanks for reaching out! 😊\n\n` +
            `I'm here to help you find what you're looking for.`;

        await safeSendMessage(client, userPhone, defaultMsg);

        const products = await getAllProducts();
        const productListMsg = formatProductsList(products);
        await safeSendMessage(client, userPhone, productListMsg);

        const fullMsg = defaultMsg + '\n\n' + productListMsg;
        await saveMessage(userPhone, fullMsg, 'bot');

    } catch (error) {
        console.error('Error handling message:', error);
        await safeSendMessage(client, userPhone, '⚠️ An error occurred. Please try again.');
    }
}

/**
 * Admin dashboard commands
 */
async function handleAdminCommand(adminPhone, command, client) {
    const cmd = command.toLowerCase().trim();

    // Show main menu if no command
    if (!cmd || cmd === 'menu' || cmd === 'help' || cmd === 'dashboard') {
        const menuMsg = `🤖 *ADMIN DASHBOARD*\n\n` +
            `Commands:\n\n` +
            `1️⃣  *products* - Show products (paginated)\n` +
            `2️⃣  *orders* - Show all orders\n` +
            `3️⃣  *transactions* - Last 5 transactions\n` +
            `4️⃣  *earnings* - Today's earnings\n` +
            `5️⃣  *pending* - Unverified payments\n` +
            `6️⃣  *collection* - Product-wise sales\n` +
            `7️⃣  *sessions* - Active sessions\n\n` +
            `Pagination: Reply "products 2" for page 2`;
        await safeSendMessage(client, adminPhone, menuMsg);
        return;
    }

    // Parse command and page number
    const parts = cmd.split(' ');
    const action = parts[0];
    const page = parseInt(parts[1]) || 1;

    try {
        if (action === 'products') {
            const productsData = await adminService.getProductsPage(page, 5);
            const formattedMsg = adminService.formatProductsList(productsData);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'orders') {
            const ordersData = await adminService.getOrdersPage(page, 5);
            const formattedMsg = adminService.formatOrdersList(ordersData);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'transactions') {
            const transactions = await adminService.getLastTransactions(5);
            const formattedMsg = adminService.formatTransactionsList(transactions);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'earnings') {
            const earnings = await adminService.getTodayEarnings();
            const formattedMsg = adminService.formatEarnings(earnings);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'pending') {
            const payments = await adminService.getUnverifiedPayments();
            const formattedMsg = adminService.formatUnverifiedPayments(payments);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'collection') {
            const collections = await adminService.getProductWiseCollection();
            const formattedMsg = adminService.formatProductCollection(collections);
            await safeSendMessage(client, adminPhone, formattedMsg);
            await saveMessage(adminPhone, formattedMsg, 'bot');
        }
        else if (action === 'sessions') {
            const sessions = await getAllActiveSessions();
            if (sessions.length === 0) {
                await safeSendMessage(client, adminPhone, '📊 No active sessions.');
                return;
            }

            let sessionsMsg = `📊 *ACTIVE SESSIONS* (${sessions.length})\n\n`;
            sessions.slice(0, 5).forEach((s, i) => {
                sessionsMsg += `${i + 1}. ${s.user_phone}\n`;
                sessionsMsg += `   Product: ${s.title} (₹${s.price})\n`;
                sessionsMsg += `   Status: ${s.status}\n`;
                sessionsMsg += `   Started: ${new Date(s.session_started_at).toLocaleString('en-IN')}\n\n`;
            });

            if (sessions.length > 5) {
                sessionsMsg += `... and ${sessions.length - 5} more`;
            }

            await safeSendMessage(client, adminPhone, sessionsMsg);
        }
        else {
            await safeSendMessage(client, adminPhone, 'Unknown command. Type "menu" for available commands.');
        }
    } catch (error) {
        console.error('Admin command error:', error);
        await safeSendMessage(client, adminPhone, `❌ Error: ${error.message}`);
    }
}

/**
 * Handle payment screenshot
 */
async function handlePaymentScreenshot(userPhone, media, client) {
    try {
        // Get user's session
        const session = await getSession(userPhone);

        if (!session) {
            await safeSendMessage(client, userPhone,
                '❌ No active session.\n\n' +
                'Start a new session: *product=P101*');
            return;
        }

        await safeSendMessage(client, userPhone, '⏳ Verifying payment (OCR + AI)...');

        // Convert media to buffer
        const buffer = Buffer.from(media.data, 'base64');

        // Process image with OCR
        const ocrResult = await processPaymentImage(buffer);
        console.log('OCR Result:', ocrResult);

        // EXTRA: Intent Classification - Is this even a payment?
        // Relaxing checks: transactionId is optional now
        const isNotPayment = !ocrResult.amount && !ocrResult.isSuccess && !ocrResult.isFailed;
        if (isNotPayment && !ocrResult.rawText.toLowerCase().includes('phonepe') && !ocrResult.rawText.toLowerCase().includes('paytm') && !ocrResult.rawText.toLowerCase().includes('google pay') && !ocrResult.rawText.toLowerCase().includes('upi')) {
            await safeSendMessage(client, userPhone,
                '🤔 This doesn\'t look like a payment screenshot.\n\n' +
                'Please send a clear screenshot of your successful transaction!');
            return;
        }

        if (ocrResult.isFailed) {
            await safeSendMessage(client, userPhone,
                '❌ This payment appears to be *FAILED* or *DECLINED*.\n\n' +
                'Please ensure your transaction was successful before sending the screenshot.');
            return;
        }

        // Update session with OCR data
        // Using ocrResult.numericAmount for numeric logic but passing the full raw text to AI
        await updateSessionWithOCR(userPhone, ocrResult.rawText, ocrResult.numericAmount);
        await updateSessionWithScreenshot(userPhone, ocrResult.imagePath || 'screenshot');

        // Verify with AI (AI will now see symbols in rawText)
        const aiVerification = await verifyPaymentScreenshot(ocrResult.rawText);
        console.log('AI Verification:', aiVerification);

        // **STRICT VALIDATION with 3 data points:**
        // 1. Product price (from session)
        // 2. OCR amount (from OCR - numeric)
        // 3. Raw text (from OCR)

        const strictValidation = await strictPaymentValidation(
            {
                ...aiVerification,
                ocrAmount: ocrResult.numericAmount,   // fallback if AI misses amount
                productPrice: session.product_price,
                rawText: ocrResult.rawText
            },
            userPhone
        );

        console.log('Strict Validation:', strictValidation);

        // Log attempt
        await logPaymentAttempt(userPhone, null, strictValidation.isValid,
            strictValidation.amount, strictValidation.transactionId);

        if (strictValidation.isValid) {
            // Create order and mark as verified
            const order = await createOrder(userPhone, session.product_id);
            await markPaymentVerified(order, strictValidation.amount, strictValidation.transactionId);

            // End session
            await endSession(userPhone);

            // Get product details
            const product = await getProductById(session.product_id);

            // SPECIAL HANDLING: Followers (P106)
            let deliveryText = product.delivery_link;
            if (product.product_code === 'P106') {
                deliveryText = `🚀 *FOLLOWERS ORDER ACTIVATED!*\n\n` +
                    `Please visit our private panel to claim your followers:\n` +
                    `${product.delivery_link}\n\n` +
                    `Use your phone number (${userPhone}) as the claim ID on the panel!`;
            }

            // Send success message with delivery link
            const successMsg =
                '✅ *PAYMENT VERIFIED!*\n\n' +
                `Thank you for purchasing *${product.title}*\n\n` +
                (product.product_code === 'P106' ? deliveryText : `🔗 *Your Access Link:*\n${deliveryText}\n\n💡 Save this link and access now!`);

            await safeSendMessage(client, userPhone, successMsg);
            await saveMessage(userPhone, successMsg, 'bot');

            // Send admin notification
            const adminMsg =
                '✅ *PAYMENT VERIFIED*\n\n' +
                `User: ${userPhone}\n` +
                `Product: ${product.title}\n` +
                `Amount: ₹${strictValidation.amount}\n` +
                `Transaction: ${strictValidation.transactionId}\n` +
                `OCR Amount: ₹${ocrResult.extractedAmount}`;

            await safeSendMessage(client, config.ADMIN_NUMBER, adminMsg);

        } else {
            // Payment verification failed
            const failureMsg =
                '❌ *PAYMENT NOT VERIFIED*\n\n' +
                `Issues:\n${strictValidation.errors.join('\n')}\n\n` +
                'Please try again or start a new session.\n' +
                `*product=P101*`;

            await safeSendMessage(client, userPhone, failureMsg);

            // Send admin alert
            const adminFailureMsg =
                '❌ *PAYMENT VERIFICATION FAILED*\n\n' +
                `User: ${userPhone}\n` +
                `Product: ${session.product.title}\n` +
                `Errors:\n${strictValidation.errors.join('\n')}\n\n` +
                `OCR Amount: ₹${ocrResult.extractedAmount}\n` +
                `AI Result: ${JSON.stringify(aiVerification, null, 2)}`;

            await safeSendMessage(client, config.ADMIN_NUMBER, adminFailureMsg);
        }

    } catch (error) {
        console.error('Error handling payment screenshot:', error);
        await safeSendMessage(client, userPhone, '⚠️ Error processing screenshot. Try again.');

        const errorMsg = `⚠️ *ERROR - PAYMENT PROCESSING*\n\nUser: ${userPhone}\nError: ${error.message}`;
        await safeSendMessage(client, config.ADMIN_NUMBER, errorMsg);
    }
}

/**
 * Send daily analytics report to admin
 */
async function sendDailyAnalytics(client) {
    try {
        const earnings = await adminService.getTodayEarnings();

        const analyticsMsg =
            '📊 *DAILY SALES REPORT*\n\n' +
            `✅ Completed Orders: ${earnings.completed_orders}\n` +
            `💰 Total Revenue: ₹${earnings.total_revenue}\n\n` +
            `Date: ${new Date().toLocaleDateString('en-IN')}`;

        await safeSendMessage(client, config.ADMIN_NUMBER, analyticsMsg);

    } catch (error) {
        console.error('Error sending analytics:', error);
    }
}

module.exports = {
    handleMessage,
    handlePaymentScreenshot,
    sendDailyAnalytics,
    isAdmin,
    handleAdminCommand,
    getAllActiveSessions
};
