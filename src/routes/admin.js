const express = require('express');
const db = require('../lib/db');
const { requireAdmin } = require('../middleware/auth');
const { hashPassword, comparePassword } = require('../lib/hash');

const router = express.Router();
router.use(requireAdmin);

// ─── GET /api/admin/stats ─────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [families, parents, children, beta, unreadMessages] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM family WHERE archived_at IS NULL'),
      db.query('SELECT COUNT(*) as count FROM parent'),
      db.query('SELECT COUNT(*) as count FROM child'),
      db.query('SELECT COUNT(*) as count FROM beta_signup'),
      db.query('SELECT COUNT(*) as count FROM contact_message WHERE is_read = false'),
    ]);

    res.json({
      families: parseInt(families.rows[0].count),
      parents: parseInt(parents.rows[0].count),
      children: parseInt(children.rows[0].count),
      betaSignups: parseInt(beta.rows[0].count),
      unreadMessages: parseInt(unreadMessages.rows[0].count),
    });
  } catch (err) {
    console.error('[ADMIN] Stats error:', err);
    res.status(500).json({ error: 'Kunde inte hämta statistik' });
  }
});

// ─── GET /api/admin/families ──────────────────────────────
router.get('/families', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT f.id, f.created_at, f.time_display_mode,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', p.id, 'email', p.email, 'verified', p.verified, 'locked', COALESCE(p.locked, false)))
          FILTER (WHERE p.id IS NOT NULL), '[]'
        ) as parents,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', c.id, 'name', c.name, 'emoji', c.emoji, 'username', c.username))
          FILTER (WHERE c.id IS NOT NULL), '[]'
        ) as children
      FROM family f
      LEFT JOIN parent p ON p.family_id = f.id
      LEFT JOIN child c ON c.family_id = f.id
      GROUP BY f.id
      ORDER BY f.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[ADMIN] Families error:', err);
    res.status(500).json({ error: 'Kunde inte hämta familjer' });
  }
});

// ─── GET /api/admin/beta-signups ──────────────────────────
router.get('/beta-signups', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, num_children, child_ages, extra_support, routine_challenge, email_sent_at, created_at
       FROM beta_signup ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[ADMIN] Beta signups error:', err);
    res.status(500).json({ error: 'Kunde inte hämta registreringar' });
  }
});

// ─── GET /api/admin/beta-signups/csv ──────────────────────
router.get('/beta-signups/csv', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT name, email, num_children, child_ages, extra_support, routine_challenge, created_at
       FROM beta_signup ORDER BY created_at DESC`
    );

    const header = 'Namn,E-post,Antal barn,Barnens åldrar,Extra stöd,Svårast med rutiner,Datum\n';
    const rows = result.rows.map(r => {
      const date = new Date(r.created_at).toISOString().split('T')[0];
      const name = `"${(r.name || '').replace(/"/g, '""')}"`;
      const email = `"${(r.email || '').replace(/"/g, '""')}"`;
      const numChildren = r.num_children !== null && r.num_children !== undefined ? String(r.num_children) : '';
      const childAges = `"${((r.child_ages ? (typeof r.child_ages === 'string' ? JSON.parse(r.child_ages) : r.child_ages) : []).join(', ')).replace(/"/g, '""')}"`;
      const extraSupport = `"${(r.extra_support || '').replace(/"/g, '""')}"`;
      const routineChallenge = `"${(r.routine_challenge || '').replace(/"/g, '""')}"`;
      return `${name},${email},${numChildren},${childAges},${extraSupport},${routineChallenge},${date}`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=beta-signups.csv');
    res.send('\uFEFF' + header + rows);
  } catch (err) {
    console.error('[ADMIN] CSV export error:', err);
    res.status(500).json({ error: 'Kunde inte exportera CSV' });
  }
});

