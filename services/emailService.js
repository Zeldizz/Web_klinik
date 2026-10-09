const nodemailer = require('nodemailer');

// Create a transporter object using the default SMTP transport
// This transporter will be configured to send emails through your Gmail account.
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Your Gmail address from .env
        pass: process.env.EMAIL_PASS  // Your App Password from .env
    }
});

/**
 * Sends an email.
 * @param {string} to - The recipient's email address.
 * @param {string} subject - The subject of the email.
 * @param {string} html - The HTML body of the email.
 */
const sendEmail = async (to, subject, html) => {
    try {
        const mailOptions = {
            from: `"Klinik Al-Furqon" <${process.env.EMAIL_USER}>`,
            to: to,
            subject: subject,
            html: html
        };

        await transporter.sendMail(mailOptions);
        console.log(`Email sent successfully to ${to}`);
    } catch (error) {
        console.error(`Error sending email to ${to}:`, error);
    }
};

module.exports = { sendEmail };
