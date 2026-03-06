const Groq = require('groq-sdk');
const config = require('../config/env');

const groq = new Groq({
    apiKey: config.GROQ_KEY
});

/**
 * Verify and extract payment details from OCR text using Groq AI.
 * @param {string} ocrText 
 * @returns {Promise<{amount: string, transactionId: string, timeAgo: string, recipientName: string, recipientUPI: string, isVerified: boolean, reason: string}>}
 */
async function verifyWithAI(ocrText) {
    try {
        const prompt = `
You are a payment verification assistant for Indian UPI payments.
Analyze the following OCR text extracted from a payment screenshot (Google Pay, PhonePe, Paytm, BHIM, bank apps, etc.)

CRITICAL OCR ISSUES TO HANDLE:
* Tesseract often misreads the ₹ symbol as the digit '3'. So "39" likely means ₹9, "3999" means ₹999.
* If an amount starts with '3' and the remaining digits form a realistic price, strip the leading '3'.
* Amounts can appear below keywords like "Paid", "Amount", "Total" on the NEXT line.
* Ignore date/time numbers. Focus on the main payment amount.

Extract the following with HIGH CONFIDENCE:
1. amount — numeric only (e.g. "999", "2500", "49.00"). Remove ₹, Rs, INR. Fix ₹→3 misreads.
2. transactionId — UPI Ref No / UTR / Txn ID / Order ID
3. timeAgo — when payment happened ("just now", "5 mins ago", "11:06 PM")
4. recipientName — who received money
5. recipientUPI — exact UPI ID format (e.g. 9026196359@fam)
6. transactionNote — text in remarks/note field (e.g. "ID: 10")
7. isVerified — true if payment status is SUCCESS/PAID/COMPLETED
8. reason — 1-line explanation of your assessment

OCR Text:
"""
${ocrText}
"""

Return STRICTLY as valid JSON (no markdown, no extra text):
{
  "amount": "numeric amount only, e.g. '999'",
  "transactionId": "exact ID string or 'Not found'",
  "timeAgo": "when it happened or 'Not found'",
  "recipientName": "name or 'Not found'",
  "recipientUPI": "UPI ID or 'Not found'",
  "transactionNote": "note text or 'Not found'",
  "isVerified": true,
  "reason": "brief reason"
}
`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ],
            model: config.GROQ_MODEL,
            temperature: 0.1, // Low temperature for factual extraction
        });

        const resultText = chatCompletion.choices[0]?.message?.content || '{}';

        // Extract JSON from the response (sometimes models include markdown)
        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : resultText);

        return result;
    } catch (error) {
        console.error('AI Verification Error:', error);
        return {
            amount: 'Not found',
            transactionId: 'Not found',
            timeAgo: 'Not found',
            isVerified: false,
            reason: 'AI service error'
        };
    }
}

/**
 * Understand user intent from conversation using AI
 * Determines if user is interested in shopping, saying yes/no, or asking something else
 */
async function understandUserIntent(userMessage, context = 'initial') {
    try {
        const prompt = `You are a helpful shopping assistant. Analyze this user message and determine their intent.

User Message: "${userMessage}"
Context: ${context}

Determine:
1. Is the user interested/saying yes (positive intent)?
2. Is the user saying no/not interested?
3. Is the user asking a question or confused?
4. What should be the response?

Respond STRICTLY as valid JSON:
{
  "intent": "interested" | "not_interested" | "asking_question" | "unclear",
  "confidence": 0.0-1.0,
  "isPositive": true or false,
  "suggestion": "brief response suggestion for the user",
  "reasoning": "why you think this is their intent"
}`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ],
            model: config.GROQ_MODEL,
            temperature: 0.3,
        });

        const resultText = chatCompletion.choices[0]?.message?.content || '{}';
        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : resultText);

        return result;
    } catch (error) {
        console.error('AI Intent Understanding Error:', error);
        return {
            intent: 'unclear',
            confidence: 0,
            isPositive: false,
            suggestion: 'Could you tell me more about what you are looking for?',
            reasoning: 'Error in AI processing'
        };
    }
}

/**
 * Generate AI-powered conversation response
 * More natural and conversational than templated messages
 */
async function generateConversationResponse(userMessage, products, shopName) {
    try {
        const productList = products.map((p, i) =>
            `${i + 1}. ${p.title} (${p.product_code}) - ₹${p.price}`
        ).join('\n');

        const prompt = `You are a friendly and helpful shopping assistant for "${shopName}".

User said: "${userMessage}"

Available products:
${productList}

Generate a natural, conversational response that:
1. Acknowledges their message
2. Shows them the products in a formatted way
3. Invites them to choose (without being pushy)
4. Keeps it short and friendly (3-4 sentences max)

Make it feel like talking to a real person, not a bot.`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ],
            model: config.GROQ_MODEL,
            temperature: 0.7,
        });

        const response = chatCompletion.choices[0]?.message?.content || '';
        return response;
    } catch (error) {
        console.error('AI Response Generation Error:', error);
        return null;
    }
}

