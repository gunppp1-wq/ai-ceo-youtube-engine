import puppeteer from "@cloudflare/puppeteer";

async function b2Authorize(env) {
  const credentials = btoa(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`);
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { "Authorization": `Basic ${credentials}` }
  });
  if (!res.ok) { const errBody = await res.text(); throw new Error(`B2 authorize failed: ${res.status} ${errBody}`); }
  return await res.json();
}

async function b2GetUploadUrl(apiUrl, authToken, bucketId) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${bucketId}`, {
    headers: { "Authorization": authToken }
  });
  if (!res.ok) { const errBody = await res.text(); throw new Error(`B2 get upload URL failed: ${res.status} ${errBody}`); }
  return await res.json();
}

async function b2UploadFile(uploadUrl, uploadAuthToken, fileName, bytes, contentType) {
  const sha1Buffer = await crypto.subtle.digest("SHA-1", bytes);
  const sha1Hex = Array.from(new Uint8Array(sha1Buffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": uploadAuthToken,
      "X-Bz-File-Name": encodeURIComponent(fileName),
      "Content-Type": contentType,
      "X-Bz-Content-Sha1": sha1Hex
    },
    body: bytes
  });
  if (!res.ok) throw new Error(`B2 upload failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function callRenderAssembler(payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 170000);

      const resp = await fetch("https://ai-ceo-video-assembler.onrender.com/assemble-frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Render assemble failed: ${resp.status} ${errText}`);
      }

      return await resp.json();
    } catch (err) {
      console.log(`Render call attempt ${attempt} failed:`, err.message);
      if (attempt === 2) throw err;
      console.log("Retrying Render call (likely cold start)...");
    }
  }
}

const DAILY_B2_OP_LIMIT = 30;

async function checkAndIncrementDailyLimit(env, opType) {
  const today = new Date().toISOString().slice(0, 10);

  const row = await env.ai_ceo_memory.prepare(
    "SELECT count FROM daily_usage WHERE usage_date = ? AND op_type = ?"
  ).bind(today, opType).first();

  const currentCount = row ? row.count : 0;

  if (currentCount >= DAILY_B2_OP_LIMIT) {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
    ).bind("DAILY_LIMIT_REACHED", `Daily limit reached for ${opType}: ${currentCount}/${DAILY_B2_OP_LIMIT}`).run();
    return false;
  }

  if (row) {
    await env.ai_ceo_memory.prepare(
      "UPDATE daily_usage SET count = count + 1 WHERE usage_date = ? AND op_type = ?"
    ).bind(today, opType).run();
  } else {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO daily_usage (usage_date, op_type, count) VALUES (?, ?, 1)"
    ).bind(today, opType).run();
  }

  return true;
}

const SAFETY_BLOCKLIST = {
  violent_dangerous: ["shooting", "murder", "death", "war crime", "explosion", "terrorist", "weapon sale", "torture", "execution", "massacre"],
  child_safety: ["child", "minor", "csam", "groom", "underage"],
  self_harm: ["suicide", "self-harm", "self harm", "cutting", "overdose"],
  hate_harassment: ["hate speech", "slur", "extremist", "nazi", "genocide", "ethnic cleansing"],
  spam_scam: ["scam", "phishing", "counterfeit", "pyramid scheme", "get rich quick", "guaranteed profit"],
  regulated_goods: ["illegal drug", "drug trafficking", "firearm sale", "explosive sale"],
  misinformation: ["election fraud", "vaccine hoax", "fake cure"]
};

function passesPlatformSafetyGate(text) {
  if (!text) return { passes: false, reason: "empty content" };
  const lower = text.toLowerCase();

  for (const [category, words] of Object.entries(SAFETY_BLOCKLIST)) {
    const matched = words.find(word => lower.includes(word));
    if (matched) {
      return { passes: false, reason: `${category}: matched "${matched}"` };
    }
  }

  return { passes: true, reason: null };
}

