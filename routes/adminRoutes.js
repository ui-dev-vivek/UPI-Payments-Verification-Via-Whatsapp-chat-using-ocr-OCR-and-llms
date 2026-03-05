const express = require('express');
const router = express.Router();
const { getAllProducts, getProductById, updateProduct, deleteProduct, addProduct } = require('../services/productService');
const { all } = require('../database/db');

// Redirect root to products
router.get('/', (req, res) => res.redirect('/admin/products'));

// ----- PRODUCT MANAGEMENT -----

// Show all products
router.get('/products', async (req, res) => {
    try {
        const products = await getAllProducts();
        res.render('products/index', { products, success: req.query.success || null });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// New product form
router.get('/products/new', (req, res) => {
    res.render('products/form', { product: null });
});

// Edit product form
router.get('/products/edit/:id', async (req, res) => {
    try {
        const product = await getProductById(req.params.id);
        res.render('products/form', { product });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Create product
router.post('/products/create', async (req, res) => {
    try {
        const { product_code, title, description, price, delivery_link, keywords } = req.body;
        await addProduct(
            product_code.trim(),
            title.trim(),
            description.trim(),
            parseFloat(price),
            '',
            delivery_link ? delivery_link.trim() : '',
            keywords ? keywords.trim() : title.toLowerCase().trim()
        );
        res.redirect('/admin/products?success=Product added successfully');
    } catch (err) {
        const { product_code, title, description, price, delivery_link, keywords } = req.body;
        res.render('products/form', {
            product: null,
            error: err.message.includes('UNIQUE') ? 'Product code already exists. Use a different code.' : err.message
        });
    }
});

// Update product
router.post('/products/update/:id', async (req, res) => {
    try {
        const { product_code, title, description, price, delivery_link, keywords } = req.body;
        await updateProduct(req.params.id, {
            product_code: product_code.trim(),
            title: title.trim(),
            description: description.trim(),
            price: parseFloat(price),
            delivery_link: delivery_link ? delivery_link.trim() : '',
            keywords: keywords ? keywords.trim() : title.toLowerCase().trim()
        });
        res.redirect('/admin/products?success=Product updated successfully');
    } catch (err) {
        try {
            const product = await getProductById(req.params.id);
            res.render('products/form', {
                product,
                error: err.message.includes('UNIQUE') ? 'Product code already exists. Use a different code.' : err.message
            });
        } catch (e) {
            res.status(500).send(err.message);
        }
    }
});

// Delete product
router.post('/products/delete/:id', async (req, res) => {
    try {
        await deleteProduct(req.params.id);
        res.redirect('/admin/products');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// ----- PAYMENT MANAGEMENT -----

// Show all payment logs
router.get('/payments', async (req, res) => {
    try {
        const payments = await all('SELECT * FROM payment_verification_logs ORDER BY verified_at DESC');
        res.render('payments/index', { payments });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

module.exports = router;
