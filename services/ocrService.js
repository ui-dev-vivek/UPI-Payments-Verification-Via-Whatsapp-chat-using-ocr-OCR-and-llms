const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');

const PYTHON_SCRIPT = path.join(__dirname, '..', 'ocr', 'ocr_paddle.py');
const PYTHON_BIN = 'python3';
const OCR_DIR = path.join(__dirname, '..', 'ocr');  // traineddata lives here

// ─────────────────────────────────────────────
//  PYTHON (PaddleOCR) PATH — write buffer to
//  a temp file, call python3, parse JSON output
// ─────────────────────────────────────────────
function runPaddleOCR(imageBuffer) {
    return new Promise((resolve, reject) => {
        // Write buffer to a temp file (python script needs a file path)
        const tmpPath = path.join(os.tmpdir(), `wa_ocr_${Date.now()}.jpg`);
        fs.writeFileSync(tmpPath, imageBuffer);

        execFile(PYTHON_BIN, [PYTHON_SCRIPT, tmpPath], { timeout: 60000 }, (err, stdout, stderr) => {
            // Clean up temp file
            try { fs.unlinkSync(tmpPath); } catch (_) { }

            if (err) {
                reject(new Error(`Python OCR failed: ${err.message}\n${stderr}`));
                return;
            }

            try {
                const result = JSON.parse(stdout.trim());
                if (result.error) reject(new Error(result.error));
                else resolve(result);
            } catch (e) {
                reject(new Error(`Invalid JSON from Python OCR: ${stdout}`));
            }
        });
    });
}

// ─────────────────────────────────────────────
//  TESSERACT FALLBACK (Jimp preprocessing)
// ─────────────────────────────────────────────
async function preprocessImage(imageBuffer) {
    try {
        const image = await Jimp.read(imageBuffer);
        const w = image.bitmap.width;
        const h = image.bitmap.height;
        image
            .resize(w * 3, h * 3, Jimp.RESIZE_BICUBIC)
            .greyscale()
            .normalize()
            .contrast(0.6)
            .posterize(4);
        return await image.getBufferAsync(Jimp.MIME_PNG);
    } catch (err) {
        console.warn('⚠️  Jimp preprocessing failed:', err.message);
        return imageBuffer;
    }
}

function extractAmountFromText(text) {
    let t = text
        .replace(/\bRs\.?\s*/gi, '₹')
        .replace(/\bINR\s*/gi, '₹')
        .replace(/\bRupees?\s*/gi, '₹');

    const s1 = t.match(/₹\s*([\d]{1,3}(?:,[\d]{3})+(?:\.\d{1,2})?)/);
    if (s1) return s1[1].replace(/,/g, '');

    const s2 = t.match(/₹\s*(\d{1,6}(?:\.\d{1,2})?)/);
    if (s2) return s2[1];

    const lines = text.split('\n');
    for (const line of lines) {
        const s3 = line.trim().match(/^3(\d{2,5}(?:\.\d{1,2})?)$/);
        if (s3) return s3[1];
    }

    const s4 = t.match(/(?:paid|amount|total|received)[:\s]*₹?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (s4) return s4[1].replace(/,/g, '');

    for (let i = 0; i < lines.length - 1; i++) {
        if (/(?:paid|amount|total|received)/i.test(lines[i])) {
            const m = lines[i + 1].trim().match(/^₹?\s*([\d,]+(?:\.\d{1,2})?)$/);
            if (m) return m[1].replace(/,/g, '');
        }
    }

    const s7 = text.match(/\b(\d{2,6}(?:\.\d{1,2})?)\b/);
    if (s7) return s7[1];

    return null;
}

async function runTesseractOCR(imageBuffer) {
    const processedBuffer = await preprocessImage(imageBuffer);
    // eng+hin: Hindi traineddata has ₹ symbol → OCR reads "₹9" correctly instead of "39"
    const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng+hin', {
        langPath: OCR_DIR,            // eng.traineddata + hin.traineddata in ocr/
        tessedit_pageseg_mode: '6',   // uniform block of text (best for receipts)
        tessedit_ocr_engine_mode: '1', // LSTM only
        logger: m => { if (m.status === 'recognizing text') process.stdout.write(`\r  Tesseract: ${Math.round(m.progress * 100)}%  `); }
    });
    console.log('\n📄 Tesseract Raw Text:\n', text);

    const amountVal = extractAmountFromText(text);
    const txnRegex = /(?:UPI Ref No|Txn ID|Transaction ID|Ref No|UTR)[:\s]*([A-Z0-9]+)/i;
    const txnMatch = text.match(txnRegex);

    return {
        amount: amountVal ? `₹${amountVal}` : 'Not found',
        numericAmount: amountVal ? parseFloat(amountVal) : null,
        transactionId: txnMatch ? txnMatch[1] : 'Not found',
        isSuccess: /SUCCESS|COMPLETED|PAID|DONE|APPROVED/i.test(text),
        isFailed: /FAILED|DECLINED|REJECTED|CANCELLED/i.test(text),
        rawText: text,
        _engine: 'tesseract-fallback'
    };
}

// ─────────────────────────────────────────────
//  MAIN EXPORT
// ─────────────────────────────────────────────
async function processPaymentImage(imageBuffer) {
    // ── Try PaddleOCR first
    try {
        console.log('🐍 Running PaddleOCR (Python)...');
        const py = await runPaddleOCR(imageBuffer);
        console.log('✅ PaddleOCR result:', py);

        // Normalise to the same shape the rest of the app expects
        const numericAmount = py.amount && py.amount !== 'Not found'
            ? parseFloat(py.amount.replace(/[^0-9.]/g, ''))
            : null;

        return {
            amount: numericAmount != null ? `₹${numericAmount}` : 'Not found',
            numericAmount,
            transactionId: py.transactionId || 'Not found',
            timeAgo: py.time !== 'Not found' ? py.time : (py.date || 'Not found'),
            isSuccess: !!py.isSuccess,
            isFailed: !py.isSuccess && py.transaction_status !== 'Unknown',
            rawText: (py.rawLines || []).join('\n'),
            _engine: 'paddleocr',
            _strategy: py._strategy || 'paddle'
        };

    } catch (paddleErr) {
        console.warn('⚠️  PaddleOCR failed, falling back to Tesseract:', paddleErr.message);

        // ── Fallback to Tesseract + Jimp
        try {
            const result = await runTesseractOCR(imageBuffer);
            return result;
        } catch (tessErr) {
            console.error('❌ Both OCR engines failed:', tessErr.message);
            throw tessErr;
        }
    }
}

module.exports = { processPaymentImage };