// ─── PUT /api/admin/change-password ───────────────────────
router.put('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Nuvarande och nytt lösenord krävs' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
    }

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

    const newHash = await hashPassword(newPassword);
    await db.query(
      'UPDATE parent SET password_hash = $1 WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ message: 'Lösenordet har ändrats!' });
  } catch (err) {
    console.error('[ADMIN] Change password error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/admin/contact-messages ──────────────────────
// Supports filtering by ?type=bug|feedback|contact (optional)
router.get('/contact-messages', async (req, res) => {
  try {
    const typeFilter = req.query.type;
    const validTypes = ['bug', 'feedback', 'contact'];
    const whereClause = typeFilter && validTypes.includes(typeFilter)
      ? 'WHERE message_type = $1'
      : '';
    const limit = 100;

    let query;
    let params;
    if (typeFilter && validTypes.includes(typeFilter)) {
      query = `
        SELECT id, name, email, message, internal_note, noted_at, noted_by, created_at, is_read, message_type
        FROM contact_message
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $2
      `;
      params = [typeFilter, limit];
    } else {
      query = `
        SELECT id, name, email, message, internal_note, noted_at, noted_by, created_at, is_read, message_type
        FROM contact_message
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      params = [];
    }

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[ADMIN] Contact messages error:', err);
    res.status(500).json({ error: 'Kunde inte hämta meddelanden' });
  }
});

// ─── GET /api/admin/contact-messages/unread-count ───────
router.get('/contact-messages/unread-count', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT COUNT(*) as count FROM contact_message WHERE is_read = false'
    );
    res.json({ unreadCount: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('[ADMIN] Unread count error:', err);
    res.status(500).json({ error: 'Kunde inte hämta oläst-antal' });
  }
});

// ─── PUT /api/admin/contact-messages/:id/read ───────────
// Toggle read/unread. Body: { is_read: true|false }
router.put('/contact-messages/:id/read', async (req, res) => {
  try {
    const { is_read } = req.body;
    if (typeof is_read !== 'boolean') {
      return res.status(400).json({ error: 'is_read krävs (boolean)' });
    }
    const result = await db.query(
      'UPDATE contact_message SET is_read = $1 WHERE id = $2 RETURNING id, is_read',
      [is_read, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Meddelandet hittades inte' });
    }
    res.json({ message: is_read ? 'Markerat som läst' : 'Markerat som oläst', ...result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Toggle read status error:', err);
    res.status(500).json({ error: 'Kunde inte uppdatera läsläge' });
  }
});

// ─── PUT /api/admin/approve-parent/:id ──────────────────
router.put('/approve-parent/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'UPDATE parent SET verified = true WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Förälder hittades inte' });
    }
    res.json({ message: 'Kontot har godkänts' });
  } catch (err) {
    console.error('[ADMIN] Approve parent error:', err);
    res.status(500).json({ error: 'Kunde inte godkänna konto' });
  }
});

// ─── PUT /api/admin/lock-parent/:id ──────────────────────
router.put('/lock-parent/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'UPDATE parent SET locked = true WHERE id = $1 AND is_admin = false RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Förälder hittades inte eller är admin' });
    }
    res.json({ message: 'Kontot har låsts' });
  } catch (err) {
    console.error('[ADMIN] Lock parent error:', err);
    res.status(500).json({ error: 'Kunde inte låsa konto' });
  }
});

// ─── PUT /api/admin/unlock-parent/:id ────────────────────
router.put('/unlock-parent/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'UPDATE parent SET locked = false WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Förälder hittades inte' });
    }
    res.json({ message: 'Kontot har låsts upp' });
  } catch (err) {
    console.error('[ADMIN] Unlock parent error:', err);
    res.status(500).json({ error: 'Kunde inte låsa upp konto' });
  }
});

// ─── DELETE /api/admin/account/:type/:id ─────────────────
// type = 'parent' | 'child'
router.delete('/account/:type/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    const { type, id } = req.params;
    if (!['parent', 'child'].includes(type)) {
      return res.status(400).json({ error: 'Ogiltig kontotyp' });
    }

    await client.query('BEGIN');

    if (type === 'parent') {
      // Delete parent-related records (no ON DELETE CASCADE on these)
      await client.query('DELETE FROM notification_preference WHERE parent_id = $1', [id]);
      await client.query('DELETE FROM email_verification WHERE parent_id = $1', [id]);
      await client.query('DELETE FROM password_reset WHERE parent_id = $1', [id]);
      await client.query('DELETE FROM parent_child WHERE parent_id = $1', [id]);
      // Finally delete the parent account
      const result = await client.query(
        'DELETE FROM parent WHERE id = $1 RETURNING id, family_id',
        [id]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Förälder hittades inte' });
      }
      // If no parents remain in the family, also delete all children (and their
      // dependent records) so the FK constraint on child.family_id doesn't block
      // the family delete.
      const remaining = await client.query(
        'SELECT COUNT(*) as count FROM parent WHERE family_id = $1',
        [result.rows[0].family_id]
      );
      if (parseInt(remaining.rows[0].count) === 0) {
        const children = await client.query(
          'SELECT id FROM child WHERE family_id = $1',
          [result.rows[0].family_id]
        );
        for (const child of children.rows) {
          await client.query('DELETE FROM parent_note WHERE child_id = $1', [child.id]);
          await client.query('DELETE FROM streak WHERE child_id = $1', [child.id]);
          await client.query('DELETE FROM reward_redemption WHERE child_id = $1', [child.id]);
          const logs = await client.query('SELECT id FROM daily_log WHERE child_id = $1', [child.id]);
          for (const log of logs.rows) {
            await client.query('DELETE FROM daily_log_item WHERE daily_log_id = $1', [log.id]);
          }
          await client.query('DELETE FROM daily_log WHERE child_id = $1', [child.id]);
          const schedules = await client.query('SELECT id FROM weekly_schedule WHERE child_id = $1', [child.id]);
          for (const sched of schedules.rows) {
            await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [sched.id]);
          }
          await client.query('DELETE FROM weekly_schedule WHERE child_id = $1', [child.id]);
          await client.query('DELETE FROM child WHERE id = $1', [child.id]);
        }
        await client.query('DELETE FROM family WHERE id = $1', [result.rows[0].family_id]);
      }
    } else {
      // Child: delete child-related records first (no ON DELETE CASCADE)
      await client.query('DELETE FROM parent_note WHERE child_id = $1', [id]);
      await client.query('DELETE FROM streak WHERE child_id = $1', [id]);
      await client.query('DELETE FROM reward_redemption WHERE child_id = $1', [id]);
      // Get daily logs first
      const logs = await client.query('SELECT id FROM daily_log WHERE child_id = $1', [id]);
      for (const log of logs.rows) {
        await client.query('DELETE FROM daily_log_item WHERE daily_log_id = $1', [log.id]);
      }
      await client.query('DELETE FROM daily_log WHERE child_id = $1', [id]);
      // Get weekly schedules first
      const schedules = await client.query('SELECT id FROM weekly_schedule WHERE child_id = $1', [id]);
      for (const sched of schedules.rows) {
        await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [sched.id]);
      }
      await client.query('DELETE FROM weekly_schedule WHERE child_id = $1', [id]);
      // Finally delete the child
      const result = await client.query(
        'DELETE FROM child WHERE id = $1 RETURNING id',
        [id]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Barn hittades inte' });
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Kontot har tagits bort' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ADMIN] Delete account error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort konto' });
  } finally {
    client.release();
  }
});

// ─── PUT /api/admin/reset-parent-password/:id ───────────
router.put('/reset-parent-password/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    // Find parent
    const parent = await db.query('SELECT id, email FROM parent WHERE id = $1', [id]);
    if (parent.rows.length === 0) {
      return res.status(404).json({ error: 'Föräldern hittades inte' });
    }

    // Generate or use provided password
    const password = newPassword || 'Stjarndag' + Math.floor(1000 + Math.random() * 9000) + '!';
    if (password.length < 8) {
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
    }

    const passwordHash = await hashPassword(password);
    await db.query('UPDATE parent SET password_hash = $1 WHERE id = $2', [passwordHash, id]);

    console.log(`[ADMIN] Password reset for ${parent.rows[0].email} by admin ${req.user.id}`);
    res.json({
      message: `Lösenordet har återställts för ${parent.rows[0].email}`,
      temporaryPassword: password,
    });
  } catch (err) {
    console.error('[ADMIN] Reset password error:', err);
    res.status(500).json({ error: 'Kunde inte återställa lösenordet' });
  }
});

// ─── DELETE /api/admin/beta-signups/:id ──────────────────
router.delete('/beta-signups/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM beta_signup WHERE id = $1 RETURNING id, email',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Beta-anmälan hittades inte' });
    }
    res.json({ message: `Beta-anmälan för ${result.rows[0].email} har tagits bort` });
  } catch (err) {
    console.error('[ADMIN] Delete beta signup error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort beta-anmälan' });
  }
});

// ─── DELETE /api/admin/contact-messages/:id ──────────────
router.delete('/contact-messages/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM contact_message WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Meddelandet hittades inte' });
    }
    res.json({ message: 'Meddelandet har tagits bort' });
  } catch (err) {
    console.error('[ADMIN] Delete contact message error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort meddelandet' });
  }
});

// ─── POST /api/admin/create-admin ────────────────────────
router.post('/create-admin', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-post och lösenord krävs' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await db.query(
      'SELECT id FROM parent WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'E-postadressen är redan registrerad' });
    }

    const passwordHash = await hashPassword(password);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Create family for admin
      const familyResult = await client.query(
        'INSERT INTO family DEFAULT VALUES RETURNING id'
      );
      const familyId = familyResult.rows[0].id;

      // Create admin parent (verified + is_admin)
      const parentResult = await client.query(
        `INSERT INTO parent (family_id, email, password_hash, verified, is_admin, name)
         VALUES ($1, $2, $3, true, true, $4)
         RETURNING id, email, name, is_admin, verified`,
        [familyId, normalizedEmail, passwordHash, name || null]
      );

      await client.query('COMMIT');

      console.log(`[ADMIN] New admin created: ${normalizedEmail} by admin ${req.user.id}`);
      res.status(201).json({
        message: `Admin-konto skapat för ${normalizedEmail}`,
        admin: parentResult.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ADMIN] Create admin error:', err);
    res.status(500).json({ error: 'Kunde inte skapa admin-konto' });
  }
});

// ─── PUT /api/admin/contact-messages/:id/note ────────────
router.put('/contact-messages/:id/note', async (req, res) => {
  try {
    const { note } = req.body;
    const result = await db.query(
      `UPDATE contact_message
       SET internal_note = $1, noted_at = NOW(), noted_by = $2
       WHERE id = $3
       RETURNING id, internal_note, noted_at`,
      [note || null, req.user.id, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Meddelandet hittades inte' });
    }
    res.json({ message: 'Anteckning sparad', ...result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Note contact message error:', err);
    res.status(500).json({ error: 'Kunde inte spara anteckning' });
  }
});

// ─── PUT /api/admin/families/:id/name ───────────────────
router.put('/families/:id/name', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Familjenamn krävs' });
    }
    const trimmedName = name.trim();

    // Check for duplicate family name (excluding this family)
    const existing = await db.query(
      'SELECT id FROM family WHERE LOWER(name) = LOWER($1) AND id != $2',
      [trimmedName, req.params.id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'En familj med detta namn finns redan' });
    }

    const result = await db.query(
      'UPDATE family SET name = $1 WHERE id = $2 RETURNING id, name',
      [trimmedName, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Familjen hittades inte' });
    }
    res.json({ message: 'Familjenamn uppdaterat', family: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Update family name error:', err);
    res.status(500).json({ error: 'Kunde inte uppdatera familjenamn' });
  }
});

// ─── GET /api/admin/families (enhanced — grouped) ────────
// ?archived=true → show archived families; default → active only
router.get('/families-grouped', async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    const archiveFilter = showArchived
      ? 'WHERE f.archived_at IS NOT NULL'
      : 'WHERE f.archived_at IS NULL';

    const familyResult = await db.query(`
      SELECT f.id, f.name as family_name, f.created_at, f.archived_at,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', p.id, 'email', p.email, 'name', p.name,
          'verified', p.verified, 'is_admin', p.is_admin,
          'locked', COALESCE(p.locked, false), 'created_at', p.created_at
        )) FILTER (WHERE p.id IS NOT NULL), '[]') as parents,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', c.id, 'name', c.name, 'emoji', c.emoji,
          'username', c.username, 'birthday', c.birthday, 'created_at', c.created_at
        )) FILTER (WHERE c.id IS NOT NULL), '[]') as children
      FROM family f
      LEFT JOIN parent p ON p.family_id = f.id
      LEFT JOIN child c ON c.family_id = f.id
      ${archiveFilter}
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);

    res.json(familyResult.rows);
  } catch (err) {
    console.error('[ADMIN] Families grouped error:', err);
    res.status(500).json({ error: 'Kunde inte hämta familjer' });
  }
});

