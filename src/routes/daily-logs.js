/**
 * Daily log API routes.
 *
 * GET  /api/children/:childId/daily-log?date=YYYY-MM-DD
 *      → Fetch (or generate on-demand) the daily log for a child on a given date.
 *
 * GET  /api/children/:childId/daily-logs?from=YYYY-MM-DD&to=YYYY-MM-DD
 *      → Fetch history of daily logs with item counts / completion stats.
 *
 * PUT  /api/daily-log-items/:itemId/complete
 *      → Mark an activity as completed (parent action).
 *
 * PUT  /api/daily-log-items/:itemId/uncomplete
 *      → Undo completion (parent action).
 *
 * PUT  /api/daily-logs/:logId/pause
 *      → Pause a day (e.g. sick day / holiday). Sets is_paused=true.
 *
 * PUT  /api/daily-logs/:logId/unpause
 *      → Un-pause a paused day.
 */

const express = require('express');
const db = require('../lib/db');
const { requireParent, requireChild } = require('../middleware/auth');
const { getOrGenerateDailyLog, getSchoolVariant } = require('../lib/daily-log-generator');

const router = express.Router();
router.use(requireParent);

// ─── Helpers ─────────────────────────────────────────────

/**
 * Verify parent has access to child. Returns child row or null.
 */
async function getChildAccess(parentId, childId) {
  const result = await db.query(
    'SELECT c.id, c.family_id, c.timezone, c.birthday FROM child c JOIN parent_child pc ON pc.child_id = c.id WHERE pc.parent_id = $1 AND c.id = $2',
    [parentId, childId]
  );
  return result.rows[0] || null;
}

/**
 * Verify parent has access to a daily_log (via child ownership).
 * Returns { log, childId } or null.
 */
async function getLogAccess(parentId, logId) {
  const result = await db.query(
    `SELECT dl.id, dl.child_id, dl.date, dl.is_paused, dl.generated_from, dl.created_at
     FROM daily_log dl
     JOIN child c ON c.id = dl.child_id
     JOIN parent_child pc ON pc.child_id = c.id
     WHERE pc.parent_id = $1 AND dl.id = $2`,
    [parentId, logId]
  );
  return result.rows[0] || null;
}

/**
 * Verify parent has access to a daily_log_item (via log → child → parent).
 * Returns the item row or null.
 */
async function getItemAccess(parentId, itemId) {
  const result = await db.query(
    `SELECT dli.id, dli.daily_log_id, dli.completed, dli.completed_at, dl.child_id, dl.is_paused
     FROM daily_log_item dli
     JOIN daily_log dl ON dl.id = dli.daily_log_id
     JOIN child c ON c.id = dl.child_id
     JOIN parent_child pc ON pc.child_id = c.id
     WHERE pc.parent_id = $1 AND dli.id = $2`,
    [parentId, itemId]
  );
  return result.rows[0] || null;
}

/**
 * Get section times from family settings for a child.
 */
async function getSectionTimes(childId) {
  const result = await db.query(
    `SELECT f.morning_start, f.morning_end, f.day_start, f.day_end,
            f.evening_start, f.evening_end, f.night_start, f.night_end
     FROM family f
     JOIN child c ON c.family_id = f.id
     WHERE c.id = $1`,
    [childId]
  );
  return result.rows[0] || {};
}

// ─── Routes ───────────────────────────────────────────────

/**
 * GET /api/children/:childId/daily-log?date=YYYY-MM-DD
 * Fetch (or generate on-demand) today's log for the child.
 * If date is omitted, defaults to child's local today.
 */
