const { processPaymentImage } = require('./services/ocrService');
const fs = require('fs');
const path = require('path');

// Usage: node test-ocr.js [imagepath]
// Default: ./sample-payment.jpg
const imagePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, 'sample-payment.jpg');

async function testOCR() {
    if (!fs.existsSync(imagePath)) {
        console.error(`❌ Image not found: ${imagePath}`);
        console.error('Usage: node test-ocr.js <path/to/screenshot.jpg>');
        return;
    }

    console.log(`\n🧪 Testing OCR on: ${imagePath} for ₹${process.argv[3] || '500'} (ID: ${process.argv[4] || '101'})\n${'─'.repeat(50)}`);
const expectedAmount = process.argv[3] || '500';
const expectedID = process.argv[4] || '101';

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const result = await processPaymentImage(imageBuffer, expectedAmount, expectedID);

        console.log('\n' + '─'.repeat(50));
        console.log('✅ RESULT:\n');
        console.log(`  Amount        : ${result.amount}  (numeric: ${result.numericAmount})`);
        console.log(`  Strategy used : #${result._strategy ?? 'N/A'}`);
        console.log(`  Transaction ID: ${result.transactionId}`);
        console.log(`  Time          : ${result.timeAgo}`);
        console.log(`  Status        : ${result.isSuccess ? '✅ SUCCESS' : result.isFailed ? '❌ FAILED' : '❓ Unknown'}`);
        console.log('\n  Full JSON:');
        console.log(JSON.stringify(result, null, 4));

    } catch (error) {
        console.error('❌ Test Error:', error.message);
    }
}

testOCR();