// ─── GET /api/admin/feature-flags ────────────────────────
router.get('/feature-flags', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT key, enabled, description, updated_at FROM feature_flag ORDER BY key ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[ADMIN] Feature flags error:', err);
    res.status(500).json({ error: 'Kunde inte hämta funktionsflaggor' });
  }
});

// ─── PUT /api/admin/feature-flags/:key ─────────────────
router.put('/feature-flags/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled krävs (boolean)' });
    }

    const result = await db.query(
      `UPDATE feature_flag
       SET enabled = $1, updated_at = NOW(), updated_by = $2
       WHERE key = $3
       RETURNING key, enabled, description, updated_at`,
      [enabled, req.user.id, key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Flaggan hittades inte' });
    }

    console.log(`[ADMIN] Feature flag "${key}" set to ${enabled} by admin ${req.user.id}`);
    res.json({ message: `Flaggan "${key}" har uppdaterats`, ...result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Update feature flag error:', err);
    res.status(500).json({ error: 'Kunde inte uppdatera funktionsflagga' });
  }
});

// ─── GET /api/admin/app-mode ───────────────────────────────
// Returns the current app mode: 'maintenance' | 'beta' | 'registration'
router.get('/app-mode', async (req, res) => {
  try {
    const result = await db.query(
      "SELECT key, enabled FROM feature_flag WHERE key IN ('maintenance_mode', 'registration_enabled', 'payment_mode')"
    );
    const flags = {};
    for (const row of result.rows) flags[row.key] = row.enabled;

    let mode = 'beta';
    if (flags.maintenance_mode) mode = 'maintenance';
    else if (flags.registration_enabled) mode = 'registration';

    res.json({ mode });
  } catch (err) {
    console.error('[ADMIN] App mode error:', err);
    res.status(500).json({ error: 'Kunde inte hämta appläge' });
  }
});

