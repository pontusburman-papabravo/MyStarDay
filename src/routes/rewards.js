/**
 * Rewards and redemption routes.
 * Exports: { parentRouter, childRouter }
 */

const express = require('express');
const db = require('../lib/db');
const { requireParent, requireChild } = require('../middleware/auth');

/**
 * Compute star balance for a child.
 * Earned = sum of star_value on completed daily_log_items.
 * Spent = sum of star_cost snapshots on approved/auto redemptions
 *         (falls back to reward.star_cost for pre-migration rows).
 */
async function getStarBalance(childId) {
  const earnedResult = await db.query(
    `SELECT COALESCE(SUM(dli.star_value), 0) AS earned
     FROM daily_log_item dli
     JOIN daily_log dl ON dl.id = dli.daily_log_id
     WHERE dl.child_id = $1 AND dli.completed = true`,
    [childId]
  );

  // Snapshotted star_cost (migration 007+)
  const spentSnapshotResult = await db.query(
    `SELECT COALESCE(SUM(rr.star_cost), 0) AS spent
     FROM reward_redemption rr
     WHERE rr.child_id = $1
       AND rr.status IN ('approved', 'auto')
       AND rr.star_cost IS NOT NULL`,
    [childId]
  );

  // Legacy rows without snapshot — join to reward for current price
  const spentLegacyResult = await db.query(
    `SELECT COALESCE(SUM(r.star_cost), 0) AS spent
     FROM reward_redemption rr
     JOIN reward r ON r.id = rr.reward_id
     WHERE rr.child_id = $1
       AND rr.status IN ('approved', 'auto')
       AND rr.star_cost IS NULL`,
    [childId]
  );

  const earned = parseInt(earnedResult.rows[0].earned, 10);
  const spent = parseInt(spentSnapshotResult.rows[0].spent, 10) + parseInt(spentLegacyResult.rows[0].spent, 10);
  return Math.max(0, earned - spent);
}

// ─── Parent Router ────────────────────────────────────────

const parentRouter = express.Router();
parentRouter.use(requireParent);

