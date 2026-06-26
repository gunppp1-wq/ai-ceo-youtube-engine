// ============================================================
// GENERAL CODE SELF-MODIFICATION
// The program can propose, generate, and deploy changes to its own
// source code (any file except protected-core.js and the self-mod
// safety files themselves, which are physically off-limits).
//
// Mechanics follow the build spec exactly: open with plain-language
// fields, monitor a self-chosen metric, revert immediately and
// unconditionally on failure (no live patching), max 2 extensions,
// 30-day cap per deadline.
//
// Revert for arbitrary code = restoring the exact prior file content
// from code_file_backups, since there is no generic way to "undo" an
// LLM-generated diff.
// ============================================================

import { openEntry } from "./self-mod-lifecycle.js";

// Files that physically cannot be targeted by self-modification, ever.
// Enforced here, not just "instructed" — every entry point in this file
// checks against this list before doing anything.
const LOCKED_FILES = [
  "src/protected-core.js",
  "src/self-mod-lifecycle.js",
  "src/code-self-mod.js" // this file itself
];

function isLockedFile(filePath) {
  return LOCKED_FILES.some(locked => filePath.endsWith(locked) || filePath === locked);
}

/**
 * Parse-checks JavaScript without executing it. Workers have no
 * child_process / node -c equivalent, so this is the available substitute:
 * `new Function(code)` throws a SyntaxError at parse time for invalid
 * syntax, without ever calling the resulting function.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function syntaxCheck(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * The full set of module files that make up this Worker. Self-modification
 * can only ever target index.js's CONTENT through proposeAndDeployCodeChange,
 * but every deploy must re-upload every module, or Cloudflare's API would
 * replace the whole Worker with just the changed file and silently delete
 * everything else. This list must be kept in sync with the real repo.
 */
const ALL_MODULE_FILES = [
  "index.js",
  "protected-core.js",
  "self-mod-lifecycle.js",
  "notifications.js",
  "publish-hour-self-mod.js",
  "payment-proposal-trigger.js",
  "code-self-mod.js"
];

/**
 * Fetches the CURRENT live content of EVERY module file from Cloudflare's
 * Workers API, not just the entry point. Used both to capture a complete
 * backup before changing, and to give the LLM the real current file as
 * context for generating a diff. Returns { fileName: content } for all
 * files in ALL_MODULE_FILES.
 */
