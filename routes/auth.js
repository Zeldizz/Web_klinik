const express = require('express');
const bcrypt = require('bcryptjs');
const svgCaptcha = require('svg-captcha'); // Import svg-captcha
const db = require('../config/db');
const router = express.Router();

// GET /login - Show login page
router.get('/login', (req, res) => {
    res.render('login', { title: 'Login Pasien' });
});

// GET /register - Show registration page with image CAPTCHA
router.get('/register', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 6, // number of characters
        ignoreChars: '0o1i',
        noise: 2, // number of lines
        color: true,
        background: '#f4f4f4'
    });
    req.session.captcha = captcha.text;
    // Inject an ID into the SVG tag for easier DOM manipulation on the frontend
    const captchaWithId = captcha.data.replace('<svg', '<svg id="captcha-image"');
    res.render('register', {
        title: 'Registrasi Pasien',
        captchaImage: captchaWithId
    });
});

// GET /captcha - To refresh captcha image
router.get('/captcha', (req, res) => {
    const newCaptcha = svgCaptcha.create({
        size: 6,
        ignoreChars: '0o1i',
        noise: 2,
        color: true,
        background: '#f4f4f4'
    });
    req.session.captcha = newCaptcha.text;
    // Also inject the ID when the captcha is refreshed
    const captchaWithId = newCaptcha.data.replace('<svg', '<svg id="captcha-image"');
    res.type('svg').send(captchaWithId);
});

// POST /register - Handle registration with AJAX
router.post('/register', async (req, res) => {
    const { nama, email, password, captcha, no_ktp, no_telepon, jenis_kelamin, tanggal_lahir, alamat } = req.body;

    // 1. Validate CAPTCHA
    if (!req.session.captcha || captcha.toLowerCase() !== req.session.captcha.toLowerCase()) {
        // The frontend is responsible for calling GET /captcha to refresh the image.
        // The backend just needs to send the error response.
        return res.status(400).json({ message: 'CAPTCHA tidak sesuai. Silakan coba lagi.' });
    }

    // 2. Server-side validation
    const emailRegex = /\S+@\S+\.\S+/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: 'Format email tidak valid.' });
    }

    const ktpRegex = /^\d{16}$/;
    if (!ktpRegex.test(no_ktp)) {
        return res.status(400).json({ message: 'No. KTP harus terdiri dari 16 digit angka.' });
    }

    const teleponRegex = /^\d{10,15}$/;
    if (!teleponRegex.test(no_telepon)) {
        return res.status(400).json({ message: 'No. Telepon harus terdiri dari 10-15 digit angka.' });
    }

    const birthDate = new Date(tanggal_lahir);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set time to beginning of day for accurate comparison
    if (birthDate >= today) {
        return res.status(400).json({ message: 'Tanggal lahir tidak boleh hari ini atau di masa depan.' });
    }

    try {
        // 3. Check for duplicates (Email and KTP)
        const [existingPatient] = await db.query('SELECT * FROM pasien WHERE email = ? OR no_ktp = ?', [email, no_ktp]);
        if (existingPatient.length > 0) {
            if (existingPatient[0].email === email) {
                return res.status(409).json({ message: 'Email sudah terdaftar. Silakan gunakan email lain.' });
            }
            if (existingPatient[0].no_ktp === no_ktp) {
                return res.status(409).json({ message: 'No. KTP sudah terdaftar. Silakan gunakan No. KTP lain.' });
            }
        }

        // 3. Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. Insert new user into the database
        const query = `
            INSERT INTO pasien 
            (nama, email, password, no_ktp, no_telepon, jenis_kelamin, tanggal_lahir, alamat)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await db.query(query, [nama, email, hashedPassword, no_ktp, no_telepon, jenis_kelamin, tanggal_lahir, alamat]);

        // 5. Send success response
        // Clear captcha from session after successful registration
        req.session.captcha = null;
        return res.status(201).json({ 
            message: 'Pendaftaran berhasil! Anda akan dialihkan ke halaman login.',
            redirectUrl: '/login'
        });

    } catch (error) {
        console.error('Error during registration:', error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server. Silakan coba lagi nanti.' });
    }
});

// POST /login - Handle login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Find user by email
        const [users] = await db.query('SELECT * FROM pasien WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(400).send('Email atau password salah.');
        }

        const user = users[0];

        // Compare submitted password with hashed password in DB
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).send('Email atau password salah.');
        }

        // Store user info in session (excluding password)
        // Use req.session.patient to be consistent with other routes
        req.session.patient = {
            id: user.id,
            nama: user.nama,
            email: user.email,
            role: 'pasien' // Assign role
        };

        // Redirect to the new patient dashboard
        res.redirect('/dashboard');

    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /logout - Handle logout
router.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/profile'); // Or handle error appropriately
        }
        res.clearCookie('connect.sid'); // The default session cookie name
        res.redirect('/');
    });
});

module.exports = router;
