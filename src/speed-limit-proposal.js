// ============================================================
// SPEED LIMIT RAISE PROPOSAL
// Per the spec: "The program may propose raising [the daily self-mod
// limit], presented on the reporting page as a request the operator
// approves/rejects, including: the program's actual success rate as
// evidence, and a danger-level label (Low/Medium/High)."
//
// This is its own small flow, separate from payment proposals (no
// money involved) and separate from regular self-mod entries (this
// doesn't open/monitor/revert — it's a one-shot operator decision).
// ============================================================

const COOLDOWN_DAYS_AFTER_REJECTION = 14;

/**
 * Computes the program's actual success rate from real history:
 * succeeded vs reverted entries, plus how quickly failures were caught
 * (time from open to revert) as a proxy for "how risky recent attempts
 * have been" — feeding the danger-level label.
 */
async function computeSelfModTrackRecord(env) {
  const { results: closedEntries } = await env.ai_ceo_memory
    .prepare("SELECT status, opened_at, closed_at FROM self_mod_entries WHERE status IN ('succeeded', 'reverted') ORDER BY id DESC LIMIT 20")
    .all();

  const total = closedEntries.length;
  const succeeded = closedEntries.filter(e => e.status === "succeeded").length;
  const reverted = closedEntries.filter(e => e.status === "reverted").length;

  if (total === 0) {
    return { total: 0, succeeded: 0, reverted: 0, successRate: null, avgRevertHours: null, dangerLevel: "Low" };
  }

  const revertedEntries = closedEntries.filter(e => e.status === "reverted" && e.closed_at);
  const revertDurations = revertedEntries.map(e => (e.closed_at - e.opened_at) / 3600);
  const avgRevertHours = revertDurations.length > 0
    ? revertDurations.reduce((a, b) => a + b, 0) / revertDurations.length
    : null;

  const successRate = succeeded / total;

  // Danger label: factor in both how often things fail AND how fast
  // failures were caught (per the spec — "severity of past failures and
  // how fast they were caught, not just count").
  let dangerLevel = "Low";
  if (successRate < 0.5) {
    dangerLevel = "High";
  } else if (successRate < 0.8 || (avgRevertHours !== null && avgRevertHours > 72)) {
    dangerLevel = "Medium";
  }

  return { total, succeeded, reverted, successRate, avgRevertHours, dangerLevel };
}

/**
 * Checks whether conditions justify the program proposing a higher daily
 * speed limit, and if so, writes the proposal. Respects the no-repeat-
 * spam rule: won't duplicate a pending proposal, and respects a cooldown
 * after a rejection (this reuses payment_proposals' shape/table since
 * the spec describes a very similar "propose, approve/reject" flow,
 * even though no money is involved here).
 */
