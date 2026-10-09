const express = require('express');
const db = require('../config/db');
const router = express.Router();

// Rute untuk mengecek struktur tabel
router.get('/check-tables', async (req, res) => {
    try {
        // Dapatkan daftar tabel
        const [tables] = await db.query("SHOW TABLES");
        const tableNames = tables.map(t => Object.values(t)[0]);
        
        // Dapatkan struktur setiap tabel
        const tablesInfo = {};
        for (const table of tableNames) {
            try {
                const [columns] = await db.query(`DESCRIBE ${table}`);
                tablesInfo[table] = columns;
            } catch (err) {
                tablesInfo[table] = { error: err.message };
            }
        }
        
        res.json(tablesInfo);
    } catch (error) {
        console.error('Error checking tables:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rute untuk mengecek data reservasi
router.get('/check-reservations', async (req, res) => {
    try {
        const [reservations] = await db.query('SELECT * FROM reservasi LIMIT 5');
        res.json(reservations);
    } catch (error) {
        console.error('Error checking reservations:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
