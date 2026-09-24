const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// เชื่อมต่อฐานข้อมูล Docker MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'rootpassword',
    database: process.env.DB_NAME || 'tumbler_shop',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// รหัสลับสำหรับสมัครสิทธิ์ Admin (Admin Secret Key)
const ADMIN_SECRET_KEY = "ADMIN1234";

// ==========================================
// 1. ระบบจัดการสมาชิก (Authentication & Roles)
// ==========================================

// สมัครสมาชิก (รองรับ Admin Secret Key)
app.post('/api/register', (req, res) => {
    const { username, password, fullname, phone, adminSecret } = req.body;
    let role = 'user';

    if (adminSecret && adminSecret === ADMIN_SECRET_KEY) {
        role = 'admin';
    }

    const sql = `INSERT INTO users (username, password, fullname, phone, role, coins) VALUES (?, ?, ?, ?, ?, 0)`;
    db.query(sql, [username, password, fullname, phone, role], (err, result) => {
        if (err) return res.status(400).json({ error: 'Username นี้ถูกใช้งานแล้ว หรือข้อมูลไม่ถูกต้อง' });
        res.json({ message: 'สมัครสมาชิกสำเร็จ', user_id: result.insertId, role });
    });
});

// เข้าสู่ระบบ
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const sql = `SELECT user_id, username, fullname, phone, role, coins FROM users WHERE username = ? AND password = ?`;
    db.query(sql, [username, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        res.json({ message: 'เข้าสู่ระบบสำเร็จ', user: results[0] });
    });
});

// ดูโปรไฟล์และยอด Coins ล่าสุด
app.get('/api/users/profile/:id', (req, res) => {
    db.query(`SELECT user_id, username, fullname, phone, role, coins FROM users WHERE user_id = ?`, [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
        res.json(results[0]);
    });
});

// เติมเหรียญสะสม (Topup Coins)
app.post('/api/users/topup', (req, res) => {
    const { user_id, coins } = req.body;
    db.query(`UPDATE users SET coins = coins + ? WHERE user_id = ?`, [coins, user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'เติมเหรียญสะสมเรียบร้อยแล้ว' });
    });
});

// ==========================================
// 2. ระบบจัดการสินค้า & การกรอง (Search & Filter)
// ==========================================

