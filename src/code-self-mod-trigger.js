// ============================================================
// SELF-MODIFICATION TRIGGER ??broad mandate, per the build spec:
// "the program may attempt a code/logic/strategy modification on its
// own initiative." No narrow metric defines this trigger; the program
// itself decides whether something is worth attempting, each cron tick,
// subject to: the daily speed limit, the locked files being off-limits,
// and every mechanic already enforced in self-mod-lifecycle.js and
// code-self-mod.js (syntax check, backup-before-deploy, revert-first).
// ============================================================

import { canOpenNewEntry } from "./self-mod-lifecycle.js";
import { proposeAndDeployCodeChange } from "./code-self-mod.js";

/**
 * Gathers a broad snapshot of recent system signals for the program to
 * reason over ??not a narrow metric, just real, current context so its
 * decision is grounded in actual state rather than guessing blind.
 */
async function gatherSystemSnapshot(env) {
  const recentAlerts = await env.ai_ceo_memory
    .prepare("SELECT alert_type, message, created_at FROM system_alerts ORDER BY id DESC LIMIT 10")
    .all();

  const analyzerFailed = await env.ai_ceo_memory
    .prepare("SELECT COUNT(*) as cnt FROM analyzer_inputs WHERE status = 'failed'")
    .first();

  const backlogRow = await env.ai_ceo_memory
    .prepare("SELECT COUNT(*) as cnt FROM content_plans cp WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)")
    .first();

  const recentVideoPerf = await env.ai_ceo_memory
    .prepare("SELECT views, likes, comments FROM video_performance ORDER BY id DESC LIMIT 10")
    .all();

  // Internal-only lessons from past reverted attempts. Per the spec these
  // are NEVER surfaced on the reporting page ??they exist only to inform
  // this decision-making prompt, nothing else reads or displays them.
  const lessons = await env.ai_ceo_memory
    .prepare("SELECT lesson FROM self_mod_lessons ORDER BY id DESC LIMIT 5")
    .all();

  return {
    recentAlerts: recentAlerts.results || [],
    analyzerFailedCount: analyzerFailed ? analyzerFailed.cnt : 0,
    contentBacklog: backlogRow ? backlogRow.cnt : 0,
    recentVideoPerformance: recentVideoPerf.results || [],
    pastLessons: (lessons.results || []).map(r => r.lesson)
  };
}

/**
 * Asks the AI binding whether, given the current system snapshot, there
 * is a code-level change worth attempting right now. Returns either
 * null (nothing worth attempting) or a structured proposal the program
 * itself generated: which file, what to change, why, expected benefit,
 * what metric to judge it by.
 */
async function decideOnSelfModification(env, snapshot) {
  const lessonsBlock = snapshot.pastLessons.length > 0
    ? "LESSONS FROM YOUR OWN PAST FAILED ATTEMPTS (avoid repeating these mistakes):\n" + snapshot.pastLessons.map(l => "- " + l).join("\n")
    : "No past failed attempts on record.";

  const prompt = `You are an autonomous YouTube automation system reviewing your own recent operational data, deciding whether to attempt a self-modification to your own code.

RECENT SYSTEM ALERTS (last 10):
${JSON.stringify(snapshot.recentAlerts)}

ANALYZER ITEMS CURRENTLY FAILED: ${snapshot.analyzerFailedCount}
CONTENT BACKLOG (unused plans): ${snapshot.contentBacklog}
RECENT VIDEO PERFORMANCE (last 10): ${JSON.stringify(snapshot.recentVideoPerformance)}

${lessonsBlock}

You may ONLY target one of these exact filenames - do not invent or guess any other filename: index.js, notifications.js, publish-hour-self-mod.js, payment-proposal-trigger.js, gate-integrity-check.js, code-self-mod-trigger.js, speed-limit-proposal.js. (protected-core.js, self-mod-lifecycle.js, and code-self-mod.js are permanently off-limits and must never be proposed under any framing - they are intentionally excluded from the allowed list above.)

IMPORTANT: if your proposed change depends on any paid-tier resource (e.g. a raised neuron budget, a higher rate limit, a paid third-party service), it must still function correctly if that resource later becomes unavailable (payment lapses, reverts to free tier). Do not write logic that assumes a paid tier is permanent - always include a fallback to free-tier behavior. State explicitly in WHY if your change has any paid-tier dependency and what the fallback is.

If nothing here genuinely justifies a code change right now, respond with exactly: NONE

If something does justify a change, respond with EXACTLY this format, nothing else:
TARGET_FILE: <filename, e.g. index.js>
WHAT_CHANGED: <one plain-language sentence>
WHY: <one or two plain-language sentences, grounded in the data above>
EXPECTED_BENEFIT: <one plain-language sentence>
METRIC_NAME: <short snake_case name for what you'll judge this by>
METRIC_QUERY: <a single SQL SELECT statement against the existing database schema that returns ONE numeric value to track this metric over time>
DEADLINE_DAYS: <a number between 1 and 30>`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });

  const text = (response.response || "").trim();
  if (text === "NONE" || text.startsWith("NONE")) {
    return null;
  }

  const fields = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }

  if (!fields.TARGET_FILE || !fields.WHAT_CHANGED || !fields.WHY) {
    console.error("LOUD LOG: self-mod decision response was malformed, could not parse required fields. Treating as no decision.", { rawText: text });
    return null;
  }

  const deadlineDays = parseInt(fields.DEADLINE_DAYS, 10);

  return {
    targetFile: fields.TARGET_FILE,
    whatChanged: fields.WHAT_CHANGED,
    why: fields.WHY,
    expectedBenefit: fields.EXPECTED_BENEFIT || "Not specified.",
    metricName: fields.METRIC_NAME || "unnamed_metric",
    metricQuery: fields.METRIC_QUERY || null,
    deadlineDays: (Number.isFinite(deadlineDays) && deadlineDays >= 1 && deadlineDays <= 30) ? deadlineDays : 14
  };
}

/**
 * The actual entry point called from the cron. Checks the speed limit,
 * gathers context, asks the program to decide, and if it decides to act,
 * hands off to proposeAndDeployCodeChange (which itself re-checks locked
 * files, runs the syntax check, and only deploys if everything passes).
 * Returns the new entry ID, or null if nothing was attempted.
 */
export async function maybeAttemptCodeSelfModification(env) {
  if (!(await canOpenNewEntry(env))) {
    return null; // daily speed limit already used today
  }

  const snapshot = await gatherSystemSnapshot(env);
  const decision = await decideOnSelfModification(env, snapshot);

  if (!decision) {
    return null; // program itself decided nothing was worth attempting
  }

  console.log("Self-modification decision made.", { targetFile: decision.targetFile, whatChanged: decision.whatChanged });

  return await proposeAndDeployCodeChange(env, decision);
}