// ─── PUT /api/admin/app-mode ───────────────────────────────
// Sets the app mode atomically. mode: 'maintenance' | 'beta' | 'registration'
router.put('/app-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    const validModes = ['maintenance', 'beta', 'registration'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({ error: 'Ogiltigt läge. Välj: maintenance, beta eller registration' });
    }

    // Map mode → flag values
    const flagValues = {
      maintenance:  { maintenance_mode: true,  registration_enabled: false, payment_mode: false },
      beta:         { maintenance_mode: false, registration_enabled: false, payment_mode: false },
      registration: { maintenance_mode: false, registration_enabled: true,  payment_mode: false },
    }[mode];

    for (const [key, enabled] of Object.entries(flagValues)) {
      await db.query(
        `UPDATE feature_flag SET enabled = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3`,
        [enabled, req.user.id, key]
      );
    }

    console.log(`[ADMIN] App mode set to "${mode}" by admin ${req.user.id}`);
    res.json({ message: `Appläget är nu inställt på "${mode}"`, mode });
  } catch (err) {
    console.error('[ADMIN] Set app mode error:', err);
    res.status(500).json({ error: 'Kunde inte uppdatera appläget' });
  }
});

// ─── GET /api/admin/default-templates ─────────────────────
// Returns all default activity templates (the "default schema")
router.get('/default-templates', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM default_activity_template ORDER BY category_name, sort_order ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[ADMIN] List default templates error:', err);
    res.status(500).json({ error: 'Kunde inte hämta standardmallen' });
  }
});

