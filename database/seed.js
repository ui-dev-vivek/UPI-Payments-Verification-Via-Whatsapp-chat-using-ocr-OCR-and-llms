const { run, initializeDatabase } = require('./db');

/**
 * Seed database with sample products
 */
async function seedDatabase() {
    try {
        console.log('Seeding database with sample products...\n');

        // Sample products
        const products = [
            {
                product_code: 'P101',
                title: 'Instagram Growth Course',
                description: 'Learn how to grow Instagram pages using automation and viral strategies. Complete guide with proven techniques.',
                price: 199,
                payment_qr_image: 'https://example.com/qr/p101.png',
                delivery_link: 'https://t.me/instagramgrowth',
                keywords: 'instagram, growth, course, insta, viral'
            },
            {
                product_code: 'P102',
                title: 'TikTok Mastery Bundle',
                description: 'Master TikTok algorithms and create viral content. Includes editing tips, hashtag strategies, and trending sounds.',
                price: 299,
                payment_qr_image: 'https://example.com/qr/p102.png',
                delivery_link: 'https://drive.google.com/folder/tiktok-bundle',
                keywords: 'tiktok, viral, editing, bundle, trends'
            },
            {
                product_code: 'P103',
                title: 'YouTube SEO Secrets',
                description: 'Optimize your YouTube channel for maximum views. Thumbnail design, keyword research, and monetization strategies.',
                price: 249,
                payment_qr_image: 'https://example.com/qr/p103.png',
                delivery_link: 'https://drive.google.com/folder/youtube-seo',
                keywords: 'youtube, seo, monetization, channel, optimization'
            },
            {
                product_code: 'P104',
                title: 'Dropshipping Starter Kit',
                description: 'Complete guide to start dropshipping business. Supplier finding, store setup, and marketing strategies included.',
                price: 399,
                payment_qr_image: 'https://example.com/qr/p104.png',
                delivery_link: 'https://t.me/dropshippingkit',
                keywords: 'dropshipping, business, ecommerce, shopify, seller'
            },
            {
                product_code: 'P105',
                title: 'Content Creation Blueprint',
                description: 'Create engaging content for all platforms. Templates, ideas, and tools for consistent posting and growth.',
                price: 179,
                payment_qr_image: 'https://example.com/qr/p105.png',
                delivery_link: 'https://drive.google.com/folder/content-blueprint',
                keywords: 'content, creation, templates, social media, blueprint'
            }
        ];

        for (const product of products) {
            try {
                await run(
                    `INSERT INTO products (product_code, title, description, price, payment_qr_image, delivery_link, keywords)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [product.product_code, product.title, product.description, product.price, 
                     product.payment_qr_image, product.delivery_link, product.keywords]
                );
                console.log(`✅ Added: ${product.title} (${product.product_code})`);
            } catch (error) {
                if (error.message.includes('UNIQUE constraint failed')) {
                    console.log(`⚠️  Skipped: ${product.title} (already exists)`);
                } else {
                    console.error(`❌ Error adding ${product.title}:`, error.message);
                }
            }
        }

        console.log('\n✅ Database seeding completed!');
        console.log('\nProducts added:');
        products.forEach(p => {
            console.log(`  • ${p.product_code}: ${p.title} - ₹${p.price}`);
        });

        process.exit(0);

    } catch (error) {
        console.error('Error seeding database:', error);
        process.exit(1);
    }
}

// Initialize and seed
initializeDatabase();
setTimeout(seedDatabase, 1000);
