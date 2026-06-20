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
  if (!res.ok) throw new Error(`B2 get upload URL failed: ${res.status}`);
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

const DAILY_B2_OP_LIMIT = 20;

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

// --- SHARED SAFETY GATE: absolute, evaluated before any profit logic ---
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
        "SELECT * FROM opportunities WHERE status IN ('ready', 'needs_commentary_angle') ORDER BY profit_score DESC LIMIT 3"
      ).all();

      for (const opp of topOpportunities.results) {
        let success = false;
        let generatedTitle, generatedScript, contentPlanId;

        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          try {
            const isCommentary = opp.status === "needs_commentary_angle";
            const cleanTitle = opp.title.split(": ").slice(1).join(": ").replace(/[\u2013\u2014]/g, "-").replace(/"/g, "");

            const prompt = isCommentary
              ? `You are a YouTube scriptwriter. Write a short, energetic 30-45 second reaction/commentary script (just the spoken narration, no stage directions) reacting to this trending video: ${cleanTitle}. Also suggest a catchy, clickable video title under 60 characters. Format your response exactly as:\nTITLE: <title>\nSCRIPT: <script>`
              : `You are a YouTube scriptwriter. Write a short, engaging 30-45 second script (just the spoken narration, no stage directions) about this trending topic: ${cleanTitle}. Also suggest a catchy, clickable video title under 60 characters. Format your response exactly as:\nTITLE: <title>\nSCRIPT: <script>`;

            const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              messages: [{ role: "user", content: prompt }]
            });

            const responseText = aiResponse.response || "";

            if (!responseText.trim()) {
              console.log(`Empty response for opportunity id=${opp.id} on attempt ${attempt}`);
              continue;
            }

            const titleMatch = responseText.match(/TITLE:\s*(.+)/i);
            const scriptMatch = responseText.match(/SCRIPT:\s*([\s\S]+)/i);

            generatedTitle = titleMatch ? titleMatch[1].trim() : cleanTitle;
            generatedScript = scriptMatch ? scriptMatch[1].trim() : responseText.trim();

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
            ).bind(opp.id, generatedTitle, generatedScript, JSON.stringify({ style: isCommentary ? "commentary" : "direct" })).first();

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
          const canProceedImage = await checkAndIncrementDailyLimit(env, "b2_image_upload");

          if (!canProceedAudio || !canProceedImage) {
            console.log(`Daily B2 operation limit reached, skipping asset generation for content_plan_id=${contentPlanId}`);
            continue;
          }

          const ttsResp = await env.AI.run("@cf/deepgram/aura-1", {
            text: generatedScript
          }, { returnRawResponse: true });

          const audioArrayBuffer = await ttsResp.arrayBuffer();
          const audioBytes = new Uint8Array(audioArrayBuffer);

          const imagePrompt = `A vibrant, eye-catching YouTube thumbnail style image representing: ${generatedTitle}`;
          const imgResp = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
            prompt: imagePrompt
          });

          const imageBinaryString = atob(imgResp.image);
          const imageBytes = Uint8Array.from(imageBinaryString, (m) => m.codePointAt(0));

          const authData = await b2Authorize(env);
          const uploadUrlData = await b2GetUploadUrl(authData.apiUrl, authData.authorizationToken, env.B2_BUCKET_ID);

          const audioFileName = `audio/content_plan_${contentPlanId}.mp3`;
          const imageFileName = `images/content_plan_${contentPlanId}.jpg`;

          await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, audioFileName, audioBytes, "audio/mpeg");

          const uploadUrlData2 = await b2GetUploadUrl(authData.apiUrl, authData.authorizationToken, env.B2_BUCKET_ID);
          await b2UploadFile(uploadUrlData2.uploadUrl, uploadUrlData2.authorizationToken, imageFileName, imageBytes, "image/jpeg");

          await env.ai_ceo_memory.prepare(
            "INSERT INTO videos (content_plan_id, status) VALUES (?, ?)"
          ).bind(contentPlanId, "assets_ready").run();

          console.log(`Video assets uploaded for content_plan_id=${contentPlanId}: ${audioFileName}, ${imageFileName}`);
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