/**
 * AUTHORITATIVE JUDGMENT: Determine if the payment is valid based on specific STRICT rules.
 * Also extracts paymentDateTime for 20-min window validation.
 * @param {Array} evidenceList
 * @param {string} expectedNorm
 * @param {string} expectedSessionId
 * @returns {Promise<{verified: boolean, matchedRule: number|null, detected: string, confidence: number, reasoning: string, extractedName: string, extractedUPI: string, extractedNote: string, paymentDateTime: string}>}
 */
async function analyzeOcrEvidence(evidenceList, expectedNorm, expectedSessionId) {
    const GROQ_MODEL = config.GROQ_MODEL;

    // Use best-confidence passes, compact text for prompt
    const evidence = evidenceList
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 8)
        .map(r => ({
            stage: r.stage,
            psm: r.psm,
            conf: r.confidence,
            nums: r.numbers,
            text: (r.fullText || '').replace(/\s+/g, ' ').substring(0, 200),
        }));

    const prompt = `
You are a strict payment verification AI for Indian UPI payments.

EXPECTED AMOUNT : ₹${expectedNorm}
RECIPIENT NAME  : ${config.RECIPIENT_NAME}
RECIPIENT UPI   : ${config.RECIPIENT_UPI}
PAYMENT ID      : ${expectedSessionId}

OCR EVIDENCE:
${JSON.stringify(evidence, null, 2)}

STEP 1 — EXTRACT these fields from the OCR text:
  amount        — numeric only (e.g. "1500"). Fix ₹→3 misread. Remove commas.
  recipientName — person who RECEIVED money (not sender).
  recipientUPI  — UPI handle (e.g. 9876543210@ybl). NOT a bare phone number.
  paymentNote   — text in Note / Remarks / Message / Description / Reference field.
  paymentDateTime — EXACT date+time shown on screenshot.
    • Prefer formats with BOTH date AND time: "06/03/2026 11:30 PM", "Mar 6 2026 11:30"
    • If only time visible: "11:30 PM"
    • If nothing found: "Not found"

STEP 2 — STRICT RULES. verified = true ONLY when a COMPLETE rule matches:
  Rule 1: recipientName CONTAINS "${config.RECIPIENT_NAME.split(' ')[0]}"
          AND paymentNote CONTAINS "${expectedSessionId}"
          AND amount == "${expectedNorm}"

  Rule 2: recipientUPI == "${config.RECIPIENT_UPI}"
          AND amount == "${expectedNorm}"

  Rule 3: paymentNote CONTAINS "${expectedSessionId}"
          AND amount == "${expectedNorm}"

  Rule 4: recipientName CONTAINS "${config.RECIPIENT_NAME.split(' ')[0]}"
          AND amount == "${expectedNorm}"

  ⚠ Partial matches do NOT pass. Amount-only match → verified = false.
  OCR tolerance: 0↔O, 1↔l↔I, 5↔S, 8↔B, 9↔g, comma↔dot for amounts only.

Reply ONLY with valid JSON (no markdown):
{
  "verified": true or false,
  "matchedRule": 1 or 2 or 3 or 4 or null,
  "amount": "string or Not found",
  "recipientName": "string or Not found",
  "recipientUPI": "string or Not found",
  "paymentNote": "string or Not found",
  "paymentDateTime": "exact datetime from screenshot or Not found",
  "confidence": 0 to 100,
  "reasoning": "which rule matched or why none matched"
}
`.trim();

    try {
        const chat = await groq.chat.completions.create({
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.0,
            max_tokens: 450,
        });

        const raw = chat.choices[0]?.message?.content?.trim() ?? '';
        const jsonStr = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            verified: Boolean(parsed.verified),
            matchedRule: parsed.matchedRule ?? null,
            detected: parsed.amount ?? 'N/A',
            confidence: Number(parsed.confidence ?? 0),
            reasoning: parsed.reasoning ?? '',
            extractedName: parsed.recipientName ?? 'Not found',
            extractedUPI: parsed.recipientUPI ?? 'Not found',
            extractedNote: parsed.paymentNote ?? 'Not found',
            paymentDateTime: parsed.paymentDateTime ?? 'Not found',
        };
    } catch (err) {
        console.error('❌ Groq analysis failed:', err.message);
        return null;
    }
}

module.exports = {
    verifyWithAI,
    understandUserIntent,
    generateConversationResponse,
    analyzeOcrEvidence
};
