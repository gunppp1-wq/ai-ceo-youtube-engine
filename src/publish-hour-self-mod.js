// ============================================================
// PUBLISH-HOUR SELF-MODIFICATION
// First real self-modification capability: the program can propose
// trying a different publish hour if data shows the current rotation
// hour is underperforming, using the open/monitor/revert lifecycle
// already built in self-mod-lifecycle.js.
//
// Gated by a minimum-volume rule (30 total published videos) because
// at lower volume, any hour-vs-hour comparison is statistical noise,
// not signal. Below the gate, this module does nothing by design.
// ============================================================

import { openEntry, canOpenNewEntry } from "./self-mod-lifecycle.js";

const MIN_TOTAL_VIDEOS_FOR_HOUR_ANALYSIS = 30;
const MIN_VIDEOS_PER_HOUR_TO_JUDGE = 3;
const TRIAL_DEADLINE_DAYS = 14;

function weightedScore(views, likes, comments) {
  return (views || 0) + (likes || 0) * 5 + (comments || 0) * 10;
}

/**
 * Returns { ready: false, totalVideos, needed } if not enough data yet,
 * or { ready: true, hourStats } with per-hour scores if the gate is open.
 */
export async function getPublishHourAnalysis(env) {
  const totalRow = await env.ai_ceo_memory
    .prepare("SELECT COUNT(*) as cnt FROM videos WHERE status = 'published'")
    .first();
  const totalVideos = totalRow ? totalRow.cnt : 0;

  if (totalVideos < MIN_TOTAL_VIDEOS_FOR_HOUR_ANALYSIS) {
    return { ready: false, totalVideos, needed: MIN_TOTAL_VIDEOS_FOR_HOUR_ANALYSIS };
  }

  // Join videos -> video_performance, group by the hour they were actually
  // published at (target_publish_hour reflects what was used, per markHourUsed()).
  const { results } = await env.ai_ceo_memory
    .prepare(`
      SELECT v.target_publish_hour as hour,
             COUNT(*) as video_count,
             AVG(COALESCE(vp.views, 0)) as avg_views,
             AVG(COALESCE(vp.likes, 0)) as avg_likes,
             AVG(COALESCE(vp.comments, 0)) as avg_comments
      FROM videos v
      LEFT JOIN video_performance vp ON vp.video_id = v.id
      WHERE v.status = 'published' AND v.target_publish_hour IS NOT NULL
      GROUP BY v.target_publish_hour
    `)
    .all();

  const hourStats = (results || [])
    .map(r => ({
      hour: r.hour,
      videoCount: r.video_count,
      score: weightedScore(r.avg_views, r.avg_likes, r.avg_comments),
      eligible: r.video_count >= MIN_VIDEOS_PER_HOUR_TO_JUDGE
    }))
    .sort((a, b) => b.score - a.score); // best first

  return { ready: true, totalVideos, hourStats };
}

/**
 * Checks whether a publish-hour trial should be proposed right now.
 * Returns the new entry ID if one was opened, or null if conditions
 * weren't met (not enough data, no underperforming hour found, or a
 * publish-hour trial is already open).
 */
