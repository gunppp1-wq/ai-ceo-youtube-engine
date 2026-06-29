import { passesPlatformSafetyGate } from "./protected-core.js";

const RESEARCH_PROPOSAL_TASK_NAME = "weekly_research_proposal";
const RESEARCH_PROPOSAL_GATE_HOURS = 24 * 7;

export async function shouldRunResearchProposal(env) {
  const row = await env.ai_ceo_memory.prepare(
    "SELECT last_run_at FROM scheduler_state WHERE task_name = ?"
  ).bind(RESEARCH_PROPOSAL_TASK_NAME).first();
  const hoursSinceLastRun = row && row.last_run_at
    ? (Date.now() - new Date(row.last_run_at).getTime()) / (1000 * 60 * 60)
    : Infinity;
  return hoursSinceLastRun >= RESEARCH_PROPOSAL_GATE_HOURS;
}

export async function markResearchProposalRun(env) {
  await env.ai_ceo_memory.prepare(
    "INSERT INTO scheduler_state (task_name, last_run_at) VALUES (?, ?) ON CONFLICT(task_name) DO UPDATE SET last_run_at = excluded.last_run_at"
  ).bind(RESEARCH_PROPOSAL_TASK_NAME, new Date().toISOString()).run();
}

async function writeProposal(env, options) {
  const safetyCheck = passesPlatformSafetyGate(options.summary);
  if (!safetyCheck.passes) {
    console.log(`Research proposal BLOCKED by safety gate: ${safetyCheck.reason}`);
    return null;
  }
  const result = await env.ai_ceo_memory.prepare(
    "INSERT INTO content_proposals (proposal_type, summary, supporting_data, status) VALUES (?, ?, ?, 'pending') RETURNING id"
  ).bind(options.proposalType, options.summary, JSON.stringify(options.supportingData)).first();
  console.log(`Research proposal written: id=${result ? result.id : null}, type=${options.proposalType}`);
  return result ? result.id : null;
}

export async function generateWeeklyResearchProposal(env) {
  try {
    const deadLetterRows = await env.ai_ceo_memory.prepare(
      "SELECT cp.id, cp.title, cp.failed_attempts FROM content_plans cp WHERE cp.failed_attempts >= 3 AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)"
    ).all();

    if (deadLetterRows.results.length >= 3) {
      const titleCounts = {};
      for (const row of deadLetterRows.results) {
        titleCounts[row.title] = (titleCounts[row.title] || 0) + 1;
      }
      const repeatedTitle = Object.entries(titleCounts).find(function(entry) { return entry[1] > 1; });
      if (repeatedTitle) {
        const summary = `${deadLetterRows.results.length} content plans are permanently stuck (failed_attempts >= 3) without ever producing a video. The title "${repeatedTitle[0]}" alone accounts for ${repeatedTitle[1]} of them, suggesting a systemic cause rather than independent random failures. Recommend investigating what specifically fails for this topic before it recurs further.`;
        await writeProposal(env, {
          proposalType: "dead_letter_pattern",
          summary: summary,
          supportingData: { deadLetterCount: deadLetterRows.results.length, repeatedTitle: repeatedTitle[0], repeatedCount: repeatedTitle[1] }
        });
        return;
      }
    }

    const latestAssessment = await env.ai_ceo_memory.prepare(
      "SELECT chosen_value, reasoning, created_at FROM reasoning_history WHERE decision_type = 'strategy_assessment' ORDER BY id DESC LIMIT 1"
    ).first();

    if (latestAssessment) {
      const ageHours = (Date.now() - new Date(latestAssessment.created_at).getTime()) / (1000 * 60 * 60);
      if (ageHours <= 24 * 7) {
        const summary = `Latest channel strategy assessment (${latestAssessment.created_at}): ${latestAssessment.reasoning}`;
        await writeProposal(env, {
          proposalType: "strategy_assessment_followup",
          summary: summary,
          supportingData: { metrics: latestAssessment.chosen_value, assessedAt: latestAssessment.created_at }
        });
        return;
      }
    }

    console.log("Weekly research proposal: no actionable signal found this week, skipping rather than generating a speculative proposal.");
  } catch (proposalErr) {
    console.log("Non-fatal: weekly research proposal generation failed:", proposalErr.message);
  }
}