const PERSONA = `You are "The Skeptical Fan" - a YouTube commentator persona with a consistent voice across every video:
- You genuinely love movies, games, and music, but have zero patience for obvious marketing tricks and hype-building tactics
- When you notice a hype tactic (logo reveals, "coming soon" teases, vague trailers), you call it out by name
- You believe most franchises over-promise in trailers and aren't afraid to say so directly
- Your tone is casual, confident, slightly sarcastic - never a neutral narrator voice
- You often reference that you've seen this pattern before ("here we go again", "every single time")
- You end scripts with a direct, personal opinion or question to the viewer, not just a summary
- You have real opinions - state them plainly, don't hedge`;

const MOTION_TYPES = ["popIn", "slideLeft", "slideRight", "pulse"];
const COLOR_PAIRS = [
  ["#1a1a2e", "#0f3460"],
  ["#2d1b4e", "#6b2d5c"],
  ["#0f2027", "#2c5364"],
  ["#3a1c71", "#d76d77"]
];

function buildSceneHtml({ emoji, primaryColor, secondaryColor, motionType, labelText }) {
  const motionCSS = {
    popIn: `@keyframes sceneMotion {
      0% { opacity: 0; transform: scale(0.5) rotate(-10deg); }
      60% { opacity: 1; transform: scale(1.1) rotate(5deg); }
      100% { opacity: 1; transform: scale(1) rotate(0deg); }
    }`,
    slideLeft: `@keyframes sceneMotion {
      0% { opacity: 0; transform: translateX(300px); }
      100% { opacity: 1; transform: translateX(0); }
    }`,
    slideRight: `@keyframes sceneMotion {
      0% { opacity: 0; transform: translateX(-300px); }
      100% { opacity: 1; transform: translateX(0); }
    }`,
    pulse: `@keyframes sceneMotion {
      0% { opacity: 0; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.15); }
      100% { opacity: 1; transform: scale(1); }
    }`
  };

  const safeMotion = motionCSS[motionType] || motionCSS.popIn;
  const safeLabel = String(labelText || "").replace(/[<>]/g, "");

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Arial, sans-serif; }
  .scene {
    width: 1280px; height: 720px;
    background: linear-gradient(135deg, ${primaryColor}, ${secondaryColor});
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    position: relative;
  }
  .icon {
    font-size: 180px;
    animation: sceneMotion 1.2s ease-out forwards;
    animation-play-state: paused;
  }
  .label {
    font-size: 42px;
    color: white;
    font-weight: bold;
    margin-top: 30px;
    text-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    animation: sceneMotion 1.2s ease-out forwards;
    animation-delay: 0.2s;
    animation-play-state: paused;
  }
  ${safeMotion}
  .glow {
    position: absolute;
    width: 700px; height: 700px;
    background: radial-gradient(circle, rgba(255,255,255,0.15), transparent);
    animation: glowPulse 2s ease-in-out infinite;
    animation-play-state: paused;
  }
  @keyframes glowPulse {
    0%, 100% { transform: scale(1); opacity: 0.5; }
    50% { transform: scale(1.3); opacity: 0.8; }
  }
</style>
</head>
<body>
  <div class="scene">
    <div class="glow"></div>
    <div class="icon">${emoji}</div>
    <div class="label">${safeLabel}</div>
  </div>
  <script>
    document.getAnimations().forEach(a => a.pause());
    window.setSceneTime = (ms) => {
      document.getAnimations().forEach(a => { a.currentTime = ms; });
    };
  </script>
