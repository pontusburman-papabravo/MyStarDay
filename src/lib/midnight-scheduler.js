/**
 * Midnight scheduler for daily log generation.
 *
 * No external dependencies — uses setTimeout with self-rescheduling.
 * Fires just after UTC midnight each day to generate daily_log records
 * for all children whose local date just rolled over.
 *
 * On-demand fallback is handled in the GET /api/children/:childId/daily-log
 * route for any logs the scheduler may have missed.
 */

const { generateLogsForAllChildren } = require('./daily-log-generator');

let _timer = null;

/**
 * Milliseconds until the next UTC midnight.
 */
function msUntilMidnightUtc() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 30  // 00:00:30 UTC — 30s buffer so all timezones have ticked over
  ));
  return Math.max(0, tomorrow.getTime() - now.getTime());
}

async function runMidnightJob() {
  const dateStr = new Date().toISOString().slice(0, 10);
  console.log(`[MIDNIGHT-SCHEDULER] Running midnight job for ${dateStr}`);

  try {
    await generateLogsForAllChildren(dateStr);
  } catch (err) {
    console.error('[MIDNIGHT-SCHEDULER] Job failed:', err.message);
  }

  // Reschedule for the next midnight
  scheduleNextRun();
}

function scheduleNextRun() {
  const ms = msUntilMidnightUtc();
  console.log(`[MIDNIGHT-SCHEDULER] Next run in ${Math.round(ms / 60000)} minutes`);
  _timer = setTimeout(runMidnightJob, ms);
  // Prevent the timer from blocking Node.js process exit
  if (_timer.unref) _timer.unref();
}

/**
 * Start the midnight scheduler. Call once at server startup.
 */
function startMidnightScheduler() {
  scheduleNextRun();
  console.log('[MIDNIGHT-SCHEDULER] Scheduler started');
}

/**
 * Stop the scheduler (useful for tests / graceful shutdown).
 */
function stopMidnightScheduler() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}

module.exports = { startMidnightScheduler, stopMidnightScheduler };
