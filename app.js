const express = require('express');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const db = require('./config/db'); // Import database connection

// Import routes
const authRoutes = require('./routes/auth');
const reservasiRoutes = require('./routes/reservasi');
const profileRoutes = require('./routes/profile');
const dashboardRoutes = require('./routes/dashboard'); // Import dashboard route
const rekamMedisRoutes = require('./routes/rekamMedis');
const adminRoutes = require('./routes/admin');
const debugRoutes = require('./routes/debug');


const app = express();
const port = 3000;

// Session Middleware Setup
app.use(session({
    secret: 'keyboard cat', // Ganti dengan string acak yang panjang untuk keamanan
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set true jika menggunakan HTTPS
}));

// Flash messages middleware
app.use(flash());

// Middleware to make session data and flash messages available in all templates
app.use((req, res, next) => {
    // User data
    res.locals.user = req.session.patient || null;
    // Flash messages
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error');
    res.locals.admin = req.session.admin || null;
    next();
});

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Serve bootstrap from node_modules
app.use('/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));

// Middleware to parse request body
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Method Override Middleware untuk mendukung request DELETE/PUT dari form HTML
app.use(methodOverride('_method'));

// --- ROUTES ---

// Home page route
app.get('/', (req, res) => {
    res.render('index', { title: 'Selamat Datang di Klinik AL-Furqon' });
});

// Auth routes (handles /login, /register, /logout)
app.use('/', authRoutes);

// Dashboard route
app.use('/dashboard', dashboardRoutes);

// Reservation routes
app.use('/reservasi', reservasiRoutes);

// Profile routes (handles /profile, /profile/edit, etc.)
app.use('/profile', profileRoutes);

// Medical Record routes
app.use('/rekam-medis', rekamMedisRoutes);

// Admin routes
app.use('/admin', adminRoutes);

// Debug routes for development
app.use('/debug', debugRoutes);

// Start the server
app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});