parentRouter.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, icon, star_cost, requires_approval, is_active, sort_order
       FROM reward WHERE family_id = $1 ORDER BY sort_order ASC, star_cost ASC`,
      [req.user.familyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[REWARDS] List error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

parentRouter.post('/', async (req, res) => {
  try {
    const { name, icon, star_cost, requires_approval } = req.body;
    if (!name || !star_cost) {
      return res.status(400).json({ error: 'Namn och stjärnkostnad krävs' });
    }
    const cost = parseInt(star_cost, 10);
    if (isNaN(cost) || cost < 1) {
      return res.status(400).json({ error: 'Stjärnkostnad måste vara minst 1' });
    }
    const result = await db.query(
      `INSERT INTO reward (family_id, name, icon, star_cost, requires_approval, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, name, icon, star_cost, requires_approval, is_active`,
      [req.user.familyId, name.trim(), icon || '🎁', cost, requires_approval === true]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[REWARDS] Create error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

// ─── PUT /api/rewards/reorder ───────────────────────────
// IMPORTANT: This route MUST be defined before /:id to avoid Express matching "reorder" as a UUID
parentRouter.put('/reorder', async (req, res) => {
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
          'UPDATE reward SET sort_order = $1 WHERE id = $2 AND family_id = $3',
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
    console.error('[REWARDS] Reorder error:', err);
    res.status(500).json({ error: 'Något gick fel vid sparandet.' });
  }
});

parentRouter.put('/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id FROM reward WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Belöning hittades inte' });
    }
    const body = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (body.name !== undefined) { updates.push('name = $' + idx); idx++; values.push(body.name.trim()); }
    if (body.icon !== undefined) { updates.push('icon = $' + idx); idx++; values.push(body.icon); }
    if (body.star_cost !== undefined) {
      const cost = parseInt(body.star_cost, 10);
      if (isNaN(cost) || cost < 1) {
        return res.status(400).json({ error: 'Stjärnkostnad måste vara minst 1' });
      }
      updates.push('star_cost = $' + idx); idx++; values.push(cost);
    }
    if (body.requires_approval !== undefined) {
      updates.push('requires_approval = $' + idx); idx++; values.push(Boolean(body.requires_approval));
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = $' + idx); idx++; values.push(Boolean(body.is_active));
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Inget att uppdatera' });
    }
    values.push(req.params.id);
    const result = await db.query(
      `UPDATE reward SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, icon, star_cost, requires_approval, is_active`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[REWARDS] Update error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

parentRouter.delete('/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id FROM reward WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Belöning hittades inte' });
    }
    await db.query('DELETE FROM reward WHERE id = $1', [req.params.id]);
    res.json({ message: 'Belöning borttagen' });
  } catch (err) {
    console.error('[REWARDS] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

parentRouter.get('/redemptions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT rr.id, rr.status, rr.created_at, rr.approved_by, rr.sort_order,
              COALESCE(rr.star_cost, r.star_cost) AS star_cost,
              r.name AS reward_name, r.icon AS reward_icon,
              c.name AS child_name, c.emoji AS child_emoji, c.id AS child_id
       FROM reward_redemption rr
       JOIN reward r ON r.id = rr.reward_id
       JOIN child c ON c.id = rr.child_id
       JOIN parent_child pc ON pc.child_id = c.id
       WHERE pc.parent_id = $1
       ORDER BY rr.sort_order ASC, rr.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[REWARDS] Redemptions list error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

// ─── PUT /api/rewards/redemptions/reorder ────────────────
// IMPORTANT: This route MUST be defined before /redemptions/:id/* to avoid Express matching "reorder" as a UUID
parentRouter.put('/redemptions/reorder', async (req, res) => {
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
        // Only allow reordering redemptions that belong to this parent's children
        await client.query(
          `UPDATE reward_redemption SET sort_order = $1
           WHERE id = $2
           AND child_id IN (SELECT child_id FROM parent_child WHERE parent_id = $3)`,
          [item.sort_order, item.id, req.user.id]
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
    console.error('[REWARDS] Redemptions reorder error:', err);
    res.status(500).json({ error: 'Något gick fel vid sparandet.' });
  }
});

parentRouter.put('/redemptions/:id/approve', async (req, res) => {
  try {
    const rr = await db.query(
      `SELECT rr.id, rr.status, r.name AS reward_name FROM reward_redemption rr
       JOIN reward r ON r.id = rr.reward_id
       JOIN parent_child pc ON pc.child_id = rr.child_id
       WHERE rr.id = $1 AND pc.parent_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rr.rows.length === 0) return res.status(404).json({ error: 'Inlösen hittades inte' });
    if (rr.rows[0].status !== 'pending') return res.status(400).json({ error: 'Kan bara godkänna väntande inlösen' });
    await db.query(
      `UPDATE reward_redemption SET status = 'approved', approved_by = $1 WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ message: 'Inlösen av ' + rr.rows[0].reward_name + ' godkänd!' });
  } catch (err) {
    console.error('[REWARDS] Approve error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

parentRouter.put('/redemptions/:id/deny', async (req, res) => {
  try {
    const rr = await db.query(
      `SELECT rr.id, rr.status, r.name AS reward_name FROM reward_redemption rr
       JOIN reward r ON r.id = rr.reward_id
       JOIN parent_child pc ON pc.child_id = rr.child_id
       WHERE rr.id = $1 AND pc.parent_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rr.rows.length === 0) return res.status(404).json({ error: 'Inlösen hittades inte' });
    if (rr.rows[0].status !== 'pending') return res.status(400).json({ error: 'Kan bara neka väntande inlösen' });
    await db.query(`UPDATE reward_redemption SET status = 'denied' WHERE id = $1`, [req.params.id]);
    res.json({ message: 'Inlösen av ' + rr.rows[0].reward_name + ' nekad.' });
  } catch (err) {
    console.error('[REWARDS] Deny error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

// ─── Child Router ─────────────────────────────────────────

const childRouter = express.Router();
childRouter.use(requireChild);

childRouter.get('/rewards', async (req, res) => {
  try {
    const childId = req.user.id;
    const childResult = await db.query('SELECT family_id FROM child WHERE id = $1', [childId]);
    if (childResult.rows.length === 0) return res.status(404).json({ error: 'Barn hittades inte' });
    const familyId = childResult.rows[0].family_id;

    // Only show active rewards to children
    const rewards = await db.query(
      `SELECT id, name, icon, star_cost, requires_approval
       FROM reward WHERE family_id = $1 AND is_active = true ORDER BY sort_order ASC, star_cost ASC`,
      [familyId]
    );
    const balance = await getStarBalance(childId);
    const redemptions = await db.query(
      `SELECT rr.id, rr.status, rr.created_at,
              r.name AS reward_name, r.icon AS reward_icon,
              COALESCE(rr.star_cost, r.star_cost) AS star_cost
       FROM reward_redemption rr JOIN reward r ON r.id = rr.reward_id
       WHERE rr.child_id = $1 ORDER BY rr.created_at DESC LIMIT 20`,
      [childId]
    );
    res.json({ rewards: rewards.rows, starBalance: balance, redemptions: redemptions.rows });
  } catch (err) {
    console.error('[REWARDS] Child list error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

childRouter.post('/rewards/:id/redeem', async (req, res) => {
  try {
    const childId = req.user.id;
    const childResult = await db.query('SELECT family_id FROM child WHERE id = $1', [childId]);
    if (childResult.rows.length === 0) return res.status(404).json({ error: 'Barn hittades inte' });
    const familyId = childResult.rows[0].family_id;

    const rewardResult = await db.query(
      `SELECT id, name, icon, star_cost, requires_approval, is_active
       FROM reward WHERE id = $1 AND family_id = $2`,
      [req.params.id, familyId]
    );
    if (rewardResult.rows.length === 0) return res.status(404).json({ error: 'Belöning hittades inte' });
    const reward = rewardResult.rows[0];

    if (!reward.is_active) return res.status(400).json({ error: 'Den här belöningen är inte längre tillgänglig' });

    const balance = await getStarBalance(childId);
    if (balance < reward.star_cost) {
      return res.status(400).json({
        error: `Du har ${balance} stjärnor men behöver ${reward.star_cost} för ${reward.name}`,
      });
    }

    const existingPending = await db.query(
      `SELECT id FROM reward_redemption WHERE child_id = $1 AND reward_id = $2 AND status = 'pending'`,
      [childId, req.params.id]
    );
    if (existingPending.rows.length > 0) {
      return res.status(409).json({ error: 'Du har redan en väntande inlösen för den här belöningen' });
    }

    const status = reward.requires_approval ? 'pending' : 'auto';
    // Snapshot star_cost at redemption time
    const result = await db.query(
      `INSERT INTO reward_redemption (reward_id, child_id, status, star_cost)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [req.params.id, childId, status, reward.star_cost]
    );

    const message = reward.requires_approval
      ? `${reward.name} skickad för godkännande`
      : `${reward.name} inlöst!`;
    res.status(201).json({ message, redemption: result.rows[0], requiresApproval: reward.requires_approval });
  } catch (err) {
    console.error('[REWARDS] Redeem error:', err);
    res.status(500).json({ error: 'Något gick fel.' });
  }
});

module.exports = { parentRouter, childRouter };
