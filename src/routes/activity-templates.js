const express = require('express');
const db = require('../lib/db');
const { requireParent } = require('../middleware/auth');
const { getSchoolVariant } = require('../lib/daily-log-generator');

const router = express.Router();
router.use(requireParent);

// Allowed icons — emoji set (child-friendly Twemoji-style) + Lucide keys prefixed with "lucide:"
const ALLOWED_ICONS = new Set([
  // Hygiene & morning
  '🪥', '🧼', '🚿', '🛁', '🚽', '🧴', '🪒', '💊', '🧻',
  // Food & drink
  '🍳', '🥣', '🥗', '🥪', '🍎', '🍌', '🥛', '🍞', '🍱', '🥤', '🍽️', '☕',
  // School & learning
  '📚', '✏️', '📝', '🎒', '📖', '🔬', '🖊️', '🏫', '📐', '🔢',
  // Play & creativity
  '🎨', '🎮', '🧩', '⚽', '🏀', '🎯', '🎭', '🎵', '🎸', '🪀', '🛝', '🎲',
  // Rest & sleep
  '😴', '🛏️', '📕', '🌙', '🧸', '🌟',
  // Nature & outdoors
  '🚴', '🏊', '🌳', '🏃', '🚶', '🌸', '🐕', '🌞',
  // Emotions & wellbeing
  '🧘', '❤️', '🤗', '💪', '🌈',
  // Chores
  '🧹', '🧺', '🗑️', '🌿', '🪴',
  // Transport
  '🚌', '🚗', '🚲',
  // Misc
  '⭐', '🏆', '🎉', '📱',
]);

function isValidIcon(icon) {
  if (!icon) return true; // icon is optional
  return ALLOWED_ICONS.has(icon);
}

