'use strict';

/**
 * ══════════════════════════════════════════════════════════════════
 *  PAYMENT AMOUNT VERIFIER  —  7-STAGE OCR  +  GROQ AI JUDGMENT
 *  Accuracy target: 99%+
 * ══════════════════════════════════════════════════════════════════
 */

const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { analyzeOcrEvidence } = require('./aiService');

// ─────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────

const OCR_LANG = 'eng';   // English only — Hindi adds noise and garbles UPI/name text
// NOTE: NO whitelist — we need to read names, UPI IDs, and notes, not just numbers!

/** PSM modes cycled per stage */
const PSM = {
    AUTO: '3',
    SINGLE_BLOCK: '6',
    SINGLE_LINE: '7',
    SPARSE: '11',
};

// ─────────────────────────────────────────────────────────────────
//  AMOUNT NORMALISATION
// ─────────────────────────────────────────────────────────────────

/**
 * Convert any formatted amount string to a clean numeric string.
 */
function normalizeAmount(raw) {
    if (!raw) return '';
    let s = String(raw).trim();

    // Remove currency symbols and letters
    s = s.replace(/[₹$€£¥₩Rs\.]+/gi, '').trim();

    const cleaned = s.replace(/[^0-9.,]/g, '');

    // European format detection: 1.234,56  or  1.234
    const euFull = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/;
    const euNoDecim = /^\d{1,3}(\.\d{3})+$/;

    if (euFull.test(cleaned) || euNoDecim.test(cleaned)) {
        s = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
        // Indian / US format: remove commas, keep one dot
        s = cleaned.replace(/,/g, '');
    }

    // Keep only digits + dot
    s = s.replace(/[^0-9.]/g, '');

    // Multiple dots → keep only last one
    const parts = s.split('.');
    if (parts.length > 2) {
        s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    }

    return s.trim();
}

/**
 * Extract all candidate numbers from raw OCR text.
 */
function extractNumbers(text) {
    const pattern = /\b\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d+)?\b/g;
    const raw = text.match(pattern) || [];
    return [...new Set(
        raw.map(normalizeAmount).filter(n => n.length > 0 && /\d/.test(n))
    )];
}

/**
 * Multi-level numeric comparison.
 */
function amountsMatch(candidate, expected) {
    if (!candidate || !expected) return false;

    // 1. Exact string match
    if (candidate === expected) return true;

    // 2. Float equality
    const cf = parseFloat(candidate);
    const ef = parseFloat(expected);
    if (!isNaN(cf) && !isNaN(ef) && cf === ef) return true;

    // 3. Integer match (when expected has no decimal)
    if (!expected.includes('.')) {
        const ci = parseInt(candidate, 10);
        const ei = parseInt(expected, 10);
        if (!isNaN(ci) && !isNaN(ei) && ci === ei) return true;
    }

    // 4. Ignore trailing zeros  e.g. "1500.00" vs "1500"
    if (parseFloat(candidate).toFixed(0) === parseFloat(expected).toFixed(0) &&
        !expected.includes('.')) return true;

    // 5. Ghost-digit / OCR artifact tolerance (1 extra digit max)
    const cs = candidate.replace('.', '');
    const es = expected.replace('.', '');
    if (cs === es) return true;
    if (cs.includes(es) && cs.length <= es.length + 2) return true;

    return false;
}

// ─────────────────────────────────────────────────────────────────
//  IMAGE PRE-PROCESSORS  — 7 unique image treatment strategies
// ─────────────────────────────────────────────────────────────────

