const DELAYED_FAILURE_TASK_NAME = "weekly_delayed_failure_sweep";
const DELAYED_FAILURE_GATE_HOURS = 24 * 7;

export async function shouldRunDelayedFailureSweep(env) {
  const row = await env.ai_ceo_memory.prepare(
    "SELECT last_run_at FROM scheduler_state WHERE task_name = ?"
  ).bind(DELAYED_FAILURE_TASK_NAME).first();
  const hoursSinceLastRun = row && row.last_run_at
    ? (Date.now() - new Date(row.last_run_at).getTime()) / (1000 * 60 * 60)
    : Infinity;
  return hoursSinceLastRun >= DELAYED_FAILURE_GATE_HOURS;
}

export async function markDelayedFailureSweepRun(env) {
  await env.ai_ceo_memory.prepare(
    "INSERT INTO scheduler_state (task_name, last_run_at) VALUES (?, ?) ON CONFLICT(task_name) DO UPDATE SET last_run_at = excluded.last_run_at"
  ).bind(DELAYED_FAILURE_TASK_NAME, new Date().toISOString()).run();
}

export async function runDelayedFailureSweep(env) {
  try {
    const closedCodeEntries = await env.ai_ceo_memory.prepare(`
      SELECT sme.id, sme.closed_at, csmm.target_file
      FROM self_mod_entries sme
      JOIN code_self_mod_metadata csmm ON csmm.self_mod_entry_id = sme.id
      WHERE sme.status = 'succeeded'
    `).all();

    if (closedCodeEntries.results.length === 0) {
      console.log("Delayed-failure sweep: no closed code-mod entries to check this week.");
      return;
    }

    let reopenedCount = 0;
    for (const entry of closedCodeEntries.results) {
      const closedAtIso = new Date(entry.closed_at * 1000).toISOString().slice(0, 19).replace("T", " ");

      const matchingAlerts = await env.ai_ceo_memory.prepare(`
        SELECT id, alert_type, message, created_at FROM system_alerts
        WHERE created_at > ? AND message LIKE ?
        ORDER BY id DESC LIMIT 5
      `).bind(closedAtIso, `%${entry.target_file}%`).all();

      if (matchingAlerts.results.length > 0) {
        console.log(`Delayed-failure sweep: entry id=${entry.id} (target_file=${entry.target_file}) closed at ${closedAtIso}, but ${matchingAlerts.results.length} alert(s) since then mention this file. Reopening for re-judgment.`);

        const nowSeconds = Math.floor(Date.now() / 1000);
        await env.ai_ceo_memory.prepare(
          "UPDATE self_mod_entries SET status = 'open', deadline_at = ? WHERE id = ?"
        ).bind(nowSeconds, entry.id).run();

        await env.ai_ceo_memory.prepare(
          "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
        ).bind(
          "DELAYED_FAILURE_REOPENED",
          `Self-mod entry id=${entry.id} (file: ${entry.target_file}) was reopened after closing successfully, because ${matchingAlerts.results.length} new alert(s) since its closure mention the same file. It will be re-judged by the normal sweep on the next tick - if the underlying problem is confirmed, the existing revert mechanism will restore the prior working version automatically.`
        ).run();

        reopenedCount++;
      }
    }

    if (reopenedCount === 0) {
      console.log(`Delayed-failure sweep: checked ${closedCodeEntries.results.length} closed code-mod entries, no new problems found.`);
    }
  } catch (sweepErr) {
    console.log("Non-fatal: delayed-failure sweep failed:", sweepErr.message);
  }
}