// ─── POST /api/admin/default-templates ────────────────────
router.post('/default-templates', async (req, res) => {
  try {
    const { name, icon, category_name, star_value, sort_order } = req.body;
    if (!name || !category_name) {
      return res.status(400).json({ error: 'Namn och kategori krävs' });
    }
    const stars = parseInt(star_value, 10) || 1;
    const sort = parseInt(sort_order, 10) || 0;

    const result = await db.query(
      `INSERT INTO default_activity_template (name, icon, category_name, star_value, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), icon || '📌', category_name.trim(), stars, sort]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[ADMIN] Create default template error:', err);
    res.status(500).json({ error: 'Kunde inte skapa standardaktivitet' });
  }
});

// ─── PUT /api/admin/default-templates/reorder ─────────────
// IMPORTANT: This route MUST be defined before /:id to avoid Express matching "reorder" as a UUID
router.put('/default-templates/reorder', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array of { id, sort_order }' });
    }
    for (const item of order) {
      if (!item.id || typeof item.sort_order !== 'number') continue;
      await db.query(
        'UPDATE default_activity_template SET sort_order = $1 WHERE id = $2',
        [item.sort_order, item.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Default templates reorder error:', err);
    res.status(500).json({ error: 'Kunde inte ändra ordning' });
  }
});

// ─── PUT /api/admin/default-templates/:id ─────────────────
router.put('/default-templates/:id', async (req, res) => {
  try {
    const { name, icon, category_name, star_value, sort_order } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name.trim()); }
    if (icon !== undefined) { updates.push(`icon = $${idx++}`); values.push(icon); }
    if (category_name !== undefined) { updates.push(`category_name = $${idx++}`); values.push(category_name.trim()); }
    if (star_value !== undefined) { updates.push(`star_value = $${idx++}`); values.push(parseInt(star_value, 10) || 1); }
    if (sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); values.push(parseInt(sort_order, 10) || 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'Inget att uppdatera' });

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await db.query(
      `UPDATE default_activity_template SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[ADMIN] Update default template error:', err);
    res.status(500).json({ error: 'Kunde inte uppdatera standardaktivitet' });
  }
});

// ─── DELETE /api/admin/default-templates/:id ──────────────
router.delete('/default-templates/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM default_activity_template WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    res.json({ message: 'Standardaktivitet borttagen' });
  } catch (err) {
    console.error('[ADMIN] Delete default template error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort standardaktivitet' });
  }
});

