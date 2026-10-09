const express = require('express');
const db = require('../config/db');
const router = express.Router();

// Middleware to check if a patient is authenticated
const isPatientAuthenticated = (req, res, next) => {
    if (req.session.patient) {
        return next();
    }
    res.redirect('/login');
};

// Function to calculate estimated arrival time for patient
function calculateEstimatedArrivalTime(selectedDate, currentTime) {
    const OPERATING_HOURS = {
        start: 8, // 08:00
        end: 20   // 20:00
    };
    
    // Buffer times in minutes
    const BUFFER_CONFIG = {
        SAME_DAY_IMMEDIATE: 30,    // 30 minutes for same-day immediate reservations
        SAME_DAY_ADVANCE: 60,     // 1 hour for same-day advance reservations
        FUTURE_DAY: 30,           // 30 minutes for future day reservations
        TRAVEL_TIME: 15,          // Estimated travel time
        PROCESSING_TIME: 15       // Administrative processing time
    };
    
    const today = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate());
    const reservationDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    const currentHour = currentTime.getHours();
    const currentMinute = currentTime.getMinutes();
    
    let estimatedTime;
    
    // Case 1: Same day reservation
    if (reservationDate.getTime() === today.getTime()) {
        const now = new Date(currentTime);
        
        // If current time is before operating hours, set arrival to opening time + buffer
        if (currentHour < OPERATING_HOURS.start) {
            estimatedTime = new Date(reservationDate); // Use reservation date, not current time
            estimatedTime.setHours(OPERATING_HOURS.start, BUFFER_CONFIG.FUTURE_DAY, 0, 0);
        }
        // If within operating hours, add immediate buffer
        else if (currentHour >= OPERATING_HOURS.start && currentHour < OPERATING_HOURS.end) {
            estimatedTime = new Date(reservationDate); // Use reservation date
            estimatedTime.setHours(currentHour, currentMinute, 0, 0); // Set to current time
            
            // Add buffer based on how much advance notice
            const minutesUntilClose = (OPERATING_HOURS.end - currentHour) * 60 - currentMinute;
            
            if (minutesUntilClose > 120) { // More than 2 hours left
                estimatedTime.setMinutes(estimatedTime.getMinutes() + BUFFER_CONFIG.SAME_DAY_ADVANCE);
            } else { // Less than 2 hours left - urgent
                estimatedTime.setMinutes(estimatedTime.getMinutes() + BUFFER_CONFIG.SAME_DAY_IMMEDIATE);
            }
        }
        // If after operating hours (shouldn't happen due to validation, but safety check)
        else {
            // Set to next day opening + buffer
            estimatedTime = new Date(reservationDate);
            estimatedTime.setDate(estimatedTime.getDate() + 1);
            estimatedTime.setHours(OPERATING_HOURS.start, BUFFER_CONFIG.FUTURE_DAY, 0, 0);
        }
    }
    // Case 2: Future day reservation
    else {
        // Set to opening time + standard buffer for future reservations
        estimatedTime = new Date(reservationDate);
        estimatedTime.setHours(OPERATING_HOURS.start, BUFFER_CONFIG.FUTURE_DAY, 0, 0);
    }
    
    // Ensure the time doesn't exceed operating hours
    const maxTime = new Date(estimatedTime);
    maxTime.setHours(OPERATING_HOURS.end - 1, 30, 0, 0); // 30 minutes before closing
    
    if (estimatedTime > maxTime) {
        estimatedTime = maxTime;
    }
    
    // Format as HH:MM for MySQL TIME format
    const hours = String(estimatedTime.getHours()).padStart(2, '0');
    const minutes = String(estimatedTime.getMinutes()).padStart(2, '0');
    
    return `${hours}:${minutes}:00`;
}

