const express = require('express');
const db = require('../config/db');
const router = express.Router();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Middleware to check if user is authenticated
const isPatientAuthenticated = (req, res, next) => {
    if (req.session.patient) {
        return next();
    }
    res.redirect('/login');
};

// GET /rekam-medis - Show list of medical records
router.get('/', isPatientAuthenticated, async (req, res) => {
    try {
        // Fetch medical records for the logged-in patient
        // We join with 'reservasi' to get the initial complaint ('keluhan') for context
        const query = `
            SELECT 
                rm.id, 
                DATE_FORMAT(rm.tanggal_pemeriksaan, '%d %M %Y, Pukul %H:%i') as tanggal_pemeriksaan, 
                rm.diagnosis, 
                rm.tindakan as pengobatan,
                r.keluhan,
                a.nama_lengkap as nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE rm.pasien_id = ?
            ORDER BY rm.created_at DESC
        `;
        const [records] = await db.query(query, [req.session.patient.id]);
        
        res.render('rekam-medis/index', { 
            title: 'Riwayat Rekam Medis', 
            records: records,
            user: req.session.patient
        });

    } catch (error) {
        // If the table doesn't exist yet, catch the error and show an empty page
        if (error.code === 'ER_NO_SUCH_TABLE') {
            console.warn('`rekam_medis` table not found. Displaying empty page.');
            return res.render('rekam-medis/index', {
                title: 'Riwayat Rekam Medis',
                records: [],
                user: req.session.patient
            });
        }
        console.error('Error fetching medical records:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /rekam-medis/:id - Show detail of a medical record
router.get('/:id', isPatientAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const pasien_id = req.session.patient.id;

        const query = `
            SELECT 
                rm.*, 
                DATE_FORMAT(rm.tanggal_pemeriksaan, '%d %M %Y, Pukul %H:%i') as tanggal_pemeriksaan_formatted, 
                r.keluhan,
                a.nama_lengkap as nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE rm.id = ? AND rm.pasien_id = ?
        `;
        const [records] = await db.query(query, [id, pasien_id]);

        if (records.length === 0) {
            // Optional: Redirect or show a 'not found' message
            return res.status(404).send('Rekam medis tidak ditemukan atau Anda tidak memiliki akses.');
        }

        res.render('rekam-medis/detail', {
            title: 'Detail Rekam Medis',
            record: records[0],
            user: req.session.patient
        });

    } catch (error) {
        console.error('Error fetching medical record detail:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /rekam-medis/:id/preview - Show an HTML preview for printing
router.get('/:id/preview', isPatientAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const pasien_id = req.session.patient.id;

        const query = `
            SELECT 
                rm.*, 
                DATE_FORMAT(rm.tanggal_pemeriksaan, '%d %M %Y, Pukul %H:%i') as tanggal_pemeriksaan_formatted,
                r.id as reservasi_id,
                DATE_FORMAT(r.tanggal_reservasi, '%d %M %Y') as tanggal_reservasi_formatted,
                r.keluhan,
                p.nama as nama_pasien,
                p.no_ktp as nik,
                p.jenis_kelamin,
                DATE_FORMAT(p.tanggal_lahir, '%d %M %Y') as tanggal_lahir_formatted,
                a.nama_lengkap as nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN pasien p ON rm.pasien_id = p.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE rm.id = ? AND rm.pasien_id = ?
        `;
        const [records] = await db.query(query, [id, pasien_id]);

        if (records.length === 0) {
            return res.status(404).send('Rekam medis tidak ditemukan.');
        }

        const record = records[0];

        res.render('rekam-medis/preview', { record: record, layout: false });

    } catch (error) {
        console.error('Error generating preview:', error);
        res.status(500).send('Terjadi kesalahan saat membuat pratinjau.');
    }
});

// GET /rekam-medis/:id/cetak - Generate and serve a PDF of the medical record
router.get('/:id/cetak', isPatientAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const pasien_id = req.session.patient.id;

        // Comprehensive query to get all data for the PDF
        const query = `
            SELECT 
                rm.*, 
                DATE_FORMAT(rm.tanggal_pemeriksaan, '%d %M %Y, Pukul %H:%i') as tanggal_pemeriksaan_formatted,
                r.id as reservasi_id,
                DATE_FORMAT(r.tanggal_reservasi, '%d %M %Y') as tanggal_reservasi_formatted,
                r.keluhan,
                p.nama as nama_pasien,
                p.no_ktp as nik,
                p.jenis_kelamin,
                DATE_FORMAT(p.tanggal_lahir, '%d %M %Y') as tanggal_lahir_formatted,
                a.nama_lengkap as nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN pasien p ON rm.pasien_id = p.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE rm.id = ? AND rm.pasien_id = ?
        `;
        const [records] = await db.query(query, [id, pasien_id]);

        if (records.length === 0) {
            return res.status(404).send('Rekam medis tidak ditemukan.');
        }

        const record = records[0];

        // Render EJS template to HTML string
        const htmlContent = await new Promise((resolve, reject) => {
            res.render('rekam-medis/cetak-pdf', { record: record, layout: false }, (err, html) => {
                if (err) reject(err);
                resolve(html);
            });
        });

        // Launch Puppeteer
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        // Set content and generate PDF
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ 
            format: 'A4', 
            printBackground: true,
            margin: {
                top: '20mm',
                right: '20mm',
                bottom: '20mm',
                left: '20mm'
            } 
        });

        await browser.close();

        // Define path and save the PDF to the server
        const downloadsDir = path.join(__dirname, '..', 'public', 'downloads', 'pdf');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }

        const pdfPath = path.join(downloadsDir, `rekam-medis-${record.id}-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);

        // Send the saved file for download and delete it after
        res.download(pdfPath, `Rekam Medis - ${record.nama_pasien}.pdf`, (err) => {
            if (err) {
                console.error('Error during file download:', err);
            }
            // Clean up the file from the server
            fs.unlink(pdfPath, (unlinkErr) => {
                if (unlinkErr) {
                    console.error('Error deleting temporary PDF file:', unlinkErr);
                }
            });
        });

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).send('Terjadi kesalahan saat membuat file PDF.');
    }
});

module.exports = router;
