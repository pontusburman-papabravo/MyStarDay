const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { sendEmail } = require('../lib/email');

const router = express.Router();

// ─── POST /api/beta-signup ──────────────────────────────
router.post('/beta-signup', async (req, res) => {
  try {
    const { name, email, num_children, child_ages, extra_support, routine_challenge } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Namn och e-post krävs' });
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Ogiltig e-postadress' });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ error: 'Namn måste vara minst 2 tecken' });
    }
    if (num_children === undefined || num_children === null || num_children === '') {
      return res.status(400).json({ error: 'Antal barn krävs' });
    }
    if (!child_ages || !Array.isArray(child_ages) || child_ages.length === 0) {
      return res.status(400).json({ error: 'Barnens åldrar krävs' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const numChildrenInt = parseInt(num_children, 10);

    // Check for duplicate
    const existing = await db.query(
      'SELECT id FROM beta_signup WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      // Graceful: don't reveal duplicate, just say thanks
      return res.json({
        message: `Tack! Vi hör av oss inom kort till ${normalizedEmail}.`,
      });
    }

    await db.query(
      `INSERT INTO beta_signup (name, email, num_children, child_ages, extra_support, routine_challenge)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        name.trim(),
        normalizedEmail,
        isNaN(numChildrenInt) ? null : numChildrenInt,
        JSON.stringify(child_ages),
        extra_support ? extra_support.trim() : null,
        routine_challenge ? routine_challenge.trim() : null,
      ]
    );

    // Send notification email to admin
    const agesLabel = Array.isArray(child_ages) ? child_ages.join(', ') : child_ages;
    const numLabel = num_children === '0' ? '0 (gravid/planerar)'
      : num_children === '3' ? '3+' : String(num_children);

    sendEmail({
      to: 'info@mystarday.se',
      subject: `Ny betaanmälan — ${name.trim()}`,
      html: `
        <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #1B2340;">
          <h2 style="color: #1B2340;">⭐ Ny betaanmälan!</h2>
          <table style="width:100%; border-collapse:collapse; margin-top:12px;">
            <tr><td style="padding:8px 0; font-weight:600; width:180px;">Namn</td><td style="padding:8px 0;">${name.trim()}</td></tr>
            <tr style="background:#FAFBFF;"><td style="padding:8px 0; font-weight:600;">E-post</td><td style="padding:8px 0;"><a href="mailto:${normalizedEmail}" style="color:#F5A623;">${normalizedEmail}</a></td></tr>
            <tr><td style="padding:8px 0; font-weight:600;">Antal barn</td><td style="padding:8px 0;">${numLabel}</td></tr>
            <tr style="background:#FAFBFF;"><td style="padding:8px 0; font-weight:600;">Barnens åldrar</td><td style="padding:8px 0;">${agesLabel}</td></tr>
            ${extra_support ? `<tr><td style="padding:8px 0; font-weight:600; vertical-align:top;">Extra stöd</td><td style="padding:8px 0;">${extra_support.trim()}</td></tr>` : ''}
            ${routine_challenge ? `<tr style="background:#FAFBFF;"><td style="padding:8px 0; font-weight:600; vertical-align:top;">Svårast med rutiner</td><td style="padding:8px 0;">${routine_challenge.trim()}</td></tr>` : ''}
          </table>
        </div>
      `,
    }).catch(err => console.error('[BETA] Email notification failed:', err.message));

    res.status(201).json({
      message: `Tack! Vi hör av oss inom kort till ${normalizedEmail}.`,
    });
  } catch (err) {
    console.error('[BETA] Signup error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/contact ──────────────────────────────────
router.post('/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Alla fält krävs' });
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Ogiltig e-postadress' });
    }
    if (message.trim().length < 10) {
      return res.status(400).json({ error: 'Meddelandet måste vara minst 10 tecken' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Store in DB with message_type = 'contact'
    await db.query(
      'INSERT INTO contact_message (name, email, message, message_type) VALUES ($1, $2, $3, $4)',
      [name.trim(), normalizedEmail, message.trim(), 'contact']
    );

    // Send email to owner
    await sendEmail({
      to: 'info@mystarday.se',
      subject: `Kontaktformulär — ${name.trim()}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1B2340;">Nytt meddelande från Stjärndag</h2>
          <p><strong>Namn:</strong> ${name.trim()}</p>
          <p><strong>E-post:</strong> ${normalizedEmail}</p>
          <p><strong>Meddelande:</strong></p>
          <p style="background: #f5f5f5; padding: 12px; border-radius: 8px;">${message.trim()}</p>
        </div>
      `,
    });

    res.json({ message: 'Tack! Vi har tagit emot ditt meddelande.' });
  } catch (err) {
    console.error('[CONTACT] Error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/registration-status ───────────────────────
// Public endpoint: tells the landing page the current app mode.
// mode: 'maintenance' | 'beta' | 'registration'
router.get('/registration-status', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT key, enabled FROM feature_flag WHERE key IN ('registration_enabled', 'payment_mode', 'maintenance_mode')"
    );
    const flags = {};
    for (const row of result.rows) flags[row.key] = row.enabled;

    let mode = 'beta';
    if (flags.maintenance_mode) mode = 'maintenance';
    else if (flags.registration_enabled) mode = 'registration';

    res.json({
      mode,
      // keep legacy fields for any old clients
      registration_enabled: flags.registration_enabled || false,
      payment_mode: flags.payment_mode || false,
    });
  } catch (err) {
    console.error('[PUBLIC] Registration status error:', err);
    res.json({ mode: 'beta', registration_enabled: false, payment_mode: false });
  }
});

module.exports = router;
