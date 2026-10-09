const express = require('express');
const router = express.Router();
const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Middleware to ensure a patient is authenticated
const isPatientAuthenticated = (req, res, next) => {
    if (req.session.patient) {
        return next();
    }
    res.redirect('/login');
};

// GET /profile - Renders the main profile page with extensive debugging.
router.get('/', isPatientAuthenticated, async (req, res) => {
    console.log('\n--- [DEBUG] Accessing GET /profile route ---');
    const pasienId = req.session.patient.id;
    console.log(`[DEBUG] Patient ID from session: ${pasienId}`);

    if (!pasienId) {
        return res.status(400).send('Error: Patient ID not found in session.');
    }

    try {
        const connection = await db.getConnection();
        console.log('[DEBUG] Database connection acquired for profile.');

        // Query 1: Get patient's personal data
        console.log('[DEBUG] Executing query for patient data...');
        const [patientDataRows] = await connection.query(
            "SELECT *, DATE_FORMAT(tanggal_lahir, '%d %M %Y') as tgl_lahir_formatted FROM pasien WHERE id = ?",
            [pasienId]
        );
        console.log(`[DEBUG] Patient data query executed. Rows found: ${patientDataRows.length}`);
        if (patientDataRows.length === 0) {
            connection.release();
            return res.status(404).send('Data pasien tidak ditemukan.');
        }
        const patientData = patientDataRows[0];

        // Query 2: Get reservation history
        console.log('[DEBUG] Executing query for reservation history...');
        const [history] = await connection.query(
            `SELECT id, tanggal_reservasi, keluhan, status FROM reservasi WHERE pasien_id = ? ORDER BY tanggal_reservasi DESC`,
            [pasienId]
        );
        console.log(`[DEBUG] Reservation history query executed. Rows found: ${history.length}`);

        connection.release();
        console.log('[DEBUG] Database connection released.');

        try {
            console.log('[DEBUG] Attempting to render profile.ejs...');
            res.render('profile', {
                title: 'Profil Pasien',
                user: req.session.patient,
                admin: null,
                patientData: patientData,
                history: history
            });
            console.log('--- [SUCCESS] Successfully rendered profile.ejs ---');
        } catch (renderError) {
            console.error('!!! [CRITICAL] EJS RENDER ERROR in /profile !!!', renderError);
            res.status(500).send('Terjadi kesalahan saat merender halaman profil.');
        }

    } catch (error) {
        console.error('!!! [CRITICAL] DATABASE/LOGIC ERROR in GET /profile !!!', error);
        res.status(500).send('Terjadi kesalahan pada server saat memuat profil.');
    }
});

// GET /riwayat-pemeriksaan - Renders the medical history page with extensive debugging.
router.get('/riwayat-pemeriksaan', isPatientAuthenticated, async (req, res) => {
    console.log('\n--- [DEBUG] Accessing GET /profile/riwayat-pemeriksaan route ---');
    const pasienId = req.session.patient.id;
    console.log(`[DEBUG] Patient ID from session: ${pasienId}`);

    if (!pasienId) {
        return res.status(400).send('Error: Patient ID not found in session.');
    }

    try {
        const connection = await db.getConnection();
        console.log('[DEBUG] Database connection acquired for medical history.');

        const query = `
            SELECT 
                rm.id, 
                rm.diagnosis, 
                rm.tindakan AS pengobatan,
                DATE_FORMAT(rm.tanggal_pemeriksaan, '%d %M %Y, Pukul %H:%i') AS tanggal_pemeriksaan,
                a.nama_lengkap AS nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE r.pasien_id = ? AND r.status = 'Selesai'
            ORDER BY rm.tanggal_pemeriksaan DESC;`;
        console.log('[DEBUG] Executing query for medical history...');
        const [riwayat] = await connection.query(query, [pasienId]);
        console.log(`[DEBUG] Medical history query executed. Rows found: ${riwayat.length}`);
        
        connection.release();
        console.log('[DEBUG] Database connection released for medical history.');

        try {
            console.log('[DEBUG] Attempting to render riwayat-pemeriksaan.ejs...');
            res.render('riwayat-pemeriksaan', {
                title: 'Riwayat Pemeriksaan',
                user: req.session.patient,
                admin: null,
                riwayat: riwayat
            });
            console.log('--- [SUCCESS] Successfully rendered riwayat-pemeriksaan.ejs ---');
        } catch (renderError) {
            console.error('!!! [CRITICAL] EJS RENDER ERROR in /riwayat-pemeriksaan !!!', renderError);
            res.status(500).send('Terjadi kesalahan saat merender riwayat pemeriksaan.');
        }

    } catch (error) {
        console.error('!!! [CRITICAL] DATABASE/LOGIC ERROR in GET /riwayat-pemeriksaan !!!', error);
        res.status(500).send('Terjadi kesalahan pada server saat memuat riwayat pemeriksaan.');
    }
});


// GET /profile/edit - Show form to edit profile
router.get('/edit', isPatientAuthenticated, async (req, res) => {
    try {
        const [patientDataRows] = await db.query("SELECT *, DATE_FORMAT(tanggal_lahir, '%Y-%m-%d') as tgl_lahir_form FROM pasien WHERE id = ?", [req.session.patient.id]);
        if (patientDataRows.length === 0) {
            return res.status(404).send('Pasien tidak ditemukan.');
        }
        res.render('edit-profile', {
            title: 'Ubah Profil',
            user: req.session.patient,
            admin: null,
            patientData: patientDataRows[0]
        });
    } catch (error) {
        console.error('Error fetching patient data for edit:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /profile/edit - Handle profile update
router.post('/edit', isPatientAuthenticated, async (req, res) => {
    const { nama, no_ktp, no_telepon, tanggal_lahir, jenis_kelamin, alamat, password } = req.body;
    const pasienId = req.session.patient.id;

    try {
        let hashedPassword = null;
        if (password && password.trim() !== '') {
            hashedPassword = await bcrypt.hash(password, 10);
        }

        const connection = await db.getConnection();
        if (hashedPassword) {
            await connection.query(
                'UPDATE pasien SET nama = ?, no_ktp = ?, no_telepon = ?, tanggal_lahir = ?, jenis_kelamin = ?, alamat = ?, password = ? WHERE id = ?',
                [nama, no_ktp, no_telepon, tanggal_lahir, jenis_kelamin, alamat, hashedPassword, pasienId]
            );
        } else {
            await connection.query(
                'UPDATE pasien SET nama = ?, no_ktp = ?, no_telepon = ?, tanggal_lahir = ?, jenis_kelamin = ?, alamat = ? WHERE id = ?',
                [nama, no_ktp, no_telepon, tanggal_lahir, jenis_kelamin, alamat, pasienId]
            );
        }
        connection.release();

        req.session.patient.nama = nama;

        res.redirect('/profile');
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

module.exports = router;
