wa-imageverified/
├── index.js                    ← Main server entry point
│
├── config/
│   └── env.js                  ← Environment config
│
├── bot/
│   └── whatsapp.js             ← WhatsApp client
│
├── controllers/
│   └── messageController.js    ← Message handling logic
│
├── routes/
│   └── adminRoutes.js          ← Admin panel routes
│
├── services/                   ← All business logic
│   ├── aiService.js            ← Groq AI verification  ← moved here ✅
│   ├── ocrService.js           ← OCR (Tesseract+Paddle) ← moved here ✅
│   ├── productService.js
│   ├── paymentService.js
│   ├── orderService.js
│   ├── sessionService.js
│   ├── adminService.js
│   ├── cartService.js
│   ├── reminderService.js
│   └── paymentLinkService.js
│
├── ocr/                        ← OCR assets ← new folder ✅
│   ├── ocr_paddle.py           ← Python PaddleOCR pipeline
│   ├── eng.traineddata         ← Tesseract English
│   └── hin.traineddata         ← Tesseract Hindi (₹ support)
│
├── database/
│   ├── db.js
│   └── seed.js
│
├── views/                      ← Admin panel UI
│   ├── layout.ejs
│   ├── products/
│   └── payments/
│
├── test-ocr.js                 ← OCR testing script
└── .env