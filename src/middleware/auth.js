const jwt = require('jsonwebtoken');
const config = require('../lib/config');

/**
 * Verify JWT token from Authorization header or cookie.
 * Sets req.user = { id, type, familyId, email/username }
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Autentisering krävs' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Ogiltig eller utgången token' });
  }
}

/**
 * Require parent auth (not child).
 */
function requireParent(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.type !== 'parent') {
      return res.status(403).json({ error: 'Förbjuden — kräver föräldrabehörighet' });
    }
    next();
  });
}

/**
 * Require admin auth.
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.type !== 'parent' || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Förbjuden — kräver administratörsbehörighet' });
    }
    next();
  });
}

/**
 * Require child auth.
 */
function requireChild(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.type !== 'child') {
      return res.status(403).json({ error: 'Förbjuden — kräver barninloggning' });
    }
    next();
  });
}

/**
 * Optional auth — sets req.user if token is valid, continues regardless.
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    req.user = jwt.verify(token, config.jwt.secret);
  } catch {
    // Invalid token — just continue without user
  }
  next();
}

/**
 * Extract token from Authorization header or cookie.
 */
function extractToken(req) {
  // Check Authorization header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check cookie
  if (req.cookies?.token) {
    return req.cookies.token;
  }

  return null;
}

module.exports = {
  requireAuth,
  requireParent,
  requireAdmin,
  requireChild,
  optionalAuth,
};