</body>
</html>`;
}

async function captureSceneFrames(env, sceneParams, numFrames, frameDurationMs) {
  const html = buildSceneHtml(sceneParams);
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html);

    const frames = [];
    for (let i = 0; i < numFrames; i++) {
      const timeMs = i * frameDurationMs;
      await page.evaluate((ms) => { window.setSceneTime(ms); }, timeMs);
      const screenshot = await page.screenshot({ type: "jpeg", quality: 80 });
      frames.push(screenshot);
    }
    return frames;
  } finally {
    await browser.close();
  }
}

function cleanImageDescription(desc) {
  return desc
    .replace(/\btext\b/gi, "")
    .replace(/\btitle\b/gi, "")
    .replace(/\bwords?\b/gi, "")
    .replace(/\bwriting\b/gi, "")
    .replace(/\blogo\b/gi, "")
    .replace(/\bcaption\b/gi, "")
    .trim();
}

export default {
  async fetch(request, env, ctx) {
    const result = await env.ai_ceo_memory.prepare(
      "SELECT * FROM trends ORDER BY id DESC LIMIT 10"
    ).all();

    return new Response(JSON.stringify(result.results, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  },

  async scheduled(event, env, ctx) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=10&regionCode=US&key=${env.YOUTUBE_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.items) {
        console.log("No items returned", JSON.stringify(data));
        return;
      }

      const repostKeywords = ["official video", "official music video", "official trailer", "official audio", "official teaser", "official lyric video", "lyric video", "music video", "full movie", "full episode"];

      for (const item of data.items) {
        try {
          const title = item.snippet.title;
          const views = parseInt(item.statistics.viewCount || "0", 10);

          const existing = await env.ai_ceo_memory.prepare(
            "SELECT id FROM trends WHERE topic = ? AND collected_at > datetime('now', '-12 hours')"
          ).bind(title).first();

          if (existing) {
            console.log("Skipping duplicate trend within 12h:", title);
            continue;
          }

          const safetyCheck = passesPlatformSafetyGate(title);
          if (!safetyCheck.passes) {
            console.log(`SAFETY GATE BLOCKED trend (not inserted, not scored): "${title}" - ${safetyCheck.reason}`);
            continue;
          }

          const insertedTrend = await env.ai_ceo_memory.prepare(
            "INSERT INTO trends (topic, source, score) VALUES (?, ?, ?) RETURNING id"
          ).bind(title, "youtube_trending", views).first();

          if (!insertedTrend || !insertedTrend.id) {
            console.log("ERROR: insertedTrend missing id for title:", title);
            continue;
          }

          const trendId = insertedTrend.id;
          const lowerTitle = title.toLowerCase();
          const isRepost = repostKeywords.some(word => lowerTitle.includes(word));

          let competitionCheck = { cnt: 0 };
          try {
            competitionCheck = await env.ai_ceo_memory.prepare(
              "SELECT COUNT(*) as cnt FROM trends WHERE topic LIKE ? AND id != ?"
            ).bind(`%${title.split(" ").slice(0, 3).join(" ")}%`, trendId).first();
          } catch (likeErr) {
            console.log("Competition check failed (pattern too complex), defaulting to 0:", likeErr.message);
          }

          const competitionPenalty = Math.min((competitionCheck?.cnt || 0) * 0.05, 0.5);

          let profitScore = views * (1 - competitionPenalty);
          let status = "ready";
          let note = "Direct opportunity";

          if (isRepost) {
            profitScore = profitScore * 0.6;
            status = "needs_commentary_angle";
            note = "Repost-only content; requires reaction/commentary framing to avoid copyright issues";
          }

          await env.ai_ceo_memory.prepare(
            "INSERT INTO opportunities (trend_id, title, profit_score, status) VALUES (?, ?, ?, ?)"
          ).bind(trendId, `${note}: ${title}`, profitScore, status).run();
        } catch (innerErr) {
          console.log("ERROR processing item:", item?.snippet?.title, innerErr.message);
        }
      }

      const topOpportunities = await env.ai_ceo_memory.prepare(
        "SELECT * FROM opportunities WHERE status IN ('ready', 'needs_commentary_angle') ORDER BY profit_score DESC LIMIT 1"
      ).all();

      const recentPlans = await env.ai_ceo_memory.prepare(
        "SELECT title FROM content_plans ORDER BY id DESC LIMIT 3"
      ).all();
      const recentTitles = recentPlans.results.map(p => p.title).join(", ");

      for (const opp of topOpportunities.results) {
        let success = false;
        let generatedTitle, generatedScript, contentPlanId, sceneDescriptions;

        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          try {
            const isCommentary = opp.status === "needs_commentary_angle";
            const cleanTitle = opp.title.split(": ").slice(1).join(": ").replace(/[\u2013\u2014]/g, "-").replace(/"/g, "");

            const memoryNote = recentTitles
              ? `\n\nFor context, your recent videos covered: ${recentTitles}. If relevant, you may briefly reference one of these for continuity, but don't force it.`
              : "";

            const prompt = `${PERSONA}\n\nWrite a short, 30-45 second video script (just the spoken narration, no stage directions) about this trending topic: ${cleanTitle}.${memoryNote}\n\nGive your actual opinion - don't just summarize. Also suggest a catchy, clickable video title under 60 characters that reflects your personality.\n\nFinally, describe 3 distinct visual scenes representing the subject matter. For each scene, give: a single relevant emoji, and a short 3-5 word label phrase (not the title, never include literal words like "text" or "title"). Format your response exactly as:\nTITLE: <title>\nSCRIPT: <script>\nSCENE1_EMOJI: <emoji>\nSCENE1_LABEL: <short phrase>\nSCENE2_EMOJI: <emoji>\nSCENE2_LABEL: <short phrase>\nSCENE3_EMOJI: <emoji>\nSCENE3_LABEL: <short phrase>`;

            const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              messages: [{ role: "user", content: prompt }]
            });

            const responseText = aiResponse.response || "";

            if (!responseText.trim()) {
              console.log(`Empty response for opportunity id=${opp.id} on attempt ${attempt}`);
              continue;
            }

            const titleMatch = responseText.match(/TITLE:\s*(.+)/i);
            const scriptMatch = responseText.match(/SCRIPT:\s*([\s\S]+?)(?=SCENE1_EMOJI:|$)/i);
            const e1 = responseText.match(/SCENE1_EMOJI:\s*(.+)/i);
            const l1 = responseText.match(/SCENE1_LABEL:\s*(.+)/i);
            const e2 = responseText.match(/SCENE2_EMOJI:\s*(.+)/i);
            const l2 = responseText.match(/SCENE2_LABEL:\s*(.+)/i);
            const e3 = responseText.match(/SCENE3_EMOJI:\s*(.+)/i);
            const l3 = responseText.match(/SCENE3_LABEL:\s*(.+)/i);

            generatedTitle = titleMatch ? titleMatch[1].trim() : cleanTitle;
            generatedScript = scriptMatch ? scriptMatch[1].trim() : responseText.trim();

            sceneDescriptions = [
              { emoji: e1 ? e1[1].trim().split(" ")[0] : "🎬", label: l1 ? cleanImageDescription(l1[1].trim()) : cleanTitle },
              { emoji: e2 ? e2[1].trim().split(" ")[0] : "🎬", label: l2 ? cleanImageDescription(l2[1].trim()) : cleanTitle },
              { emoji: e3 ? e3[1].trim().split(" ")[0] : "🎬", label: l3 ? cleanImageDescription(l3[1].trim()) : cleanTitle }
            ];

            const genSafetyCheck = passesPlatformSafetyGate(generatedTitle + " " + generatedScript);
            if (!genSafetyCheck.passes) {
              console.log(`SAFETY GATE BLOCKED generated content for opportunity id=${opp.id}: ${genSafetyCheck.reason}`);
              await env.ai_ceo_memory.prepare(
                "UPDATE opportunities SET status = 'safety_blocked' WHERE id = ?"
              ).bind(opp.id).run();
              success = true;
              continue;
            }

            const insertedPlan = await env.ai_ceo_memory.prepare(
              "INSERT INTO content_plans (opportunity_id, title, script, metadata) VALUES (?, ?, ?, ?) RETURNING id"
            ).bind(opp.id, generatedTitle, generatedScript, JSON.stringify({ style: isCommentary ? "commentary" : "direct", persona: "skeptical_fan", sceneDescriptions })).first();

            contentPlanId = insertedPlan.id;

            await env.ai_ceo_memory.prepare(
              "UPDATE opportunities SET status = 'used' WHERE id = ?"
            ).bind(opp.id).run();

            console.log(`Generated content plan for opportunity id=${opp.id}: ${generatedTitle}`);
            success = true;
          } catch (aiErr) {
            console.log(`ERROR generating content for opportunity id=${opp.id} on attempt ${attempt}:`, aiErr.message);
          }
        }

        if (!contentPlanId) {
          continue;
        }

        try {
          const existingVideo = await env.ai_ceo_memory.prepare(
            "SELECT id FROM videos WHERE content_plan_id = ?"
          ).bind(contentPlanId).first();

          if (existingVideo) {
            console.log(`Video assets already exist for content_plan_id=${contentPlanId}, skipping`);
            continue;
          }

          const canProceedAudio = await checkAndIncrementDailyLimit(env, "b2_audio_upload");
          const canProceedFrames = await checkAndIncrementDailyLimit(env, "browser_render_scene");

          if (!canProceedAudio || !canProceedFrames) {
            console.log(`Daily operation limit reached, skipping asset generation for content_plan_id=${contentPlanId}`);
            continue;
          }

          const ttsResp = await env.AI.run("@cf/deepgram/aura-1", {
            text: generatedScript
          }, { returnRawResponse: true });

          const audioArrayBuffer = await ttsResp.arrayBuffer();
          const audioBytes = new Uint8Array(audioArrayBuffer);

          const authData = await b2Authorize(env);
          const apiUrl = authData.apiInfo.storageApi.apiUrl;
          const downloadUrlBase = authData.apiInfo.storageApi.downloadUrl;
          const authToken = authData.authorizationToken;

          console.log(`Capturing animated frames for content_plan_id=${contentPlanId}...`);

          const sceneFrameUrls = [];
          for (let sceneIdx = 0; sceneIdx < sceneDescriptions.length; sceneIdx++) {
            const colorPair = COLOR_PAIRS[(contentPlanId + sceneIdx) % COLOR_PAIRS.length];
            const motionType = MOTION_TYPES[(contentPlanId + sceneIdx) % MOTION_TYPES.length];

            const frames = await captureSceneFrames(env, {
              emoji: sceneDescriptions[sceneIdx].emoji,
              primaryColor: colorPair[0],
              secondaryColor: colorPair[1],
              motionType: motionType,
              labelText: sceneDescriptions[sceneIdx].label
            }, 8, 150);

            const frameUrls = [];
            for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
              const uploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.B2_BUCKET_ID);
              const frameFileName = `frames/content_plan_${contentPlanId}_scene${sceneIdx}_frame${frameIdx}.jpg`;
              await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, frameFileName, new Uint8Array(frames[frameIdx]), "image/jpeg");
              frameUrls.push(`${downloadUrlBase}/file/ai-ceo-media/${frameFileName}?Authorization=${authToken}`);
            }
            sceneFrameUrls.push(frameUrls);
          }

          const uploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.B2_BUCKET_ID);
          const audioFileName = `audio/content_plan_${contentPlanId}.mp3`;
          await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, audioFileName, audioBytes, "audio/mpeg");

          console.log(`Video assets uploaded for content_plan_id=${contentPlanId}: ${audioFileName}, ${sceneFrameUrls.length} scenes x ${sceneFrameUrls[0]?.length || 0} frames`);

          const audioDownloadUrl = `${downloadUrlBase}/file/ai-ceo-media/${audioFileName}?Authorization=${authToken}`;
          const finalVideoFileName = `videos/content_plan_${contentPlanId}.mp4`;

          console.log(`Calling Render to assemble video from frame sequences for content_plan_id=${contentPlanId}...`);
          const assembleResult = await callRenderAssembler({
            sceneFrameUrls: sceneFrameUrls,
            audioUrl: audioDownloadUrl,
            b2KeyId: env.B2_KEY_ID,
            b2ApplicationKey: env.B2_APPLICATION_KEY,
            b2BucketId: env.B2_BUCKET_ID,
            outputFileName: finalVideoFileName
          });

          await env.ai_ceo_memory.prepare(
            "INSERT INTO videos (content_plan_id, status) VALUES (?, ?)"
          ).bind(contentPlanId, "video_ready").run();

          console.log(`Video fully assembled for content_plan_id=${contentPlanId}: ${finalVideoFileName} (fileId: ${assembleResult.fileId})`);
        } catch (videoErr) {
          console.log(`ERROR generating/uploading video assets for content_plan_id=${contentPlanId}:`, videoErr.message);
        }
      }

      console.log("scheduled() completed successfully");
    } catch (outerErr) {
      console.log("FATAL ERROR in scheduled():", outerErr.message, outerErr.stack);
    }
  }
};
