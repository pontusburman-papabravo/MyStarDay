const rateLimit = require('express-rate-limit');
const config = require('../lib/config');

/**
 * Global rate limiter: 200 requests/min per IP.
 */
const globalLimiter = rateLimit({
  windowMs: config.rateLimits.global.windowMs,
  max: config.rateLimits.global.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'För många förfrågningar. Vänta en stund och försök igen.' },
  keyGenerator: (req) => req.ip,
});

/**
 * Login rate limiter: 10 attempts per 5 min per IP.
 * Only counts failed requests (skipSuccessfulRequests).
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimits.login.windowMs,
  max: config.rateLimits.login.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'För många inloggningsförsök. Vänta några minuter och försök igen.' },
  keyGenerator: (req) => req.ip,
  skipSuccessfulRequests: true,
});

/**
 * Registration rate limiter: 10 per hour per IP.
 */
const registrationLimiter = rateLimit({
  windowMs: config.rateLimits.registration.windowMs,
  max: config.rateLimits.registration.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'För många registreringsförsök. Försök igen senare.' },
  keyGenerator: (req) => req.ip,
});

module.exports = {
  globalLimiter,
  loginLimiter,
  registrationLimiter,
};
