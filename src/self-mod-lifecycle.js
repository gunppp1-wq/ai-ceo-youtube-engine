// ============================================================
// SELF-MODIFICATION LIFECYCLE
// Governs how self_mod_entries move through open -> succeeded/reverted.
// Enforcement of the 5 permanently-locked rules lives in protected-core.js,
// not here. This file only manages the bookkeeping/lifecycle around an
// already-decided, already-safety-gated change.
// ============================================================

const MAX_DEADLINE_DAYS = 30;
const MAX_EXTENSIONS = 2;

function daysToSeconds(days) {
  return Math.round(days * 24 * 60 * 60);
}

// ---- Speed limit (1 new entry/day to start; operator-approval-only to raise) ----

export async function getDailyLimit(env) {
  const row = await env.ai_ceo_memory
    .prepare("SELECT daily_limit FROM self_mod_speed_limit WHERE id = 1")
    .first();
  return row ? row.daily_limit : 1;
}

export async function countOpenedToday(env) {
  const startOfDay = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const row = await env.ai_ceo_memory
    .prepare("SELECT COUNT(*) as n FROM self_mod_entries WHERE opened_at >= ?")
    .bind(startOfDay)
    .first();
  return row ? row.n : 0;
}

export async function canOpenNewEntry(env) {
  const [limit, openedToday] = await Promise.all([
    getDailyLimit(env),
    countOpenedToday(env)
  ]);
  return openedToday < limit;
}

// ---- Opening a new entry ----

/**
 * Opens a new self-modification entry.
 * deadlineDays is the program's own estimate, hard-capped at 30.
 * Caller is responsible for having already run the change through
 * protected-core.js's safety/legality gates BEFORE calling this.
 */
export async function openEntry(env, {
  whatChanged,
  why,
  expectedBenefit,
  metricName,
  metricBaseline = null,
  deadlineDays,
  rollbackData = null
}) {
  if (!(await canOpenNewEntry(env))) {
    throw new Error("Daily self-modification limit reached. Cannot open a new entry today.");
  }

  const cappedDays = Math.min(deadlineDays, MAX_DEADLINE_DAYS);
  const now = Math.floor(Date.now() / 1000);
  const deadlineAt = now + daysToSeconds(cappedDays);

  const result = await env.ai_ceo_memory
    .prepare(`
      INSERT INTO self_mod_entries
        (what_changed, why, expected_benefit, metric_name, metric_baseline,
         status, opened_at, deadline_at, extension_count, rollback_data)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?)
      RETURNING id
    `)
    .bind(
      whatChanged, why, expectedBenefit, metricName, metricBaseline,
      now, deadlineAt, rollbackData ? JSON.stringify(rollbackData) : null
    )
    .first();

  await sendEntryNotification(env, result.id, "opened");
  return result.id;
}

// ---- Monitoring / metric updates ----

/**
 * Called continuously (e.g. on each relevant pipeline run), not just at
 * the deadline. Updates the tracked metric's current value.
 */
export async function updateMetric(env, entryId, currentValue) {
  await env.ai_ceo_memory
    .prepare("UPDATE self_mod_entries SET metric_current = ? WHERE id = ? AND status = 'open'")
    .bind(currentValue, entryId)
    .run();
}

// ---- Revert (single entry, or all open entries) ----

/**
 * Reverts ALL currently-open entries immediately, unconditionally.
 * Per spec: if multiple entries are open and one fails, all open entries
 * revert together — do not try to isolate the cause first.
 *
 * applyRollback is a function the caller supplies: (entry) => Promise<void>
 * that actually undoes the change (restores code/config). This module only
 * owns the bookkeeping; the actual rollback mechanics are change-specific
 * and must be supplied by whatever subsystem opened the entry.
 */
export async function revertAllOpenEntries(env, reason, applyRollback) {
  const { results: openEntries } = await env.ai_ceo_memory
    .prepare("SELECT * FROM self_mod_entries WHERE status = 'open'")
    .all();

  for (const entry of openEntries) {
    try {
      if (applyRollback) {
        await applyRollback(entry);
      }
    } finally {
      // Revert the bookkeeping even if applyRollback throws — loud logging
      // rule means we record the attempt either way, never fail silently.
      const now = Math.floor(Date.now() / 1000);
      await env.ai_ceo_memory
        .prepare(`
          UPDATE self_mod_entries
          SET status = 'reverted', closed_at = ?, revert_reason = ?
          WHERE id = ?
        `)
        .bind(now, reason, entry.id)
        .run();

      await storeLesson(env, entry.id, reason);
      await sendEntryNotification(env, entry.id, "closed");
    }
  }

  return openEntries.length;
}

async function storeLesson(env, entryId, reason) {
  // Internal only — never surfaced on the reporting page.
  await env.ai_ceo_memory
    .prepare("INSERT INTO self_mod_lessons (source_entry_id, lesson, created_at) VALUES (?, ?, ?)")
    .bind(entryId, reason, Math.floor(Date.now() / 1000))
    .run();
}

// ---- Extension (max 2 per entry, must notify operator each time) ----

