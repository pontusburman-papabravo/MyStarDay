const express = require('express');
const db = require('../lib/db');
const { hashPassword, comparePassword } = require('../lib/hash');
const { requireParent, requireAdmin } = require('../middleware/auth');
const { sendAccountDeletionRequestedEmail } = require('../lib/email');

const router = express.Router();

// ─── PUT /api/account/change-password ───────────────────
router.put('/change-password', requireParent, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Nuvarande och nytt lösenord krävs' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
    }

    // Verify current password
    const result = await db.query(
      'SELECT password_hash FROM parent WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Användare hittades inte' });
    }

    const valid = await comparePassword(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Nuvarande lösenord är felaktigt' });
    }

    // Update password
    const newHash = await hashPassword(newPassword);
    await db.query(
      'UPDATE parent SET password_hash = $1 WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Lösenordet har ändrats!' });
  } catch (err) {
    console.error('[ACCOUNT] Change password error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/account/notifications ─────────────────────
router.put('/notifications', requireParent, async (req, res) => {
  try {
    const { weekly_summary, reward_redemption, email_enabled } = req.body;

    // Upsert notification preferences
    const existing = await db.query(
      'SELECT id FROM notification_preference WHERE parent_id = $1',
      [req.user.id]
    );

    if (existing.rows.length > 0) {
      const updates = [];
      const values = [];
      let idx = 1;

      if (typeof weekly_summary === 'boolean') {
        updates.push(`weekly_summary = $${idx++}`);
        values.push(weekly_summary);
      }
      if (typeof reward_redemption === 'boolean') {
        updates.push(`reward_redemption = $${idx++}`);
        values.push(reward_redemption);
      }
      if (typeof email_enabled === 'boolean') {
        updates.push(`email_enabled = $${idx++}`);
        values.push(email_enabled);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'Inga inställningar att uppdatera' });
      }

      values.push(req.user.id);
      await db.query(
        `UPDATE notification_preference SET ${updates.join(', ')} WHERE parent_id = $${idx}`,
        values
      );
    } else {
      await db.query(
        `INSERT INTO notification_preference (parent_id, weekly_summary, reward_redemption, email_enabled)
         VALUES ($1, $2, $3, $4)`,
        [
          req.user.id,
          weekly_summary !== false,
          reward_redemption !== false,
          email_enabled !== false,
        ]
      );
    }

    // Return current preferences
    const prefs = await db.query(
      'SELECT weekly_summary, reward_redemption, email_enabled FROM notification_preference WHERE parent_id = $1',
      [req.user.id]
    );

    res.json({
      message: 'Inställningar uppdaterade!',
      notifications: prefs.rows[0],
    });
  } catch (err) {
    console.error('[ACCOUNT] Notifications error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/account/notifications ─────────────────────
router.get('/notifications', requireParent, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT weekly_summary, reward_redemption, email_enabled FROM notification_preference WHERE parent_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        weekly_summary: true,
        reward_redemption: true,
        email_enabled: true,
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[ACCOUNT] Get notifications error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/account/status ─────────────────────────────
router.get('/status', requireParent, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pending_deletion, deletion_requested_at
       FROM parent WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Användare hittades inte' });
    }

    const row = result.rows[0];
    let daysRemaining = null;
    if (row.pending_deletion && row.deletion_requested_at) {
      const due = new Date(row.deletion_requested_at);
      due.setDate(due.getDate() + 30);
      const now = new Date();
      const remaining = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      daysRemaining = Math.max(0, remaining);
    }

    res.json({
      pending_deletion: row.pending_deletion,
      deletion_requested_at: row.deletion_requested_at,
      days_remaining: daysRemaining,
    });
  } catch (err) {
    console.error('[ACCOUNT] Get status error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/account/delete ───────────────────────────
router.post('/delete', requireParent, async (req, res) => {
  try {
    // Check if already pending deletion
    const existing = await db.query(
      `SELECT pending_deletion, deletion_requested_at FROM parent WHERE id = $1`,
      [req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Användare hittades inte' });
    }

    if (existing.rows[0].pending_deletion) {
      // Already pending — return success without re-triggering
      return res.json({
        message: 'Kontot är redan markerat för radering.',
        pending_deletion: true,
        deletion_requested_at: existing.rows[0].deletion_requested_at,
      });
    }

    // Set soft delete
    const now = new Date();
    await db.query(
      `UPDATE parent SET pending_deletion = true, deletion_requested_at = $1 WHERE id = $2`,
      [now, req.user.id]
    );

    // Get email for notification
    const parentResult = await db.query(
      `SELECT email, family_id FROM parent WHERE id = $1`,
      [req.user.id]
    );
    const { email } = parentResult.rows[0];
    const firstName = email.split('@')[0].split('.')[0];

    // Send confirmation email
    sendAccountDeletionRequestedEmail(email, firstName).catch(err => {
      console.warn('[ACCOUNT] Failed to send deletion email:', err.message);
    });

    res.json({
      message: 'Kontot har markerats för radering. Du har 30 dagar att ångra dig.',
      pending_deletion: true,
      deletion_requested_at: now.toISOString(),
      days_remaining: 30,
    });
  } catch (err) {
    console.error('[ACCOUNT] Delete account error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/account/cancel-deletion ─────────────────
router.post('/cancel-deletion', requireParent, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pending_deletion FROM parent WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Användare hittades inte' });
    }

    if (!result.rows[0].pending_deletion) {
      return res.json({ message: 'Ingen radering att avbryta.' });
    }

    // Cancel the deletion
    await db.query(
      `UPDATE parent SET pending_deletion = false, deletion_requested_at = NULL WHERE id = $1`,
      [req.user.id]
    );

    res.json({ message: 'Raderingen har avbrutits. Ditt konto är nu aktivt igen.' });
  } catch (err) {
    console.error('[ACCOUNT] Cancel deletion error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/account/widget-order ────────────────────────
router.get('/widget-order', requireParent, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT widget_order FROM parent WHERE id = $1',
      [req.user.id]
    );
    res.json({ widget_order: result.rows[0]?.widget_order || [] });
  } catch (err) {
    console.error('[ACCOUNT] Get widget-order error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/account/widget-order ───────────────────────
router.put('/widget-order', requireParent, async (req, res) => {
  try {
    const { widget_order } = req.body;
    if (!Array.isArray(widget_order)) {
      return res.status(400).json({ error: 'widget_order must be an array' });
    }

    await db.query(
      'UPDATE parent SET widget_order = $1 WHERE id = $2',
      [JSON.stringify(widget_order), req.user.id]
    );

    res.json({ message: 'Ordning sparad', widget_order });
  } catch (err) {
    console.error('[ACCOUNT] Save widget-order error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = router;