export async function maybeProposePublishHourTrial(env) {
  // Don't open a second publish-hour trial while one is already running.
  const existingTrial = await env.ai_ceo_memory
    .prepare("SELECT id FROM self_mod_entries WHERE status = 'open' AND metric_name = 'publish_hour_score'")
    .first();
  if (existingTrial) return null;

  if (!(await canOpenNewEntry(env))) {
    return null;
  }

  const analysis = await getPublishHourAnalysis(env);
  if (!analysis.ready) return null;

  const eligible = analysis.hourStats.filter(h => h.eligible);
  if (eligible.length < 2) return null; // need at least 2 eligible hours to compare

  const bottomThirdCount = Math.max(1, Math.floor(eligible.length / 3));
  const worstHours = eligible.slice(-bottomThirdCount); // eligible is sorted best-first
  const bestHour = eligible[0];

  if (worstHours.length === 0) return null;

  // Pick the single worst eligible hour as the trial candidate to move away from.
  const candidateHour = worstHours[worstHours.length - 1];

  // Don't propose "switching" a hour to itself.
  if (candidateHour.hour === bestHour.hour) return null;

  // Check past lessons: if this exact hour-pair was already tried and
  // reverted recently, don't immediately re-propose the identical change.
  // This is the publish-hour trigger's concrete use of the lessons-learned
  // mechanic — a deterministic rule-based trigger has no LLM decision to
  // "inform," but it can still avoid mechanically repeating a known failure.
  const recentLesson = await env.ai_ceo_memory
    .prepare("SELECT lesson FROM self_mod_lessons ORDER BY id DESC LIMIT 10")
    .all();
  const alreadyTriedThisPair = (recentLesson.results || []).some(
    r => r.lesson && r.lesson.includes("hour " + candidateHour.hour) && r.lesson.includes("toward " + bestHour.hour)
  );
  if (alreadyTriedThisPair) {
    console.log("Publish-hour trial skipped: this exact hour change was already tried and reverted recently.");
    return null;
  }

  const entryId = await openEntry(env, {
    whatChanged: `Shifting publish-hour rotation away from ${candidateHour.hour}:00 UTC toward ${bestHour.hour}:00 UTC`,
    why: `Hour ${candidateHour.hour}:00 UTC ranks in the bottom third of all hours with enough data (${candidateHour.videoCount} videos, score ${Math.round(candidateHour.score)}), while ${bestHour.hour}:00 UTC currently scores highest (${Math.round(bestHour.score)}).`,
    expectedBenefit: "Higher average views/likes/comments per video by favoring a better-performing publish hour.",
    metricName: "publish_hour_score",
    metricBaseline: candidateHour.score,
    deadlineDays: TRIAL_DEADLINE_DAYS,
    rollbackData: { candidateHour: candidateHour.hour, previousBestHour: bestHour.hour }
  });

  // NOTE: this function does NOT call markHourUsed() itself, to avoid a
  // circular import back into index.js. The caller (index.js, where
  // markHourUsed already lives) is responsible for actually steering the
  // rotation using the returned candidateHour, e.g.:
  //   const entryId = await maybeProposePublishHourTrial(env);
  //   if (entryId) { await markHourUsed(env, <candidateHour from the entry>); }
  // The candidate hour is also stored in rollback_data on the entry itself,
  // so it can always be recovered later without needing it returned here.

  return entryId;
}

/**
 * Judge function for sweepExpiredEntries(). Compares the trial hour's
 * current score against its pre-trial baseline.
 */
export async function judgePublishHourTrial(env, entry) {
  const rollback = entry.rollback_data ? JSON.parse(entry.rollback_data) : null;
  if (!rollback) return "reverted"; // can't judge without knowing what we changed

  const analysis = await getPublishHourAnalysis(env);
  if (!analysis.ready) return "extend"; // shouldn't normally happen, but extend rather than guess

  const candidateNow = analysis.hourStats.find(h => h.hour === rollback.candidateHour);
  if (!candidateNow || candidateNow.videoCount < MIN_VIDEOS_PER_HOUR_TO_JUDGE) {
    return "extend"; // not enough new data yet at this hour to judge fairly
  }

  const improved = candidateNow.score > entry.metric_baseline;
  return improved ? "succeeded" : "reverted";
}

/**
 * Rollback function for revertAllOpenEntries(). Undoes the steering
 * applied when the trial opened: clears the artificial last_used_at
 * timestamp on the candidate hour so it returns to normal rotation
 * eligibility, exactly as if the trial had never been proposed.
 *
 * This does NOT touch any code or config — only the one D1 row that
 * was written when the trial opened. That's deliberate: the entire
 * "modification" here is a single timestamp write, so undoing it is
 * a single timestamp clear, nothing more.
 */
export async function rollbackPublishHourTrial(env, entry) {
  const rollback = entry.rollback_data ? JSON.parse(entry.rollback_data) : null;
  if (!rollback || rollback.candidateHour === undefined) {
    // Nothing we recognize to roll back; loud-log and move on rather than guess.
    console.error("LOUD LOG: publish-hour rollback called on entry with no recognizable rollback_data.", { entryId: entry.id });
    return;
  }

  // Clear the artificial "recently used" marker on the candidate hour.
  // Setting last_used_at far in the past makes it immediately eligible
  // again under the existing least-recently-used logic in getNextRotationHour().
  await env.ai_ceo_memory
    .prepare("UPDATE publish_hour_rotation SET last_used_at = datetime('now', '-999 days') WHERE hour = ?")
    .bind(rollback.candidateHour)
    .run();

  // Store a specific, matchable lesson — separate from the generic one
  // revertAllOpenEntries() already records — so maybeProposePublishHourTrial()
  // can detect "this exact hour pair was already tried" on future runs.
  // Internal only, per the spec: never surfaced on the reporting page.
  const lessonText = "Tried moving away from hour " + rollback.candidateHour + " toward " + rollback.previousBestHour + ", but it was reverted  (no improvement).";
  await env.ai_ceo_memory
    .prepare("INSERT INTO self_mod_lessons (source_entry_id, lesson, created_at) VALUES (?, ?, ?)")
    .bind(entry.id, lessonText, Math.floor(Date.now() / 1000))
    .run();

  console.log("Publish-hour trial reverted: hour " + rollback.candidateHour + " returned to normal rotation eligibility.");
}