router.get('/:childId/daily-log', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    // Determine the date
    let dateStr = req.query.date;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // Default to child's local today
      const tz = child.timezone || 'Europe/Stockholm';
      dateStr = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
    }

    const { log, items, generated } = await getOrGenerateDailyLog(req.params.childId, dateStr);

    // Compute age-aware school variant for this child
    const schoolVariant = getSchoolVariant(child.birthday);

    // Add age_variant to each item for frontend display
    const itemsWithVariant = items.map(item => ({
      ...item,
      age_variant: (item.name === 'Skola/Förskola' || item.name === 'Skola')
        ? schoolVariant
        : null,
    }));

    // Group items by section
    const sections = {};
    for (const item of itemsWithVariant) {
      if (!sections[item.section]) sections[item.section] = [];
      sections[item.section].push(item);
    }

    const sectionTimes = await getSectionTimes(req.params.childId);

    res.json({
      log,
      child_birthday: child.birthday,
      age_variant: schoolVariant,
      items: itemsWithVariant,
      sections,
      section_times: sectionTimes,
      generated,
      total: itemsWithVariant.length,
      completed: itemsWithVariant.filter(i => i.completed).length,
    });
  } catch (err) {
    console.error('[DAILY-LOG] Get error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * GET /api/children/:childId/daily-logs?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Fetch history of daily logs in a date range.
 */
router.get('/:childId/daily-logs', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from och to krävs (YYYY-MM-DD)' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Ogiltigt datumformat. Använd YYYY-MM-DD.' });
    }

    // Limit range to max 90 days
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const diffDays = (toDate - fromDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 90) {
      return res.status(400).json({ error: 'Datumintervallet får inte överstiga 90 dagar' });
    }

    const result = await db.query(
      `SELECT dl.id, dl.date, dl.is_paused, dl.generated_from, dl.created_at,
              COUNT(dli.id) AS total_items,
              COUNT(CASE WHEN dli.completed THEN 1 END) AS completed_items
       FROM daily_log dl
       LEFT JOIN daily_log_item dli ON dli.daily_log_id = dl.id
       WHERE dl.child_id = $1 AND dl.date >= $2 AND dl.date <= $3
       GROUP BY dl.id
       ORDER BY dl.date DESC`,
      [req.params.childId, from, to]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[DAILY-LOG] History error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ────────────────────────────────────────────────────────────
// Item-level routes (mounted at /api/daily-log-items)
// ────────────────────────────────────────────────────────────

const itemRouter = express.Router();
itemRouter.use(requireParent);

/**
 * PUT /api/daily-log-items/reorder
 * Parent reorders activities in a child's daily log.
 * Body: { ordered_item_ids: string[] }
 * IMPORTANT: This route MUST be defined before /:itemId to avoid Express matching "reorder" as a UUID
 */
itemRouter.put('/reorder', async (req, res) => {
  try {
    const { ordered_item_ids } = req.body;
    if (!Array.isArray(ordered_item_ids) || ordered_item_ids.length === 0) {
      return res.status(400).json({ error: 'ordered_item_ids must be a non-empty array' });
    }

    // Verify parent has access to the first item (all items should be in the same log)
    const firstItem = await getItemAccess(req.user.id, ordered_item_ids[0]);
    if (!firstItem) return res.status(403).json({ error: 'Du har inte åtkomst till dessa aktiviteter' });

    // Update sort_order for each item
    for (let i = 0; i < ordered_item_ids.length; i++) {
      await db.query(
        'UPDATE daily_log_item SET sort_order = $1 WHERE id = $2 AND daily_log_id = $3',
        [i, ordered_item_ids[i], firstItem.daily_log_id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[DAILY-LOG-ITEM] Parent reorder error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/daily-log-items/:itemId/complete
 * Mark an activity as completed.
 */
itemRouter.put('/:itemId/complete', async (req, res) => {
  try {
    const item = await getItemAccess(req.user.id, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Aktiviteten hittades inte' });

    const result = await db.query(
      `UPDATE daily_log_item
       SET completed = true, completed_at = NOW()
       WHERE id = $1
       RETURNING id, completed, completed_at`,
      [req.params.itemId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG-ITEM] Complete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/daily-log-items/:itemId/uncomplete
 * Undo completion of an activity.
 */
itemRouter.put('/:itemId/uncomplete', async (req, res) => {
  try {
    const item = await getItemAccess(req.user.id, req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Aktiviteten hittades inte' });

    const result = await db.query(
      `UPDATE daily_log_item
       SET completed = false, completed_at = NULL
       WHERE id = $1
       RETURNING id, completed, completed_at`,
      [req.params.itemId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG-ITEM] Uncomplete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ────────────────────────────────────────────────────────────
// Log-level routes (mounted at /api/daily-logs)
// ────────────────────────────────────────────────────────────

const logRouter = express.Router();
logRouter.use(requireParent);

/**
 * PUT /api/daily-logs/:logId/pause
 * Pause a day (sick day / holiday).
 */
logRouter.put('/:logId/pause', async (req, res) => {
  try {
    const log = await getLogAccess(req.user.id, req.params.logId);
    if (!log) return res.status(404).json({ error: 'Dagloggen hittades inte' });

    const result = await db.query(
      `UPDATE daily_log SET is_paused = true WHERE id = $1 RETURNING id, date, is_paused`,
      [req.params.logId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG] Pause error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/daily-logs/:logId/unpause
 * Un-pause a day.
 */
logRouter.put('/:logId/unpause', async (req, res) => {
  try {
    const log = await getLogAccess(req.user.id, req.params.logId);
    if (!log) return res.status(404).json({ error: 'Dagloggen hittades inte' });

    const result = await db.query(
      `UPDATE daily_log SET is_paused = false WHERE id = $1 RETURNING id, date, is_paused`,
      [req.params.logId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG] Unpause error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ────────────────────────────────────────────────────────────
// Child self-access routes (mounted at /api/children/me)
// Children can fetch their own daily log and mark items as done.
// ────────────────────────────────────────────────────────────

const childSelfRouter = express.Router();
childSelfRouter.use(requireChild);

/**
 * GET /api/children/me/daily-log?date=YYYY-MM-DD
 * Fetch (or generate on-demand) today's log for the authenticated child.
 */
childSelfRouter.get('/daily-log', async (req, res) => {
  try {
    const childId = req.user.id;

    // Determine the date
    let dateStr = req.query.date;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const tzResult = await db.query('SELECT timezone FROM child WHERE id = $1', [childId]);
      const tz = (tzResult.rows[0] && tzResult.rows[0].timezone) || 'Europe/Stockholm';
      dateStr = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
    }

    // Get child's allow_child_reorder setting for UI flag
    const childResult = await db.query(
      'SELECT allow_child_reorder FROM child WHERE id = $1',
      [childId]
    );
    const allowChildReorder = childResult.rows[0]?.allow_child_reorder || false;

    const { log, items, generated } = await getOrGenerateDailyLog(childId, dateStr);

    // Group items by section
    const sections = {};
    for (const item of items) {
      if (!sections[item.section]) sections[item.section] = [];
      sections[item.section].push(item);
    }

    const sectionTimes = await getSectionTimes(childId);

    res.json({
      log,
      allow_child_reorder: allowChildReorder,
      items,
      sections,
      section_times: sectionTimes,
      generated,
      total: items.length,
      completed: items.filter(i => i.completed).length,
    });
  } catch (err) {
    console.error('[DAILY-LOG-CHILD] Get error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/children/me/daily-log-items/:itemId/complete
 * Child marks an activity as completed.
 */
childSelfRouter.put('/daily-log-items/:itemId/complete', async (req, res) => {
  try {
    // Verify the item belongs to this child
    const itemResult = await db.query(
      `SELECT dli.id, dli.daily_log_id, dli.completed, dl.child_id, dl.is_paused
       FROM daily_log_item dli
       JOIN daily_log dl ON dl.id = dli.daily_log_id
       WHERE dli.id = $1 AND dl.child_id = $2`,
      [req.params.itemId, req.user.id]
    );
    const item = itemResult.rows[0];
    if (!item) return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    if (item.is_paused) return res.status(400).json({ error: 'Dagen är pausad' });

    const result = await db.query(
      `UPDATE daily_log_item
       SET completed = true, completed_at = NOW()
       WHERE id = $1
       RETURNING id, completed, completed_at`,
      [req.params.itemId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG-CHILD] Complete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/me/daily-log/reorder
 * Child reorders activities in their daily log.
 * Accepts: { ordered_item_ids: string[] } — new order of item IDs (within same log)
 *
 * Saves child_sort_order for each item. This is separate from the parent's
 * schedule sort_order, so children's custom ordering doesn't affect the template.
 */
childSelfRouter.put('/daily-log/reorder', async (req, res) => {
  try {
    const { ordered_item_ids } = req.body;
    if (!Array.isArray(ordered_item_ids) || ordered_item_ids.length === 0) {
      return res.status(400).json({ error: 'ordered_item_ids must be a non-empty array' });
    }

    const childId = req.user.id;

    // Verify first item belongs to this child's daily log
    const firstItem = await db.query(
      `SELECT dli.id, dl.id AS log_id
       FROM daily_log_item dli
       JOIN daily_log dl ON dl.id = dli.daily_log_id
       WHERE dli.id = $1 AND dl.child_id = $2`,
      [ordered_item_ids[0], childId]
    );
    if (firstItem.rows.length === 0) {
      return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    }
    const logId = firstItem.rows[0].log_id;

    // Verify all items are in the same log and belong to this child
    const validItems = await db.query(
      `SELECT dli.id
       FROM daily_log_item dli
       JOIN daily_log dl ON dl.id = dli.daily_log_id
       WHERE dl.id = $1 AND dl.child_id = $2`,
      [logId, childId]
    );
    const validIds = new Set(validItems.rows.map(r => r.id));
    for (const id of ordered_item_ids) {
      if (!validIds.has(id)) {
        return res.status(400).json({ error: 'Ogiltigt aktivitets-ID i listan' });
      }
    }

    // Update child_sort_order for each item in a transaction
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ordered_item_ids.length; i++) {
        await client.query(
          'UPDATE daily_log_item SET child_sort_order = $1 WHERE id = $2 AND daily_log_id = $3',
          [i, ordered_item_ids[i], logId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: 'Ordning sparad' });
  } catch (err) {
    console.error('[DAILY-LOG-CHILD] Reorder error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

/**
 * PUT /api/children/me/daily-log-items/:itemId/uncomplete
 * Child undoes completion of an activity.
 */
childSelfRouter.put('/daily-log-items/:itemId/uncomplete', async (req, res) => {
  try {
    const itemResult = await db.query(
      `SELECT dli.id, dl.child_id
       FROM daily_log_item dli
       JOIN daily_log dl ON dl.id = dli.daily_log_id
       WHERE dli.id = $1 AND dl.child_id = $2`,
      [req.params.itemId, req.user.id]
    );
    const item = itemResult.rows[0];
    if (!item) return res.status(404).json({ error: 'Aktiviteten hittades inte' });

    const result = await db.query(
      `UPDATE daily_log_item
       SET completed = false, completed_at = NULL
       WHERE id = $1
       RETURNING id, completed, completed_at`,
      [req.params.itemId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[DAILY-LOG-CHILD] Uncomplete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = { childRouter: router, itemRouter, logRouter, childSelfRouter };
