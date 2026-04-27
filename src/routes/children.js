const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { hashPassword, pinFingerprint } = require('../lib/hash');
const { requireParent } = require('../middleware/auth');

const router = express.Router();

// All routes require parent auth
router.use(requireParent);

/**
 * Check if a Postgres error is a unique_violation on child_family_name_unique.
 */
function isDuplicateNameError(err) {
  return err.code === '23505' && (
    (err.constraint && err.constraint.includes('child_family_name')) ||
    (err.detail && err.detail.toLowerCase().includes('name'))
  );
}

/**
 * Build suggestion names for a duplicate child name.
 * Uses number suffixes (e.g. "Emma 2", "Emma 3") instead of emojis,
 * because emojis can't be typed via keyboard.
 */
function buildNameSuggestions(name) {
  return [2, 3, 4].map(n => `${name} ${n}`);
}

/**
 * Generate a username from child name.
 * Swedish chars normalized, lowercase, + 3-digit suffix.
 */
function generateUsername(name) {
  const base = name
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/[ö]/g, 'o')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 10);
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${base}${suffix}`;
}

/**
 * Generate a random 4-digit PIN.
 */
function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Validate that a PIN is not a weak/common code.
 * Returns null if OK, or an error message if rejected.
 */
function validatePin(pin) {
  // Reject all same digit
  if (/^(\d)\1{3}$/.test(pin)) return 'PIN-koden kan inte bestå av fyra likadana siffror';

  // Reject sequential (ascending)
  const seqAsc = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '7890'];
  if (seqAsc.includes(pin)) return 'PIN-koden kan inte vara en stigande sifferföljd';

  // Reject sequential (descending)
  const seqDesc = ['9876', '8765', '7654', '6543', '5432', '4321', '3210', '2109'];
  if (seqDesc.includes(pin)) return 'PIN-koden kan inte vara en sjunkande sifferföljd';

  return null;
}

// ─── GET /api/children ──────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.emoji, c.birthday, c.timezone, c.view_mode,
              c.allow_child_reorder, c.username, c.created_at, pc.role
       FROM child c
       JOIN parent_child pc ON pc.child_id = c.id
       WHERE pc.parent_id = $1
       ORDER BY c.sort_order ASC, c.created_at ASC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[CHILDREN] List error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/children ─────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, emoji, birthday, timezone, view_mode, pin } = req.body;

    // Validation
    if (!name || !emoji) {
      return res.status(400).json({ error: 'Namn och emoji krävs' });
    }
    if (name.trim().length < 1) {
      return res.status(400).json({ error: 'Namn krävs' });
    }

    // Validate birthday format if provided
    if (birthday) {
      const birthDate = new Date(birthday);
      if (isNaN(birthDate.getTime())) {
        return res.status(400).json({ error: 'Ogiltigt datumformat' });
      }
    }

    // Validate PIN if provided (parent-chosen) — must be 4 digits and not weak
    let rawPin;
    if (pin !== undefined && pin !== null && pin !== '') {
      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: 'PIN-koden måste vara exakt 4 siffror' });
      }
      const pinError = validatePin(pin);
      if (pinError) {
        return res.status(400).json({ error: pinError });
      }
      rawPin = pin;
    } else {
      rawPin = generatePin();
    }

    const childTimezone = timezone || 'Europe/Stockholm';
    const childViewMode = view_mode || 'auto';

    // Generate unique username (still needed for display purposes only)
    let username = generateUsername(name.trim());
    let attempts = 0;
    while (attempts < 10) {
      const exists = await db.query(
        'SELECT id FROM child WHERE LOWER(username) = $1',
        [username.toLowerCase()]
      );
      if (exists.rows.length === 0) break;
      username = generateUsername(name.trim());
      attempts++;
    }

    // Hash PIN and compute fingerprint for global uniqueness
    const pinHash = await hashPassword(rawPin);
    const pinFp = pinFingerprint(rawPin);

    // Check global PIN uniqueness
    const pinExists = await db.query(
      'SELECT id FROM child WHERE pin_fingerprint = $1',
      [pinFp]
    );
    if (pinExists.rows.length > 0) {
      return res.status(409).json({ error: 'Den PIN-koden används redan. Välj en annan 4-siffrig kod.' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Create child
      const childResult = await client.query(
        `INSERT INTO child (family_id, name, emoji, birthday, timezone, view_mode, pin, username, pin_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, emoji, birthday, timezone, view_mode, username, created_at`,
        [req.user.familyId, name.trim(), emoji, birthday || null, childTimezone, childViewMode, pinHash, username, pinFp]
      );

      const child = childResult.rows[0];

      // Create parent-child relationship for creating parent (primary)
      await client.query(
        'INSERT INTO parent_child (parent_id, child_id, role) VALUES ($1, $2, $3)',
        [req.user.id, child.id, 'primary']
      );

      // Also link all other parents in the family to the new child (shared)
      const otherParents = await client.query(
        'SELECT id FROM parent WHERE family_id = $1 AND id != $2',
        [req.user.familyId, req.user.id]
      );
      for (const op of otherParents.rows) {
        await client.query(
          `INSERT INTO parent_child (parent_id, child_id, role) VALUES ($1, $2, 'shared')
           ON CONFLICT (parent_id, child_id) DO NOTHING`,
          [op.id, child.id]
        );
      }

      // Create streak record
      await client.query(
        'INSERT INTO streak (child_id) VALUES ($1)',
        [child.id]
      );

      await client.query('COMMIT');

      res.status(201).json({
        ...child,
        pin: rawPin, // Show PIN once so parent can save it
        message: `${name.trim()} har lagts till! Spara PIN-koden: ${rawPin}`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (isDuplicateNameError(err)) {
      const trimmedName = req.body.name.trim();
      const suggestions = buildNameSuggestions(trimmedName);
      return res.status(409).json({
        error: `${trimmedName} finns redan i din familj`,
        code: 'DUPLICATE_CHILD_NAME',
        suggestions,
      });
    }
    console.error('[CHILDREN] Create error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/children/:id ──────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // Verify parent has access to this child
    const access = await db.query(
      'SELECT role FROM parent_child WHERE parent_id = $1 AND child_id = $2',
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) {
      return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });
    }

    const result = await db.query(
      `SELECT id, name, emoji, birthday, timezone, view_mode, allow_child_reorder, username, created_at
       FROM child WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Barnet hittades inte' });
    }

    res.json({ ...result.rows[0], role: access.rows[0].role });
  } catch (err) {
    console.error('[CHILDREN] Get error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/children/reorder ────────────────────────
// IMPORTANT: This route MUST be defined before /:id to avoid Express matching "reorder" as a UUID
router.put('/reorder', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array of { id, sort_order }' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      for (const item of order) {
        if (!item.id || typeof item.sort_order !== 'number') continue;
        await client.query(
          `UPDATE child SET sort_order = $1 WHERE id = $2 AND family_id = $3`,
          [item.sort_order, item.id, req.user.familyId]
        );
      }

      await client.query('COMMIT');
      res.json({ message: 'Ordning uppdaterad' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[CHILDREN] Reorder error:', err);
    res.status(500).json({ error: 'Något gick fel vid sparandet.' });
  }
});

// ─── PUT /api/children/:id ──────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    // Verify parent has access
    const access = await db.query(
      'SELECT role FROM parent_child WHERE parent_id = $1 AND child_id = $2',
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) {
      return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });
    }

    const { name, emoji, birthday, timezone, view_mode, allow_child_reorder } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (name.trim().length < 1) {
        return res.status(400).json({ error: 'Namn krävs' });
      }
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (emoji !== undefined) {
      updates.push(`emoji = $${idx++}`);
      values.push(emoji);
    }
    if (birthday !== undefined) {
      const d = new Date(birthday);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Ogiltigt datumformat' });
      }
      updates.push(`birthday = $${idx++}`);
      values.push(birthday);
    }
    if (timezone !== undefined) {
      updates.push(`timezone = $${idx++}`);
      values.push(timezone);
    }
    if (view_mode !== undefined) {
      updates.push(`view_mode = $${idx++}`);
      values.push(view_mode);
    }
    if (allow_child_reorder !== undefined) {
      updates.push(`allow_child_reorder = $${idx++}`);
      values.push(!!allow_child_reorder);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Inget att uppdatera' });
    }

    values.push(req.params.id);
    const result = await db.query(
      `UPDATE child SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, emoji, birthday, timezone, view_mode, allow_child_reorder, username, created_at`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (isDuplicateNameError(err)) {
      const trimmedName = (req.body.name || '').trim();
      const suggestions = buildNameSuggestions(trimmedName);
      return res.status(409).json({
        error: `${trimmedName} finns redan i din familj`,
        code: 'DUPLICATE_CHILD_NAME',
        suggestions,
      });
    }
    console.error('[CHILDREN] Update error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── DELETE /api/children/:id ───────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    // Verify parent has primary access
    const access = await db.query(
      `SELECT role FROM parent_child WHERE parent_id = $1 AND child_id = $2 AND role = 'primary'`,
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) {
      return res.status(403).json({ error: 'Bara primär förälder kan ta bort barn' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Delete related records in order of dependencies
      await client.query('DELETE FROM streak WHERE child_id = $1', [req.params.id]);
      await client.query('DELETE FROM parent_note WHERE child_id = $1', [req.params.id]);
      await client.query('DELETE FROM reward_redemption WHERE child_id = $1', [req.params.id]);

      // Delete daily log items (via daily_log)
      await client.query(
        `DELETE FROM rating WHERE daily_log_item_id IN (
           SELECT dli.id FROM daily_log_item dli
           JOIN daily_log dl ON dl.id = dli.daily_log_id
           WHERE dl.child_id = $1
         )`,
        [req.params.id]
      );
      await client.query(
        `DELETE FROM daily_log_item WHERE daily_log_id IN (
           SELECT id FROM daily_log WHERE child_id = $1
         )`,
        [req.params.id]
      );
      await client.query('DELETE FROM daily_log WHERE child_id = $1', [req.params.id]);

      // Delete weekly schedule items and schedules
      await client.query(
        `DELETE FROM weekly_schedule_item WHERE weekly_schedule_id IN (
           SELECT id FROM weekly_schedule WHERE child_id = $1
         )`,
        [req.params.id]
      );
      await client.query('DELETE FROM weekly_schedule WHERE child_id = $1', [req.params.id]);

      // Delete parent-child links and child
      await client.query('DELETE FROM parent_child WHERE child_id = $1', [req.params.id]);
      await client.query('DELETE FROM child WHERE id = $1', [req.params.id]);

      await client.query('COMMIT');
      res.json({ message: 'Barnet har tagits bort' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[CHILDREN] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/children/:id/pin ──────────────────────────
router.put('/:id/pin', async (req, res) => {
  try {
    const access = await db.query(
      'SELECT role FROM parent_child WHERE parent_id = $1 AND child_id = $2',
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) {
      return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });
    }

    const { pin } = req.body;
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN-koden måste vara exakt 4 siffror' });
    }

    // Reject weak PINs
    const weakError = validatePin(pin);
    if (weakError) {
      return res.status(400).json({ error: weakError });
    }

    // Check global PIN uniqueness (exclude current child)
    const pinFp = pinFingerprint(pin);
    const pinExists = await db.query(
      'SELECT id FROM child WHERE pin_fingerprint = $1 AND id != $2',
      [pinFp, req.params.id]
    );
    if (pinExists.rows.length > 0) {
      return res.status(409).json({ error: 'Den PIN-koden används redan. Välj en annan 4-siffrig kod.' });
    }

    const pinHash = await hashPassword(pin);
    await db.query('UPDATE child SET pin = $1, pin_fingerprint = $2 WHERE id = $3', [pinHash, pinFp, req.params.id]);

    res.json({ message: 'PIN-koden har ändrats!' });
  } catch (err) {
    console.error('[CHILDREN] Change PIN error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/children/:id/progress ─────────────────────
router.get('/:id/progress', async (req, res) => {
  try {
    const access = await db.query(
      'SELECT role FROM parent_child WHERE parent_id = $1 AND child_id = $2',
      [req.user.id, req.params.id]
    );
    if (access.rows.length === 0) {
      return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });
    }

    // Placeholder — will be filled in later phases
    const streak = await db.query(
      'SELECT current_streak, cycle_day, last_active_date FROM streak WHERE child_id = $1',
      [req.params.id]
    );

    res.json({
      childId: req.params.id,
      streak: streak.rows[0] || { current_streak: 0, cycle_day: 0, last_active_date: null },
      totalStars: 0,
      completedToday: 0,
      totalToday: 0,
      message: 'Framsteg fylls i i kommande faser',
    });
  } catch (err) {
    console.error('[CHILDREN] Progress error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = router;