export async function maybeProposeSpeedLimitIncrease(env) {
  const existing = await env.ai_ceo_memory
    .prepare(`
      SELECT id, status, decided_at FROM payment_proposals
      WHERE config_key = 'SELF_MOD_DAILY_LIMIT'
      ORDER BY created_at DESC LIMIT 1
    `)
    .first();

  if (existing) {
    if (existing.status === "pending" || existing.status === "approved") {
      return null;
    }
    if (existing.status === "rejected" && existing.decided_at) {
      const daysSince = (Date.now() / 1000 - existing.decided_at) / 86400;
      if (daysSince < COOLDOWN_DAYS_AFTER_REJECTION) {
        return null;
      }
    }
    // paid_confirmed doesn't apply here (no real payment), but if ever
    // set, treat as "already raised" and don't propose the same raise again.
    if (existing.status === "paid_confirmed") {
      return null;
    }
  }

  const trackRecord = await computeSelfModTrackRecord(env);

  // Only propose raising the limit once there's enough real history to
  // make an honest case — an empty or tiny track record isn't evidence.
  if (trackRecord.total < 5) {
    return null;
  }
  // Only propose if the track record is actually good — a high-failure
  // history is a reason NOT to ask for more autonomy, not a reason to ask.
  if (trackRecord.dangerLevel === "High") {
    return null;
  }

  const currentLimitRow = await env.ai_ceo_memory
    .prepare("SELECT daily_limit FROM self_mod_speed_limit WHERE id = 1")
    .first();
  const currentLimit = currentLimitRow ? currentLimitRow.daily_limit : 1;
  const proposedLimit = currentLimit + 1;

  const successRatePct = trackRecord.successRate !== null ? Math.round(trackRecord.successRate * 100) : "unknown";
  const now = Math.floor(Date.now() / 1000);

  const result = await env.ai_ceo_memory
    .prepare(`
      INSERT INTO payment_proposals
        (title, description, cost_summary, payment_url, danger_level,
         proposal_type, config_key, config_new_value, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'known_upgrade', 'SELF_MOD_DAILY_LIMIT', ?, 'pending', ?)
      RETURNING id
    `)
    .bind(
      "Raise self-modification speed limit to " + proposedLimit + " per day",
      "Based on the last " + trackRecord.total + " closed self-modification attempts: " + trackRecord.succeeded + " succeeded, " + trackRecord.reverted + " reverted (" + successRatePct + "% success rate). Currently limited to " + currentLimit + " new attempt(s) per day. Requesting permission to raise this to " + proposedLimit + " per day.",
      "No cost — this does not involve any payment or third-party service.",
      "#", // no external payment page; approval itself is the action
      trackRecord.dangerLevel.toLowerCase(),
      String(proposedLimit),
      now
    )
    .first();

  console.log("Speed limit increase proposed: id=" + result.id + ", " + currentLimit + " -> " + proposedLimit + " (" + trackRecord.dangerLevel + " risk, " + successRatePct + "% success rate)");
  return result.id;
}

/**
 * Called when the operator approves a SELF_MOD_DAILY_LIMIT proposal.
 * Unlike a real payment, this takes effect immediately on approval —
 * there's no external "go pay for it" step, so approve = apply.
 */
export async function applyApprovedSpeedLimitIncrease(env, proposalId) {
  const proposal = await env.ai_ceo_memory
    .prepare("SELECT * FROM payment_proposals WHERE id = ? AND config_key = 'SELF_MOD_DAILY_LIMIT' AND status = 'approved'")
    .bind(proposalId)
    .first();

  if (!proposal) {
    return { ok: false, error: "Proposal not found or not approved" };
  }

  const newLimit = parseInt(proposal.config_new_value, 10);
  if (!Number.isFinite(newLimit) || newLimit < 1) {
    return { ok: false, error: "Invalid stored limit value" };
  }

  await env.ai_ceo_memory
    .prepare("UPDATE self_mod_speed_limit SET daily_limit = ? WHERE id = 1")
    .bind(newLimit)
    .run();

  const now = Math.floor(Date.now() / 1000);
  await env.ai_ceo_memory
    .prepare("UPDATE payment_proposals SET status = 'paid_confirmed', paid_confirmed_at = ? WHERE id = ?")
    .bind(now, proposalId)
    .run();

  console.log("Self-modification daily limit raised to " + newLimit + " (proposal id=" + proposalId + ")");
  return { ok: true, newLimit };
}

/**
 * Returns prior decisions on similar proposals, for the "precedent" UI
 * feature described in the spec: "repeated similar future proposals may
 * reference prior operator decisions as precedent shown on the page."
 * Matches on config_key, since that's the stable identifier for "this
 * same kind of request" across multiple proposal instances.
 */
export async function getProposalPrecedents(env, configKey, excludeProposalId) {
  const { results } = await env.ai_ceo_memory
    .prepare(`
      SELECT id, status, decided_at, created_at FROM payment_proposals
      WHERE config_key = ? AND id != ? AND status IN ('approved', 'rejected', 'paid_confirmed')
      ORDER BY created_at DESC LIMIT 5
    `)
    .bind(configKey, excludeProposalId)
    .all();
  return results || [];
}
