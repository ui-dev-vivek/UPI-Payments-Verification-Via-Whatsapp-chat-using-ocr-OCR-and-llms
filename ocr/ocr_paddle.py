#!/usr/bin/env python3
"""
ocr_paddle.py  —  Payment screenshot OCR using OpenCV + PaddleOCR
Called by Node.js ocrService.js via child_process.
Usage:  python3 ocr_paddle.py <image_path>
Output: JSON to stdout
"""

import sys
import os
import json
import re
import cv2
import numpy as np

# Skip the slow model-source connectivity check on every run
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

# ─── LOAD PADDLEOCR ───
from paddleocr import PaddleOCR

# PaddleOCR v3 API: use_textline_orientation replaces use_angle_cls
ocr_engine = PaddleOCR(use_textline_orientation=True, lang='en')


# ─────────────────────────────────────────────────────────────────
#  1. IMAGE PREPROCESSING
#  Goal: Make ₹ + amount on same horizontal line sharp & readable
# ─────────────────────────────────────────────────────────────────
def preprocess_image(image_path):
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Cannot load image: {image_path}")

    # Resize to consistent size (better OCR on uniform input)
    img = cv2.resize(img, (800, 1024))

    # Denoise — removes JPEG artefacts and WhatsApp compression noise
    img = cv2.fastNlMeansDenoisingColored(img, None, 10, 10, 7, 21)

    # Greyscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Adaptive threshold → clean binary image (text black on white)
    binary = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 9, 3
    )

    return binary


# ─────────────────────────────────────────────────────────────────
#  2. TEXT EXTRACTION via PaddleOCR
# ─────────────────────────────────────────────────────────────────
def extract_text(image):
    """Run PaddleOCR on a numpy image array. Returns list of text lines."""
    result = ocr_engine.ocr(image, cls=True)
    lines = []
    if result and result[0]:
        for line in result:
            for word_info in line:
                text = word_info[1][0].strip()
                if text:
                    lines.append(text)
    return lines


# ─────────────────────────────────────────────────────────────────
#  3. PARSING — regex-based, payment-app-aware
# ─────────────────────────────────────────────────────────────────
# Regex constants
RE_AMOUNT   = re.compile(r'[₹Rs\.INR]*\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d{2,7}(?:\.\d{1,2})?)')
RE_DATE     = re.compile(r'(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})', re.I)
RE_TIME     = re.compile(r'(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm))')
RE_UPI      = re.compile(r'\b([A-Za-z0-9.\-_+]+@[a-z]+)\b')
RE_TXN      = re.compile(r'(?:UPI Ref|Txn ID|Transaction ID|UTR|Ref No|Order ID)[.:\s#]*([A-Z0-9]{8,25})', re.I)
RE_STATUS   = re.compile(r'(Paid\s*Successfully|Payment\s*Successful|Success(?:ful)?|Completed|Failed|Declined)', re.I)


def parse_details(lines):
    combined = '\n'.join(lines)
    details = {}

    # ── Status
    status_match = RE_STATUS.search(combined)
    raw_status = status_match.group(0) if status_match else 'Unknown'
    details['transaction_status'] = raw_status
    details['isSuccess'] = bool(re.search(r'paid|success|complet', raw_status, re.I))

    # ── Transaction ID
    txn_match = RE_TXN.search(combined)
    details['transactionId'] = txn_match.group(1) if txn_match else 'Not found'

    # ── UPI IDs (could be sender or receiver)
    upi_ids = RE_UPI.findall(combined)
    details['upiIds'] = list(set(upi_ids))

    # ── Amount  (multi-strategy)
    amount = None

    # Strategy A: line that is ONLY digits (pure amount line — PhonePe style)
    for line in lines:
        stripped = line.replace(',', '').replace('.', '').strip()
        if stripped.isdigit() and 2 <= len(stripped) <= 6:
            amount = line.replace(',', '')
            details['_strategy'] = 'A-standalone-digits'
            break

    # Strategy B: ₹ prefix on same line
    if not amount:
        for line in lines:
            m = re.search(r'₹\s*([\d,]+(?:\.\d{1,2})?)', line)
            if m:
                amount = m.group(1).replace(',', '')
                details['_strategy'] = 'B-rupee-prefix'
                break

    # Strategy C: keyword + number (same line or next line)
    if not amount:
        for i, line in enumerate(lines):
            if re.search(r'\b(paid|amount|total|received|debit|credit)\b', line, re.I):
                # Check same line
                m = RE_AMOUNT.search(line)
                if m:
                    amount = m.group(1).replace(',', '')
                    details['_strategy'] = 'C-keyword-sameline'
                    break
                # Check next line
                if i + 1 < len(lines):
                    m = RE_AMOUNT.search(lines[i + 1])
                    if m:
                        amount = m.group(1).replace(',', '')
                        details['_strategy'] = 'C-keyword-nextline'
                        break

    # Strategy D: '3' prefix = OCR misread of ₹
    if not amount:
        for line in lines:
            m = re.match(r'^3(\d{2,5}(?:\.\d{1,2})?)$', line.strip())
            if m:
                amount = m.group(1)
                details['_strategy'] = 'D-rupee3-fix'
                break

    # Strategy E: Any RE_AMOUNT match in combined text
    if not amount:
        m = RE_AMOUNT.search(combined)
        if m:
            amount = m.group(1).replace(',', '')
            details['_strategy'] = 'E-fallback-regex'

    details['amount'] = amount or 'Not found'

    # ── Date & Time
    date_match = RE_DATE.search(combined)
    details['date'] = date_match.group(0) if date_match else 'Not found'

    time_match = RE_TIME.search(combined)
    details['time'] = time_match.group(0) if time_match else 'Not found'

    # ── Recipient / Sender (To / From)
    to_match   = re.search(r'To[:\s]+([A-Za-z\s]{3,40})', combined)
    from_match = re.search(r'From[:\s]+([A-Za-z\s]{3,40})', combined)
    details['To']   = to_match.group(1).strip()   if to_match   else 'Not found'
    details['From'] = from_match.group(1).strip() if from_match else 'Not found'

    # ── Raw lines (for AI fallback)
    details['rawLines'] = lines

    return details


# ─────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No image path provided'}))
        sys.exit(1)

    image_path = sys.argv[1]

    try:
        # Step 1: preprocess
        processed = preprocess_image(image_path)

        # Step 2: OCR
        lines = extract_text(processed)

        # Step 3: parse
        details = parse_details(lines)

        # Output JSON to stdout (Node.js reads this)
        print(json.dumps(details, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
