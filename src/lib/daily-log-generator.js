/**
 * Daily log generator.
 *
 * Generates a daily_log + daily_log_items snapshot from the weekly_schedule.
 * Snapshot principle: changes to the weekly schedule template do NOT affect
 * already-generated daily logs.
 *
 * Called:
 *   1. At midnight (scheduled job) for all children
 *   2. On-demand when a parent or child first accesses the log for a date
 */

const db = require('./db');

/**
 * Calculate child's age in years from a birthday string (YYYY-MM-DD).
 * Returns a floating-point number (e.g. 4.5 for a 4.5-year-old).
 * @param {string|null} birthday - ISO date string
 * @returns {number} Age in years, or null if birthday is not set
 */
function getChildAgeInYears(birthday) {
  if (!birthday) return null;
  const birthDate = new Date(birthday);
  if (isNaN(birthDate.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - birthDate.getTime();
  const ageYears = diffMs / (1000 * 60 * 60 * 24 * 365.25);
  return Math.round(ageYears * 10) / 10; // Round to 1 decimal
}

/**
 * Determine the age-appropriate label for school-related activities.
 * - Ages 0–6 (including exactly 6): use "Skola/Förskola"
 * - Ages >6: use "Skola"
 *
 * When showing schedule items to a child, call this to get the correct variant name.
 *
 * @param {string|null} birthday
 * @returns {'Skola/Förskola' | 'Skola'}
 */
function getSchoolVariant(birthday) {
  const age = getChildAgeInYears(birthday);
  if (age === null) return 'Skola/Förskola'; // Default to younger variant
  if (age <= 6) return 'Skola/Förskola';
  return 'Skola';
}

/**
 * Get the ISO date string (YYYY-MM-DD) in the child's timezone.
 * Falls back to Europe/Stockholm.
 */
function getLocalDateStr(dateInput, timezone) {
  const tz = timezone || 'Europe/Stockholm';
  const d = dateInput ? new Date(dateInput) : new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: tz }); // sv-SE produces YYYY-MM-DD
}

/**
 * Get JS day-of-week (0=Sun, 1=Mon, … 6=Sat) for a date string in a timezone.
 */
function getDayOfWeek(dateStr, timezone) {
  const tz = timezone || 'Europe/Stockholm';
  const d = new Date(`${dateStr}T12:00:00Z`); // midday UTC avoids DST edge cases
  const localDay = parseInt(
    d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).slice(0, 2),
    10
  );
  // Use Intl to get numeric day
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const name = formatter.format(d);
  return dayNames.indexOf(name.substring(0, 3));
}

/**
 * Generate (or retrieve) the daily log for a child on a specific date.
 *
 * @param {string} childId  - UUID of the child
 * @param {string} dateStr  - ISO date string YYYY-MM-DD (local date)
 * @param {object} [client] - Optional pg client (for transactions). Uses pool if omitted.
 * @returns {Promise<{ log: object, items: object[], generated: boolean }>}
 */
