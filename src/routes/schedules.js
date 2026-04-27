/**
 * Weekly schedule routes.
 *
 * GET    /api/children/:childId/schedules              — list all 7-day schedules for child
 * GET    /api/children/:childId/schedules/:dayOfWeek   — get schedule for specific day (0=sun,1=mon…)
 * POST   /api/children/:childId/schedules              — create schedule for a day
 * DELETE /api/children/:childId/schedules/:scheduleId  — delete schedule (and all items)
 * POST   /api/children/:childId/schedules/copy-day     — copy one day → other days
 * POST   /api/children/:childId/schedules/copy-to-child — copy all schedules to another child
 *
 * GET    /api/schedules/:scheduleId/items              — list items in schedule
 * POST   /api/schedules/:scheduleId/items              — add item to schedule
 * PUT    /api/schedules/:scheduleId/items/:itemId      — update item (sort_order, times, section)
 * DELETE /api/schedules/:scheduleId/items/:itemId      — remove item from schedule
 * PUT    /api/schedules/:scheduleId/items/reorder      — bulk reorder items in schedule
 */

const express = require('express');
const db = require('../lib/db');
const { requireParent } = require('../middleware/auth');
const { getSchoolVariant } = require('../lib/daily-log-generator');

const childRouter = express.Router({ mergeParams: true });
const scheduleRouter = express.Router({ mergeParams: true });

childRouter.use(requireParent);
scheduleRouter.use(requireParent);

// ─── Helpers ─────────────────────────────────────────────

/**
 * Verify parent has access to child (any role).
 * Returns the child row or null.
 */
async function getChildAccess(parentId, childId) {
  const result = await db.query(
    'SELECT c.id, c.family_id FROM child c JOIN parent_child pc ON pc.child_id = c.id WHERE pc.parent_id = $1 AND c.id = $2',
    [parentId, childId]
  );
  return result.rows[0] || null;
}

/**
 * Verify parent owns the schedule (via child access).
 * Returns the schedule row or null.
 */
async function getScheduleAccess(parentId, scheduleId) {
  const result = await db.query(
    `SELECT ws.id, ws.child_id, ws.day_of_week, ws.sort_order
     FROM weekly_schedule ws
     JOIN child c ON c.id = ws.child_id
     JOIN parent_child pc ON pc.child_id = c.id
     WHERE pc.parent_id = $1 AND ws.id = $2`,
    [parentId, scheduleId]
  );
  return result.rows[0] || null;
}

/**
 * Determine section based on start_time and family settings.
 * Falls back to 'dag' if times don't match.
 */
function determineSection(startTime, familySettings) {
  if (!startTime) return 'dag';
  const [h, m] = startTime.split(':').map(Number);
  const mins = h * 60 + m;

  function timeToMins(t) {
    const [th, tm] = (t || '00:00').split(':').map(Number);
    return th * 60 + tm;
  }

  const morningStart = timeToMins(familySettings.morning_start || '06:00');
  const morningEnd = timeToMins(familySettings.morning_end || '09:00');
  const dayStart = timeToMins(familySettings.day_start || '09:00');
  const dayEnd = timeToMins(familySettings.day_end || '16:00');
  const eveningStart = timeToMins(familySettings.evening_start || '16:00');
  const eveningEnd = timeToMins(familySettings.evening_end || '21:00');

  if (mins >= morningStart && mins < morningEnd) return 'morgon';
  if (mins >= dayStart && mins < dayEnd) return 'dag';
  if (mins >= eveningStart && mins < eveningEnd) return 'kvall';
  return 'natt';
}

// ─── Child-scoped schedule routes ────────────────────────