// ดึงรายการสินค้าทั้งหมด พร้อมการกรองและค้นหา
app.get('/api/products', (req, res) => {
    const { search, category_id, brand_id } = req.query;
    let sql = `
        SELECT p.*, c.category_name, b.brand_name, 
               v.variant_id, v.color_name, v.capacity, v.price, v.promotion_price, v.stock,
               (SELECT image_url FROM product_images img WHERE img.product_id = p.product_id LIMIT 1) as image_url
        FROM products p
        LEFT JOIN categories c ON p.category_id = c.category_id
        LEFT JOIN brands b ON p.brand_id = b.brand_id
        LEFT JOIN product_variants v ON p.product_id = v.product_id
        WHERE 1=1
    `;
    const params = [];

    if (search) {
        sql += ` AND (p.product_name LIKE ? OR b.brand_name LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }
    if (category_id) {
        sql += ` AND p.category_id = ?`;
        params.push(category_id);
    }
    if (brand_id) {
        sql += ` AND p.brand_id = ?`;
        params.push(brand_id);
    }

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/categories', (req, res) => {
    db.query(`SELECT * FROM categories`, (err, results) => res.json(results || []));
});

app.get('/api/brands', (req, res) => {
    db.query(`SELECT * FROM brands`, (err, results) => res.json(results || []));
});

// ==========================================
// 3. ระบบชำระเงิน ตรวจสอบสต็อก & หัก Coins (Checkout)
// ==========================================

app.post('/api/checkout', (req, res) => {
    const { user_id, items, total_amount, payment_method } = req.body;
    // items: [{ variant_id: 1, quantity: 2, price: 390 }]

    if (!items || items.length === 0) {
        return res.status(400).json({ error: 'ไม่มีสินค้าในตะกร้า' });
    }

    // 1. ตรวจสอบ Coins กรณีจ่ายด้วย Coins
    db.query(`SELECT coins FROM users WHERE user_id = ?`, [user_id], (err, userRes) => {
        if (err) return res.status(500).json({ error: err.message });
        if (payment_method === 'Coin' && (!userRes[0] || userRes[0].coins < total_amount)) {
            return res.status(400).json({ error: 'เหรียญสะสมไม่พอสำหรับการชำระเงิน' });
        }

        // 2. สร้าง Order
        db.query(`INSERT INTO orders (user_id, total_amount, status) VALUES (?, ?, 'paid')`, [user_id, total_amount], (err, orderRes) => {
            if (err) return res.status(500).json({ error: err.message });
            const order_id = orderRes.insertId;

            // 3. บันทึก Payment
            db.query(`INSERT INTO payments (order_id, payment_method, amount, payment_status) VALUES (?, ?, ?, 'completed')`,
                [order_id, payment_method, total_amount]);

            // 4. หัก Coins
            if (payment_method === 'Coin') {
                db.query(`UPDATE users SET coins = coins - ? WHERE user_id = ?`, [total_amount, user_id]);
            }

            // 5. บันทึก Order Items และตัด Stock
            items.forEach(item => {
                db.query(`INSERT INTO order_items (order_id, variant_id, quantity, price) VALUES (?, ?, ?, ?)`,
                    [order_id, item.variant_id, item.quantity, item.price]);
                db.query(`UPDATE product_variants SET stock = stock - ? WHERE variant_id = ?`,
                    [item.quantity, item.variant_id]);
            });

            res.json({ message: 'สั่งซื้อสำเร็จเรียบร้อย', order_id });
        });
    });
});

// ==========================================
// 4. ระบบประวัติสั่งซื้อ ที่อยู่จัดส่ง และรีวิว (History & Reviews)
// ==========================================

// ดูประวัติสั่งซื้อของผู้ใช้
app.get('/api/orders/user/:userId', (req, res) => {
    const sql = `
        SELECT o.order_id, o.total_amount, o.status, o.created_at, p.payment_method
        FROM orders o
        LEFT JOIN payments p ON o.order_id = p.order_id
        WHERE o.user_id = ? ORDER BY o.created_at DESC
    `;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// บันทึกรีวิวสินค้า
app.post('/api/reviews', (req, res) => {
    const { user_id, product_id, rating, comment } = req.body;
    db.query(`INSERT INTO reviews (user_id, product_id, rating, comment) VALUES (?, ?, ?, ?)`,
        [user_id, product_id, rating, comment], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'บันทึกรีวิวเรียบร้อยแล้ว' });
        });
});

// ดึงรีวิวตามสินค้า
app.get('/api/reviews/product/:productId', (req, res) => {
    const sql = `
        SELECT r.*, u.username 
        FROM reviews r 
        JOIN users u ON r.user_id = u.user_id 
        WHERE r.product_id = ? ORDER BY r.created_at DESC
    `;
    db.query(sql, [req.params.productId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ==========================================
// 5. ระบบฝั่งผู้ดูแลระบบ (Admin CRUD & Reports)
// ==========================================

// เพิ่มสินค้าใหม่
app.post('/api/admin/products', (req, res) => {
    const { product_name, description, category_id, brand_id } = req.body;
    db.query(`INSERT INTO products (product_name, description, category_id, brand_id) VALUES (?, ?, ?, ?)`,
        [product_name, description, category_id, brand_id], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'เพิ่มสินค้าสำเร็จ', product_id: result.insertId });
        });
});

// เพิ่ม ตัวเลือกย่อย (Variant)
app.post('/api/admin/variants', (req, res) => {
    const { product_id, color_name, capacity, price, promotion_price, stock } = req.body;
    db.query(`INSERT INTO product_variants (product_id, color_name, capacity, price, promotion_price, stock) VALUES (?, ?, ?, ?, ?, ?)`,
        [product_id, color_name, capacity, price, promotion_price || null, stock], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'เพิ่มตัวเลือกสินค้าสำเร็จ', variant_id: result.insertId });
        });
});

// ตั้งค่าราคาโปรโมชัน (Promotion Price)
app.put('/api/admin/variants/:variantId/promotion', (req, res) => {
    const { promotion_price } = req.body;
    db.query(`UPDATE product_variants SET promotion_price = ? WHERE variant_id = ?`,
        [promotion_price, req.params.variantId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'อัปเดตราคาโปรโมชันเรียบร้อยแล้ว' });
        });
});

// รายงานสรุปยอดขายและสินค้าคงเหลือ (Admin Analytics & Reports)
app.get('/api/admin/reports', (req, res) => {
    const salesSql = `SELECT SUM(total_amount) as total_sales, COUNT(order_id) as total_orders FROM orders WHERE status = 'paid'`;
    const stockSql = `
        SELECT p.product_name, v.color_name, v.capacity, v.stock 
        FROM product_variants v 
        JOIN products p ON v.product_id = p.product_id 
        ORDER BY v.stock ASC
    `;
    db.query(salesSql, (err, sales) => {
        db.query(stockSql, (err2, stock) => {
            res.json({
                total_sales: sales[0]?.total_sales || 0,
                total_orders: sales[0]?.total_orders || 0,
                stock_report: stock || []
            });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));