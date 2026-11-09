const nodemailer = require("nodemailer");

// Works with any SMTP mailbox (Microsoft 365, Gmail app password, Spacemail, ...).
// Without SMTP settings, alerts are printed to the server log instead.
const configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendAlert({ subject, text, html, attachments }) {
  if (!transport) {
    console.log(`[alert not emailed: SMTP not set up]\n${subject}\n${text}`);
    return false;
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.ORDER_ALERT_TO || process.env.SMTP_USER,
    subject,
    text,
    html,
    attachments,
  });
  return true;
}

module.exports = { sendAlert, mailConfigured: configured };
