/**
 * Application configuration.
 * All rate limiting values are configurable via environment variables.
 */
module.exports = {
  jwt: {
    secret: process.env.JWT_SECRET || process.env.POLSIA_API_TOKEN || 'dev-jwt-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    childExpiresIn: process.env.JWT_CHILD_EXPIRES_IN || '12h',
  },

  rateLimits: {
    // Global: 200 requests/min per user
    global: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
      max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
    },
    // Login: 10 failed attempts → lock 5 min
    login: {
      windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 5 * 60_000,
      max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
    },
    // Child login lockout: 5 failed PIN attempts → lock 5 min (DB-based, not express-rate-limit)
    childLogin: {
      windowMs: parseInt(process.env.CHILD_LOGIN_LOCKOUT_WINDOW_MS) || 5 * 60_000,
      max: parseInt(process.env.CHILD_LOGIN_LOCKOUT_MAX) || 5,
    },
    // Registration: 10 per hour per IP
    registration: {
      windowMs: parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS) || 60 * 60_000,
      max: parseInt(process.env.REGISTER_RATE_LIMIT_MAX) || 10,
    },
  },

  email: {
    from: process.env.EMAIL_FROM || 'stjarndag@polsia.app',
    baseUrl: process.env.APP_URL || 'https://mystarday.se',
  },

  bcrypt: {
    rounds: parseInt(process.env.BCRYPT_ROUNDS) || 12,
  },

  verification: {
    tokenExpiryHours: parseInt(process.env.VERIFY_TOKEN_EXPIRY_HOURS) || 24,
    resetTokenExpiryHours: parseInt(process.env.RESET_TOKEN_EXPIRY_HOURS) || 1,
  },
};
