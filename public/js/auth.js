/**
 * Min Stjärndag auth helpers.
 * Handles token storage, API calls, and redirects.
 */
const Auth = {
  TOKEN_KEY: 'stjarndag_token',
  USER_KEY: 'stjarndag_user',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.USER_KEY));
    } catch {
      return null;
    }
  },

  setAuth(token, user) {
    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  },

  clearAuth() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  /**
   * Make an authenticated API request.
   */
  async api(url, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, { ...options, headers });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Något gick fel');
    }
    return data;
  },

  /**
   * Redirect to appropriate dashboard based on user type.
   * Admins go to /admin, children to /child-dashboard, parents to /dashboard.
   */
  redirectToDashboard() {
    const user = this.getUser();
    if (!user) return;
    if (user.type === 'child' || (!user.email && user.username)) {
      window.location.href = '/child-dashboard';
    } else if (user.isAdmin) {
      window.location.href = '/admin';
    } else {
      window.location.href = '/dashboard';
    }
  },

  /**
   * Require auth — redirect to login if not authenticated.
   */
  requireAuth(type = null) {
    if (!this.isLoggedIn()) {
      window.location.href = type === 'child' ? '/child-login' : '/login';
      return false;
    }
    return true;
  },

  /**
   * Logout and redirect.
   */
  logout() {
    this.clearAuth();
    window.location.href = '/';
  },
};

/**
 * Show error message in a form.
 */
function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

/**
 * Hide error message.
 */
function hideError(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    el.classList.add('hidden');
  }
}

/**
 * Show success message.
 */
function showSuccess(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

/**
 * Set button loading state.
 */
function setLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Laddar...';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
}

/**
 * Authenticated fetch — returns raw Response (does NOT throw on non-2xx).
 * Usage: const res = await window.apiFetch('/api/foo', { method: 'POST', body: JSON.stringify({}) });
 */
window.apiFetch = function(url, options = {}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
};

/**
 * Auth guard for parent-only pages.
 * Redirects to /login if not authenticated.
 * Returns the current user object if authenticated.
 */
window.authGuard = async function() {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/login';
    return null;
  }
  try {
    const res = await window.apiFetch('/api/auth/me');
    if (!res.ok) {
      Auth.clearAuth();
      window.location.href = '/login';
      return null;
    }
    return await res.json();
  } catch {
    window.location.href = '/login';
    return null;
  }
};

/**
 * Logout helper exposed on window for inline onclick handlers.
 */
window.logout = function() { Auth.logout(); };
