const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const router = express.Router();
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { sendEmail } = require('../services/emailService'); // Import WhatsApp Service
const cron = require('node-cron'); // Import Cron for scheduling

// Middleware untuk memeriksa apakah ada admin/staf yang login
const isAdminAuthenticated = (req, res, next) => {
    if (req.session.admin && req.session.admin.id) {
        res.locals.admin = req.session.admin; // Make admin session available in all views
        return next();
    }
    res.redirect('/admin/login');
};

// Middleware untuk memeriksa peran 'Admin'
const isAdmin = (req, res, next) => {
    if (req.session.admin && req.session.admin.role === 'Admin') {
        return next();
    }
    res.status(403).send('Akses Ditolak: Hanya untuk Admin.');
};

// Middleware untuk memeriksa peran 'Tenaga Medis' atau 'Admin'
const isTenagaMedisOrAdmin = (req, res, next) => {
    if (req.session.admin && (req.session.admin.role === 'Tenaga Medis' || req.session.admin.role === 'Admin')) {
        return next();
    }
    res.status(403).send('Akses Ditolak.');
};

// Middleware untuk memeriksa semua peran kecuali pasien
const isAnyStaff = (req, res, next) => {
    if (req.session.admin && ['Admin', 'Tenaga Medis', 'Pimpinan Klinik'].includes(req.session.admin.role)) {
        return next();
    }
    res.status(403).send('Akses Ditolak.');
};

// Middleware untuk memeriksa peran 'Pimpinan Klinik'
const isPimpinanKlinik = (req, res, next) => {
    if (req.session.admin && req.session.admin.role === 'Pimpinan Klinik') {
        return next();
    }
    res.status(403).send('Akses Ditolak: Hanya untuk Pimpinan Klinik.');
};

// Middleware untuk memeriksa peran 'Admin' atau 'Pimpinan Klinik'
const isAdminOrPimpinan = (req, res, next) => {
    if (req.session.admin && (req.session.admin.role === 'Admin' || req.session.admin.role === 'Pimpinan Klinik')) {
        return next();
    }
    res.status(403).send('Akses Ditolak.');
};

// GET /admin/login - Show admin login page
router.get('/login', (req, res) => {
    if (req.session.admin) {
        return res.redirect('/admin/dashboard');
    }
    res.render('admin/login', { title: 'Login Admin/Tenaga Medis' });
});

// POST /admin/login - Handle admin login with AJAX
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [admins] = await db.query('SELECT * FROM admin WHERE username = ?', [username]);
        if (admins.length === 0) {
            return res.status(401).json({ message: 'Username atau password salah.' });
        }

        const admin = admins[0];
        // Note: The hash for 'admin123' should be correct in the database.
        // A sample correct hash: $2a$10$3l.YV0i24s2s4i4b5o5c6u3g/h/i/j/k/l/m/n/o/p/q/r/s/t/u
        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Username atau password salah.' });
        }

        req.session.admin = {
            id: admin.id,
            username: admin.username,
            nama: admin.nama_lengkap,
            role: admin.role
        };
        
        // Destroy patient session if it exists, to prevent conflicts
        if(req.session.user) {
            req.session.user = null;
        }

        res.json({ redirectUrl: '/admin/dashboard' });

    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