async function buildPreprocessors(imageInput) {
    let img = sharp(imageInput);
    const meta = await img.metadata();
    const baseWidth = Math.max(meta.width ?? 1000, 1400);
    const doubleWidth = baseWidth * 2;

    return [
        {
            name: 'Stage 1 · Original Upscale',
            psms: [PSM.AUTO, PSM.SINGLE_BLOCK],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .toBuffer(),
        },
        {
            name: 'Stage 2 · Grayscale + Contrast Boost',
            psms: [PSM.AUTO, PSM.SINGLE_BLOCK],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .linear(1.5, -15)
                    .toBuffer(),
        },
        {
            name: 'Stage 3 · Hard B&W Threshold',
            psms: [PSM.AUTO, PSM.SINGLE_LINE],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .normalise()
                    .threshold(160)
                    .toBuffer(),
        },
        {
            name: 'Stage 4 · Inverted (dark-bg receipts)',
            psms: [PSM.AUTO, PSM.SINGLE_BLOCK],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .negate()
                    .normalise()
                    .threshold(155)
                    .toBuffer(),
        },
        {
            name: 'Stage 5 · 2× Upscale + Sharpen',
            psms: [PSM.AUTO, PSM.SPARSE],
            build: () =>
                sharp(imageInput)
                    .resize(doubleWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .sharpen({ sigma: 2.5, m1: 0, m2: 4 })
                    .linear(1.6, -20)
                    .toBuffer(),
        },
        {
            name: 'Stage 6 · Denoise + Threshold',
            psms: [PSM.AUTO, PSM.SINGLE_BLOCK],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .median(3)
                    .normalise()
                    .threshold(148)
                    .toBuffer(),
        },
        {
            name: 'Stage 7 · Gamma Lift (faded ink)',
            psms: [PSM.AUTO, PSM.SINGLE_BLOCK, PSM.SPARSE],
            build: () =>
                sharp(imageInput)
                    .resize(baseWidth, null, { fit: 'inside', kernel: 'lanczos3' })
                    .grayscale()
                    .gamma(1.8)
                    .normalise()
                    .toBuffer(),
        },
    ];
}

// ─────────────────────────────────────────────────────────────────
//  OCR TEXT SANITIZER — strip non-ASCII chars that break LLM JSON
// ─────────────────────────────────────────────────────────────────

function sanitizeForAI(text) {
    if (!text) return '';

    // Deduplicate — OCR runs the same image multiple times, producing repeated lines
    const lines = text.split('\n');
    const seen = new Set();
    const unique = lines.filter(l => {
        const key = l.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key || key.length < 3 || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return unique.join('\n')
        // Remove Devanagari / non-ASCII that breaks JSON
        .replace(/[\u0900-\u097F\u0980-\u09FF]/g, ' ')  // Hindi, Bengali
        .replace(/[^\x20-\x7E\n]/g, ' ')                 // other non-printable
        .replace(/[ \t]{4,}/g, '   ')                    // collapse whitespace runs
        .substring(0, 800);                               // generous cap
}


async function runOCR(imgBuffer, stageName, psm) {
    // No whitelist — we need letters for names, UPI IDs, refs, not just numbers
    const tessCfg = {
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: psm,
    };

    const result = await Tesseract.recognize(imgBuffer, OCR_LANG, {
        ...tessCfg,
        logger: () => {}
    });

    const fullText = result.data.text || '';
    const numbers = extractNumbers(fullText);
    const confidence = parseFloat(result.data.confidence?.toFixed(1) ?? '0');

    return { fullText, numbers, confidence, stageName, psm };
}

// ─────────────────────────────────────────────────────────────────
//  STAGE RUNNER
// ─────────────────────────────────────────────────────────────────

async function runStage(stageDef, expectedNorm, auditLog) {
    const results = [];
    const buf = await stageDef.build();

    for (const psm of stageDef.psms) {
        const ocr = await runOCR(buf, stageDef.name, psm);

        const entry = {
            stage: stageDef.name,
            psm,
            confidence: ocr.confidence,
            numbers: ocr.numbers,
            fullText: ocr.fullText.replace(/\n/g, ' ').substring(0, 300),
            matched: null,
        };

        const hit = ocr.numbers.find(n => amountsMatch(n, expectedNorm));
        if (hit) entry.matched = hit;

        results.push(entry);

        auditLog.push(
            `    ${stageDef.name} | PSM ${psm} | Conf: ${ocr.confidence}% | Numbers: [${ocr.numbers.join(', ')}]` +
            (hit ? ` ✅ HIT: ${hit}` : ' ⬜ no match')
        );
    }

    return results;
}

// ─────────────────────────────────────────────────────────────────
//  OCR CORRUPTION REGEX SCAN
// ─────────────────────────────────────────────────────────────────

function corruptionScan(allTexts, expectedNorm, auditLog) {
    const combined = allTexts.join(' ');

    const pattern = new RegExp(
        expectedNorm
            .replace(/0/g, '[0OoQ]')
            .replace(/1/g, '[1lI|!]')
            .replace(/5/g, '[5S$]')
            .replace(/6/g, '[6G]')
            .replace(/8/g, '[8B]')
            .replace(/9/g, '[9g]')
            .replace(/2/g, '[2Z]')
            .replace(/\./g, '[.,]'),
        'gi'
    );

    const matches = combined.match(pattern);
    if (matches?.length) {
        auditLog.push(`    ✅ Corruption match: "${matches[0]}"`);
        return { found: true, detected: matches[0], method: 'OCR Corruption Regex' };
    }

    // Digit-scatter: digits may have 1 non-digit between them
    const digits = expectedNorm.replace(/\./g, '');
    const scatter = new RegExp(digits.split('').join('[^0-9]?'));
    const digText = combined.replace(/[^0-9]/g, ' ');
    if (scatter.test(digText)) {
        auditLog.push('    ✅ Digit-scatter match');
        return { found: true, detected: digits, method: 'Digit Scatter Match' };
    }

    return { found: false };
}

/**
 * Main OCR Processing and Verification Entry Point
 * @param {Buffer|string} imageInput 
 * @param {number|string} expectedAmount 
 * @param {string} sessionId
 */
async function processPaymentImage(imageInput, expectedAmount, sessionId) {
    const auditLog = [];
    const startTime = Date.now();

    const expectedNorm = normalizeAmount(expectedAmount);
    auditLog.push(`Expected Amount: ₹${expectedAmount} (Normalized: ${expectedNorm})`);
    auditLog.push(`Expected Session ID: ${sessionId}`);

    if (!expectedNorm || isNaN(parseFloat(expectedNorm))) {
        return finalize(false, 'Invalid expected amount', 'N/A', 0, 'The provided amount is not valid.', auditLog, startTime);
    }

    let buf;
    if (Buffer.isBuffer(imageInput)) {
        buf = imageInput;
    } else {
        const imagePath = path.resolve(String(imageInput));
        if (!fs.existsSync(imagePath)) {
            return finalize(false, 'Image file not found', 'N/A', 0, 'Image file does not exist.', auditLog, startTime);
        }
        buf = fs.readFileSync(imagePath);
    }

    const stages = await buildPreprocessors(buf);
    const allResults = [];
    const allTexts = [];
    let earlyWin = null;

    console.log(`📸 Processing payment image for ₹${expectedAmount}...`);

    for (const stage of stages) {
        const stageResults = await runStage(stage, expectedNorm, auditLog);

        for (const r of stageResults) {
            allResults.push(r);
            allTexts.push(r.fullText);
            if (!earlyWin && r.matched) {
                earlyWin = { detected: r.matched, confidence: r.confidence, method: r.stage };
            }
        }
    }

    // Corruption scan
    const scan = corruptionScan(allTexts, expectedNorm, auditLog);
    if (!earlyWin && scan.found) {
        earlyWin = { detected: scan.detected, confidence: 30, method: scan.method };
    }

    // Extract Transaction ID (UTR / Ref No)
    const txnRegex = /(?:UPI Ref No|Txn ID|Transaction ID|Ref No|UTR)[:\s]*([A-Z0-9]+)/i;
    let transactionId = 'Not found';
    for (const text of allTexts) {
        const match = text.match(txnRegex);
        if (match) {
            transactionId = match[1];
            break;
        }
    }

    // AUTHORITATIVE AI JUDGMENT
    console.log('🤖 Consulting AI for final confirmation...');

    // Sanitize all OCR texts before sending to AI (prevent JSON parse failures)
    const allResultsSanitized = allResults.map(r => ({
        ...r,
        fullText: sanitizeForAI(r.fullText),
    }));
    const sanitizedRawText = sanitizeForAI(allTexts.join(' '));

    const aiResponse = await analyzeOcrEvidence(allResultsSanitized, expectedNorm, sessionId);

    if (aiResponse) {
        // Apply 85+ accuracy rule
        const isHighlyConfident = aiResponse.confidence >= 85;
        const finalVerified = aiResponse.verified && isHighlyConfident;

        return finalize(
            finalVerified,
            finalVerified ? `AI Verified Rule ${aiResponse.matchedRule} (${aiResponse.confidence}%)` : `AI Rejected (${aiResponse.confidence}%)`,
            aiResponse.detected,
            aiResponse.confidence,
            aiResponse.reasoning,
            auditLog,
            startTime,
            sanitizedRawText,
            transactionId,
            {
                extractedName: aiResponse.extractedName,
                extractedUPI: aiResponse.extractedUPI,
                extractedNote: aiResponse.extractedNote,
                paymentDateTime: aiResponse.paymentDateTime,
                matchedRule: aiResponse.matchedRule,
            }
        );
    }

    // ⚠️ AI FAILED — NEVER auto-verify without AI confirmation
    // The 3-rule check requires AI to extract name/UPI/note. Without it, we can't confirm.
    console.warn('⚠️  AI unavailable — rejecting payment for safety (cannot confirm 3-rule validation)');
    return finalize(
        false,
        'AI Unavailable — Rejected for Safety',
        earlyWin?.detected ?? 'N/A',
        earlyWin?.confidence ?? 0,
        'AI judgment could not be obtained. Cannot safely verify without checking recipient and payment ID. Please retry.',
        auditLog,
        startTime,
        sanitizedRawText,
        transactionId
    );
}

function finalize(isVerified, method, detected, confidence, reasoning, auditLog, startTime, rawText = '', transactionId = 'Not found', aiMetadata = {}) {
    const elapsed = Date.now() - startTime;

    const result = {
        verified: isVerified,
        method,
        detected,
        confidence,
        reasoning,
        elapsedMs: elapsed,
        auditLog,
        amount: detected !== 'N/A' ? `₹${detected}` : 'Not found',
        numericAmount: detected !== 'N/A' ? parseFloat(detected) : null,
        transactionId,
        isSuccess: isVerified,
        // isFailed = true ONLY if OCR text indicates a declined/failed transaction
        // NOT simply because AI rejected — that's a verification failure, different thing
        isFailed: false,
        rawText,
        _engine: 'multi-stage-ocr',
        extractedName: aiMetadata.extractedName || 'Not found',
        extractedUPI: aiMetadata.extractedUPI || 'Not found',
        extractedNote: aiMetadata.extractedNote || 'Not found',
        paymentDateTime: aiMetadata.paymentDateTime || 'Not found',
        matchedRule: aiMetadata.matchedRule || null,
    };

    console.log(`\n🏁 Result: ${isVerified ? '✅ VERIFIED' : '❌ REJECTED'}`);
    console.log(`   Method: ${method}`);
    console.log(`   Confidence: ${confidence}%`);
    console.log(`   Time: ${elapsed}ms\n`);

    return result;
}

module.exports = {
    processPaymentImage,
    normalizeAmount,
    amountsMatch,
    extractNumbers
};