async function fetchAllLiveModules(env) {
  // NOTE: Cloudflare's /content endpoint for module Workers returns the
  // full multipart body of all modules, not just the entry point. This
  // function fetches it once and splits it by module name. If the API
  // response shape differs from what's assumed here, this is the first
  // place to check when debugging — it was not possible to verify this
  // against the real API in this environment, so treat as unverified
  // until tested against the live Worker.
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/ai-ceo-orchestrator/content`,
    { headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch live script content: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("multipart")) {
    // Single-file response — only index.js exists server-side as far as
    // this endpoint is concerned. Treat other files as empty/missing
    // rather than guessing; the caller decides what to do with that.
    const text = await res.text();
    return { "index.js": text };
  }

  // Parse the multipart response into named parts.
  const formData = await res.formData();
  const modules = {};
  for (const fileName of ALL_MODULE_FILES) {
    const part = formData.get(fileName);
    if (part) {
      modules[fileName] = typeof part === "string" ? part : await part.text();
    }
  }
  return modules;
}

/**
 * Pushes new script content live via Cloudflare's Workers API.
 * This is the ONLY deploy path available to self-modification — it
 * cannot run wrangler, cannot use git, cannot do anything a human
 * operator does. It is a direct API overwrite of the script body.
 *
 * CRITICAL: must include EVERY module file, not just the one that
 * changed — Cloudflare's PUT replaces the whole script. Uploading only
 * the changed file would silently delete every other module.
 * allModules is { fileName: content } covering every file in
 * ALL_MODULE_FILES, with exactly one entry replaced by newContent for
 * the targeted file.
 */
async function deployScriptContent(env, allModules) {
  const formData = new FormData();
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-06-19",
    compatibility_flags: ["nodejs_compat_v2"]
  };
  formData.append("metadata", JSON.stringify(metadata));

  for (const fileName of ALL_MODULE_FILES) {
    const content = allModules[fileName];
    if (content === undefined) {
      throw new Error(`Refusing to deploy: missing content for required module "${fileName}". Aborting to avoid deleting it.`);
    }
    formData.append(fileName, new Blob([content], { type: "application/javascript+module" }), fileName);
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/ai-ceo-orchestrator`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      body: formData
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Deploy failed: HTTP ${res.status} - ${errText}`);
  }
  return await res.json();
}

/**
 * Asks the AI binding to generate a complete replacement for the target
 * file's content, given a description of the intended change. Returns
 * the raw text the model produced — NOT yet syntax-checked or deployed.
 */
async function generateCodeChange(env, currentContent, changeDescription) {
  const prompt = `You are modifying a Cloudflare Worker's source file (JavaScript, ES modules).

CURRENT FILE CONTENT:
${currentContent}

REQUESTED CHANGE:
${changeDescription}

Respond with ONLY the complete new file content, nothing else - no explanation, no markdown code fences, no preamble. The output must be the entire file from the first line to the last, ready to deploy as-is.`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 16000
  });

  let newContent = (response.response || "").trim();
  // Strip markdown code fences if the model added them despite instructions.
  newContent = newContent.replace(/^```(?:javascript|js)?\n/, "").replace(/\n```$/, "");
  return newContent;
}

/**
 * Full propose-and-deploy flow for a code self-modification.
 * Returns the new entry ID on success, or null if the attempt was
 * rejected at any safety checkpoint (locked file, syntax failure, etc).
 * A rejection here is NOT a revert — it means nothing was ever deployed,
 * so there is nothing to undo. Rejections are loud-logged, never silent.
 */
export async function proposeAndDeployCodeChange(env, { targetFile, whatChanged, why, expectedBenefit, metricName, metricQuery, deadlineDays }) {
  if (isLockedFile(targetFile)) {
    console.error("LOUD LOG: self-modification attempted to target a locked file. Rejected.", { targetFile });
    return null;
  }
  if (!ALL_MODULE_FILES.includes(targetFile)) {
    console.error("LOUD LOG: self-modification targeted a file outside the known module list. Rejected.", { targetFile });
    return null;
  }

  let allModules;
  try {
    allModules = await fetchAllLiveModules(env);
  } catch (err) {
    console.error("LOUD LOG: could not fetch current live modules, aborting code self-mod attempt.", { error: err.message });
    return null;
  }

  const currentContent = allModules[targetFile];
  if (currentContent === undefined) {
    console.error("LOUD LOG: target file not found among live modules, aborting.", { targetFile });
    return null;
  }

  const newContent = await generateCodeChange(env, currentContent, whatChanged + " — " + why);

  const check = syntaxCheck(newContent);
  if (!check.valid) {
    console.error("LOUD LOG: self-generated code failed syntax check. Deploy aborted, nothing changed.", { error: check.error });
    return null;
  }

  for (const locked of LOCKED_FILES) {
    const lockedModuleName = locked.split("/").pop();
    if (currentContent.includes(lockedModuleName) && !newContent.includes(lockedModuleName)) {
      console.error("LOUD LOG: generated code appears to remove a reference to a locked safety module. Deploy aborted.", { lockedModuleName });
      return null;
    }
  }

  // Paid-resource dependency check: if the generated code introduces or
  // changes a budget/limit-style constant (the common shape of a change
  // that assumes a paid tier), require that the same diff also contains
  // some form of fallback/conditional logic. This is a coarse heuristic,
  // not a guarantee the fallback is correct - but it stops the most
  // obvious violation (a hardcoded higher constant with zero fallback)
  // from deploying silently, per the spec's paid-resource dependency rule.
  const budgetConstantPattern = /(BUDGET|LIMIT|QUOTA|CEILING)\s*=\s*\d+/gi;
  const oldConstants = currentContent.match(budgetConstantPattern) || [];
  const newConstants = newContent.match(budgetConstantPattern) || [];
  const constantsChanged = JSON.stringify(oldConstants) !== JSON.stringify(newConstants);
  const hasFallbackLogic = /fallback|free.?tier|if\s*\(.*available.*\)|catch\s*\(/i.test(newContent);

  if (constantsChanged && !hasFallbackLogic) {
    console.error("LOUD LOG: generated code changes a budget/limit constant with no detectable fallback logic. Deploy aborted per the paid-resource dependency rule.", { oldConstants, newConstants });
    return null;
  }

  let metricBaseline = null;
  if (metricQuery) {
    try {
      const baselineRow = await env.ai_ceo_memory.prepare(metricQuery).first();
      metricBaseline = baselineRow ? Object.values(baselineRow)[0] : null;
    } catch (err) {
      console.error("LOUD LOG: metric_query failed during baseline capture. Proceeding without a baseline.", { error: err.message });
    }
  }

  const entryId = await openEntry(env, {
    whatChanged,
    why,
    expectedBenefit,
    metricName,
    metricBaseline,
    deadlineDays,
    rollbackData: { targetFile, isCodeChange: true }
  });

  // Save a backup of EVERY module's current content, not just the
  // targeted file — revert needs to restore the complete known-good
  // bundle, and storing only the changed file would leave revert unable
  // to reconstruct the full deploy on its own.
  const now = Math.floor(Date.now() / 1000);
  for (const fileName of ALL_MODULE_FILES) {
    await env.ai_ceo_memory
      .prepare("INSERT INTO code_file_backups (self_mod_entry_id, file_path, content_before, created_at) VALUES (?, ?, ?, ?)")
      .bind(entryId, fileName, allModules[fileName], now)
      .run();
  }

  await env.ai_ceo_memory
    .prepare("INSERT INTO code_self_mod_metadata (self_mod_entry_id, target_file, metric_query, metric_baseline_value, deploy_succeeded) VALUES (?, ?, ?, ?, 0)")
    .bind(entryId, targetFile, metricQuery || null, metricBaseline)
    .run();

  const newModuleSet = { ...allModules, [targetFile]: newContent };

  try {
    await deployScriptContent(env, newModuleSet);
  } catch (deployErr) {
    console.error("LOUD LOG: code change failed to deploy. Entry stays open but unsuccessful; no live change occurred.", { entryId, error: deployErr.message });
    return entryId;
  }

  await env.ai_ceo_memory
    .prepare("UPDATE code_self_mod_metadata SET deploy_succeeded = 1 WHERE self_mod_entry_id = ?")
    .bind(entryId)
    .run();

  console.log("Code self-modification deployed live.", { entryId, targetFile });
  return entryId;
}

/**
 * Generic judge function for code self-modification entries. Unlike
 * publish-hour (which has a hardcoded metric), code changes use whatever
 * metric_query the program defined for itself at open time.
 */
export async function judgeCodeChange(env, entry) {
  const meta = await env.ai_ceo_memory
    .prepare("SELECT * FROM code_self_mod_metadata WHERE self_mod_entry_id = ?")
    .bind(entry.id)
    .first();

  if (!meta || !meta.deploy_succeeded) {
    return "reverted"; // never actually went live, or we lost track of it — don't keep it open
  }
  if (!meta.metric_query) {
    return "reverted"; // no way to judge success without a defined metric
  }

  let currentValue;
  try {
    const row = await env.ai_ceo_memory.prepare(meta.metric_query).first();
    currentValue = row ? Object.values(row)[0] : null;
  } catch (err) {
    console.error("LOUD LOG: metric_query failed during judging. Reverting out of caution.", { entryId: entry.id, error: err.message });
    return "reverted";
  }

  if (currentValue === null || meta.metric_baseline_value === null) {
    return "extend"; // not enough information yet to judge fairly
  }

  return currentValue > meta.metric_baseline_value ? "succeeded" : "reverted";
}

/**
 * Rollback function for code self-modification entries. Restores the
 * exact file content that was live before this entry's deploy, per the
 * spec's "revert immediately, unconditionally, no live patching" rule.
 */
export async function rollbackCodeChange(env, entry) {
  const { results: backups } = await env.ai_ceo_memory
    .prepare("SELECT * FROM code_file_backups WHERE self_mod_entry_id = ?")
    .bind(entry.id)
    .all();

  if (!backups || backups.length === 0) {
    console.error("LOUD LOG: no backup found for code self-mod entry, cannot revert automatically. Manual intervention required.", { entryId: entry.id });
    return;
  }

  const restoredModules = {};
  for (const backup of backups) {
    restoredModules[backup.file_path] = backup.content_before;
  }

  // Verify every required module is present in the backup set before
  // attempting to deploy anything — a partial backup is not safe to use.
  const missing = ALL_MODULE_FILES.filter(f => restoredModules[f] === undefined);
  if (missing.length > 0) {
    console.error("LOUD LOG: backup set is missing required modules, cannot safely revert. Manual intervention required.", { entryId: entry.id, missing });
    return;
  }

  for (const fileName of ALL_MODULE_FILES) {
    const check = syntaxCheck(restoredModules[fileName]);
    if (!check.valid) {
      // Should be impossible (it was live before), but never trust blindly.
      console.error("LOUD LOG: backup content failed syntax check during revert. Aborting automatic revert, manual intervention required.", { entryId: entry.id, fileName, error: check.error });
      return;
    }
  }

  try {
    await deployScriptContent(env, restoredModules);
    console.log("Code self-modification reverted: restored prior version of all modules.", { entryId: entry.id });
  } catch (err) {
    console.error("LOUD LOG: revert deploy itself failed. System may be in a broken state. Manual intervention required immediately.", { entryId: entry.id, error: err.message });
  }
}