async function getOrGenerateDailyLog(childId, dateStr, client) {
  const q = client || db;

  // ── 1. Check if log already exists ──────────────────────
  const existing = await q.query(
    `SELECT dl.id, dl.child_id, dl.date, dl.is_paused, dl.generated_from, dl.created_at
     FROM daily_log dl
     WHERE dl.child_id = $1 AND dl.date = $2`,
    [childId, dateStr]
  );

  if (existing.rows.length > 0) {
    const log = existing.rows[0];
    const items = await q.query(
      `SELECT dli.id, dli.daily_log_id, dli.activity_template_id, dli.name, dli.icon,
              dli.start_time, dli.end_time, dli.star_value, dli.completed, dli.completed_at,
              dli.sort_order, dli.child_sort_order, dli.section,
              COALESCE(at.feedback_for, 'both') AS feedback_for
       FROM daily_log_item dli
       LEFT JOIN activity_template at ON at.id = dli.activity_template_id
       WHERE dli.daily_log_id = $1
       ORDER BY dli.section, dli.child_sort_order ASC`,
      [log.id]
    );

    // BUG-10 FIX: If log exists but has 0 items, check if a schedule now exists
    // and populate items from it. This handles the case where a daily log was
    // generated before the parent created a schedule for this day.
    if (items.rows.length === 0) {
      const childInfo = await q.query('SELECT id, timezone FROM child WHERE id = $1', [childId]);
      const tz = (childInfo.rows[0] && childInfo.rows[0].timezone) || 'Europe/Stockholm';
      const dayOfWeek = getDayOfWeek(dateStr, tz);
      const scheduleResult = await q.query(
        `SELECT ws.id FROM weekly_schedule ws WHERE ws.child_id = $1 AND ws.day_of_week = $2`,
        [childId, dayOfWeek]
      );
      if (scheduleResult.rows.length > 0) {
        const scheduleId = scheduleResult.rows[0].id;
        const scheduleItems = await q.query(
          `SELECT wsi.activity_template_id, wsi.start_time, wsi.end_time, wsi.sort_order, wsi.section,
                  at.name, at.icon, at.star_value
           FROM weekly_schedule_item wsi
           JOIN activity_template at ON at.id = wsi.activity_template_id
           WHERE wsi.weekly_schedule_id = $1
           ORDER BY wsi.section, wsi.sort_order ASC`,
          [scheduleId]
        );
        if (scheduleItems.rows.length > 0) {
          // Populate items from schedule template
          for (const item of scheduleItems.rows) {
            await q.query(
              `INSERT INTO daily_log_item
                 (daily_log_id, activity_template_id, name, icon, start_time, end_time, star_value, sort_order, child_sort_order, section)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
              [log.id, item.activity_template_id, item.name, item.icon,
               item.start_time, item.end_time, item.star_value, item.sort_order, item.section]
            );
          }
          // Update generated_from reference
          await q.query('UPDATE daily_log SET generated_from = $1 WHERE id = $2', [scheduleId, log.id]);
          // Re-fetch populated items
          const populatedItems = await q.query(
            `SELECT dli.id, dli.daily_log_id, dli.activity_template_id, dli.name, dli.icon,
                    dli.start_time, dli.end_time, dli.star_value, dli.completed, dli.completed_at,
                    dli.sort_order, dli.child_sort_order, dli.section,
                    COALESCE(at.feedback_for, 'both') AS feedback_for
             FROM daily_log_item dli
             LEFT JOIN activity_template at ON at.id = dli.activity_template_id
             WHERE dli.daily_log_id = $1
             ORDER BY dli.section, dli.child_sort_order ASC`,
            [log.id]
          );
          return { log, items: populatedItems.rows, generated: true };
        }
      }
    }

    return { log, items: items.rows, generated: false };
  }

  // ── 2. Get child info (timezone) ─────────────────────────
  const childResult = await q.query(
    'SELECT id, timezone FROM child WHERE id = $1',
    [childId]
  );
  if (childResult.rows.length === 0) throw new Error('Child not found');

  const child = childResult.rows[0];
  const timezone = child.timezone || 'Europe/Stockholm';

  // ── 3. Get day of week for dateStr ───────────────────────
  const dayOfWeek = getDayOfWeek(dateStr, timezone);

  // ── 4. Find weekly schedule for that day_of_week ─────────
  const scheduleResult = await q.query(
    `SELECT ws.id
     FROM weekly_schedule ws
     WHERE ws.child_id = $1 AND ws.day_of_week = $2`,
    [childId, dayOfWeek]
  );

  // ── 5. Create the daily_log record ───────────────────────
  const scheduleId = scheduleResult.rows[0]?.id || null;

  const logResult = await q.query(
    `INSERT INTO daily_log (child_id, date, is_paused, generated_from)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (child_id, date) DO UPDATE SET generated_from = EXCLUDED.generated_from
     RETURNING id, child_id, date, is_paused, generated_from, created_at`,
    [childId, dateStr, scheduleId]
  );
  const log = logResult.rows[0];

  // ── 6. Copy schedule items → daily_log_items (snapshot) ──
  if (scheduleId) {
    const scheduleItems = await q.query(
      `SELECT wsi.activity_template_id, wsi.start_time, wsi.end_time, wsi.sort_order, wsi.section,
              at.name, at.icon, at.star_value
       FROM weekly_schedule_item wsi
       JOIN activity_template at ON at.id = wsi.activity_template_id
       WHERE wsi.weekly_schedule_id = $1
       ORDER BY wsi.section, wsi.sort_order ASC`,
      [scheduleId]
    );

    for (const item of scheduleItems.rows) {
      await q.query(
        `INSERT INTO daily_log_item
           (daily_log_id, activity_template_id, name, icon, start_time, end_time, star_value, sort_order, child_sort_order, section)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
        [
          log.id,
          item.activity_template_id,
          item.name,
          item.icon,
          item.start_time,
          item.end_time,
          item.star_value,
          item.sort_order,
          item.section,
        ]
      );
    }
  }

  // ── 7. Return fresh log + items ───────────────────────────
  const items = await q.query(
    `SELECT dli.id, dli.daily_log_id, dli.activity_template_id, dli.name, dli.icon,
            dli.start_time, dli.end_time, dli.star_value, dli.completed, dli.completed_at,
            dli.sort_order, dli.child_sort_order, dli.section,
            COALESCE(at.feedback_for, 'both') AS feedback_for
     FROM daily_log_item dli
     LEFT JOIN activity_template at ON at.id = dli.activity_template_id
     WHERE dli.daily_log_id = $1
     ORDER BY dli.section, dli.child_sort_order ASC`,
    [log.id]
  );

  return { log, items: items.rows, generated: true };
}

/**
 * Generate daily logs for ALL children for a given date.
 * Used by the midnight scheduler.
 *
 * @param {string} [dateStr] - YYYY-MM-DD, defaults to today (UTC)
 */
async function generateLogsForAllChildren(dateStr) {
  if (!dateStr) {
    dateStr = new Date().toISOString().slice(0, 10);
  }

  const childResult = await db.query('SELECT id, timezone FROM child');
  const children = childResult.rows;

  let generated = 0;
  let skipped = 0;
  let errors = 0;

  for (const child of children) {
    // Use child's local date
    const localDate = getLocalDateStr(new Date(`${dateStr}T00:00:00Z`), child.timezone);
    try {
      const result = await getOrGenerateDailyLog(child.id, localDate);
      if (result.generated) generated++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error(`[DAILY-LOG-GEN] Error for child ${child.id}:`, err.message);
    }
  }

  console.log(`[DAILY-LOG-GEN] ${dateStr}: generated=${generated} skipped=${skipped} errors=${errors}`);
  return { generated, skipped, errors };
}

module.exports = {
  getOrGenerateDailyLog,
  generateLogsForAllChildren,
  getLocalDateStr,
  getChildAgeInYears,
  getSchoolVariant,
};
