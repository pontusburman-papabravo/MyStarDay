const config = require('./config');

/**
 * Send an email via the Polsia email proxy (Postmark).
 * Falls back to console logging if the proxy is unavailable.
 */
async function sendEmail({ to, subject, html }) {
  const apiToken = process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY;
  const fromEmail = config.email.from; // stjarndag@polsia.app

  console.log(`[EMAIL] Sending to: ${to} | Subject: ${subject}`);

  if (!apiToken) {
    console.warn('[EMAIL] No POLSIA_API_TOKEN — falling back to console-only');
    return { success: false, provider: 'console' };
  }

  // Polsia email proxy endpoints — try multiple URL patterns
  const baseUrl = (process.env.POLSIA_R2_BASE_URL || 'https://polsia.com').replace(/\/$/, '');
  const endpoints = [
    `${baseUrl}/api/proxy/email/send`,
    `${baseUrl}/api/email/send`,
    `${baseUrl}/email/postmark/email`,
    `${baseUrl}/email/send`,
    `${baseUrl}/api/v1/email/send`,
  ];

  const payload = JSON.stringify({
    to,
    subject,
    html_body: html,
    from: fromEmail,
    tag: 'transactional',
  });

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
          'x-api-key': apiToken,
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        console.log(`[EMAIL] Sent successfully via ${endpoint}`);
        return { success: true, provider: 'polsia-proxy', data };
      }

      if (res.status === 404) {
        continue; // silently try next
      }

      const errText = await res.text().catch(() => '');
      console.error(`[EMAIL] ${endpoint} returned ${res.status}: ${errText}`);
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        console.error(`[EMAIL] ${endpoint} failed:`, err.message);
      }
    }
  }

  // Postmark direct API — requires POSTMARK_SERVER_TOKEN env var
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (postmarkToken) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Postmark-Server-Token': postmarkToken,
        },
        body: JSON.stringify({
          From: fromEmail,
          To: to,
          Subject: subject,
          HtmlBody: html,
          MessageStream: 'outbound',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`[EMAIL] Sent via Postmark direct: ${data.MessageID}`);
        return { success: true, provider: 'postmark', data };
      }

      const errText = await res.text().catch(() => '');
      console.error(`[EMAIL] Postmark direct failed ${res.status}: ${errText}`);
    } catch (err) {
      console.error('[EMAIL] Postmark direct error:', err.message);
    }
  }

  console.error(`[EMAIL] All delivery methods failed for: ${to}. Proxy endpoints all 404. POSTMARK_SERVER_TOKEN=${postmarkToken ? 'set' : 'MISSING'}. Platform bug reported — awaiting POSTMARK_SERVER_TOKEN env var.`);
  return { success: false, provider: 'none' };
}

/**
 * Send email verification link.
 */
async function sendVerificationEmail(email, token) {
  const url = `${config.email.baseUrl}/verify-email?token=${token}`;
  return sendEmail({
    to: email,
    subject: 'Verifiera din e-post — Stjärndag',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1B2340;">Välkommen till Stjärndag! ⭐</h2>
        <p>Klicka på knappen nedan för att verifiera din e-postadress:</p>
        <a href="${url}" style="display: inline-block; background: #F5A623; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Verifiera e-post</a>
        <p style="color: #5A6178; font-size: 14px; margin-top: 24px;">Länken är giltig i ${config.verification.tokenExpiryHours} timmar.</p>
      </div>
    `,
  });
}

/**
 * Send password reset link.
 */
async function sendPasswordResetEmail(email, token) {
  const url = `${config.email.baseUrl}/reset-password?token=${token}`;
  return sendEmail({
    to: email,
    subject: 'Återställ lösenord — Stjärndag',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1B2340;">Återställ ditt lösenord</h2>
        <p>Du har begärt att återställa ditt lösenord. Klicka på knappen nedan:</p>
        <a href="${url}" style="display: inline-block; background: #F5A623; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600;">Återställ lösenord</a>
        <p style="color: #5A6178; font-size: 14px; margin-top: 24px;">Länken är giltig i ${config.verification.resetTokenExpiryHours} timme. Ignorera detta mail om du inte begärde en återställning.</p>
      </div>
    `,
  });
}

/**
 * Send notification to parent about child's failed login attempts.
 */
async function sendChildLockoutNotification(parentEmail, childName) {
  return sendEmail({
    to: parentEmail,
    subject: `Inloggningsförsök spärrat — ${childName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1B2340;">Inloggning spärrad</h2>
        <p>${childName} har gjort för många felaktiga inloggningsförsök och kontot är tillfälligt låst i 15 minuter.</p>
        <p style="color: #5A6178; font-size: 14px;">Om detta inte var ditt barn kan du logga in och ändra PIN-koden.</p>
      </div>
    `,
  });
}

/**
 * Send deletion confirmation when account deletion is requested.
 */
async function sendAccountDeletionRequestedEmail(email, firstName) {
  const baseUrl = config.email.baseUrl;
  return sendEmail({
    to: email,
    subject: 'Ditt konto hos Min Stjärndag har markerats för radering',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1B2340;">Hej ${firstName}!</h2>
        <p>Vi har tagit emot en begäran om att radera ditt konto och all tillhörande data.</p>
        <div style="background: #FFF3D6; border-left: 4px solid #F5A623; border-radius: 8px; padding: 1rem 1.2rem; margin: 1.5rem 0;">
          <p style="color: #1B2340; font-weight: 600; margin: 0;">⏳ Dina data raderas permanent om 30 dagar.</p>
        </div>
        <p>Under denna period kan du logga in och <strong>ångra raderingen</strong> om du ändrar dig.</p>
        <p>Om du ångrar dig — logga in på <a href="${baseUrl}" style="color: #F5A623; font-weight: 600;">Min Stjärndag</a> så ser du ett alternativ att avbryta.</p>
        <p style="color: #5A6178; font-size: 14px; margin-top: 2rem;">Om detta var ett misstag kan du ignorera detta mejl. Dina data kommer att raderas om 30 dagar om du inte avbryter.</p>
        <p style="color: #5A6178; font-size: 14px;">Om du har frågor, kontakta oss på <a href="mailto:stjarndag@polsia.app" style="color: #F5A623;">stjarndag@polsia.app</a></p>
      </div>
    `,
  });
}

/**
 * Send confirmation when account has been fully deleted.
 */
async function sendAccountDeletedEmail(email, firstName) {
  return sendEmail({
    to: email,
    subject: 'Ditt konto hos Min Stjärndag har raderats',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1B2340;">Hej ${firstName}</h2>
        <p>Ditt konto och all tillhörande data har nu raderats permanent från Min Stjärndag.</p>
        <div style="background: #E0F5EC; border-left: 4px solid #22C55E; border-radius: 8px; padding: 1rem 1.2rem; margin: 1.5rem 0;">
          <p style="color: #1B2340; font-weight: 600; margin: 0;">Alla familjer, barn, scheman, aktiviteter och stjärnor har tagits bort.</p>
        </div>
        <p>Vi hoppas att Min Stjärndag har varit till hjälp under tiden.</p>
        <p style="color: #5A6178; font-size: 14px; margin-top: 2rem;">Om du vill skapa ett nytt konto är du välkommen tillbaka när som helst på <a href="https://stjarndag.polsia.app" style="color: #F5A623; font-weight: 600;">stjarndag.polsia.app</a></p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendChildLockoutNotification,
  sendAccountDeletionRequestedEmail,
  sendAccountDeletedEmail,
};