// Function to generate comprehensive monthly report data
async function generateMonthlyReportData(filters) {
    try {
        const reportData = {
            summary: {},
            patientStats: {},
            diseaseStats: [],
            medicineStats: [],
            monthlyTrends: []
        };

        // Build date conditions based on filters
        let dateCondition = '';
        let queryParams = [];
        
        switch (filters.range) {
            case 'last7days':
                dateCondition = 'DATE(p.created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
                break;
            case 'thisMonth':
                dateCondition = 'MONTH(p.created_at) = MONTH(CURDATE()) AND YEAR(p.created_at) = YEAR(CURDATE())';
                break;
            case 'last12months':
                dateCondition = 'DATE(p.created_at) >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)';
                break;
            case 'thisYear':
                dateCondition = 'YEAR(p.created_at) = YEAR(CURDATE())';
                break;
            case 'specificMonth':
                dateCondition = 'MONTH(p.created_at) = ? AND YEAR(p.created_at) = ?';
                queryParams.push(filters.month, filters.year);
                break;
            case 'dateRange':
                if (filters.startDate && filters.endDate) {
                    dateCondition = 'DATE(p.created_at) BETWEEN ? AND ?';
                    queryParams.push(filters.startDate, filters.endDate);
                } else {
                    dateCondition = 'DATE(p.created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
                }
                break;
            default:
                dateCondition = 'MONTH(p.created_at) = MONTH(CURDATE()) AND YEAR(p.created_at) = YEAR(CURDATE())';
        }

        // 1. Summary Statistics
        const [summaryResult] = await db.query(`
            SELECT 
                COUNT(DISTINCT p.id) as total_patients,
                COUNT(DISTINCT r.id) as total_reservations,
                COUNT(DISTINCT rm.id) as total_examinations,
                COUNT(DISTINCT CASE WHEN r.status = 'Selesai' THEN r.id END) as completed_reservations
            FROM pasien p
            LEFT JOIN reservasi r ON p.id = r.pasien_id
            LEFT JOIN rekam_medis rm ON p.id = rm.pasien_id
            WHERE ${dateCondition}
        `, queryParams);

        reportData.summary = summaryResult[0];

        // 2. Patient Gender Statistics
        const [genderStats] = await db.query(`
            SELECT 
                jenis_kelamin,
                COUNT(*) as count,
                ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM pasien p2 WHERE ${dateCondition.replace(/p\./g, 'p2.')})), 1) as percentage
            FROM pasien p
            WHERE ${dateCondition}
            GROUP BY jenis_kelamin
            ORDER BY count DESC
        `, queryParams.concat(queryParams));

        reportData.patientStats.gender = genderStats;

        // 3. Age Group Statistics
        const [ageStats] = await db.query(`
            SELECT 
                CASE 
                    WHEN TIMESTAMPDIFF(YEAR, p.tanggal_lahir, CURDATE()) < 18 THEN 'Anak-anak (< 18)'
                    WHEN TIMESTAMPDIFF(YEAR, p.tanggal_lahir, CURDATE()) BETWEEN 18 AND 30 THEN 'Dewasa Muda (18-30)'
                    WHEN TIMESTAMPDIFF(YEAR, p.tanggal_lahir, CURDATE()) BETWEEN 31 AND 50 THEN 'Dewasa (31-50)'
                    WHEN TIMESTAMPDIFF(YEAR, p.tanggal_lahir, CURDATE()) BETWEEN 51 AND 65 THEN 'Lansia Awal (51-65)'
                    ELSE 'Lansia (> 65)'
                END as age_group,
                COUNT(*) as count,
                ROUND(AVG(TIMESTAMPDIFF(YEAR, p.tanggal_lahir, CURDATE())), 1) as avg_age
            FROM pasien p
            WHERE ${dateCondition}
            GROUP BY age_group
            ORDER BY count DESC
        `, queryParams);

        reportData.patientStats.age = ageStats;

        // 4. Disease/Diagnosis Statistics (from medical records)
        const diseaseCondition = dateCondition.replace(/p\./g, 'p2.').replace('p2.created_at', 'rm2.tanggal_pemeriksaan');
        const mainDiseaseCondition = dateCondition.replace(/p\./g, 'p.').replace('p.created_at', 'rm.tanggal_pemeriksaan');
        
        const [diseaseStats] = await db.query(`
            SELECT 
                diagnosis,
                COUNT(*) as count,
                ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM rekam_medis rm2 
                    JOIN pasien p2 ON rm2.pasien_id = p2.id 
                    WHERE ${diseaseCondition})), 1) as percentage
            FROM rekam_medis rm
            JOIN pasien p ON rm.pasien_id = p.id
            WHERE ${mainDiseaseCondition} 
                AND diagnosis IS NOT NULL 
                AND diagnosis != ''
            GROUP BY diagnosis
            ORDER BY count DESC
            LIMIT 10
        `, queryParams.concat(queryParams));

        reportData.diseaseStats = diseaseStats;

        // 5. Medicine Statistics (from medical records)
        const [medicineRaw] = await db.query(`
            SELECT resep_obat
            FROM rekam_medis rm
            JOIN pasien p ON rm.pasien_id = p.id
            WHERE ${mainDiseaseCondition} 
                AND resep_obat IS NOT NULL 
                AND resep_obat != ''
        `, queryParams);

        // Process medicine data (since it's stored as text)
        const medicineCount = {};
        medicineRaw.forEach(row => {
            if (row.resep_obat) {
                // Split by newlines and process each medicine
                const medicines = row.resep_obat.split('\n').filter(med => med.trim());
                medicines.forEach(medicine => {
                    // Extract medicine name (before first dash)
                    const medicineName = medicine.split(' - ')[0].trim();
                    if (medicineName) {
                        medicineCount[medicineName] = (medicineCount[medicineName] || 0) + 1;
                    }
                });
            }
        });

        // Convert to array and sort
        const totalMedicines = Object.values(medicineCount).reduce((a, b) => a + b, 0);
        reportData.medicineStats = Object.entries(medicineCount)
            .map(([name, count]) => ({
                medicine_name: name,
                count: count,
                percentage: totalMedicines > 0 ? ((count / totalMedicines) * 100).toFixed(1) : '0.0'
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        // 6. Monthly Trends (last 6 months)
        const [monthlyTrends] = await db.query(`
            SELECT 
                DATE_FORMAT(p.created_at, '%Y-%m') as month,
                DATE_FORMAT(p.created_at, '%M %Y') as month_name,
                COUNT(DISTINCT p.id) as new_patients,
                COUNT(DISTINCT r.id) as total_reservations,
                COUNT(DISTINCT rm.id) as total_examinations
            FROM pasien p
            LEFT JOIN reservasi r ON p.id = r.pasien_id AND MONTH(r.tanggal_reservasi) = MONTH(p.created_at) AND YEAR(r.tanggal_reservasi) = YEAR(p.created_at)
            LEFT JOIN rekam_medis rm ON p.id = rm.pasien_id AND MONTH(rm.tanggal_pemeriksaan) = MONTH(p.created_at) AND YEAR(rm.tanggal_pemeriksaan) = YEAR(p.created_at)
            WHERE p.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
            GROUP BY DATE_FORMAT(p.created_at, '%Y-%m')
            ORDER BY month DESC
            LIMIT 6
        `);

        reportData.monthlyTrends = monthlyTrends.reverse(); // Show oldest to newest

        return reportData;

    } catch (error) {
        console.error('Error generating monthly report:', error);
        return {
            summary: {},
            patientStats: { gender: [], age: [] },
            diseaseStats: [],
            medicineStats: [],
            monthlyTrends: []
        };
    }
}

// GET /admin/dashboard - Show admin dashboard
router.get('/dashboard', isAnyStaff, async (req, res) => {
    try {
        const { range, month, year, startDate, endDate, gender, reportMonth, customMonth, customYear } = req.query;

        // Handle reportMonth parameter for monthly report section
        let monthlyReportFilters = {
            range: 'thisMonth',
            month: new Date().getMonth() + 1,
            year: new Date().getFullYear()
        };

        if (reportMonth) {
            switch (reportMonth) {
                case 'current':
                    monthlyReportFilters.range = 'thisMonth';
                    monthlyReportFilters.month = new Date().getMonth() + 1;
                    monthlyReportFilters.year = new Date().getFullYear();
                    break;
                case 'previous':
                    const prevDate = new Date();
                    prevDate.setMonth(prevDate.getMonth() - 1);
                    monthlyReportFilters.range = 'specificMonth';
                    monthlyReportFilters.month = prevDate.getMonth() + 1;
                    monthlyReportFilters.year = prevDate.getFullYear();
                    break;
                case 'custom':
                    if (customMonth && customYear) {
                        monthlyReportFilters.range = 'specificMonth';
                        monthlyReportFilters.month = parseInt(customMonth);
                        monthlyReportFilters.year = parseInt(customYear);
                    }
                    break;
            }
        }

        // Set default filters for main dashboard charts
        const filters = {
            range: range || 'last7days',
            month: month || new Date().getMonth() + 1,
            year: year || new Date().getFullYear(),
            startDate: startDate,
            endDate: endDate,
            gender: gender || '',
        };

        // Build date conditions based on filter
        let dateCondition = '';
        let queryParams = [];
        let newPatientsQueryParams = [];
        const currentDate = new Date();

        switch (filters.range) {
            case 'last7days':
                dateCondition = 'r.tanggal_reservasi >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
                break;
            case 'thisMonth':
                dateCondition = 'MONTH(r.tanggal_reservasi) = MONTH(CURDATE()) AND YEAR(r.tanggal_reservasi) = YEAR(CURDATE())';
                break;
            case 'specificMonth':
                dateCondition = 'MONTH(r.tanggal_reservasi) = ? AND YEAR(r.tanggal_reservasi) = ?';
                queryParams.push(filters.month, filters.year);
                newPatientsQueryParams.push(filters.month, filters.year);
                break;
            case 'last12months':
                dateCondition = 'r.tanggal_reservasi >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)';
                break;
            case 'thisYear':
                dateCondition = 'YEAR(r.tanggal_reservasi) = YEAR(CURDATE())';
                break;
            case 'dateRange':
                if (filters.startDate && filters.endDate) {
                    dateCondition = 'r.tanggal_reservasi BETWEEN ? AND ?';
                    queryParams.push(filters.startDate, filters.endDate);
                    newPatientsQueryParams.push(filters.startDate, filters.endDate);
                } else {
                    dateCondition = 'r.tanggal_reservasi >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
                }
                break;
            default:
                dateCondition = 'r.tanggal_reservasi >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        }

        // Add gender filter if specified
        let genderCondition = '';
        if (filters.gender) {
            genderCondition = ' AND p.jenis_kelamin = ?';
            queryParams.push(filters.gender);
        }

        // Query for reservations chart data
        let reservationsQuery = `
            SELECT 
                DATE(r.tanggal_reservasi) as label,
                COUNT(r.id) as total_reservations
            FROM reservasi r
            JOIN pasien p ON r.pasien_id = p.id
            WHERE ${dateCondition}${genderCondition}
            GROUP BY label
            ORDER BY label ASC
        `;

        const [reservationsData] = await db.query(reservationsQuery, queryParams);

        // Query for new patients chart data
        let newPatientsDateCondition = dateCondition.replace(/r\.tanggal_reservasi/g, 'created_at');
        let newPatientsQuery = `
            SELECT 
                DATE(created_at) as label,
                COUNT(id) as total_new_patients
            FROM pasien
            WHERE ${newPatientsDateCondition}
        `;

        if (filters.gender) {
            newPatientsQuery += ' AND jenis_kelamin = ?';
            newPatientsQueryParams.push(filters.gender);
        }

        newPatientsQuery += ' GROUP BY label ORDER BY label ASC';

        const [newPatientsData] = await db.query(newPatientsQuery, newPatientsQueryParams);

        // Process chart data
        let labels = [];
        let reservations = [];
        let newPatients = [];

        // Create a map for easier lookup
        const reservationsMap = new Map();
        const newPatientsMap = new Map();

        reservationsData.forEach(row => {
            reservationsMap.set(row.label.toISOString().split('T')[0], row.total_reservations);
        });

        newPatientsData.forEach(row => {
            newPatientsMap.set(row.label.toISOString().split('T')[0], row.total_new_patients);
        });

        // Generate labels based on filter range
        if (filters.range === 'last7days') {
            const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
            for (let i = 6; i >= 0; i--) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                const dayName = days[date.getDay()];
                labels.push(dayName);
                reservations.push(reservationsMap.get(dateStr) || 0);
                newPatients.push(newPatientsMap.get(dateStr) || 0);
            }
        } else if (filters.range === 'thisMonth' || filters.range === 'specificMonth') {
            // Group by week
            const targetMonth = filters.range === 'specificMonth' ? filters.month - 1 : currentDate.getMonth();
            const targetYear = filters.range === 'specificMonth' ? filters.year : currentDate.getFullYear();
            
            for (let week = 1; week <= 4; week++) {
                labels.push(`Minggu ${week}`);
                let weekReservations = 0;
                let weekNewPatients = 0;
                
                reservationsData.forEach(row => {
                    const date = new Date(row.label);
                    if (date.getMonth() === targetMonth && date.getFullYear() === targetYear) {
                        const weekNum = Math.ceil(date.getDate() / 7);
                        if (weekNum === week) {
                            weekReservations += row.total_reservations;
                        }
                    }
                });
                
                newPatientsData.forEach(row => {
                    const date = new Date(row.label);
                    if (date.getMonth() === targetMonth && date.getFullYear() === targetYear) {
                        const weekNum = Math.ceil(date.getDate() / 7);
                        if (weekNum === week) {
                            weekNewPatients += row.total_new_patients;
                        }
                    }
                });
                
                reservations.push(weekReservations);
                newPatients.push(weekNewPatients);
            }
        } else if (filters.range === 'last12months' || filters.range === 'thisYear') {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
            const startMonth = filters.range === 'thisYear' ? 0 : currentDate.getMonth() - 11;
            
            for (let i = 0; i < 12; i++) {
                const monthIndex = (startMonth + i + 12) % 12;
                labels.push(months[monthIndex]);
                
                let monthReservations = 0;
                let monthNewPatients = 0;
                
                reservationsData.forEach(row => {
                    const date = new Date(row.label);
                    if (date.getMonth() === monthIndex) {
                        monthReservations += row.total_reservations;
                    }
                });
                
                newPatientsData.forEach(row => {
                    const date = new Date(row.label);
                    if (date.getMonth() === monthIndex) {
                        monthNewPatients += row.total_new_patients;
                    }
                });
                
                reservations.push(monthReservations);
                newPatients.push(monthNewPatients);
            }
        } else {
            // For date range or default
            const allDates = new Set([...reservationsMap.keys(), ...newPatientsMap.keys()]);
            const sortedDates = Array.from(allDates).sort();
            
            sortedDates.forEach(dateStr => {
                const date = new Date(dateStr);
                labels.push(date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }));
                reservations.push(reservationsMap.get(dateStr) || 0);
                newPatients.push(newPatientsMap.get(dateStr) || 0);
            });
        }

        // Query for donut chart data (status distribution)
        let donutQuery = `
            SELECT 
                r.status,
                COUNT(*) as count
            FROM reservasi r
        `;
        
        let donutQueryParams = [];
        if (filters.gender) {
            donutQuery += ' JOIN pasien p ON r.pasien_id = p.id WHERE p.jenis_kelamin = ?';
            donutQueryParams.push(filters.gender);
        }
        
        donutQuery += ' GROUP BY r.status';
        
        const [donutDataResult] = await db.query(donutQuery, donutQueryParams);

        // Process donut chart data
        const statusMap = new Map();
        donutDataResult.forEach(row => {
            statusMap.set(row.status, row.count);
        });

        const donutLabels = ['Menunggu', 'Dikonfirmasi', 'Selesai', 'Dibatalkan'];
        const donutData = [
            statusMap.get('Menunggu') || 0,
            statusMap.get('Dikonfirmasi') || 0,
            statusMap.get('Selesai') || 0,
            statusMap.get('Dibatalkan') || 0
        ];
        const donutColors = ['#ffc107', '#0d6efd', '#198754', '#dc3545'];

        // Get total counts for stat cards
        const [totalReservasiRows] = await db.query('SELECT COUNT(*) as count FROM reservasi');
        const [totalPasienRows] = await db.query('SELECT COUNT(*) as count FROM pasien');
        const [totalTenagaMedisRows] = await db.query('SELECT COUNT(*) as count FROM admin WHERE role IN ("Tenaga Medis", "Admin")');

        // Generate Monthly Report Data
        const monthlyReportData = await generateMonthlyReportData(monthlyReportFilters);

        res.render('admin/dashboard', {
            title: 'Dashboard Admin',
            layout: 'layouts/admin-layout',
            admin: req.session.admin,
            locals: {
                totalReservasi: totalReservasiRows[0].count,
                totalPasien: totalPasienRows[0].count,
                totalTenagaMedis: totalTenagaMedisRows[0].count,
                chartData: {
                    labels,
                    reservations,
                    newPatients
                },
                donutLabels,
                donutData,
                donutColors,
                filters,
                monthlyReport: monthlyReportData,
                monthlyReportFilters: monthlyReportFilters
            }
        });

    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        req.flash('error_msg', 'Tidak dapat memuat data dasbor.');
        res.redirect('/admin/dashboard');
    }
});

// GET /admin/laporan/export-pdf - Export monthly report to PDF
router.get('/laporan/export-pdf', isAnyStaff, async (req, res) => {
    try {
        const { range, month, year, startDate, endDate, gender, reportMonth, customMonth, customYear } = req.query;

        // Handle reportMonth parameter from monthly report filter
        let finalRange = range || 'thisMonth';
        let finalMonth = month || new Date().getMonth() + 1;
        let finalYear = year || new Date().getFullYear();

        if (reportMonth) {
            switch (reportMonth) {
                case 'current':
                    finalRange = 'thisMonth';
                    finalMonth = new Date().getMonth() + 1;
                    finalYear = new Date().getFullYear();
                    break;
                case 'previous':
                    const prevDate = new Date();
                    prevDate.setMonth(prevDate.getMonth() - 1);
                    finalRange = 'specificMonth';
                    finalMonth = prevDate.getMonth() + 1;
                    finalYear = prevDate.getFullYear();
                    break;
                case 'custom':
                    if (customMonth && customYear) {
                        finalRange = 'specificMonth';
                        finalMonth = parseInt(customMonth);
                        finalYear = parseInt(customYear);
                    }
                    break;
            }
        }

        // Set default filters
        const filters = {
            range: finalRange,
            month: finalMonth,
            year: finalYear,
            startDate: startDate || '',
            endDate: endDate || '',
            gender: gender || '',
        };

        // Generate report data
        const monthlyReportData = await generateMonthlyReportData(filters);

        // Generate report title based on filter
        let reportTitle = 'Laporan Bulanan Klinik';
        let reportPeriod = '';
        
        switch (filters.range) {
            case 'last7days':
                reportPeriod = '7 Hari Terakhir';
                break;
            case 'thisMonth':
                const currentMonth = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
                reportPeriod = `Bulan ${currentMonth}`;
                break;
            case 'last12months':
                reportPeriod = '12 Bulan Terakhir';
                break;
            case 'thisYear':
                reportPeriod = `Tahun ${new Date().getFullYear()}`;
                break;
            case 'specificMonth':
                const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 
                                  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
                reportPeriod = `${monthNames[filters.month - 1]} ${filters.year}`;
                break;
            case 'dateRange':
                if (filters.startDate && filters.endDate) {
                    const startDate = new Date(filters.startDate).toLocaleDateString('id-ID');
                    const endDate = new Date(filters.endDate).toLocaleDateString('id-ID');
                    reportPeriod = `${startDate} - ${endDate}`;
                } else {
                    reportPeriod = 'Periode Tidak Valid';
                }
                break;
        }

        res.render('admin/laporan-pdf', {
            title: `${reportTitle} - ${reportPeriod}`,
            layout: false, // No layout for PDF
            reportTitle,
            reportPeriod,
            reportData: monthlyReportData,
            filters,
            admin: req.session.admin,
            generatedAt: new Date().toLocaleDateString('id-ID', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
        });

    } catch (error) {
        console.error('Error generating PDF report:', error);
        req.flash('error_msg', 'Gagal menghasilkan laporan PDF.');
        res.redirect('/admin/dashboard');
    }
});

// GET /admin/reservasi - Show list of reservations
router.get('/reservasi', isAnyStaff, async (req, res) => {
    try {
        const { search, status, tanggal } = req.query;
        let queryParams = [];
        
        let baseQuery = `
            SELECT 
                r.id, 
                r.tanggal_reservasi,
                r.jam_sesi AS sesi,
                r.status,
                r.keluhan,
                p.nama AS nama_pasien,
                COALESCE((
                    SELECT a.nama_lengkap 
                    FROM rekam_medis rm 
                    JOIN admin a ON rm.admin_id = a.id 
                    WHERE rm.reservasi_id = r.id 
                    LIMIT 1
                ), 'Belum ada dokter') AS nama_dokter,
                COALESCE((
                    SELECT rm.id 
                    FROM rekam_medis rm 
                    WHERE rm.reservasi_id = r.id 
                    LIMIT 1
                ), 0) AS rekam_medis_id
            FROM reservasi r
            JOIN pasien p ON r.pasien_id = p.id
        `;

        let whereClauses = [];
        if (search) {
            whereClauses.push("p.nama LIKE ?");
            queryParams.push(`%${search}%`);
        }
        if (status) {
            whereClauses.push("r.status = ?");
            queryParams.push(status);
        }
        if (tanggal) {
            whereClauses.push("DATE(r.tanggal_reservasi) = ?");
            queryParams.push(tanggal);
        }

        if (whereClauses.length > 0) {
            baseQuery += " WHERE " + whereClauses.join(" AND ");
        }

        baseQuery += " ORDER BY r.tanggal_reservasi DESC, r.id DESC";
        
        const [reservations] = await db.query(baseQuery, queryParams);
        
        res.render('admin/reservasi', { 
            title: 'Manajemen Reservasi', 
            reservations, 
            admin: req.session.admin,
            search: search || '',
            status: status || '',
            tanggal: tanggal || ''
        });
    } catch (error) {
        console.error('Error fetching reservations:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /admin/reservasi/atur-jadwal/:id - Show form to set schedule for a reservation
router.get('/reservasi/atur-jadwal/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;
        const [reservasiResult] = await db.query(
            'SELECT r.*, p.nama as nama_pasien, DAYOFWEEK(r.tanggal_reservasi) AS day_of_week FROM reservasi r JOIN pasien p ON r.pasien_id = p.id WHERE r.id = ?',
            [id]
        );
        
        if (reservasiResult.length === 0) {
            return res.status(404).send('Reservasi tidak ditemukan.');
        }
        const reservasi = reservasiResult[0];

        const dayMap = { 1: 'Minggu', 2: 'Senin', 3: 'Selasa', 4: 'Rabu', 5: 'Kamis', 6: 'Jumat', 7: 'Sabtu' };
        const reservationDay = dayMap[reservasi.day_of_week];
        
        const [availableSessions] = await db.query(`
            SELECT 
                jd.id,
                TIME_FORMAT(jd.jam_mulai, '%H:%i') as jam_mulai,
                TIME_FORMAT(jd.jam_selesai, '%H:%i') as jam_selesai,
                a.nama_lengkap as nama_dokter
            FROM jadwal_dokter jd
            JOIN admin a ON jd.id_admin = a.id
            WHERE (jd.status = 'Aktif' OR jd.status = 'Tersedia') AND jd.hari = ?
        `, [reservationDay]);

        res.render('admin/reservasi-set-jadwal', {
            title: 'Atur Jadwal Reservasi',
            reservasi,
            availableSessions,
            admin: req.session.admin
        });

    } catch (error) {
        console.error('Error getting form to set schedule:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /admin/reservasi/atur-jadwal/:id - Confirm reservation and set session time
router.post('/reservasi/atur-jadwal/:id', isAnyStaff, async (req, res) => {
    const { id } = req.params;
    const { sesi_data } = req.body;

    if (!sesi_data) {
        req.flash('error_msg', 'Silakan pilih sesi yang valid.');
        return res.redirect(`/admin/reservasi/atur-jadwal/${id}`);
    }

    const [jadwal_id, jam_sesi] = sesi_data.split('|');

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // --- Start: Hybrid Queue and Arrival Time Logic ---

        // 1. Get the reservation date and check if it's for today.
        const [currentReservationResult] = await connection.query(
            'SELECT tanggal_reservasi FROM reservasi WHERE id = ?',
            [id]
        );
        const reservationDate = new Date(currentReservationResult[0].tanggal_reservasi);
        const today = new Date();
        const isToday = reservationDate.toDateString() === today.toDateString();

        let nomorAntrian;
        let jamEstimasiDatang;

        if (isToday) {
            // LOGIC FOR TODAY: Based on last patient today and current confirmation time.
            const [lastPatientTodayResult] = await connection.query(
                `SELECT nomor_antrian FROM reservasi 
                 WHERE status = 'Dikonfirmasi' AND DATE(tanggal_reservasi) = CURDATE() 
                 ORDER BY nomor_antrian DESC LIMIT 1`
            );
            nomorAntrian = lastPatientTodayResult.length > 0 ? lastPatientTodayResult[0].nomor_antrian + 1 : 1;
            
            // Arrival time is based on when the admin confirms, plus 15 minutes.
            const confirmationTime = new Date();
            jamEstimasiDatang = new Date(confirmationTime.getTime() + 15 * 60 * 1000);

        } else {
            // LOGIC FOR FUTURE DATES: Based on last patient of that specific day.
            const [lastPatientFutureResult] = await connection.query(
                `SELECT nomor_antrian, jam_estimasi_datang FROM reservasi 
                 WHERE status = 'Dikonfirmasi' AND DATE(tanggal_reservasi) = DATE(?) 
                 ORDER BY nomor_antrian DESC LIMIT 1`,
                [reservationDate]
            );

            if (lastPatientFutureResult.length > 0) {
                // If a patient already exists on that future date, continue the queue.
                const lastPatient = lastPatientFutureResult[0];
                nomorAntrian = lastPatient.nomor_antrian + 1;
                let lastArrivalTime = new Date(lastPatient.jam_estimasi_datang);
                jamEstimasiDatang = new Date(lastArrivalTime.getTime() + 15 * 60 * 1000);
            } else {
                // If it's the first patient for that future date, start at opening time.
                nomorAntrian = 1;
                const openingTime = jam_sesi.split(' - ')[0];
                let [hours, minutes] = openingTime.split(':');
                jamEstimasiDatang = new Date(reservationDate);
                jamEstimasiDatang.setHours(hours, minutes, 0, 0);
            }
        }
        // --- End: Hybrid Logic ---

        // 4. Update reservasi dengan semua data baru
        await connection.query(
            `UPDATE reservasi SET id_jadwal = ?, jam_sesi = ?, status = 'Dikonfirmasi', nomor_antrian = ?, jam_estimasi_datang = ? WHERE id = ?`,
            [jadwal_id, jam_sesi, nomorAntrian, jamEstimasiDatang, id]
        );

        await connection.commit();
        req.flash('success_msg', 'Jadwal reservasi berhasil diatur dan notifikasi sedang dikirim.');

        // --- Start: Dual Notification Logic (WhatsApp & Email) ---
        try {
            const [notifDataResult] = await db.query(
                `SELECT p.nama AS nama_lengkap, p.no_telepon, p.email, r.keluhan, r.tanggal_reservasi, r.nomor_antrian, r.jam_estimasi_datang 
                 FROM reservasi r 
                 JOIN pasien p ON r.pasien_id = p.id 
                 WHERE r.id = ?`,
                [id]
            );

            if (notifDataResult.length > 0) {
                const notifData = notifDataResult[0];
                const patientPhoneNumber = notifData.no_telepon.startsWith('0') ? `+62${notifData.no_telepon.substring(1)}` : notifData.no_telepon;
                const patientEmail = notifData.email;

                const dateOnly = new Date(notifData.tanggal_reservasi).toISOString().slice(0, 10);
                const dateTimeString = `${dateOnly}T${notifData.jam_estimasi_datang}`;
                const jamEstimasi = new Date(dateTimeString);

                const formattedDate = new Date(notifData.tanggal_reservasi).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                const formattedTime = jamEstimasi.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

                // 1. Send Confirmation Notifications
                const confirmationMessageWa = `Halo *${notifData.nama_lengkap}*,

Reservasi Anda di *Klinik Al-Furqon* telah berhasil dikonfirmasi:

*Tanggal:* ${formattedDate}
*Keluhan:* ${notifData.keluhan}
*Antrean:* *#${notifData.nomor_antrian}*
*Jam Kedatangan:* *${formattedTime} WIB*

Terima kasih.`;
                sendWhatsAppMessage(patientPhoneNumber, confirmationMessageWa);

                if (patientEmail) {
                    const emailSubject = `Konfirmasi Reservasi Anda di Klinik Al-Furqon - #${notifData.nomor_antrian}`;
                    const emailHtml = `<h3>Halo ${notifData.nama_lengkap},</h3><p>Reservasi Anda telah berhasil dikonfirmasi dengan detail sebagai berikut:</p><ul><li><strong>Tanggal Reservasi:</strong> ${formattedDate}</li><li><strong>Keluhan:</strong> ${notifData.keluhan}</li><li><strong>Nomor Antrean:</strong> #${notifData.nomor_antrian}</li><li><strong>Jam Kedatangan:</strong> ${formattedTime} WIB</li></ul><p>Terima kasih telah memilih Klinik Al-Furqon.</p>`;
                    sendEmail(patientEmail, emailSubject, emailHtml);
                }

                // 2. Schedule Reminder Notifications
                const reminderTime = new Date(jamEstimasi.getTime() - 10 * 60 * 1000);
                if (reminderTime > new Date()) {
                    const cronTime = `${reminderTime.getMinutes()} ${reminderTime.getHours()} ${reminderTime.getDate()} ${reminderTime.getMonth() + 1} *`;
                    cron.schedule(cronTime, () => {
                        const reminderMessageWa = `*PENGINGAT RESERVasi* 

Halo *${notifData.nama_lengkap}*, ini adalah pengingat bahwa jadwal reservasi Anda di *Klinik Al-Furqon* adalah sekitar *10 menit lagi* pada pukul *${formattedTime} WIB*.

Mohon untuk mempersiapkan diri. Terima kasih.`;
                        sendWhatsAppMessage(patientPhoneNumber, reminderMessageWa);

                        if (patientEmail) {
                            const reminderSubject = `Pengingat Reservasi Anda di Klinik Al-Furqon - ${formattedTime} WIB`;
                            const reminderHtml = `<h3>Halo ${notifData.nama_lengkap},</h3><p>Ini adalah pengingat bahwa jadwal reservasi Anda di Klinik Al-Furqon adalah sekitar <strong>10 menit lagi</strong>, pada pukul <strong>${formattedTime} WIB</strong>.</p><p>Mohon untuk mempersiapkan diri. Terima kasih.</p>`;
                            sendEmail(patientEmail, reminderSubject, reminderHtml);
                        }
                        console.log(`Scheduled notifications sent for reservation #${notifData.nomor_antrian}`);
                    }, { scheduled: true, timezone: "Asia/Jakarta" });
                }
            }
        } catch (notificationError) {
            console.error('Failed to send notifications or schedule reminders:', notificationError);
            req.flash('error_msg', 'Jadwal berhasil diatur, namun notifikasi gagal dikirim.');
        }
        // --- End: Dual Notification Logic ---
        res.redirect('/admin/reservasi');

    } catch (error) {
        await connection.rollback();
        console.error('Error confirming reservation schedule:', error);
        req.flash('error_msg', 'Gagal mengonfirmasi jadwal reservasi.');
        res.redirect(`/admin/reservasi/atur-jadwal/${id}`);
    } finally {
        connection.release();
    }
});

// GET /admin/rekam-medis/tambah/:reservasi_id - Show form to add medical record
router.get('/rekam-medis/tambah/:reservasi_id', isTenagaMedisOrAdmin, async (req, res) => {
    try {
        const { reservasi_id } = req.params;
        const [existingRecord] = await db.query('SELECT id FROM rekam_medis WHERE reservasi_id = ?', [reservasi_id]);
        if (existingRecord.length > 0) {
            const [rekamMedis] = await db.query('SELECT id FROM rekam_medis WHERE reservasi_id = ? LIMIT 1', [reservasi_id]);
            return res.redirect(`/admin/rekam-medis/ubah/${rekamMedis[0].id}`);
        }

        const [result] = await db.query(`
            SELECT 
                r.id as reservasi_id, r.tanggal_reservasi, r.keluhan,
                p.id as pasien_id, p.no_ktp as nik, p.nama as nama_pasien, p.tanggal_lahir, p.jenis_kelamin
            FROM reservasi r 
            JOIN pasien p ON r.pasien_id = p.id 
            WHERE r.id = ?
        `, [reservasi_id]);
        if (result.length === 0) return res.status(404).send('Reservasi tidak ditemukan.');

        const patientData = result[0];

        // Auto-fill for vital signs is disabled as per user request.
        // The fields will now be manually filled by medical staff for each visit.
        // const [lastRecord] = await db.query(`
        //     SELECT nadi, suhu, pernafasan, tekanan_darah, tinggi_badan, berat_badan 
        //     FROM rekam_medis WHERE pasien_id = ? ORDER BY tanggal_pemeriksaan DESC LIMIT 1
        // `, [patientData.pasien_id]);

        const rekamMedisData = {
            ...patientData,
            // ...(lastRecord[0] || {}), // Auto-fill logic disabled
            reservasi_id: reservasi_id
        };

        const [tenagaMedis] = await db.query("SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap");

        res.render('admin/rekam-medis-form', {
            title: 'Input Rekam Medis',
            rekamMedis: rekamMedisData,
            action: '/admin/rekam-medis/tambah',
            tenagaMedis,
            admin: req.session.admin,
            error_msg: null // Initialize error message to null
        });
    } catch (error) {
        console.error('Error getting medical record form:', error);
        res.status(500).send('Server Error');
    }
});

// POST /admin/rekam-medis/tambah - Save new medical record
router.post('/rekam-medis/tambah', isTenagaMedisOrAdmin, async (req, res) => {
    const {
        reservasi_id, pasien_id, admin_id, tanggal_pemeriksaan, 
        nadi, suhu, pernafasan, tekanan_darah, tinggi_badan, berat_badan,
        diagnosis, tindakan, resep_obat, catatan_tambahan,
        obat_nama, obat_aturan_minum, obat_waktu_konsumsi
    } = req.body;
    
    // Process medicine data from arrays to string format
    let processedResepObat = resep_obat;
    if (obat_nama && obat_aturan_minum && obat_waktu_konsumsi) {
        const obatNamaArray = Array.isArray(obat_nama) ? obat_nama : [obat_nama];
        const obatAturanMinumArray = Array.isArray(obat_aturan_minum) ? obat_aturan_minum : [obat_aturan_minum];
        const obatWaktuKonsumsiArray = Array.isArray(obat_waktu_konsumsi) ? obat_waktu_konsumsi : [obat_waktu_konsumsi];
        
        const resepData = [];
        for (let i = 0; i < obatNamaArray.length; i++) {
            if (obatNamaArray[i] && obatAturanMinumArray[i] && obatWaktuKonsumsiArray[i]) {
                resepData.push(`${obatNamaArray[i]} - ${obatAturanMinumArray[i]} - ${obatWaktuKonsumsiArray[i]}`);
            }
        }
        
        if (resepData.length > 0) {
            processedResepObat = resepData.join('; ');
        }
    }

    // Server-side validation for all required fields
    const requiredFields = {
        admin_id: 'Tenaga medis yang menangani',
        tanggal_pemeriksaan: 'Tanggal pemeriksaan',
        nadi: 'Nadi',
        suhu: 'Suhu',
        pernafasan: 'Pernafasan',
        tekanan_darah: 'Tekanan darah',
        tinggi_badan: 'Tinggi badan',
        berat_badan: 'Berat badan',
        diagnosis: 'Diagnosis',
        tindakan: 'Tindakan',
        resep_obat: 'Resep obat'
    };

    // Special validation for medicine data
    if (!processedResepObat || processedResepObat.trim() === '') {
        const [tenagaMedis] = await db.query("SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap");
        const [result] = await db.query(`
            SELECT r.id as reservasi_id, r.tanggal_reservasi, r.keluhan,
                   p.id as pasien_id, p.no_ktp as nik, p.nama as nama_pasien, p.tanggal_lahir, p.jenis_kelamin
            FROM reservasi r JOIN pasien p ON r.pasien_id = p.id WHERE r.id = ?
        `, [reservasi_id]);

        const patientData = result[0];
        
        return res.render('admin/rekam-medis-form', {
            title: 'Input Rekam Medis',
            rekamMedis: { ...patientData, ...req.body },
            action: `/admin/rekam-medis/tambah`,
            tenagaMedis,
            admin: req.session.admin,
            error_msg: 'Minimal harus memilih 1 obat beserta aturan konsumsinya!'
        });
    }
    
    for (const field in requiredFields) {
        // Skip resep_obat validation since we handle it separately above
        if (field === 'resep_obat') continue;
        
        if (!req.body[field] || String(req.body[field]).trim() === '') {
            // If validation fails, re-render the form with the user's input and an error message
            const [tenagaMedis] = await db.query("SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap");
            const [result] = await db.query(`
                SELECT r.id as reservasi_id, r.tanggal_reservasi, r.keluhan,
                       p.id as pasien_id, p.no_ktp as nik, p.nama as nama_pasien, p.tanggal_lahir, p.jenis_kelamin
                FROM reservasi r JOIN pasien p ON r.pasien_id = p.id WHERE r.id = ?
            `, [reservasi_id]);

            const patientData = result[0];
            
            return res.render('admin/rekam-medis-form', {
                title: 'Input Rekam Medis',
                rekamMedis: { ...patientData, ...req.body }, // Merge patient data with submitted form data
                action: `/admin/rekam-medis/tambah`,
                tenagaMedis,
                admin: req.session.admin,
                error_msg: `Semua kolom yang ditandai * wajib diisi. Kolom '${requiredFields[field]}' belum diisi.`
            });
        }
    }
    
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        // Simpan rekam medis
        const query = `
            INSERT INTO rekam_medis (
                reservasi_id, pasien_id, admin_id, tanggal_pemeriksaan, 
                nadi, suhu, pernafasan, tekanan_darah, tinggi_badan, berat_badan, 
                diagnosis, tindakan, resep_obat, catatan_tambahan, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        const values = [
            reservasi_id, pasien_id, admin_id, tanggal_pemeriksaan, 
            nadi || null, suhu || null, pernafasan || null, tekanan_darah || null, tinggi_badan || null, berat_badan || null,
            diagnosis, tindakan, processedResepObat, catatan_tambahan
        ];
        const [result] = await connection.query(query, values);
        
        // Update status reservasi menjadi 'Selesai'
        await connection.query(
            "UPDATE reservasi SET status = 'Selesai' WHERE id = ?", 
            [reservasi_id]
        );
        
        await connection.commit();
        req.flash('success_msg', 'Rekam medis berhasil disimpan');
        res.redirect('/admin/reservasi');
    } catch (error) {
        await connection.rollback();
        console.error('Error saat menyimpan rekam medis:', error);
        req.flash('error_msg', 'Gagal menyimpan rekam medis: ' + error.message);
        res.redirect('back');
    } finally {
        connection.release();
    }
});

// GET /admin/rekam-medis/detail/:id - Show medical record detail
router.get('/rekam-medis/detail/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;
        const [result] = await db.query(`
            SELECT rm.*, 
               p.nama as nama_pasien, p.tanggal_lahir, p.no_ktp as nik, 
               a.nama_lengkap as nama_dokter,
               r.id as reservasi_id, r.tanggal_reservasi, r.keluhan
        FROM rekam_medis rm
        JOIN pasien p ON rm.pasien_id = p.id
        JOIN admin a ON rm.admin_id = a.id
        JOIN reservasi r ON rm.reservasi_id = r.id
        WHERE rm.id = ?
        `, [id]);
        if (result.length === 0) return res.status(404).send('Rekam medis tidak ditemukan.');
        res.render('admin/rekam-medis-detail', { title: 'Detail Rekam Medis', rekamMedis: result[0], admin: req.session.admin });
    } catch (error) {
        console.error(error);
        res.status(500).send('Server Error');
    }
});

// GET /admin/rekam-medis/ubah/:id - Show form to edit medical record
router.get('/rekam-medis/ubah/:id', isTenagaMedisOrAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const [rekamMedisResult] = await db.query(`
            SELECT 
                rm.*, 
                r.id as reservasi_id, r.tanggal_reservasi, r.keluhan,
                p.no_ktp as nik, p.nama as nama_pasien, p.tanggal_lahir, p.jenis_kelamin
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN pasien p ON rm.pasien_id = p.id
            WHERE rm.id = ?
        `, [id]);
        
        if (rekamMedisResult.length === 0) {
            req.flash('error_msg', 'Rekam medis tidak ditemukan');
            return res.redirect('/admin/reservasi');
        }

        const [tenagaMedis] = await db.query(
            "SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap"
        );
        
        res.render('admin/rekam-medis-form', {
            title: 'Ubah Rekam Medis',
            rekamMedis: rekamMedisResult[0],
            action: `/admin/rekam-medis/ubah/${id}`,
            tenagaMedis,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error saat mengambil data rekam medis:', error);
        req.flash('error_msg', 'Terjadi kesalahan saat mengambil data rekam medis');
        res.redirect('/admin/reservasi');
    }
});

// POST /admin/rekam-medis/ubah/:id - Update medical record
router.post('/rekam-medis/ubah/:id', isTenagaMedisOrAdmin, async (req, res) => {
    const { id } = req.params;
    const {
        admin_id, tanggal_pemeriksaan,
        nadi, suhu, pernafasan, tekanan_darah, tinggi_badan, berat_badan,
        diagnosis, tindakan, resep_obat, catatan_tambahan
    } = req.body;
    
    try {
        const query = `
            UPDATE rekam_medis SET 
                admin_id = ?, tanggal_pemeriksaan = ?, 
                nadi = ?, suhu = ?, pernafasan = ?, tekanan_darah = ?, tinggi_badan = ?, berat_badan = ?, 
                diagnosis = ?, tindakan = ?, resep_obat = ?, catatan_tambahan = ?
            WHERE id = ?
        `;
        const values = [
            admin_id, tanggal_pemeriksaan, 
            nadi || null, suhu || null, pernafasan || null, tekanan_darah || null, tinggi_badan || null, berat_badan || null,
            diagnosis, tindakan, resep_obat, catatan_tambahan, 
            id
        ];
        await db.query(query, values);
        
        req.flash('success_msg', 'Rekam medis berhasil diperbarui');
        res.redirect(`/admin/reservasi`);
    } catch (error) {
        console.error('Error saat memperbarui rekam medis:', error);
        req.flash('error_msg', 'Gagal memperbarui rekam medis: ' + error.message);
        res.redirect('back');
    }
});

// GET /admin/pasien - Show list of all patients
router.get('/pasien', isAnyStaff, async (req, res) => {
    try {
        const [patients] = await db.query('SELECT id, nama, email, tanggal_lahir, jenis_kelamin, no_telepon FROM pasien ORDER BY nama ASC');
        
        res.render('admin/pasien', {
            title: 'Manajemen Pasien',
            patients: patients,
            admin: req.session.admin
        });

    } catch (error) {
        console.error('Error fetching patient list:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /admin/pasien/ubah/:id - Show form to edit a patient
router.get('/pasien/ubah/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;
        const [patientResult] = await db.query('SELECT * FROM pasien WHERE id = ?', [id]);

        if (patientResult.length === 0) {
            req.flash('error_msg', 'Pasien tidak ditemukan.');
            return res.redirect('/admin/pasien');
        }

        res.render('admin/pasien-form', {
            title: 'Ubah Data Pasien',
            patient: patientResult[0],
            action: `/admin/pasien/ubah/${id}`,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching patient for edit:', error);
        req.flash('error_msg', 'Gagal memuat data pasien.');
        res.redirect('/admin/pasien');
    }
});

// POST /admin/pasien/ubah/:id - Update patient data
router.post('/pasien/ubah/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;
        const { nama, email, tanggal_lahir, jenis_kelamin, alamat, no_telepon } = req.body;

        const [result] = await db.query(
            `UPDATE pasien SET 
                nama = ?, email = ?, tanggal_lahir = ?, jenis_kelamin = ?, alamat = ?, no_telepon = ? 
            WHERE id = ?`,
            [nama, email, tanggal_lahir, jenis_kelamin, alamat, no_telepon, id]
        );

        if (result.affectedRows > 0) {
            req.flash('success_msg', 'Data pasien berhasil diperbarui.');
        } else {
            req.flash('error_msg', 'Gagal memperbarui data: Pasien tidak ditemukan.');
        }

        res.redirect('/admin/pasien');
    } catch (error) {
        console.error('Error updating patient data:', error);
        req.flash('error_msg', 'Gagal memperbarui data pasien.');
        res.redirect('back');
    }
});

// GET /admin/pasien/profil/:id - Show patient profile and medical history
router.get('/pasien/profil/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch patient details
        const [patientResult] = await db.query('SELECT id, nama, email, no_ktp, no_telepon, tanggal_lahir, jenis_kelamin, alamat FROM pasien WHERE id = ?', [id]);
        if (patientResult.length === 0) {
            return res.status(404).send('Pasien tidak ditemukan.');
        }
        const patient = patientResult[0];

        // Fetch patient's medical records
        const medicalRecordsQuery = `
            SELECT 
                rm.id,
                rm.created_at AS tanggal_pemeriksaan,
                rm.diagnosis,
                r.keluhan,
                a.nama_lengkap AS nama_dokter
            FROM rekam_medis rm
            JOIN reservasi r ON rm.reservasi_id = r.id
            JOIN admin a ON rm.admin_id = a.id
            WHERE rm.pasien_id = ?
            ORDER BY rm.created_at DESC
        `;
        const [medicalRecords] = await db.query(medicalRecordsQuery, [id]);

        res.render('admin/pasien-detail', {
            title: `Profil Pasien: ${patient.nama}`,
            patient,
            medicalRecords,
            admin: req.session.admin
        });

    } catch (error) {
        console.error('Error fetching patient profile:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /admin/pasien/detail/:id - Show patient detail and medical history
router.get('/pasien/detail/:id', isAnyStaff, async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Get patient info
        const [patientResult] = await db.query('SELECT * FROM pasien WHERE id = ?', [id]);
        if (patientResult.length === 0) {
            return res.status(404).send('Pasien tidak ditemukan.');
        }
        const patient = patientResult[0];

        // 2. Get medical records for that patient
        const recordsQuery = `
            SELECT 
                rm.id_reservasi AS reservasi_id, rm.tanggal_periksa, rm.diagnosis,
                r.keluhan as keluhan_awal,
                a.nama_lengkap as nama_admin
            FROM rekam_medis rm
            JOIN reservasi r ON rm.id_reservasi = r.id
            JOIN admin a ON rm.id_admin = a.id
            WHERE rm.id_pasien = ?
            ORDER BY rm.tanggal_periksa DESC
        `;
        const [records] = await db.query(recordsQuery, [id]);

        res.render('admin/pasien-detail', {
            title: 'Riwayat Medis Pasien',
            patient: patient,
            records: records,
            admin: req.session.admin
        });

    } catch (error) {
        console.error('Error fetching patient medical history:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /admin/reservasi/hapus/:id - Delete a reservation and its medical record
router.post('/reservasi/hapus/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection(); // Dapatkan koneksi untuk transaksi

    try {
        await connection.beginTransaction(); // Mulai transaksi

        // Hapus terlebih dahulu rekam medis yang terkait (jika ada)
        await connection.query('DELETE FROM rekam_medis WHERE reservasi_id = ?', [id]);

        // Kemudian hapus reservasi itu sendiri
        const [result] = await connection.query('DELETE FROM reservasi WHERE id = ?', [id]);

        await connection.commit(); // Konfirmasi transaksi jika semua berhasil

        if (result.affectedRows > 0) {
            req.flash('success_msg', 'Reservasi dan rekam medis terkait berhasil dihapus.');
        } else {
            req.flash('error_msg', 'Reservasi tidak ditemukan.');
        }
        res.redirect('/admin/reservasi');

    } catch (error) {
        await connection.rollback(); // Batalkan transaksi jika ada error
        console.error('Error saat menghapus reservasi:', error);
        req.flash('error_msg', 'Gagal menghapus reservasi.');
        res.redirect('/admin/reservasi');
    } finally {
        connection.release(); // Selalu lepaskan koneksi
    }
});

// GET /admin/logout
router.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/admin/dashboard');
        }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// GET /admin/tenaga-medis - Show list of staff
router.get('/tenaga-medis', isAdmin, async (req, res) => {
    try {
        const [staff] = await db.query('SELECT id, nama_lengkap, username, role, spesialis FROM admin ORDER BY nama_lengkap ASC');
        res.render('admin/tenaga-medis', {
            title: 'Kelola Tenaga Medis',
            staff: staff,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching medical staff:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /admin/tenaga-medis/tambah - Show form to add new staff
router.get('/tenaga-medis/tambah', isAdmin, (req, res) => {
    res.render('admin/tenaga-medis-form', {
        title: 'Tambah Tenaga Medis',
        staff: {}, // Empty object for a new staff
        action: 'tambah',
        admin: req.session.admin
    });
});

// POST /admin/tenaga-medis/tambah - Save new staff
router.post('/tenaga-medis/tambah', isAdmin, async (req, res) => {
    const { nama_lengkap, username, password, role, spesialis } = req.body;
    if (!nama_lengkap || !username || !password || !role) {
        return res.status(400).send('Semua field harus diisi.');
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const spesialisValue = role === 'Tenaga Medis' ? spesialis : null;
        await db.query(
            'INSERT INTO admin (nama_lengkap, username, password, role, spesialis) VALUES (?, ?, ?, ?, ?)',
            [nama_lengkap, username, hashedPassword, role, spesialisValue]
        );
        res.redirect('/admin/tenaga-medis');
    } catch (error) {
        console.error('Error adding medical staff:', error);
        res.status(500).send('Gagal menambahkan tenaga medis.');
    }
});

// GET /admin/tenaga-medis/ubah/:id - Show form to edit staff
router.get('/tenaga-medis/ubah/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const [staffResult] = await db.query('SELECT id, nama_lengkap, username, role, spesialis FROM admin WHERE id = ?', [id]);
        if (staffResult.length === 0) {
            return res.status(404).send('Tenaga medis tidak ditemukan.');
        }
        res.render('admin/tenaga-medis-form', {
            title: 'Ubah Tenaga Medis',
            staff: staffResult[0],
            action: `ubah/${id}`,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching staff for edit:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /admin/tenaga-medis/ubah/:id - Update staff data
router.post('/tenaga-medis/ubah/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { nama_lengkap, username, password, role, spesialis } = req.body;
    if (!nama_lengkap || !username || !role) {
        return res.status(400).send('Nama, username, dan role harus diisi.');
    }
    try {
        let query;
        let params;
        const spesialisValue = role === 'Tenaga Medis' ? spesialis : null;

        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            query = 'UPDATE admin SET nama_lengkap = ?, username = ?, password = ?, role = ?, spesialis = ? WHERE id = ?';
            params = [nama_lengkap, username, hashedPassword, role, spesialisValue, id];
        } else {
            query = 'UPDATE admin SET nama_lengkap = ?, username = ?, role = ?, spesialis = ? WHERE id = ?';
            params = [nama_lengkap, username, role, spesialisValue, id];
        }
        await db.query(query, params);
        res.redirect('/admin/tenaga-medis');
    } catch (error) {
        console.error('Error updating medical staff:', error);
        res.status(500).send('Gagal memperbarui data tenaga medis.');
    }
});

// POST /admin/tenaga-medis/hapus/:id - Delete staff
router.post('/tenaga-medis/hapus/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // Add a safeguard to prevent deleting the last admin or oneself
        if (parseInt(id, 10) === req.session.admin.id) {
            // Optional: Add a flash message here
            return res.status(403).send('Anda tidak dapat menghapus akun Anda sendiri.');
        }
        await db.query('DELETE FROM admin WHERE id = ?', [id]);
        res.redirect('/admin/tenaga-medis');
    } catch (error) {
        console.error('Error deleting medical staff:', error);
        res.status(500).send('Gagal menghapus tenaga medis.');
    }
});

// --- KELOLA JADWAL DOKTER ---

const compressDays = (dayString) => {
    if (!dayString) return '';
    const dayOrder = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
    const days = dayString.split(', ');

    if (days.length < 2) return dayString;

    const result = [];
    let i = 0;
    while (i < days.length) {
        const startDay = days[i];
        let j = i;
        while (j + 1 < days.length && dayOrder.indexOf(days[j + 1]) === dayOrder.indexOf(days[j]) + 1) {
            j++;
        }
        if (j > i) {
            result.push(`${startDay}-${days[j]}`);
        } else {
            result.push(startDay);
        }
        i = j + 1;
    }
    return result.join(', ');
};

// GET /admin/jadwal - Show list of schedules
router.get('/jadwal', isAnyStaff, async (req, res) => {
    try {
        const [schedules] = await db.query(`
            SELECT 
                MIN(jd.id) AS id,
                a.nama_lengkap AS nama_dokter,
                jd.id_admin,
                GROUP_CONCAT(jd.hari ORDER BY FIELD(jd.hari, 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu') SEPARATOR ', ') AS hari,
                TIME_FORMAT(jd.jam_mulai, '%H:%i') AS jam_mulai,
                TIME_FORMAT(jd.jam_selesai, '%H:%i') AS jam_selesai,
                jd.status
            FROM jadwal_dokter jd
            JOIN admin a ON jd.id_admin = a.id
            GROUP BY a.nama_lengkap, jd.id_admin, jd.jam_mulai, jd.jam_selesai, jd.status
            ORDER BY a.nama_lengkap, jam_mulai
        `);

        // Compress day strings before rendering
        const compressedSchedules = schedules.map(schedule => ({
            ...schedule,
            hari: compressDays(schedule.hari)
        }));

        res.render('admin/jadwal', {
            title: 'Kelola Jadwal Praktik',
            schedules: compressedSchedules,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching schedules:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// GET /admin/jadwal/tambah - Show form to add new schedule
router.get('/jadwal/tambah', isAdmin, async (req, res) => {
    try {
        const [doctors] = await db.query("SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap ASC");
        res.render('admin/jadwal-form', {
            title: 'Tambah Jadwal',
            schedule: {},
            doctors: doctors,
            action: 'tambah',
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching doctors for schedule form:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /admin/jadwal/tambah - Save new schedule
router.post('/jadwal/tambah', isAdminOrPimpinan, async (req, res) => {
    try {
        const { id_admin, hari, jam_mulai, jam_selesai } = req.body;
        const hariString = Array.isArray(hari) ? hari.join(',') : hari;

        await db.query(
            'INSERT INTO jadwal_dokter (id_admin, hari, jam_mulai, jam_selesai, status) VALUES (?, ?, ?, ?, ?)',
            [id_admin, hariString, jam_mulai, jam_selesai, 'Tersedia']
        );

        req.flash('success_msg', 'Jadwal baru berhasil ditambahkan.');
        res.redirect('/admin/jadwal');
    } catch (error) {
        console.error('Error saat menambah jadwal:', error);
        req.flash('error_msg', 'Gagal menambahkan jadwal baru.');
        res.redirect(req.get('Referrer') || '/admin/jadwal');
    }
});

// GET /admin/jadwal/ubah/:id - Show form to edit a schedule
router.get('/jadwal/ubah/:id', isTenagaMedisOrAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Find the main schedule entry to get the grouping keys
        const [mainScheduleResult] = await db.query('SELECT * FROM jadwal_dokter WHERE id = ?', [id]);
        if (mainScheduleResult.length === 0) {
            return res.status(404).send('Jadwal tidak ditemukan.');
        }
        const mainSchedule = mainScheduleResult[0];
        const { id_admin, jam_mulai, jam_selesai } = mainSchedule;

        // Find all days for that same group (same doctor, same time)
        const [groupSchedules] = await db.query(
            'SELECT hari FROM jadwal_dokter WHERE id_admin = ? AND jam_mulai = ? AND jam_selesai = ?',
            [id_admin, jam_mulai, jam_selesai]
        );
        
        // Create an array of days for the checkboxes
        mainSchedule.days = groupSchedules.map(s => s.hari);
        
        // Format time for the input fields
        mainSchedule.jam_mulai = jam_mulai.substring(0, 5);
        mainSchedule.jam_selesai = jam_selesai.substring(0, 5);

        const [doctors] = await db.query("SELECT id, nama_lengkap FROM admin WHERE role = 'Tenaga Medis' ORDER BY nama_lengkap ASC");

        res.render('admin/jadwal-form', {
            title: 'Ubah Jadwal',
            schedule: mainSchedule,
            doctors: doctors,
            action: `ubah/${id}`,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching schedule for edit:', error);
        res.status(500).send('Terjadi kesalahan pada server.');
    }
});

// POST /admin/jadwal/ubah/:id - Update schedule
router.post('/jadwal/ubah/:id', isTenagaMedisOrAdmin, async (req, res) => {
    const { id } = req.params;
    const { id_admin, hari, jam_mulai, jam_selesai, status } = req.body;

    // Translate form status to database status
    const dbStatus = (status === 'Aktif') ? 'Tersedia' : 'Tidak Tersedia';

    // Ensure 'hari' is an array, as a single checkbox might not be sent as an array
    const days = Array.isArray(hari) ? hari : [hari];
    
    if (!days || days.length === 0 || !days[0]) {
        return res.status(400).send('Silakan pilih minimal satu hari praktik.');
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Find the original schedule to get grouping keys (id_admin, jam_mulai, jam_selesai)
        const [originalSchedules] = await connection.query('SELECT * FROM jadwal_dokter WHERE id = ?', [id]);
        if (originalSchedules.length === 0) {
            await connection.rollback();
            return res.status(404).send('Jadwal asli tidak ditemukan untuk diedit.');
        }
        const originalSchedule = originalSchedules[0];

        // 1. Delete all entries in the same group (same doctor, same original time)
        await connection.query(
            'DELETE FROM jadwal_dokter WHERE id_admin = ? AND jam_mulai = ? AND jam_selesai = ?',
            [originalSchedule.id_admin, originalSchedule.jam_mulai, originalSchedule.jam_selesai]
        );

        // 2. Create new entries for all checked days with the form data
        const insertPromises = days.map(day => {
            return connection.query(
                'INSERT INTO jadwal_dokter (id_admin, hari, jam_mulai, jam_selesai, status) VALUES (?, ?, ?, ?, ?)',
                [id_admin, day, jam_mulai, jam_selesai, dbStatus] // Use translated status
            );
        });
        
        await Promise.all(insertPromises);
        
        await connection.commit();
        res.redirect('/admin/jadwal');
    } catch (error) {
        await connection.rollback();
        console.error('Error updating schedule:', error);
        res.status(500).send('Gagal memperbarui jadwal.');
    } finally {
        connection.release();
    }
});

// POST /admin/jadwal/hapus/:id - Delete a schedule group
router.post('/jadwal/hapus/:id', isTenagaMedisOrAdmin, async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Find the main schedule to identify the group
        const [mainScheduleResult] = await connection.query('SELECT id_admin, jam_mulai, jam_selesai FROM jadwal_dokter WHERE id = ?', [id]);
        if (mainScheduleResult.length === 0) {
            await connection.rollback();
            // Optionally, add a flash message
            return res.redirect('/admin/jadwal');
        }
        const { id_admin, jam_mulai, jam_selesai } = mainScheduleResult[0];

        // Delete all schedules in that group
        await connection.query('DELETE FROM jadwal_dokter WHERE id_admin = ? AND jam_mulai = ? AND jam_selesai = ?', [id_admin, jam_mulai, jam_selesai]);
        
        await connection.commit();
        res.redirect('/admin/jadwal');
    } catch (error) {
        await connection.rollback();
        console.error('Error deleting schedule group:', error);
        res.status(500).send('Gagal menghapus jadwal.');
    } finally {
        connection.release();
    }
});

// POST /admin/reservasi/update-status/:id - Update status reservasi
router.post('/reservasi/update-status/:id', isAnyStaff, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // Status 'Dikonfirmasi' sekarang ditangani oleh alur 'atur-jadwal'.
    const allowedStatuses = ['Menunggu', 'Dibatalkan', 'Selesai', 'Ditolak'];
    if (!allowedStatuses.includes(status)) {
        req.flash('error_msg', 'Status tidak valid atau operasi tidak diizinkan.');
        return res.redirect('/admin/reservasi');
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Jika status diubah menjadi Dibatalkan, Menunggu, atau Ditolak, hapus info antrean.
        if (['Dibatalkan', 'Menunggu', 'Ditolak'].includes(status)) {
            await connection.query(
                'UPDATE reservasi SET status = ?, nomor_antrian = NULL, jam_estimasi_datang = NULL WHERE id = ?',
                [status, id]
            );
        } else {
            // Untuk status lain (misal: Selesai), hanya perbarui statusnya.
            await connection.query('UPDATE reservasi SET status = ? WHERE id = ?', [status, id]);
        }

        await connection.commit();
        req.flash('success_msg', 'Status reservasi berhasil diperbarui.');

    } catch (error) {
        await connection.rollback();
        console.error('Error updating reservation status:', error);
        req.flash('error_msg', 'Gagal memperbarui status reservasi.');
    } finally {
        connection.release();
        res.redirect('/admin/reservasi');
    }
});

// GET /admin/pasien - Show list of patients
router.get('/pasien', isAnyStaff, async (req, res) => {
    try {
        const [patients] = await db.query('SELECT * FROM pasien ORDER BY nama ASC');
        res.render('admin/pasien', {
            title: 'Manajemen Pasien',
            patients,
            admin: req.session.admin
        });
    } catch (error) {
        console.error('Error fetching patients:', error);
        req.flash('error_msg', 'Gagal memuat data pasien.');
        res.redirect('/admin/dashboard');
    }
});

// DELETE /admin/pasien/hapus/:id - Delete a patient and all related data
router.delete('/pasien/hapus/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Delete related reservations
        await connection.query('DELETE FROM reservasi WHERE pasien_id = ?', [id]);

        // 2. Delete related medical records
        await connection.query('DELETE FROM rekam_medis WHERE pasien_id = ?', [id]);

        // 3. Delete the patient
        const [result] = await connection.query('DELETE FROM pasien WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            throw new Error('Pasien tidak ditemukan atau sudah dihapus.');
        }

        await connection.commit();
        req.flash('success_msg', 'Pasien dan semua data terkait berhasil dihapus.');
    } catch (error) {
        await connection.rollback();
        console.error('Error deleting patient:', error);
        req.flash('error_msg', `Gagal menghapus pasien: ${error.message}`);
    } finally {
        connection.release();
        res.redirect('/admin/pasien');
    }
});

// ... (rest of the code remains the same)
module.exports = router;
