const mysql = require('mysql2');

// Create a connection pool. This is better for performance as it reuses connections.
const pool = mysql.createPool({
    host: 'localhost',          // Your database host, usually 'localhost'
    user: 'root',               // Your MySQL username, often 'root'
    password: '',               // Your MySQL password (leave empty if you don't have one)
    database: 'klinik_al_furqon', // The database name we created
    waitForConnections: true,
    connectionLimit: 10,        // Max number of connections in pool
    queueLimit: 0
});

// Test the connection
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
        return;
    }
    console.log('Koneksi ke database MySQL berhasil dengan ID ' + connection.threadId);
    connection.release(); // Release the connection back to the pool
});

// Export the pool so we can use it in other parts of our app
module.exports = pool.promise();
