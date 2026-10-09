require('dotenv').config();
const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// Check if credentials are available
if (!accountSid || !authToken || !twilioWhatsAppNumber) {
    console.error('Twilio credentials are not set in the .env file.');
    // In a real app, you might want to throw an error or exit
    // For this implementation, we will log the error and continue,
    // but message sending will fail.
}

const client = twilio(accountSid, authToken);

/**
 * Sends a WhatsApp message to a specified number.
 * @param {string} to - The recipient's phone number in E.164 format (e.g., '+6281234567890').
 * @param {string} body - The content of the message to be sent.
 * @returns {Promise<object>} - A promise that resolves with the message object from Twilio.
 */
const sendWhatsAppMessage = async (to, body) => {
    try {
        // Ensure the 'to' number is prefixed for WhatsApp
        const formattedTo = `whatsapp:${to}`;

        console.log(`Sending WhatsApp message to ${formattedTo}...`);

        const message = await client.messages.create({
            from: twilioWhatsAppNumber,
            body: body,
            to: formattedTo
        });

        console.log(`Message sent successfully. SID: ${message.sid}`);
        return message;
    } catch (error) {
        console.error('Failed to send WhatsApp message:', error);
        // Re-throw the error to be handled by the caller
        throw error;
    }
};

module.exports = { sendWhatsAppMessage };