// GET /reservasi - Show reservation history for the patient
router.get('/', isPatientAuthenticated, async (req, res) => {
    try {
        const pasien_id = req.session.patient.id;
        const [reservations] = await db.query(
            `SELECT r.*, 
                   DATE_FORMAT(r.tanggal_reservasi, "%d %M %Y") as tanggal_formatted, 
                   r.nomor_antrian,
                   TIME_FORMAT(r.jam_estimasi_datang, '%H:%i') AS jam_estimasi,
                   DATE_FORMAT(r.created_at, "%e %M %Y pukul %H.%i") as dibuat_pada, 
                   rm.id as rekam_medis_id 
            FROM reservasi r 
            LEFT JOIN rekam_medis rm ON r.id = rm.reservasi_id 
            WHERE r.pasien_id = ? 
            ORDER BY r.tanggal_reservasi DESC`,
            [pasien_id]
        );
        res.render('reservasi/riwayat', { 
            title: 'Riwayat Reservasi', 
            reservations: reservations,
            user: req.session.patient,
            admin: null
        });
    } catch (error) {
        console.error('Error fetching reservation history:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /reservasi/riwayat - Show reservation history for the patient (alternative route)
router.get('/riwayat', isPatientAuthenticated, async (req, res) => {
    try {
        const pasien_id = req.session.patient.id;
        const [reservations] = await db.query(
            `SELECT r.*, 
                   DATE_FORMAT(r.tanggal_reservasi, "%d %M %Y") as tanggal_formatted, 
                   r.nomor_antrian,
                   TIME_FORMAT(r.jam_estimasi_datang, '%H:%i') AS jam_estimasi,
                   DATE_FORMAT(r.created_at, "%e %M %Y pukul %H.%i") as dibuat_pada, 
                   rm.id as rekam_medis_id 
            FROM reservasi r 
            LEFT JOIN rekam_medis rm ON r.id = rm.reservasi_id 
            WHERE r.pasien_id = ? 
            ORDER BY r.tanggal_reservasi DESC`,
            [pasien_id]
        );
        res.render('reservasi/riwayat', { 
            title: 'Riwayat Reservasi', 
            reservations: reservations,
            user: req.session.patient,
            admin: null
        });
    } catch (error) {
        console.error('Error fetching reservation history:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /reservasi/baru - Show form to create a new reservation
router.get('/baru', isPatientAuthenticated, (req, res) => {
    res.render('reservasi/form', { 
        title: 'Buat Reservasi Baru',
        user: req.session.patient,
        admin: null,
        error: null // Initialize error as null for clean form display
    });
});

// POST /reservasi/baru - Handle new reservation creation
router.post('/baru', isPatientAuthenticated, async (req, res) => {
    const { tanggal_reservasi, keluhan } = req.body;
    const pasien_id = req.session.patient.id;

    try {
        // Server-side validation for operating hours and days
        const selectedDate = new Date(tanggal_reservasi);
        const today = new Date();
        const now = new Date();
        
        // Reset time for date comparison
        const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const selectedDateOnly = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
        
        // Operating hours configuration
        const OPERATING_HOURS = {
            start: 8, // 08:00
            end: 20   // 20:00
        };
        
        // Validate: No Sunday reservations
        if (selectedDate.getDay() === 0) {
            return res.status(400).render('reservasi/form', {
                title: 'Buat Reservasi Baru',
                user: req.session.patient,
                admin: null,
                error: 'Maaf, klinik tutup pada hari Minggu. Silakan pilih hari lain.'
            });
        }
        
        // Validate: No past dates
        if (selectedDateOnly < todayDateOnly) {
            return res.status(400).render('reservasi/form', {
                title: 'Buat Reservasi Baru',
                user: req.session.patient,
                admin: null,
                error: 'Tidak dapat membuat reservasi untuk tanggal yang sudah lewat.'
            });
        }
        
        // Validate: If selected date is today, check if within operating hours
        if (selectedDateOnly.getTime() === todayDateOnly.getTime()) {
            const currentHour = now.getHours();
            
            if (currentHour >= OPERATING_HOURS.end) {
                return res.status(400).render('reservasi/form', {
                    title: 'Buat Reservasi Baru',
                    user: req.session.patient,
                    admin: null,
                    error: `Maaf, jam operasional klinik telah berakhir untuk hari ini (${OPERATING_HOURS.start}:00 - ${OPERATING_HOURS.end}:00). Silakan pilih tanggal besok atau hari lain.`
                });
            }
        }
        
        // Validate: Complaint minimum length
        if (!keluhan || keluhan.trim().length < 10) {
            return res.status(400).render('reservasi/form', {
                title: 'Buat Reservasi Baru',
                user: req.session.patient,
                admin: null,
                error: 'Mohon jelaskan keluhan Anda minimal 10 karakter untuk membantu dokter memahami kondisi Anda.'
            });
        }
        
        // Construct a new Date object to ensure it's treated as a local date
        // and format it to 'YYYY-MM-DD' which is safe for MySQL DATE/DATETIME columns
        const localDate = new Date(tanggal_reservasi);
        const formattedDate = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;

        // Check for duplicate reservation on the same date
        const [existingReservations] = await db.query(
            'SELECT id FROM reservasi WHERE pasien_id = ? AND tanggal_reservasi = ? AND status != "Dibatalkan"',
            [pasien_id, formattedDate]
        );
        
        if (existingReservations.length > 0) {
            return res.status(400).render('reservasi/form', {
                title: 'Buat Reservasi Baru',
                user: req.session.patient,
                admin: null,
                error: 'Anda sudah memiliki reservasi pada tanggal tersebut. Silakan pilih tanggal lain atau batalkan reservasi sebelumnya.'
            });
        }

        // Calculate estimated arrival time
        const estimatedArrivalTime = calculateEstimatedArrivalTime(selectedDate, now);
        
        // Insert new reservation with estimated arrival time
        await db.query(
            'INSERT INTO reservasi (pasien_id, tanggal_reservasi, keluhan, status, jam_estimasi_datang) VALUES (?, ?, ?, ?, ?)',
            [pasien_id, formattedDate, keluhan.trim(), 'Menunggu', estimatedArrivalTime]
        );
        
        // Redirect with success message
        res.redirect('/reservasi?success=1'); // Redirect to history page after creation
        
    } catch (error) {
        console.error('Error creating reservation:', error);
        res.status(500).render('reservasi/form', {
            title: 'Buat Reservasi Baru',
            user: req.session.patient,
            admin: null,
            error: 'Terjadi kesalahan pada server. Silakan coba lagi.'
        });
    }
});

// POST /reservasi/batal/:id - Patient cancels their reservation
router.post('/batal/:id', isPatientAuthenticated, async (req, res) => {
    const reservasiId = req.params.id;
    const pasienId = req.session.patient.id;

    const connection = await db.getConnection();
    try {
        const [reservations] = await connection.query(
            'SELECT * FROM reservasi WHERE id = ? AND pasien_id = ? AND status = ?',
            [reservasiId, pasienId, 'Menunggu']
        );

        if (reservations.length === 0) {
            return res.status(403).send('Pembatalan gagal. Reservasi tidak ditemukan atau sudah diproses.');
        }

        await connection.query('DELETE FROM reservasi WHERE id = ?', [reservasiId]);

        res.redirect('/profile');

    } catch (error) {
        console.error('Error cancelling reservation:', error);
        res.status(500).send('Terjadi kesalahan pada server saat membatalkan reservasi.');
    } finally {
        connection.release();
    }
});

module.exports = router;