// ─── PUT /api/admin/families/:id/archive ─────────────────
router.put('/families/:id/archive', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE family SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL RETURNING id, name',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Familjen hittades inte eller är redan arkiverad' });
    }
    console.log(`[ADMIN] Family ${req.params.id} archived by admin ${req.user.id}`);
    res.json({ message: 'Familjen har arkiverats', family: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Archive family error:', err);
    res.status(500).json({ error: 'Kunde inte arkivera familjen' });
  }
});

// ─── PUT /api/admin/families/:id/restore ─────────────────
router.put('/families/:id/restore', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE family SET archived_at = NULL WHERE id = $1 AND archived_at IS NOT NULL RETURNING id, name',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Familjen hittades inte eller är inte arkiverad' });
    }
    console.log(`[ADMIN] Family ${req.params.id} restored by admin ${req.user.id}`);
    res.json({ message: 'Familjen har återställts', family: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Restore family error:', err);
    res.status(500).json({ error: 'Kunde inte återställa familjen' });
  }
});

// ─── DELETE /api/admin/families/:id ──────────────────────
// Hard cascade delete — GDPR compliant, no data remains
router.delete('/families/:id', async (req, res) => {
  const client = await db.getClient();
  try {
    const familyId = req.params.id;

    await client.query('BEGIN');

    // Verify family exists
    const fam = await client.query('SELECT id, name FROM family WHERE id = $1', [familyId]);
    if (fam.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Familjen hittades inte' });
    }
    const familyName = fam.rows[0].name || familyId;

    // Delete all children and their dependent data
    const children = await client.query('SELECT id FROM child WHERE family_id = $1', [familyId]);
    for (const child of children.rows) {
      await client.query('DELETE FROM parent_note WHERE child_id = $1', [child.id]);
      await client.query('DELETE FROM streak WHERE child_id = $1', [child.id]);
      await client.query('DELETE FROM reward_redemption WHERE child_id = $1', [child.id]);
      // Delete ratings → daily_log_items → daily_logs (respecting FK order)
      await client.query(
        `DELETE FROM rating WHERE daily_log_item_id IN (
           SELECT dli.id FROM daily_log_item dli
           JOIN daily_log dl ON dl.id = dli.daily_log_id
           WHERE dl.child_id = $1
         )`, [child.id]);
      await client.query(
        `DELETE FROM daily_log_item WHERE daily_log_id IN (
           SELECT id FROM daily_log WHERE child_id = $1
         )`, [child.id]);
      await client.query('DELETE FROM daily_log WHERE child_id = $1', [child.id]);
      // Delete weekly_schedule_items → weekly_schedules
      await client.query(
        `DELETE FROM weekly_schedule_item WHERE weekly_schedule_id IN (
           SELECT id FROM weekly_schedule WHERE child_id = $1
         )`, [child.id]);
      await client.query('DELETE FROM weekly_schedule WHERE child_id = $1', [child.id]);
    }

    // Delete parent_child BEFORE children (FK: parent_child.child_id → child.id)
    await client.query(
      `DELETE FROM parent_child WHERE child_id IN (SELECT id FROM child WHERE family_id = $1)`, [familyId]);
    await client.query('DELETE FROM child WHERE family_id = $1', [familyId]);
    await client.query('DELETE FROM reward WHERE family_id = $1', [familyId]);

    // Delete all parents and their dependent data
    const parents = await client.query('SELECT id FROM parent WHERE family_id = $1', [familyId]);
    for (const parent of parents.rows) {
      await client.query('DELETE FROM notification_preference WHERE parent_id = $1', [parent.id]);
      await client.query('DELETE FROM email_verification WHERE parent_id = $1', [parent.id]);
      await client.query('DELETE FROM password_reset WHERE parent_id = $1', [parent.id]);
    }
    await client.query('DELETE FROM parent WHERE family_id = $1', [familyId]);

    // Delete family-level data: activity_templates → categories (FK order), invites
    await client.query('DELETE FROM activity_template WHERE family_id = $1', [familyId]);
    await client.query('DELETE FROM category WHERE family_id = $1', [familyId]);
    await client.query('DELETE FROM family_invite WHERE family_id = $1', [familyId]);

    // Finally delete the family
    await client.query('DELETE FROM family WHERE id = $1', [familyId]);

    await client.query('COMMIT');
    console.log(`[ADMIN] Family "${familyName}" (${familyId}) permanently deleted by admin ${req.user.id}`);
    res.json({ message: `Familjen "${familyName}" har tagits bort permanent` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ADMIN] Delete family error:', err);
    res.status(500).json({ error: 'Kunde inte ta bort familjen' });
  } finally {
    client.release();
  }
});

module.exports = router;