// ─── GET /api/activity-templates ────────────────────────
// Optional query: ?child_id=UUID — if provided, filters out age-inappropriate school variants
router.get('/', async (req, res) => {
  try {
    const { child_id } = req.query;
    let childBirthday = null;

    // If child_id provided, fetch child's birthday for age-aware filtering
    if (child_id) {
      const childResult = await db.query(
        `SELECT c.birthday FROM child c
         JOIN parent_child pc ON pc.child_id = c.id
         WHERE pc.parent_id = $1 AND c.id = $2`,
        [req.user.id, child_id]
      );
      if (childResult.rows.length > 0) {
        childBirthday = childResult.rows[0].birthday;
      }
    }

    const schoolVariant = getSchoolVariant(childBirthday);
    // When child_id is provided, filter out the non-age-appropriate school variant
    const unwantedSchoolVariant = (child_id && childBirthday)
      ? (schoolVariant === 'Skola/Förskola' ? 'Skola' : 'Skola/Förskola')
      : null;

    let queryText = `
      SELECT at.id, at.name, at.icon, at.category_id, at.star_value, at.is_favorite,
             at.feedback_for, at.sort_order,
             c.name AS category_name, c.sort_order AS category_sort_order
      FROM activity_template at
      LEFT JOIN category c ON c.id = at.category_id
      WHERE at.family_id = $1`;

    const params = [req.user.familyId];

    if (unwantedSchoolVariant) {
      params.push(unwantedSchoolVariant);
      queryText += ` AND at.name != $${params.length}`;
    }

    queryText += ` ORDER BY c.sort_order ASC NULLS LAST, at.sort_order ASC, at.name ASC`;

    const result = await db.query(queryText, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[ACTIVITY-TEMPLATES] List error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── GET /api/activity-templates/icons ──────────────────
// Returns the allowed icon set for the frontend picker
router.get('/icons', async (req, res) => {
  res.json({ icons: Array.from(ALLOWED_ICONS) });
});

const VALID_FEEDBACK_FOR = new Set(['both', 'child', 'parent', 'none']);

// ─── POST /api/activity-templates ───────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, icon, category_id, star_value, is_favorite, feedback_for } = req.body;

    if (!name || name.trim().length < 1) {
      return res.status(400).json({ error: 'Aktivitetsnamn krävs' });
    }
    if (!isValidIcon(icon)) {
      return res.status(400).json({ error: 'Ogiltig ikon' });
    }
    const stars = parseInt(star_value, 10) || 1;
    if (stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'Stjärnvärde måste vara mellan 1 och 5' });
    }
    const feedbackFor = feedback_for && VALID_FEEDBACK_FOR.has(feedback_for) ? feedback_for : 'both';

    // Verify category belongs to family (if provided)
    if (category_id) {
      const cat = await db.query(
        'SELECT id FROM category WHERE id = $1 AND family_id = $2',
        [category_id, req.user.familyId]
      );
      if (cat.rows.length === 0) {
        return res.status(404).json({ error: 'Kategorin hittades inte' });
      }
    }

    const result = await db.query(
      `INSERT INTO activity_template (family_id, name, icon, category_id, star_value, is_favorite, feedback_for)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, icon, category_id, star_value, is_favorite, feedback_for`,
      [req.user.familyId, name.trim(), icon || null, category_id || null, stars, is_favorite ? true : false, feedbackFor]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[ACTIVITY-TEMPLATES] Create error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/activity-templates/reorder ─────────────────
// IMPORTANT: This route MUST be defined before /:id to avoid Express matching "reorder" as a UUID
router.put('/reorder', async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array of { id, sort_order }' });
    }
    for (const item of order) {
      if (!item.id || typeof item.sort_order !== 'number') continue;
      await db.query(
        'UPDATE activity_template SET sort_order = $1 WHERE id = $2 AND family_id = $3',
        [item.sort_order, item.id, req.user.familyId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[ACTIVITY-TEMPLATES] Reorder error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/activity-templates/:id ────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id FROM activity_template WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    }

    const { name, icon, category_id, star_value, is_favorite, feedback_for, sort_order } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (name.trim().length < 1) return res.status(400).json({ error: 'Aktivitetsnamn krävs' });
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (icon !== undefined) {
      if (!isValidIcon(icon)) return res.status(400).json({ error: 'Ogiltig ikon' });
      updates.push(`icon = $${idx++}`);
      values.push(icon || null);
    }
    if (category_id !== undefined) {
      if (category_id !== null) {
        const cat = await db.query(
          'SELECT id FROM category WHERE id = $1 AND family_id = $2',
          [category_id, req.user.familyId]
        );
        if (cat.rows.length === 0) return res.status(404).json({ error: 'Kategorin hittades inte' });
      }
      updates.push(`category_id = $${idx++}`);
      values.push(category_id);
    }
    if (star_value !== undefined) {
      const stars = parseInt(star_value, 10);
      if (stars < 1 || stars > 5) return res.status(400).json({ error: 'Stjärnvärde måste vara mellan 1 och 5' });
      updates.push(`star_value = $${idx++}`);
      values.push(stars);
    }
    if (is_favorite !== undefined) {
      updates.push(`is_favorite = $${idx++}`);
      values.push(Boolean(is_favorite));
    }
    if (feedback_for !== undefined) {
      if (!VALID_FEEDBACK_FOR.has(feedback_for)) return res.status(400).json({ error: 'Ogiltigt feedback_for-värde' });
      updates.push(`feedback_for = $${idx++}`);
      values.push(feedback_for);
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(parseInt(sort_order, 10) || 0);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Inget att uppdatera' });

    values.push(req.params.id);
    const result = await db.query(
      `UPDATE activity_template SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, icon, category_id, star_value, is_favorite, feedback_for`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[ACTIVITY-TEMPLATES] Update error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── DELETE /api/activity-templates/:id ─────────────────
router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id FROM activity_template WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    }

    // Check if template is used in any weekly schedule item
    const used = await db.query(
      'SELECT COUNT(*) FROM weekly_schedule_item WHERE activity_template_id = $1',
      [req.params.id]
    );
    if (parseInt(used.rows[0].count, 10) > 0) {
      return res.status(409).json({
        error: 'Aktiviteten används i ett eller flera veckoscheman. Ta bort den därifrån först.',
      });
    }

    await db.query('DELETE FROM activity_template WHERE id = $1', [req.params.id]);
    res.json({ message: 'Aktiviteten har tagits bort' });
  } catch (err) {
    console.error('[ACTIVITY-TEMPLATES] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = router;