// GET /api/children/:childId/schedules
childRouter.get('/', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const schedules = await db.query(
      `SELECT ws.id, ws.day_of_week, ws.sort_order,
              COUNT(wsi.id) AS item_count
       FROM weekly_schedule ws
       LEFT JOIN weekly_schedule_item wsi ON wsi.weekly_schedule_id = ws.id
       WHERE ws.child_id = $1
       GROUP BY ws.id
       ORDER BY ws.day_of_week ASC`,
      [req.params.childId]
    );
    res.json(schedules.rows);
  } catch (err) {
    console.error('[SCHEDULES] List error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules
// Body: { day_of_week: 0-6 }
// Auto-populates new schedule with existing activity templates
childRouter.post('/', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { day_of_week } = req.body;
    if (day_of_week === undefined || day_of_week === null) {
      return res.status(400).json({ error: 'Veckodag krävs (0=sön, 1=mån, … 6=lör)' });
    }
    const dow = parseInt(day_of_week, 10);
    if (isNaN(dow) || dow < 0 || dow > 6) {
      return res.status(400).json({ error: 'Veckodag måste vara ett tal 0–6' });
    }

    // Check for existing
    const existing = await db.query(
      'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
      [req.params.childId, dow]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Det finns redan ett schema för den veckodagen', id: existing.rows[0].id });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Create schedule
      const result = await client.query(
        `INSERT INTO weekly_schedule (child_id, day_of_week, sort_order)
         VALUES ($1, $2, $3)
         RETURNING id, child_id, day_of_week, sort_order`,
        [req.params.childId, dow, dow]
      );
      const schedule = result.rows[0];

      // Get family_id from child
      const familyResult = await client.query('SELECT family_id FROM child WHERE id = $1', [req.params.childId]);
      const familyId = familyResult.rows[0]?.family_id;
      if (familyId) {
        // Fetch activity templates with their category for section mapping
        const templates = await client.query(
          `SELECT at.id, at.name, at.icon, at.star_value, c.name AS category_name, c.sort_order AS category_sort
           FROM activity_template at
           LEFT JOIN category c ON c.id = at.category_id
           WHERE at.family_id = $1
           ORDER BY c.sort_order ASC, at.name ASC`,
          [familyId]
        );

        // Map category names to schedule sections
        const categoryToSection = {
          'Morgonrutin': 'morgon',
          'Morgon': 'morgon',
          'Skola/Fritid': 'dag',
          'Förmiddag': 'dag',
          'Eftermiddag': 'dag',
          'Kvällsrutin': 'kvall',
          'Kväll': 'kvall',
        };

        // Sequential sort_order within each section (0, 1, 2, ...)
        const sectionCounters = {};

        for (const tpl of templates.rows) {
          const sec = categoryToSection[tpl.category_name] || 'dag';
          if (!(sec in sectionCounters)) sectionCounters[sec] = 0;
          const sortOrder = sectionCounters[sec]++;

          await client.query(
            `INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section)
             VALUES ($1, $2, NULL, NULL, $3, $4)`,
            [schedule.id, tpl.id, sortOrder, sec]
          );
        }
      }

      await client.query('COMMIT');

      res.status(201).json(schedule);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] Create error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// DELETE /api/children/:childId/schedules/:scheduleId
childRouter.delete('/:scheduleId', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const schedule = await db.query(
      'SELECT id FROM weekly_schedule WHERE id = $1 AND child_id = $2',
      [req.params.scheduleId, req.params.childId]
    );
    if (schedule.rows.length === 0) {
      return res.status(404).json({ error: 'Schemat hittades inte' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [req.params.scheduleId]);
      await client.query('DELETE FROM weekly_schedule WHERE id = $1', [req.params.scheduleId]);
      await client.query('COMMIT');
      res.json({ message: 'Schemat har tagits bort' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules/copy-day
// Body: { from_day: 1, to_days: [2,3,4,5] }
childRouter.post('/copy-day', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { from_day, to_days } = req.body;
    if (from_day === undefined || !Array.isArray(to_days) || to_days.length === 0) {
      return res.status(400).json({ error: 'from_day och to_days[] krävs' });
    }

    const fromDow = parseInt(from_day, 10);
    if (isNaN(fromDow) || fromDow < 0 || fromDow > 6) {
      return res.status(400).json({ error: 'from_day måste vara 0–6' });
    }

    // Get source schedule
    const sourceResult = await db.query(
      'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
      [req.params.childId, fromDow]
    );
    if (sourceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Inget schema finns för den angivna veckodagen' });
    }
    const sourceId = sourceResult.rows[0].id;

    // Get source items
    const itemsResult = await db.query(
      'SELECT activity_template_id, start_time, end_time, sort_order, section FROM weekly_schedule_item WHERE weekly_schedule_id = $1 ORDER BY sort_order ASC',
      [sourceId]
    );
    const sourceItems = itemsResult.rows;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const results = [];
      for (const toDow of to_days) {
        const dow = parseInt(toDow, 10);
        if (isNaN(dow) || dow < 0 || dow > 6) continue;
        if (dow === fromDow) continue;

        // Get or create target schedule
        let targetScheduleId;
        const existingTarget = await client.query(
          'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
          [req.params.childId, dow]
        );
        if (existingTarget.rows.length > 0) {
          targetScheduleId = existingTarget.rows[0].id;
          // Clear existing items
          await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [targetScheduleId]);
        } else {
          const newSchedule = await client.query(
            'INSERT INTO weekly_schedule (child_id, day_of_week, sort_order) VALUES ($1, $2, $3) RETURNING id',
            [req.params.childId, dow, dow]
          );
          targetScheduleId = newSchedule.rows[0].id;
        }

        // Copy items
        for (const item of sourceItems) {
          await client.query(
            'INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section) VALUES ($1, $2, $3, $4, $5, $6)',
            [targetScheduleId, item.activity_template_id, item.start_time, item.end_time, item.sort_order, item.section]
          );
        }
        results.push(dow);
      }

      await client.query('COMMIT');
      res.json({ message: `Schema kopierat till ${results.length} dag(ar)`, copied_to_days: results });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] Copy-day error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules/copy-to-child
// Body: { target_child_id: UUID }
childRouter.post('/copy-to-child', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { target_child_id } = req.body;
    if (!target_child_id) return res.status(400).json({ error: 'target_child_id krävs' });
    if (target_child_id === req.params.childId) return res.status(400).json({ error: 'Kan inte kopiera till samma barn' });

    const targetChild = await getChildAccess(req.user.id, target_child_id);
    if (!targetChild) return res.status(403).json({ error: 'Du har inte åtkomst till målbarnet' });

    // Get all source schedules + items
    const schedulesResult = await db.query(
      'SELECT id, day_of_week, sort_order FROM weekly_schedule WHERE child_id = $1',
      [req.params.childId]
    );

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      for (const srcSchedule of schedulesResult.rows) {
        // Get items for this schedule
        const itemsResult = await client.query(
          'SELECT activity_template_id, start_time, end_time, sort_order, section FROM weekly_schedule_item WHERE weekly_schedule_id = $1 ORDER BY sort_order ASC',
          [srcSchedule.id]
        );

        // Get or create target schedule
        let targetScheduleId;
        const existingTarget = await client.query(
          'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
          [target_child_id, srcSchedule.day_of_week]
        );
        if (existingTarget.rows.length > 0) {
          targetScheduleId = existingTarget.rows[0].id;
          await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [targetScheduleId]);
        } else {
          const newSchedule = await client.query(
            'INSERT INTO weekly_schedule (child_id, day_of_week, sort_order) VALUES ($1, $2, $3) RETURNING id',
            [target_child_id, srcSchedule.day_of_week, srcSchedule.sort_order]
          );
          targetScheduleId = newSchedule.rows[0].id;
        }

        // Copy items
        for (const item of itemsResult.rows) {
          await client.query(
            'INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section) VALUES ($1, $2, $3, $4, $5, $6)',
            [targetScheduleId, item.activity_template_id, item.start_time, item.end_time, item.sort_order, item.section]
          );
        }
      }

      await client.query('COMMIT');
      res.json({ message: 'Hela veckoschemat har kopierats till det andra barnet' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] Copy-to-child error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── Schedule-item routes ─────────────────────────────────

// GET /api/schedules/:scheduleId/items
scheduleRouter.get('/', async (req, res) => {
  try {
    const schedule = await getScheduleAccess(req.user.id, req.params.scheduleId);
    if (!schedule) return res.status(403).json({ error: 'Du har inte åtkomst till detta schema' });

    const items = await db.query(
      `SELECT wsi.id, wsi.activity_template_id, wsi.start_time, wsi.end_time, wsi.sort_order, wsi.section,
              at.name AS activity_name, at.icon AS activity_icon, at.star_value
       FROM weekly_schedule_item wsi
       JOIN activity_template at ON at.id = wsi.activity_template_id
       WHERE wsi.weekly_schedule_id = $1
       ORDER BY wsi.section, wsi.sort_order ASC`,
      [req.params.scheduleId]
    );

    // Also return family section time settings and child's birthday for age-aware filtering
    const familyResult = await db.query(
      `SELECT f.morning_start, f.morning_end, f.day_start, f.day_end, f.evening_start, f.evening_end,
              f.night_start, f.night_end, c.birthday
       FROM family f
       JOIN child c ON c.family_id = f.id
       WHERE c.id = $1`,
      [schedule.child_id]
    );

    const familyData = familyResult.rows[0] || {};
    const birthday = familyData.birthday;
    const schoolVariant = getSchoolVariant(birthday);

    // Apply age-aware display names for school-related activities
    const ageAwareItems = items.rows.map(item => {
      const activityName = item.activity_name;
      // If this is the non-age-appropriate school variant, rename to the correct one
      if ((activityName === 'Skola/Förskola' || activityName === 'Skola') &&
          activityName !== schoolVariant) {
        return {
          ...item,
          activity_name_display: schoolVariant,
          age_variant: schoolVariant,
        };
      }
      return {
        ...item,
        activity_name_display: activityName,
        age_variant: activityName === 'Skola/Förskola' || activityName === 'Skola' ? schoolVariant : null,
      };
    });

    res.json({
      schedule_id: req.params.scheduleId,
      day_of_week: schedule.day_of_week,
      child_birthday: birthday,
      age_variant: schoolVariant,
      items: ageAwareItems,
      section_times: {
        morning_start: familyData.morning_start,
        morning_end: familyData.morning_end,
        day_start: familyData.day_start,
        day_end: familyData.day_end,
        evening_start: familyData.evening_start,
        evening_end: familyData.evening_end,
        night_start: familyData.night_start,
        night_end: familyData.night_end,
      },
    });
  } catch (err) {
    console.error('[SCHEDULE-ITEMS] List error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/schedules/:scheduleId/items
// Body: { activity_template_id, start_time?, end_time?, sort_order?, section? }
scheduleRouter.post('/', async (req, res) => {
  try {
    const schedule = await getScheduleAccess(req.user.id, req.params.scheduleId);
    if (!schedule) return res.status(403).json({ error: 'Du har inte åtkomst till detta schema' });

    const { activity_template_id, start_time, end_time, sort_order, section } = req.body;
    if (!activity_template_id) return res.status(400).json({ error: 'activity_template_id krävs' });

    // Verify template belongs to family
    const familyResult = await db.query(
      'SELECT f.id FROM family f JOIN child c ON c.family_id = f.id WHERE c.id = $1',
      [schedule.child_id]
    );
    const familyId = familyResult.rows[0]?.id;

    const template = await db.query(
      'SELECT id FROM activity_template WHERE id = $1 AND family_id = $2',
      [activity_template_id, familyId]
    );
    if (template.rows.length === 0) return res.status(404).json({ error: 'Aktivitetsmallen hittades inte' });

    // Get max sort_order
    const maxResult = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM weekly_schedule_item WHERE weekly_schedule_id = $1',
      [req.params.scheduleId]
    );
    const nextOrder = sort_order !== undefined ? sort_order : maxResult.rows[0].next_order;

    // Auto-determine section from start_time if not provided
    const familySettings = await db.query(
      'SELECT morning_start, morning_end, day_start, day_end, evening_start, evening_end FROM family f JOIN child c ON c.family_id = f.id WHERE c.id = $1',
      [schedule.child_id]
    );
    const detectedSection = section || determineSection(start_time, familySettings.rows[0] || {});

    const result = await db.query(
      `INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section`,
      [req.params.scheduleId, activity_template_id, start_time || null, end_time || null, nextOrder, detectedSection]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[SCHEDULE-ITEMS] Create error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// PUT /api/schedules/:scheduleId/items/reorder
// Body: { order: [{ id: UUID, sort_order: int }] }
// IMPORTANT: This route MUST be defined before /:itemId to avoid Express matching "reorder" as a UUID
scheduleRouter.put('/reorder', async (req, res) => {
  try {
    const schedule = await getScheduleAccess(req.user.id, req.params.scheduleId);
    if (!schedule) return res.status(403).json({ error: 'Du har inte åtkomst till detta schema' });

    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order[] krävs' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const { id, sort_order, section } of order) {
        if (!id) continue;
        const updates = [];
        const vals = [];
        let idx = 1;
        if (sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); vals.push(sort_order); }
        if (section !== undefined) { updates.push(`section = $${idx++}`); vals.push(section); }
        if (updates.length > 0) {
          vals.push(id, req.params.scheduleId);
          await client.query(
            `UPDATE weekly_schedule_item SET ${updates.join(', ')} WHERE id = $${idx++} AND weekly_schedule_id = $${idx}`,
            vals
          );
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Sorteringsordning uppdaterad' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULE-ITEMS] Reorder error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// PUT /api/schedules/:scheduleId/items/:itemId
scheduleRouter.put('/:itemId', async (req, res) => {
  try {
    const schedule = await getScheduleAccess(req.user.id, req.params.scheduleId);
    if (!schedule) return res.status(403).json({ error: 'Du har inte åtkomst till detta schema' });

    const existing = await db.query(
      'SELECT id FROM weekly_schedule_item WHERE id = $1 AND weekly_schedule_id = $2',
      [req.params.itemId, req.params.scheduleId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Aktiviteten hittades inte i schemat' });

    const { start_time, end_time, sort_order, section, activity_template_id } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (start_time !== undefined) { updates.push(`start_time = $${idx++}`); values.push(start_time || null); }
    if (end_time !== undefined) { updates.push(`end_time = $${idx++}`); values.push(end_time || null); }
    if (sort_order !== undefined) { updates.push(`sort_order = $${idx++}`); values.push(sort_order); }
    if (section !== undefined) {
      const validSections = ['morgon', 'dag', 'kvall', 'natt'];
      if (!validSections.includes(section)) return res.status(400).json({ error: 'Ogiltig sektion (morgon/dag/kvall/natt)' });
      updates.push(`section = $${idx++}`);
      values.push(section);
    }
    if (activity_template_id !== undefined) {
      updates.push(`activity_template_id = $${idx++}`);
      values.push(activity_template_id);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Inget att uppdatera' });

    values.push(req.params.itemId);
    const result = await db.query(
      `UPDATE weekly_schedule_item SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[SCHEDULE-ITEMS] Update error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// DELETE /api/schedules/:scheduleId/items/:itemId
scheduleRouter.delete('/:itemId', async (req, res) => {
  try {
    const schedule = await getScheduleAccess(req.user.id, req.params.scheduleId);
    if (!schedule) return res.status(403).json({ error: 'Du har inte åtkomst till detta schema' });

    const result = await db.query(
      'DELETE FROM weekly_schedule_item WHERE id = $1 AND weekly_schedule_id = $2 RETURNING id',
      [req.params.itemId, req.params.scheduleId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Aktiviteten hittades inte i schemat' });

    res.json({ message: 'Aktiviteten har tagits bort från schemat' });
  } catch (err) {
    console.error('[SCHEDULE-ITEMS] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules/copy-item-to-day
// Copy a single schedule item to another day
// Body: { item_id: UUID, from_schedule_id: UUID, to_day: 0-6 }
childRouter.post('/copy-item-to-day', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { item_id, from_schedule_id, to_day } = req.body;
    if (!item_id || !from_schedule_id || to_day === undefined) {
      return res.status(400).json({ error: 'item_id, from_schedule_id, to_day krävs' });
    }
    const toDow = parseInt(to_day, 10);
    if (isNaN(toDow) || toDow < 0 || toDow > 6) {
      return res.status(400).json({ error: 'to_day måste vara 0–6' });
    }

    // Get source item (verify it belongs to this child)
    const itemResult = await db.query(
      `SELECT wsi.* FROM weekly_schedule_item wsi
       JOIN weekly_schedule ws ON ws.id = wsi.weekly_schedule_id
       WHERE wsi.id = $1 AND wsi.weekly_schedule_id = $2 AND ws.child_id = $3`,
      [item_id, from_schedule_id, req.params.childId]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    }
    const item = itemResult.rows[0];

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Get or create target day schedule
      let targetScheduleId;
      const existingTarget = await client.query(
        'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
        [req.params.childId, toDow]
      );
      if (existingTarget.rows.length > 0) {
        targetScheduleId = existingTarget.rows[0].id;
      } else {
        const newSchedule = await client.query(
          'INSERT INTO weekly_schedule (child_id, day_of_week, sort_order) VALUES ($1, $2, $3) RETURNING id',
          [req.params.childId, toDow, toDow]
        );
        targetScheduleId = newSchedule.rows[0].id;
      }

      // Check for duplicate (same activity already in target day)
      const existingItem = await client.query(
        'SELECT id FROM weekly_schedule_item WHERE weekly_schedule_id = $1 AND activity_template_id = $2',
        [targetScheduleId, item.activity_template_id]
      );
      if (existingItem.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.json({ message: 'Aktiviteten finns redan den dagen', schedule_id: targetScheduleId, skipped: true });
      }

      // Get next sort_order
      const maxResult = await client.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM weekly_schedule_item WHERE weekly_schedule_id = $1',
        [targetScheduleId]
      );
      const nextOrder = maxResult.rows[0].next_order;

      const result = await client.query(
        `INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [targetScheduleId, item.activity_template_id, item.start_time, item.end_time, nextOrder, item.section]
      );
      await client.query('COMMIT');
      res.json({ message: 'Aktiviteten kopierades', item_id: result.rows[0].id, schedule_id: targetScheduleId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] copy-item-to-day error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules/copy-item-to-child
// Copy a single schedule item to another child's schedule day
// Body: { item_id: UUID, from_schedule_id: UUID, to_child_id: UUID, to_day: 0-6 }
childRouter.post('/copy-item-to-child', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { item_id, from_schedule_id, to_child_id, to_day } = req.body;
    if (!item_id || !from_schedule_id || !to_child_id || to_day === undefined) {
      return res.status(400).json({ error: 'item_id, from_schedule_id, to_child_id, to_day krävs' });
    }
    const toDow = parseInt(to_day, 10);
    if (isNaN(toDow) || toDow < 0 || toDow > 6) {
      return res.status(400).json({ error: 'to_day måste vara 0–6' });
    }

    // Verify access to target child
    const targetChild = await getChildAccess(req.user.id, to_child_id);
    if (!targetChild) return res.status(403).json({ error: 'Du har inte åtkomst till målbarnet' });

    // Get source item
    const itemResult = await db.query(
      `SELECT wsi.* FROM weekly_schedule_item wsi
       JOIN weekly_schedule ws ON ws.id = wsi.weekly_schedule_id
       WHERE wsi.id = $1 AND wsi.weekly_schedule_id = $2 AND ws.child_id = $3`,
      [item_id, from_schedule_id, req.params.childId]
    );
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Aktiviteten hittades inte' });
    }
    const item = itemResult.rows[0];

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      let targetScheduleId;
      const existingTarget = await client.query(
        'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
        [to_child_id, toDow]
      );
      if (existingTarget.rows.length > 0) {
        targetScheduleId = existingTarget.rows[0].id;
      } else {
        const newSchedule = await client.query(
          'INSERT INTO weekly_schedule (child_id, day_of_week, sort_order) VALUES ($1, $2, $3) RETURNING id',
          [to_child_id, toDow, toDow]
        );
        targetScheduleId = newSchedule.rows[0].id;
      }

      // Check for duplicate
      const existingItem = await client.query(
        'SELECT id FROM weekly_schedule_item WHERE weekly_schedule_id = $1 AND activity_template_id = $2',
        [targetScheduleId, item.activity_template_id]
      );
      if (existingItem.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.json({ message: 'Aktiviteten finns redan', schedule_id: targetScheduleId, skipped: true });
      }

      const maxResult = await client.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM weekly_schedule_item WHERE weekly_schedule_id = $1',
        [targetScheduleId]
      );
      const result = await client.query(
        `INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [targetScheduleId, item.activity_template_id, item.start_time, item.end_time, maxResult.rows[0].next_order, item.section]
      );
      await client.query('COMMIT');
      res.json({ message: 'Aktiviteten kopierades till det andra barnet', item_id: result.rows[0].id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] copy-item-to-child error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// POST /api/children/:childId/schedules/swap-day
// Swap all activities between two days
// Body: { day_a: 0-6, day_b: 0-6 }
childRouter.post('/swap-day', async (req, res) => {
  try {
    const child = await getChildAccess(req.user.id, req.params.childId);
    if (!child) return res.status(403).json({ error: 'Du har inte åtkomst till detta barn' });

    const { day_a, day_b } = req.body;
    const dowA = parseInt(day_a, 10);
    const dowB = parseInt(day_b, 10);
    if (isNaN(dowA) || isNaN(dowB) || dowA < 0 || dowA > 6 || dowB < 0 || dowB > 6 || dowA === dowB) {
      return res.status(400).json({ error: 'Ogiltiga dagar' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const getScheduleItems = async (dow) => {
        const schedResult = await client.query(
          'SELECT id FROM weekly_schedule WHERE child_id = $1 AND day_of_week = $2',
          [req.params.childId, dow]
        );
        if (schedResult.rows.length === 0) return { scheduleId: null, items: [] };
        const scheduleId = schedResult.rows[0].id;
        const itemsResult = await client.query(
          'SELECT activity_template_id, start_time, end_time, sort_order, section FROM weekly_schedule_item WHERE weekly_schedule_id = $1 ORDER BY sort_order ASC',
          [scheduleId]
        );
        return { scheduleId, items: itemsResult.rows };
      };

      const { scheduleId: schedA, items: itemsA } = await getScheduleItems(dowA);
      const { scheduleId: schedB, items: itemsB } = await getScheduleItems(dowB);

      // Ensure schedules exist if needed
      const ensureSchedule = async (dow, existingId) => {
        if (existingId) return existingId;
        const result = await client.query(
          'INSERT INTO weekly_schedule (child_id, day_of_week, sort_order) VALUES ($1, $2, $3) RETURNING id',
          [req.params.childId, dow, dow]
        );
        return result.rows[0].id;
      };

      const useA = itemsB.length > 0 ? await ensureSchedule(dowA, schedA) : schedA;
      const useB = itemsA.length > 0 ? await ensureSchedule(dowB, schedB) : schedB;

      // Clear both
      if (useA) await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [useA]);
      if (useB) await client.query('DELETE FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [useB]);

      // Write B's items into A and A's items into B
      for (const item of itemsB) {
        if (useA) await client.query(
          'INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section) VALUES ($1,$2,$3,$4,$5,$6)',
          [useA, item.activity_template_id, item.start_time, item.end_time, item.sort_order, item.section]
        );
      }
      for (const item of itemsA) {
        if (useB) await client.query(
          'INSERT INTO weekly_schedule_item (weekly_schedule_id, activity_template_id, start_time, end_time, sort_order, section) VALUES ($1,$2,$3,$4,$5,$6)',
          [useB, item.activity_template_id, item.start_time, item.end_time, item.sort_order, item.section]
        );
      }

      // Clean up empty schedules (optional but tidy)
      if (useA) {
        const countA = await client.query('SELECT COUNT(*) FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [useA]);
        if (parseInt(countA.rows[0].count) === 0 && !schedA) {
          await client.query('DELETE FROM weekly_schedule WHERE id = $1', [useA]);
        }
      }
      if (useB) {
        const countB = await client.query('SELECT COUNT(*) FROM weekly_schedule_item WHERE weekly_schedule_id = $1', [useB]);
        if (parseInt(countB.rows[0].count) === 0 && !schedB) {
          await client.query('DELETE FROM weekly_schedule WHERE id = $1', [useB]);
        }
      }

      await client.query('COMMIT');
      res.json({ message: 'Dagarna har bytts' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[SCHEDULES] swap-day error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = { childRouter, scheduleRouter };
