const express = require('express');
const db = require('../lib/db');
const { requireParent } = require('../middleware/auth');

const router = express.Router();
router.use(requireParent);

// ─── GET /api/categories ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, sort_order, is_default
       FROM category
       WHERE family_id = $1
       ORDER BY sort_order ASC, name ASC`,
      [req.user.familyId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[CATEGORIES] List error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── POST /api/categories ────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, sort_order } = req.body;
    if (!name || name.trim().length < 1) {
      return res.status(400).json({ error: 'Kategorinamn krävs' });
    }

    // Get max sort_order for family
    const maxResult = await db.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM category WHERE family_id = $1',
      [req.user.familyId]
    );
    const nextOrder = sort_order !== undefined ? sort_order : maxResult.rows[0].next_order;

    const result = await db.query(
      `INSERT INTO category (family_id, name, sort_order, is_default)
       VALUES ($1, $2, $3, false)
       RETURNING id, name, sort_order, is_default`,
      [req.user.familyId, name.trim(), nextOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[CATEGORIES] Create error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── PUT /api/categories/:id ─────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    // Verify ownership
    const existing = await db.query(
      'SELECT id, is_default FROM category WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Kategorin hittades inte' });
    }

    const { name, sort_order } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      if (name.trim().length < 1) return res.status(400).json({ error: 'Kategorinamn krävs' });
      updates.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(sort_order);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Inget att uppdatera' });

    values.push(req.params.id);
    const result = await db.query(
      `UPDATE category SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, sort_order, is_default`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[CATEGORIES] Update error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

// ─── DELETE /api/categories/:id ──────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, is_default FROM category WHERE id = $1 AND family_id = $2',
      [req.params.id, req.user.familyId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Kategorin hittades inte' });
    }

    // Check if category has templates
    const templates = await db.query(
      'SELECT COUNT(*) FROM activity_template WHERE category_id = $1',
      [req.params.id]
    );
    if (parseInt(templates.rows[0].count, 10) > 0) {
      return res.status(409).json({
        error: 'Kategorin har aktiviteter kopplade till sig. Ta bort aktiviteterna först eller flytta dem till en annan kategori.',
      });
    }

    await db.query('DELETE FROM category WHERE id = $1', [req.params.id]);
    res.json({ message: 'Kategorin har tagits bort' });
  } catch (err) {
    console.error('[CATEGORIES] Delete error:', err);
    res.status(500).json({ error: 'Något gick fel. Försök igen senare.' });
  }
});

module.exports = router;
