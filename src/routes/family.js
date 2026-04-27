const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { requireParent } = require('../middleware/auth');
const { sendEmail } = require('../lib/email');
const config = require('../lib/config');

const router = express.Router();

// ─── Public: GET /api/family/invite/:token (no auth) ────
router.get('/invite/:token', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT fi.id, fi.email, fi.expires_at, fi.accepted, fi.child_ids, fi.family_id
       FROM family_invite fi WHERE fi.token = $1`,
      [req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Inbjudan hittades inte' });
    }
    const invite = result.rows[0];
    if (invite.accepted) {
      return res.status(400).json({ error: 'Inbjudan har redan accepterats' });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Inbjudan har gått ut' });
    }
    let children = [];
    if (invite.child_ids && invite.child_ids.length > 0) {
      const childResult = await db.query(
        'SELECT id, name, emoji FROM child WHERE id = ANY($1)',
        [invite.child_ids]
      );
      children = childResult.rows;
    }
    res.json({ email: invite.email, familyId: invite.family_id, expiresAt: invite.expires_at, children });
  } catch (err) {
    console.error('[FAMILY] Validate invite error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// All remaining routes require parent auth
router.use(requireParent);

// ─── GET /api/family ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const familyResult = await db.query(
      `SELECT id, name, timezone, time_display_mode, morning_start, morning_end,
              day_start, day_end, evening_start, evening_end,
              night_start, night_end, streak_start_day, sound_enabled, created_at
       FROM family WHERE id = $1`,
      [req.user.familyId]
    );

    if (familyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Familj hittades inte' });
    }

    const family = familyResult.rows[0];

    // Get parents in family with their child links
    const parentsResult = await db.query(
      'SELECT id, email, name, is_admin, family_role, created_at FROM parent WHERE family_id = $1',
      [req.user.familyId]
    );

    // Get parent-child links for all parents
    const parentChildLinks = await db.query(
      `SELECT pc.parent_id, pc.child_id, pc.role
       FROM parent_child pc
       JOIN parent p ON p.id = pc.parent_id
       WHERE p.family_id = $1`,
      [req.user.familyId]
    );
    const linksByParent = {};
    for (const link of parentChildLinks.rows) {
      if (!linksByParent[link.parent_id]) linksByParent[link.parent_id] = [];
      linksByParent[link.parent_id].push(link.child_id);
    }
    for (const p of parentsResult.rows) {
      p.linked_child_ids = linksByParent[p.id] || [];
    }

    // Get children in family (only those the current parent has access to)
    const childrenResult = await db.query(
      `SELECT c.id, c.name, c.emoji, c.birthday, c.username, c.timezone, c.allow_child_reorder,
              c.sort_order, pc.role,
              CASE WHEN c.pin IS NOT NULL AND c.pin != '' THEN true ELSE false END AS has_pin
       FROM child c
       JOIN parent_child pc ON pc.child_id = c.id
       WHERE pc.parent_id = $1
       ORDER BY c.sort_order ASC, c.created_at ASC`,
      [req.user.id]
    );

    // Get ALL children in family (for parent-child assignment UI)
    const allChildrenResult = await db.query(
      `SELECT id, name, emoji FROM child WHERE family_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [req.user.familyId]
    );

    // Get pending invites
    const invitesResult = await db.query(
      `SELECT id, email, expires_at, accepted, created_at
       FROM family_invite
       WHERE family_id = $1 AND accepted = false AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.familyId]
    );

    res.json({
      ...family,
      parents: parentsResult.rows,
      children: childrenResult.rows,
      allChildren: allChildrenResult.rows,
      pendingInvites: invitesResult.rows,
    });
  } catch (err) {
    console.error('[FAMILY] Get error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/family ───────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const { name, timezone } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(name.trim() || null);
    }

    if (timezone !== undefined) {
      updates.push(`timezone = $${idx++}`);
      values.push(timezone);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Inga ändringar att spara' });
    }

    values.push(req.user.familyId);
    const result = await db.query(
      `UPDATE family SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, timezone`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Familj hittades inte' });
    }

    res.json({ message: 'Familj uppdaterad!', family: result.rows[0] });
  } catch (err) {
    console.error('[FAMILY] Put error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/family/members/:id ────────────────────────
router.put('/members/:id', async (req, res) => {
  try {
    const { family_role } = req.body;
    const memberId = req.params.id;

    // Verify member belongs to the same family
    const memberResult = await db.query(
      'SELECT id FROM parent WHERE id = $1 AND family_id = $2',
      [memberId, req.user.familyId]
    );
    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'Medlem hittades inte' });
    }

    const validRoles = ['mamma', 'pappa', 'bonusförälder', 'annan'];
    if (family_role !== undefined) {
      if (family_role !== null && !validRoles.includes(family_role)) {
        return res.status(400).json({ error: 'Ogiltig roll. Välj: mamma, pappa, bonusförälder eller annan' });
      }
      await db.query(
        'UPDATE parent SET family_role = $1 WHERE id = $2',
        [family_role || null, memberId]
      );
    }

    res.json({ message: 'Roll uppdaterad!' });
  } catch (err) {
    console.error('[FAMILY] Member update error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/family/members/:id/children ────────────────
// Update which children a parent can see
router.put('/members/:id/children', async (req, res) => {
  const client = await db.getClient();
  try {
    const memberId = req.params.id;
    const { childIds } = req.body;

    if (!Array.isArray(childIds) || childIds.length === 0) {
      return res.status(400).json({ error: 'Minst ett barn måste väljas' });
    }

    await client.query('BEGIN');

    // Verify member belongs to same family
    const memberResult = await client.query(
      'SELECT id FROM parent WHERE id = $1 AND family_id = $2',
      [memberId, req.user.familyId]
    );
    if (memberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Medlem hittades inte' });
    }

    // Verify all children belong to same family
    const childResult = await client.query(
      'SELECT id FROM child WHERE family_id = $1',
      [req.user.familyId]
    );
    const familyChildIds = childResult.rows.map(r => r.id);
    const invalidIds = childIds.filter(id => !familyChildIds.includes(id));
    if (invalidIds.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ogiltiga barn-ID:n' });
    }

    // Remove existing links
    await client.query('DELETE FROM parent_child WHERE parent_id = $1', [memberId]);

    // Re-create with selected children
    for (const childId of childIds) {
      await client.query(
        `INSERT INTO parent_child (parent_id, child_id, role)
         VALUES ($1, $2, 'shared')
         ON CONFLICT (parent_id, child_id) DO NOTHING`,
        [memberId, childId]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Barnkopplingar uppdaterade!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FAMILY] Update member children error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/family/members/:id ─────────────────────
router.delete('/members/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    const memberId = req.params.id;

    await client.query('BEGIN');

    // Prevent removing yourself if you're the last admin
    const allParents = await client.query(
      'SELECT id, is_admin FROM parent WHERE family_id = $1',
      [req.user.familyId]
    );
    if (allParents.rows.length <= 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Kan inte ta bort sista föräldern i familjen' });
    }

    const memberResult = await client.query(
      'SELECT id, is_admin FROM parent WHERE id = $1 AND family_id = $2',
      [memberId, req.user.familyId]
    );
    if (memberResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Medlem hittades inte' });
    }

    // Don't let a non-admin remove an admin
    if (!req.user.isAdmin && memberResult.rows[0].is_admin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Kan inte ta bort en admin' });
    }

    // Remove parent_child links first (no FK cascade on parent_id, so clean explicitly)
    await client.query(
      'DELETE FROM parent_child WHERE parent_id = $1',
      [memberId]
    );

    // Delete the parent (notification_preference cascades via FK ON DELETE)
    await client.query('DELETE FROM parent WHERE id = $1', [memberId]);

    await client.query('COMMIT');
    res.json({ message: 'Förälder borttagen från famiglia.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FAMILY] Member delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/family/children/:id ───────────────────
router.delete('/children/:id', async (req, res) => {
  try {
    const childId = req.params.id;

    // Verify child belongs to this family
    const childResult = await db.query(
      'SELECT id FROM child WHERE id = $1 AND family_id = $2',
      [childId, req.user.familyId]
    );
    if (childResult.rows.length === 0) {
      return res.status(404).json({ error: 'Barn hittades inte' });
    }

    // Cascade delete: child → cascade to parent_child, daily_log, daily_log_item, weekly_schedule, etc.
    // (Foreign key cascades handle most; explicit deletes for tables without FK cascade)
    await db.query('DELETE FROM child WHERE id = $1', [childId]);
    res.json({ message: 'Barn borttaget' });
  } catch (err) {
    console.error('[FAMILY] Child delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/family/settings ───────────────────────────
router.put('/settings', async (req, res) => {
  try {
    const {
      name,
      timezone,
      time_display_mode,
      morning_start, morning_end,
      day_start, day_end,
      evening_start, evening_end,
      night_start, night_end,
      streak_start_day,
      sound_enabled,
    } = req.body;

    const updates = [];
    const values = [];
    let idx = 1;

    // Family name
    if (name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(name.trim() || null);
    }

    // Family timezone
    if (timezone !== undefined) {
      updates.push(`timezone = $${idx++}`);
      values.push(timezone);
    }

    // Validate time_display_mode
    if (time_display_mode !== undefined) {
      const validModes = ['simple', 'starttime', 'full'];
      if (!validModes.includes(time_display_mode)) {
        return res.status(400).json({ error: 'Ogiltigt tidsvisningsläge. Välj: simple, starttime eller full' });
      }
      updates.push(`time_display_mode = $${idx++}`);
      values.push(time_display_mode);
    }

    // Time fields — validate HH:MM format
    const timeFields = {
      morning_start, morning_end, day_start, day_end,
      evening_start, evening_end, night_start, night_end,
    };
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    for (const [field, value] of Object.entries(timeFields)) {
      if (value !== undefined) {
        if (!timeRegex.test(value)) {
          return res.status(400).json({ error: `Ogiltigt tidsformat för ${field}. Använd HH:MM` });
        }
        updates.push(`${field} = $${idx++}`);
        values.push(value);
      }
    }

    // streak_start_day (0=Sunday ... 6=Saturday, 1=Monday default)
    if (streak_start_day !== undefined) {
      const day = parseInt(streak_start_day);
      if (isNaN(day) || day < 0 || day > 6) {
        return res.status(400).json({ error: 'Ogiltigt värde för streak-startdag (0-6)' });
      }
      updates.push(`streak_start_day = $${idx++}`);
      values.push(day);
    }

    if (sound_enabled !== undefined) {
      updates.push(`sound_enabled = $${idx++}`);
      values.push(!!sound_enabled);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Inga inställningar att uppdatera' });
    }

    values.push(req.user.familyId);
    const result = await db.query(
      `UPDATE family SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, timezone, time_display_mode, morning_start, morning_end,
                 day_start, day_end, evening_start, evening_end,
                 night_start, night_end, streak_start_day, sound_enabled`,
      values
    );

    res.json({
      message: 'Inställningar uppdaterade!',
      settings: result.rows[0],
    });
  } catch (err) {
    console.error('[FAMILY] Settings error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/family/invite ────────────────────────────
router.post('/invite', async (req, res) => {
  try {
    const { email, childIds } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'E-postadress krävs' });
    }
    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Ogiltig e-postadress' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if already in this family
    const existingParent = await db.query(
      'SELECT id FROM parent WHERE LOWER(email) = $1 AND family_id = $2',
      [normalizedEmail, req.user.familyId]
    );
    if (existingParent.rows.length > 0) {
      return res.status(409).json({ error: 'Den här personen finns redan i din familj' });
    }

    // Check for existing pending invite
    const existingInvite = await db.query(
      `SELECT id FROM family_invite
       WHERE family_id = $1 AND LOWER(email) = $2 AND accepted = false AND expires_at > NOW()`,
      [req.user.familyId, normalizedEmail]
    );
    if (existingInvite.rows.length > 0) {
      return res.status(409).json({ error: 'Det finns redan en väntande inbjudan för denna e-post' });
    }

    // Create invite
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000); // 7 days

    await db.query(
      `INSERT INTO family_invite (family_id, email, child_ids, token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.familyId, normalizedEmail, childIds || [], token, expiresAt]
    );

    // Send invite email
    const inviteUrl = `${config.email.baseUrl}/accept-invite?token=${token}`;
    await sendEmail({
      to: normalizedEmail,
      subject: 'Du har blivit inbjuden till Min Stjärndag',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1B2340;">Du har blivit inbjuden! ⭐</h2>
          <p>${req.user.email} har bjudit in dig att gå med i sin familj på Min Stjärndag.</p>
          <p>Min Stjärndag är ett visuellt dagsschema som hjälper barn att förstå sin dag, bocka av aktiviteter och samla stjärnor.</p>
          <a href="${inviteUrl}" style="display: inline-block; background: #F5A623; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Acceptera inbjudan</a>
          <p style="color: #5A6178; font-size: 14px; margin-top: 24px;">Inbjudan gäller i 7 dagar.</p>
        </div>
      `,
    });

    res.status(201).json({
      message: `Inbjudan skickad till ${normalizedEmail}!`,
      invite: {
        email: normalizedEmail,
        expiresAt,
      },
    });
  } catch (err) {
    console.error('[FAMILY] Invite error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── DELETE /api/family/invite/:inviteId ──────────────────
// Revoke a pending invitation (also removes the invited parent if they registered but haven't been removed)
router.delete('/invite/:inviteId', async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Check if invite exists and belongs to this family
    const inviteResult = await client.query(
      `SELECT fi.id, fi.email, fi.accepted
       FROM family_invite fi
       WHERE fi.id = $1 AND fi.family_id = $2`,
      [req.params.inviteId, req.user.familyId]
    );

    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inbjudan hittades inte' });
    }

    const invite = inviteResult.rows[0];

    // If there's a parent linked to this invite email in this family, remove them too
    // (cleanup parent_child links first, then the parent record)
    if (invite.email) {
      const parentResult = await client.query(
        `SELECT id FROM parent WHERE LOWER(email) = LOWER($1) AND family_id = $2`,
        [invite.email, req.user.familyId]
      );
      if (parentResult.rows.length > 0) {
        const parentId = parentResult.rows[0].id;
        // Remove parent_child links (no FK cascade on parent_id)
        await client.query('DELETE FROM parent_child WHERE parent_id = $1', [parentId]);
        // Delete parent (notification_preference cascades via FK ON DELETE)
        await client.query('DELETE FROM parent WHERE id = $1', [parentId]);
      }
    }

    // Delete the invite itself
    await client.query(
      `DELETE FROM family_invite WHERE id = $1`,
      [req.params.inviteId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Inbjudan återkallad' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FAMILY] Revoke invite error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  } finally {
    client.release();
  }
});

// ─── POST /api/family/add-parent ───────────────────────────
// Create a parent account directly (no email verification needed)
router.post('/add-parent', async (req, res) => {
  const client = await db.getClient();
  try {
    const { name, email, password } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: 'Namn krävs' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Giltig e-postadress krävs' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Lösenordet måste vara minst 6 tecken' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedName = name.trim();

    // Check if email already exists in ANY family
    const existingAny = await client.query(
      'SELECT id FROM parent WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    if (existingAny.rows.length > 0) {
      return res.status(409).json({ error: 'E-postadressen används redan av ett annat konto' });
    }

    // Check if email already in this family's parent list
    const existingFamily = await client.query(
      'SELECT id FROM parent WHERE LOWER(email) = $1 AND family_id = $2',
      [normalizedEmail, req.user.familyId]
    );
    if (existingFamily.rows.length > 0) {
      return res.status(409).json({ error: 'Personen finns redan i din familj' });
    }

    // Check for existing pending invite for this email in this family
    const existingInvite = await client.query(
      `SELECT id FROM family_invite
       WHERE family_id = $1 AND LOWER(email) = $2 AND accepted = false AND expires_at > NOW()`,
      [req.user.familyId, normalizedEmail]
    );

    await client.query('BEGIN');

    // Create the new parent account (auto-verified, same family)
    const { hashPassword } = require('../lib/hash');
    const passwordHash = await hashPassword(password);

    const newParentResult = await client.query(
      `INSERT INTO parent (family_id, email, password_hash, name, verified, is_admin, family_role)
       VALUES ($1, $2, $3, $4, true, false, NULL)
       RETURNING id, email, name`,
      [req.user.familyId, normalizedEmail, passwordHash, trimmedName]
    );
    const newParent = newParentResult.rows[0];

    // Link new parent to all existing children in the family (shared access)
    const childrenResult = await client.query(
      'SELECT id FROM child WHERE family_id = $1',
      [req.user.familyId]
    );
    for (const child of childrenResult.rows) {
      await client.query(
        `INSERT INTO parent_child (parent_id, child_id, role) VALUES ($1, $2, 'shared')
         ON CONFLICT (parent_id, child_id) DO NOTHING`,
        [newParent.id, child.id]
      );
    }

    // Remove any pending invite for this email (cleanup)
    if (existingInvite.rows.length > 0) {
      await client.query(
        `DELETE FROM family_invite WHERE id = $1`,
        [existingInvite.rows[0].id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Konto skapat!',
      parent: {
        id: newParent.id,
        email: newParent.email,
        name: newParent.name,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FAMILY] Add parent error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  } finally {
    client.release();
  }
});

// ─── POST /api/family/accept-invite ─────────────────────
router.post('/accept-invite', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Inbjudningstoken krävs' });
    }

    const inviteResult = await db.query(
      `SELECT id, family_id, email, child_ids, expires_at, accepted
       FROM family_invite WHERE token = $1`,
      [token]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Inbjudan hittades inte' });
    }

    const invite = inviteResult.rows[0];
    if (invite.accepted) {
      return res.status(400).json({ error: 'Inbjudan har redan accepterats' });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Inbjudan har gått ut' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Update parent's family to the invited family
      await client.query(
        'UPDATE parent SET family_id = $1 WHERE id = $2',
        [invite.family_id, req.user.id]
      );

      // Create parent_child records for shared children
      if (invite.child_ids && invite.child_ids.length > 0) {
        for (const childId of invite.child_ids) {
          // Check if link already exists
          const existing = await client.query(
            'SELECT 1 FROM parent_child WHERE parent_id = $1 AND child_id = $2',
            [req.user.id, childId]
          );
          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO parent_child (parent_id, child_id, role) VALUES ($1, $2, 'shared')`,
              [req.user.id, childId]
            );
          }
        }
      }

      // Mark invite as accepted
      await client.query(
        'UPDATE family_invite SET accepted = true WHERE id = $1',
        [invite.id]
      );

      await client.query('COMMIT');

      res.json({ message: 'Du har gått med i familjen!' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[FAMILY] Accept invite error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/family/dashboard-stats ────────────────────
// Returns per-child stats: today's progress, star balance, 7-day history
router.get('/dashboard-stats', async (req, res) => {
  try {
    const parentId = req.user.id;

    // Get parent's children
    const childrenResult = await db.query(
      `SELECT c.id, c.name, c.emoji, c.timezone
       FROM child c
       JOIN parent_child pc ON pc.child_id = c.id
       WHERE pc.parent_id = $1
       ORDER BY c.created_at ASC`,
      [parentId]
    );
    const children = childrenResult.rows;

    if (children.length === 0) {
      return res.json({ children: [] });
    }

    const childIds = children.map(c => c.id);

    // Today's date per child timezone (use Stockholm as default for query efficiency)
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

    // Get today's log stats per child
    const todayStats = await db.query(
      `SELECT dl.child_id,
              COUNT(dli.id) AS total,
              COUNT(CASE WHEN dli.completed THEN 1 END) AS completed
       FROM daily_log dl
       LEFT JOIN daily_log_item dli ON dli.daily_log_id = dl.id
       WHERE dl.child_id = ANY($1) AND dl.date = $2
       GROUP BY dl.child_id`,
      [childIds, todayStr]
    );
    const todayMap = {};
    for (const row of todayStats.rows) {
      todayMap[row.child_id] = { total: parseInt(row.total, 10), completed: parseInt(row.completed, 10) };
    }

    // Get star balances per child
    const earnedResult = await db.query(
      `SELECT dl.child_id, COALESCE(SUM(dli.star_value), 0) AS earned
       FROM daily_log_item dli
       JOIN daily_log dl ON dl.id = dli.daily_log_id
       WHERE dl.child_id = ANY($1) AND dli.completed = true
       GROUP BY dl.child_id`,
      [childIds]
    );
    const spentResult = await db.query(
      `SELECT rr.child_id, COALESCE(SUM(rr.star_cost), 0) AS spent
       FROM reward_redemption rr
       WHERE rr.child_id = ANY($1) AND rr.status IN ('approved', 'auto') AND rr.star_cost IS NOT NULL
       GROUP BY rr.child_id`,
      [childIds]
    );
    // Fallback for children without star_cost snapshot (legacy redemptions)
    const spentFallbackResult = await db.query(
      `SELECT rr.child_id, COALESCE(SUM(r.star_cost), 0) AS spent
       FROM reward_redemption rr
       JOIN reward r ON r.id = rr.reward_id
       WHERE rr.child_id = ANY($1) AND rr.status IN ('approved', 'auto') AND rr.star_cost IS NULL
       GROUP BY rr.child_id`,
      [childIds]
    );

    const earnedMap = {};
    for (const row of earnedResult.rows) earnedMap[row.child_id] = parseInt(row.earned, 10);

    const spentMap = {};
    for (const row of spentResult.rows) {
      spentMap[row.child_id] = (spentMap[row.child_id] || 0) + parseInt(row.spent, 10);
    }
    for (const row of spentFallbackResult.rows) {
      spentMap[row.child_id] = (spentMap[row.child_id] || 0) + parseInt(row.spent, 10);
    }

    // 7-day completion history per child
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const fromStr = sevenDaysAgo.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

    const historyResult = await db.query(
      `SELECT dl.child_id, dl.date::text AS date,
              COUNT(dli.id) AS total,
              COUNT(CASE WHEN dli.completed THEN 1 END) AS completed,
              dl.is_paused
       FROM daily_log dl
       LEFT JOIN daily_log_item dli ON dli.daily_log_id = dl.id
       WHERE dl.child_id = ANY($1) AND dl.date >= $2
       GROUP BY dl.child_id, dl.date, dl.is_paused
       ORDER BY dl.date ASC`,
      [childIds, fromStr]
    );
    const historyByChild = {};
    for (const row of historyResult.rows) {
      if (!historyByChild[row.child_id]) historyByChild[row.child_id] = [];
      historyByChild[row.child_id].push({
        date: row.date,
        total: parseInt(row.total, 10),
        completed: parseInt(row.completed, 10),
        is_paused: row.is_paused,
        pct: row.total > 0 ? Math.round((parseInt(row.completed, 10) / parseInt(row.total, 10)) * 100) : null,
      });
    }

    // Pending redemptions per child
    const pendingResult = await db.query(
      `SELECT rr.child_id, COUNT(*) AS count
       FROM reward_redemption rr
       WHERE rr.child_id = ANY($1) AND rr.status = 'pending'
       GROUP BY rr.child_id`,
      [childIds]
    );
    const pendingMap = {};
    for (const row of pendingResult.rows) pendingMap[row.child_id] = parseInt(row.count, 10);

    // Build response
    const childStats = children.map(c => {
      const earned = earnedMap[c.id] || 0;
      const spent = spentMap[c.id] || 0;
      const today = todayMap[c.id] || { total: 0, completed: 0 };
      return {
        id: c.id,
        name: c.name,
        emoji: c.emoji,
        today_total: today.total,
        today_completed: today.completed,
        today_pct: today.total > 0 ? Math.round((today.completed / today.total) * 100) : null,
        star_balance: Math.max(0, earned - spent),
        pending_redemptions: pendingMap[c.id] || 0,
        history: historyByChild[c.id] || [],
      };
    });

    const totalPending = childStats.reduce((s, c) => s + c.pending_redemptions, 0);

    res.json({ children: childStats, today: todayStr, total_pending_redemptions: totalPending });
  } catch (err) {
    console.error('[FAMILY] Dashboard stats error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = router;
