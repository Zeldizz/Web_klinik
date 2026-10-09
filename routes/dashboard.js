const express = require('express');
const router = express.Router();
const db = require('../config/db'); // Import database connection

// Middleware to ensure a patient is authenticated
const isPatientAuthenticated = (req, res, next) => {
    if (req.session.patient) {
        return next(); // Continue if patient is in session
    }
    res.redirect('/login'); // Redirect to login if not authenticated
};

// GET /dashboard - Renders the patient dashboard page with active reservations.
router.get('/', isPatientAuthenticated, async (req, res) => {
    try {
        const patientId = req.session.patient.id;

        // Fetch active reservations (not 'Selesai' or 'Dibatalkan')
        const [reservations] = await db.query(
            `SELECT 
                id, 
                DATE_FORMAT(tanggal_reservasi, "%d %M %Y") as tanggal_formatted, 
                keluhan, 
                status,
                nomor_antrian,
                TIME_FORMAT(jam_estimasi_datang, '%H:%i') AS jam_estimasi,
                DATE_FORMAT(created_at, "%e %M %Y pukul %H.%i") as dibuat_pada
             FROM reservasi 
             WHERE pasien_id = ? AND status NOT IN ('Selesai', 'Dibatalkan')
             ORDER BY tanggal_reservasi ASC`,
            [patientId]
        );

        res.render('dashboard', {
            title: 'Dashboard Pasien',
            user: req.session.patient, // Pass patient data to the view
            reservations: reservations, // Pass active reservations to the view
            admin: null // Ensure admin is defined for the header
        });

    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

module.exports = router;
