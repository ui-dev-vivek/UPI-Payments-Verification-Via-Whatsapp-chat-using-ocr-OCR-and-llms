const QRCode = require('qrcode');
const Jimp = require('jimp');
const TinyURL = require('tinyurl');
const config = require('../config/env');
const fs = require('fs');
const path = require('path');

/**
 * Generate UPI deep link with amount
 * Format: upi://pay?pa=UPI_ID&pn=NAME&am=AMOUNT&tn=DESCRIPTION
 */
function generateUPILink(amount, description = 'Product Payment') {
    // const upiLink = `upi://pay?pa=${config.RECIPIENT_UPI}&pn=${encodeURIComponent(config.RECIPIENT_NAME)}&am=${amount}&tn=${encodeURIComponent(description)}`;
    const upiLink = `upi://pay?pa=${config.RECIPIENT_UPI}&am=${amount}&tn=${encodeURIComponent(description)}`;
    return upiLink;
}

/**
 * Generate QR code image for UPI payment
 * Returns both data URL and file path to actual image file
 */
async function generatePaymentQR(amount, description = 'Product Payment', sessionId = '') {
    try {
        // Append unique session ID to description if provided
        const fullDescription = sessionId ? `${description} (ID: ${sessionId})` : description;
        const upiLink = generateUPILink(amount, fullDescription);

        // Generate QR code as data URL
        const qrCode = await QRCode.toDataURL(upiLink, {
            errorCorrectionLevel: 'H',
            type: 'image/png',
            quality: 0.95,
            margin: 1,
            width: 300
        });

        // Convert data URL to buffer
        const base64Data = qrCode.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // --- ADD AMOUNT TEXT TO CENTER OF QR ---
        try {
            const image = await Jimp.read(buffer);
            const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

            const text = `Rs.${amount}`;
            const textWidth = Jimp.measureText(font, text);
            const textHeight = Jimp.measureTextHeight(font, text, 100);

            // Draw a white background for the text in the middle
            const x = (image.bitmap.width / 2) - (textWidth / 2) - 15;
            const y = (image.bitmap.height / 2) - (textHeight / 2) - 5;
            const w = textWidth + 30; // Increase box width
            const h = textHeight + 10;

            // Draw white box
            for (let i = x; i < x + w; i++) {
                for (let j = y; j < y + h; j++) {
                    image.setPixelColor(0xFFFFFFFF, i, j);
                }
            }

            // Draw specific text
            image.print(font, (image.bitmap.width / 2) - (textWidth / 2), (image.bitmap.height / 2) - (textHeight / 2), text);

            // Save modified image
            const qrDir = path.join(__dirname, '../qr_codes');
            if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

            const filename = `qr_${amount}_${Date.now()}.png`;
            const filepath = path.join(qrDir, filename);
            await image.writeAsync(filepath);

            // Shorten UPI Link
            // let shortLink = upiLink;
            // try {
            //     shortLink = await TinyURL.shorten(upiLink);
            // } catch (err) {
            //     console.log('Shortener failed, using raw link');
            // }

            return {
                qrCode,
                qrFilePath: filepath,
                upiLink,
                // shortLink
                upiLink
            };
        } catch (jimpError) {
            console.error('Jimp Error:', jimpError);
            // Fallback to normal QR if Jimp fails
            const qrDir = path.join(__dirname, '../qr_codes');
            if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });
            const filename = `qr_${amount}_${Date.now()}.png`;
            const filepath = path.join(qrDir, filename);
            fs.writeFileSync(filepath, buffer);
            return { qrCode, qrFilePath: filepath, upiLink, shortLink: upiLink };
        }
    } catch (error) {
        console.error('Error generating payment QR:', error);
        return null;
    }
}

/**
 * Format payment message with UPI details
 */
function formatPaymentMessage(product, amount) {
    const upiLink = generateUPILink(amount);

    return {
        message: `💳 *PAYMENT INSTRUCTIONS*\n\n` +
            `📦 Product: ${product.title}\n` +
            `💰 Amount: ₹${amount}\n\n` +
            `👤 Recipient: ${config.RECIPIENT_NAME}\n` +
            `📱 UPI: ${config.RECIPIENT_UPI}\n\n` +
            `*Payment Methods:*\n` +
            `• Google Pay\n` +
            `• PhonePe\n` +
            `• Paytm\n` +
            `• BHIM\n` +
            `• iMobile\n\n` +
            `⏰ Payment must be within 20 minutes\n\n` +
            `📸 Send screenshot after payment`,
        upiLink
    };
}

module.exports = {
    generateUPILink,
    generatePaymentQR,
    formatPaymentMessage
};
