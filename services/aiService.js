const Groq = require('groq-sdk');

const groq = new Groq({
    apiKey: process.env.GROQ_KEY
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
            model: process.env.GROQ_MODEL || "llama3-70b-8192", // Default to llama3 if not specified
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
            model: process.env.GROQ_MODEL || "llama3-70b-8192",
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
            model: process.env.GROQ_MODEL || "llama3-70b-8192",
            temperature: 0.7,
        });

        const response = chatCompletion.choices[0]?.message?.content || '';
        return response;
    } catch (error) {
        console.error('AI Response Generation Error:', error);
        return null;
    }
}

module.exports = {
    verifyWithAI,
    understandUserIntent,
    generateConversationResponse
};
