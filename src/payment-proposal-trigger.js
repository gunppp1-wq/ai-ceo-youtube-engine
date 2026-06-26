// ============================================================
// PAYMENT PROPOSAL: Workers plan upgrade triggered by growing backlog
//
// Real, evidence-based trigger: the existing LIMIT 1 workaround (added
// after hitting Cloudflare's 50-subrequest-per-invocation free-tier
// ceiling) processes one unused content plan's assets per cron tick.
// If the backlog of unused plans is GROWING over time, that's concrete
// evidence the 1-per-tick rate can no longer keep up — the honest signal
// to propose lifting the subrequest ceiling via the Workers Paid plan.
//
// This does NOT propose anything based on the neuron/AI budget, since
// real usage data showed that budget isn't currently constrained.
// ============================================================

const BACKLOG_GROWTH_LOOKBACK_DAYS = 7;
const BACKLOG_GROWTH_THRESHOLD = 10; // backlog must have grown by at least this many items
const REJECTED_PROPOSAL_COOLDOWN_DAYS = 30;

/**
 * Checks whether the unused-plans backlog has grown enough to justify
 * proposing a Workers plan upgrade, and writes the proposal if so.
 * Respects the no-repeat-spam rule: won't create a duplicate if one is
 * already pending/approved, was paid_confirmed (done forever), or was
 * rejected within the cooldown window.
 */
export async function maybeProposeWorkersPlanUpgrade(env) {
  // 1. Don't propose if a matching proposal already exists in a state
  //    that means "already being handled" or "too soon to ask again".
  const existing = await env.ai_ceo_memory
    .prepare(`
      SELECT id, status, decided_at FROM payment_proposals
      WHERE config_key = 'WORKERS_PLAN_UPGRADE'
      ORDER BY created_at DESC LIMIT 1
    `)
    .first();

  if (existing) {
    if (existing.status === "pending" || existing.status === "approved") {
      return null; // already awaiting action or in progress, don't duplicate
    }
    if (existing.status === "paid_confirmed") {
      return null; // already upgraded, never ask again for this exact thing
    }
    if (existing.status === "rejected" && existing.decided_at) {
      const daysSinceRejected = (Date.now() / 1000 - existing.decided_at) / 86400;
      if (daysSinceRejected < REJECTED_PROPOSAL_COOLDOWN_DAYS) {
        return null; // too soon to re-ask after a rejection
      }
      // else: cooldown has passed, allowed to propose again below
    }
  }

  // 2. Check real backlog growth, not just current size.
  const currentBacklogRow = await env.ai_ceo_memory
    .prepare(`
      SELECT COUNT(*) as cnt FROM content_plans cp
      WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)
    `)
    .first();
  const currentBacklog = currentBacklogRow ? currentBacklogRow.cnt : 0;

  // Snapshot table: records backlog size once per day so growth can be
  // measured later. If this table doesn't have a row from ~7 days ago yet,
  // we can't measure growth honestly — don't propose anything speculative.
  const pastSnapshot = await env.ai_ceo_memory
    .prepare(`
      SELECT backlog_count FROM backlog_snapshots
      WHERE snapshot_date <= date('now', '-' || ? || ' days')
      ORDER BY snapshot_date DESC LIMIT 1
    `)
    .bind(BACKLOG_GROWTH_LOOKBACK_DAYS)
    .first();

  if (!pastSnapshot) {
    return null; // not enough history yet to measure real growth
  }

  const growth = currentBacklog - pastSnapshot.backlog_count;
  if (growth < BACKLOG_GROWTH_THRESHOLD) {
    return null; // not growing fast enough to justify a proposal
  }

  // 3. Write the actual proposal.
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ai_ceo_memory
    .prepare(`
      INSERT INTO payment_proposals
        (title, description, cost_summary, payment_url, danger_level,
         proposal_type, config_key, config_new_value, status, created_at)
      VALUES (?, ?, ?, ?, 'low', 'known_upgrade', 'WORKERS_PLAN_UPGRADE', 'paid', 'pending', ?)
      RETURNING id
    `)
    .bind(
      "Upgrade Cloudflare Workers plan",
      `The backlog of content waiting for video assembly has grown by ${growth} items over the last ${BACKLOG_GROWTH_LOOKBACK_DAYS} days (now ${currentBacklog} total). This system currently processes only 1 item per hour to stay under Cloudflare's free-tier 50-subrequest-per-invocation limit. The Workers Paid plan removes that ceiling entirely, letting the backlog actually shrink instead of grow.`,
      "$5/month",
      "https://dash.cloudflare.com/?to=/:account/workers/plans",
      now
    )
    .first();

  console.log(`Payment proposal created: Workers plan upgrade (id=${result.id}), backlog grew by ${growth} in ${BACKLOG_GROWTH_LOOKBACK_DAYS} days.`);
  return result.id;
}

/**
 * Records today's backlog size, once per day, so future calls to
 * maybeProposeWorkersPlanUpgrade() can measure real growth over time.
 * Call this once per cron tick; it no-ops if today's snapshot already exists.
 */
export async function recordBacklogSnapshot(env) {
  const today = new Date().toISOString().slice(0, 10);
  const alreadyRecorded = await env.ai_ceo_memory
    .prepare("SELECT 1 FROM backlog_snapshots WHERE snapshot_date = ?")
    .bind(today)
    .first();
  if (alreadyRecorded) return;

  const backlogRow = await env.ai_ceo_memory
    .prepare(`
      SELECT COUNT(*) as cnt FROM content_plans cp
      WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)
    `)
    .first();

  await env.ai_ceo_memory
    .prepare("INSERT INTO backlog_snapshots (snapshot_date, backlog_count) VALUES (?, ?)")
    .bind(today, backlogRow ? backlogRow.cnt : 0)
    .run();
}
