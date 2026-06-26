// ============================================================
// NOTIFICATIONS — outbound email via Resend
// Workers cannot open raw TCP sockets, so SMTP is not possible here.
// Resend's HTTP API is the free, Cloudflare-recommended path for this.
// ============================================================

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "onboarding@resend.dev"; // Resend's shared sandbox sender;
                                                // works without domain verification
                                                // when sending to your own signup email
const TO_ADDRESS = "gunppp1@gmail.com";

/**
 * Sends a plain-text-style email (rendered as simple HTML) via Resend.
 * Per the loud-logging rule, failures here are logged loudly (console.error
 * with full context) rather than swallowed — but a failed send should never
 * crash the caller's lifecycle logic, since a notification failing to send
 * is not itself a reason to abandon a revert or a status update.
 */
export async function sendEmail(env, subject, body) {
  if (!env.RESEND_API_KEY) {
    console.error("LOUD LOG: RESEND_API_KEY is not set. Notification not sent.", { subject });
    return { sent: false, reason: "missing_api_key" };
  }

  const escaped = escapeHtml(body);
  // Turn any https:// URL into a real clickable link. Escaping happens
  // first, so this only ever wraps text that was already made safe -
  // it can't be used to inject markup via a crafted body.
  const linked = escaped.replace(
    /(https:\/\/[^\s<]+)/g,
    '<a href="$1" style="color: #3ecf9b;">$1</a>'
  );
  const html = `<pre style="font-family: monospace; white-space: pre-wrap; font-size: 14px;">${linked}</pre>`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: TO_ADDRESS,
        subject,
        html
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("LOUD LOG: Resend send failed.", { status: res.status, errBody, subject });
      return { sent: false, reason: `resend_error_${res.status}` };
    }

    const data = await res.json();
    return { sent: true, id: data.id };
  } catch (err) {
    console.error("LOUD LOG: Resend send threw an exception.", { error: err.message, subject });
    return { sent: false, reason: "exception", message: err.message };
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