export async function extendDeadline(env, entryId, additionalDays) {
  const entry = await env.ai_ceo_memory
    .prepare("SELECT * FROM self_mod_entries WHERE id = ? AND status = 'open'")
    .bind(entryId)
    .first();

  if (!entry) throw new Error(`Entry ${entryId} not found or not open.`);
  if (entry.extension_count >= MAX_EXTENSIONS) {
    throw new Error(`Entry ${entryId} has already used its ${MAX_EXTENSIONS} allowed extensions.`);
  }

  const cappedDays = Math.min(additionalDays, MAX_DEADLINE_DAYS);
  const newDeadline = entry.deadline_at + daysToSeconds(cappedDays);

  await env.ai_ceo_memory
    .prepare(`
      UPDATE self_mod_entries
      SET deadline_at = ?, extension_count = extension_count + 1
      WHERE id = ?
    `)
    .bind(newDeadline, entryId)
    .run();

  await sendEntryNotification(env, entryId, "extended");
}

// ---- Succeed (close as succeeded, keep the change) ----

export async function markSucceeded(env, entryId) {
  const now = Math.floor(Date.now() / 1000);
  await env.ai_ceo_memory
    .prepare("UPDATE self_mod_entries SET status = 'succeeded', closed_at = ? WHERE id = ?")
    .bind(now, entryId)
    .run();

  await sendEntryNotification(env, entryId, "closed");
}

// ---- Deadline sweep (run on cron) ----

/**
 * Call this once per cron tick. Finds entries past deadline and decides
 * succeeded/reverted/needs-extension based on caller-supplied judgment.
 * judgeFn: (entry) => Promise<'succeeded' | 'reverted' | 'extend'>
 * This module doesn't decide success/failure itself — that judgment is
 * change-specific (a content change is judged by views, a technical change
 * by error rate, etc.) and belongs to the subsystem that owns the metric.
 */
export async function sweepExpiredEntries(env, judgeFn, applyRollback) {
  const now = Math.floor(Date.now() / 1000);
  const { results: expired } = await env.ai_ceo_memory
    .prepare("SELECT * FROM self_mod_entries WHERE status = 'open' AND deadline_at <= ?")
    .bind(now)
    .all();

  for (const entry of expired) {
    const verdict = await judgeFn(entry);

    if (verdict === "succeeded") {
      await markSucceeded(env, entry.id);
    } else if (verdict === "extend") {
      if (entry.extension_count >= MAX_EXTENSIONS) {
        // Final deadline reached with no further extensions allowed — must close.
        await revertAllOpenEntries(env, "Final deadline reached, no extensions remaining, results inconclusive.", applyRollback);
      } else {
        await extendDeadline(env, entry.id, MAX_DEADLINE_DAYS);
      }
    } else {
      // 'reverted' or any failure signal
      await revertAllOpenEntries(env, "Results did not materialize by deadline.", applyRollback);
    }
  }
}

// ---- Notifications ----

async function sendEntryNotification(env, entryId, eventType) {
  const settings = await env.ai_ceo_memory
    .prepare("SELECT enabled FROM notification_settings WHERE id = 1")
    .first();

  if (!settings || settings.enabled !== 1) return; // muted, skip silently (this is the one
                                                     // intentional silent-skip in the system,
                                                     // since muting is an explicit operator choice)

  const entry = await env.ai_ceo_memory
    .prepare("SELECT * FROM self_mod_entries WHERE id = ?")
    .bind(entryId)
    .first();

  if (!entry) return;

  // Actual email send is implemented in notifications.js (separate module,
  // since it needs the email provider/API key wiring). This just builds
  // the plain-language content.
  const { sendEmail } = await import("./notifications.js");

  let subject, body;
  const dashboardLink = "https://ai-ceo-orchestrator.jacklabs.workers.dev/dashboard";
  if (eventType === "opened") {
    subject = `Self-mod opened: ${entry.what_changed}`;
    body = `What changed: ${entry.what_changed}\nWhy: ${entry.why}\nExpected benefit: ${entry.expected_benefit}\nTracking: ${entry.metric_name}\nDeadline: ${new Date(entry.deadline_at * 1000).toLocaleString()}\n\nView on dashboard: ${dashboardLink}`;
  } else if (eventType === "extended") {
    subject = `Self-mod deadline extended: ${entry.what_changed}`;
    body = `This entry's deadline was extended (extension ${entry.extension_count} of ${MAX_EXTENSIONS}).\nNew deadline: ${new Date(entry.deadline_at * 1000).toLocaleString()}\n\nView on dashboard: ${dashboardLink}`;
  } else {
    subject = `Self-mod closed (${entry.status}): ${entry.what_changed}`;
    body = entry.status === "succeeded"
      ? `This change succeeded and has been kept.\nWhat changed: ${entry.what_changed}\n\nView on dashboard: ${dashboardLink}`
      : `This change was reverted.\nWhat changed: ${entry.what_changed}\nReason: ${entry.revert_reason || "not specified"}\n\nView on dashboard: ${dashboardLink}`;
  }

  const result = await sendEmail(env, subject, body);
  if (!result.sent) {
    // sendEmail already console.error'd the details, but Worker logs are
    // ephemeral and nothing else reads them - persist a trace here so a
    // broken notification path is visible via /status instead of silent.
    try {
      await env.ai_ceo_memory.prepare(
        "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
      ).bind("NOTIFICATION_SEND_FAILED", `Email for self-mod entry id=${entryId} (${eventType}) failed: ${result.reason}${result.message ? " - " + result.message : ""}`).run();
    } catch (alertErr) {
      console.error("LOUD LOG: could not record NOTIFICATION_SEND_FAILED alert:", alertErr.message);
    }
  }
}
