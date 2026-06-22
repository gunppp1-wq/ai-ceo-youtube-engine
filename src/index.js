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

async function b2DeleteFileVersion(apiUrl, authToken, fileId, fileName) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: "POST",
    headers: {
      "Authorization": authToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fileId, fileName })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`B2 delete file failed: ${res.status} ${errBody}`);
  }
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

async function getYoutubeAccessToken(env) {
  let refreshToken = env.YOUTUBE_REFRESH_TOKEN;

  try {
    const tokenRow = await env.ai_ceo_memory.prepare(
      "SELECT refresh_token FROM oauth_tokens WHERE purpose = ?"
    ).bind("youtube_main").first();
    if (tokenRow && tokenRow.refresh_token) {
      refreshToken = tokenRow.refresh_token;
    }
  } catch (dbErr) {
    console.log("Non-fatal: could not check oauth_tokens table, using secret fallback:", dbErr.message);
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`YouTube token refresh failed: ${res.status} ${errBody}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function uploadVideoToYoutube(accessToken, videoBytes, title, description) {
  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
      categoryId: "24"
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false
    }
  };

  const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(videoBytes.length)
    },
    body: JSON.stringify(metadata)
  });

  if (!initRes.ok) {
    const errBody = await initRes.text();
    throw new Error(`YouTube upload session init failed: ${initRes.status} ${errBody}`);
  }

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube upload session init did not return a Location header");

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoBytes.length)
    },
    body: videoBytes
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    throw new Error(`YouTube video upload failed: ${uploadRes.status} ${errBody}`);
  }

  return await uploadRes.json();
}

async function getVideoStatus(accessToken, videoId) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,statistics&id=${videoId}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Get video status failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.items || !data.items[0]) {
    return { exists: false };
  }
  return {
    exists: true,
    privacyStatus: data.items[0].status.privacyStatus,
    uploadStatus: data.items[0].status.uploadStatus,
    rejectionReason: data.items[0].status.rejectionReason || null,
    viewCount: data.items[0].statistics?.viewCount || "0"
  };
}

async function deleteYoutubeVideo(accessToken, videoId) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 204) {
    const errBody = await res.text();
    throw new Error(`Delete video failed: ${res.status} ${errBody}`);
  }
  return true;
}

async function setYoutubeThumbnail(accessToken, videoId, thumbnailBytes) {
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "image/jpeg"
    },
    body: thumbnailBytes
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`YouTube thumbnail set failed: ${res.status} ${errBody}`);
  }

  return await res.json();
}

async function generateChannelIdentity(env) {
  const prompt = `${PERSONA}\n\nYou need to design the YouTube channel identity for this persona. Generate:\n1. A catchy channel NAME under 30 characters that reflects this skeptical-but-passionate commentator persona (not generic, memorable, fits a trending pop-culture/gaming/music commentary channel)\n2. A channel DESCRIPTION under 800 characters that tells potential subscribers what to expect, written in the persona voice\n3. A BANNER_PROMPT - a short visual description (for an AI image generator) for a YouTube channel banner background that fits this persona and content (dramatic, eye-catching, NOT containing any text/words/logos)\n\nFormat exactly as:\nNAME: <name>\nDESCRIPTION: <description>\nBANNER_PROMPT: <prompt>`;

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });

  const responseText = aiResponse.response || "";
  const nameMatch = responseText.match(/NAME:\s*(.+)/i);
  const descMatch = responseText.match(/DESCRIPTION:\s*([\s\S]+?)(?=BANNER_PROMPT:|$)/i);
  const bannerMatch = responseText.match(/BANNER_PROMPT:\s*(.+)/i);

  const cleanName = nameMatch ? nameMatch[1].trim().replace(/["`]/g, "").replace(/\s+/g, " ").slice(0, 30).trim() : "";
  const cleanDescription = descMatch ? descMatch[1].trim().replace(/["`]/g, "").slice(0, 800).trim() : "";

  return {
    name: (cleanName.length >= 3) ? cleanName : "The Skeptical Fan",
    description: (cleanDescription.length >= 10) ? cleanDescription : "Calling out the hype, one trend at a time.",
    bannerPrompt: bannerMatch ? bannerMatch[1].trim().replace(/["`]/g, "") : "dramatic dark cinematic background, bold colors"
  };
}

async function uploadChannelBanner(accessToken, bannerBytes) {
  const res = await fetch("https://www.googleapis.com/upload/youtube/v3/channelBanners/insert?uploadType=media", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "image/png"
    },
    body: bannerBytes
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Channel banner upload failed: ${res.status} ${errBody}`);
  }

  return await res.json();
}

async function applyChannelBranding(accessToken, channelId, title, description, bannerUrl) {
  const body = {
    id: channelId,
    brandingSettings: {
      channel: {
        title: title,
        description: description
      }
    }
  };
  if (bannerUrl) {
    body.brandingSettings.image = { bannerExternalUrl: bannerUrl };
  }

  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=brandingSettings", {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Channel branding update failed: ${res.status} ${errBody}`);
  }

  return await res.json();
}

async function getOwnChannelId(accessToken) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Get own channel failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.items || !data.items[0]) throw new Error("No channel found for this account");
  return data.items[0].id;
}

const DAILY_NEURON_BUDGET = 10000;
const ESTIMATED_NEURON_COST = {
  text_generation: 150,
  tts: 8200,
  image_generation: 700
};

async function checkNeuronBudget(env, operationType) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.ai_ceo_memory.prepare(
    "SELECT count FROM daily_usage WHERE usage_date = ? AND op_type = ?"
  ).bind(today, "neurons_estimated").first();

  const usedSoFar = row ? row.count : 0;
  const estimatedCost = ESTIMATED_NEURON_COST[operationType] || 200;

  if (usedSoFar + estimatedCost > DAILY_NEURON_BUDGET) {
    console.log(`Estimated neuron budget would be exceeded for ${operationType}: ${usedSoFar} used + ${estimatedCost} estimated > ${DAILY_NEURON_BUDGET}`);
    return false;
  }

  if (row) {
    await env.ai_ceo_memory.prepare(
      "UPDATE daily_usage SET count = count + ? WHERE usage_date = ? AND op_type = ?"
    ).bind(estimatedCost, today, "neurons_estimated").run();
  } else {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO daily_usage (usage_date, op_type, count) VALUES (?, ?, ?)"
    ).bind(today, "neurons_estimated", estimatedCost).run();
  }

  return true;
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

const MIN_PROFIT_SCORE = 100;
const MIN_SCRIPT_LENGTH = 80;

function passesEconomicsGate(opp, generatedScript) {
  if (!opp.profit_score || opp.profit_score < MIN_PROFIT_SCORE) {
    return { passes: false, reason: `profit_score too low or missing: ${opp.profit_score}` };
  }

  if (!generatedScript || generatedScript.trim().length < MIN_SCRIPT_LENGTH) {
    return { passes: false, reason: `script too short or missing: ${generatedScript ? generatedScript.trim().length : 0} chars` };
  }

  const words = generatedScript.trim().split(/\s+/);
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const repetitionRatio = uniqueWords.size / words.length;
  if (words.length > 10 && repetitionRatio < 0.4) {
    return { passes: false, reason: `script appears too repetitive: ${uniqueWords.size}/${words.length} unique words` };
  }

  return { passes: true, reason: null };
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

function buildImageSceneHtml({ imageBase64, motionType, labelText }) {
  const motionCSS = {
    popIn: `@keyframes sceneZoom {
      0% { transform: scale(1.0); }
      100% { transform: scale(1.15); }
    }`,
    slideLeft: `@keyframes sceneZoom {
      0% { transform: scale(1.1) translateX(0); }
      100% { transform: scale(1.1) translateX(-3%); }
    }`,
    slideRight: `@keyframes sceneZoom {
      0% { transform: scale(1.1) translateX(0); }
      100% { transform: scale(1.1) translateX(3%); }
    }`,
    pulse: `@keyframes sceneZoom {
      0% { transform: scale(1.05); }
      50% { transform: scale(1.15); }
      100% { transform: scale(1.05); }
    }`
  };

  const safeMotion = motionCSS[motionType] || motionCSS.popIn;
  const safeLabel = String(labelText || "").replace(/[<>]/g, "");

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Arial, sans-serif; }
  .scene { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #000; }
  .bgimg {
    position: absolute; top: 0; left: 0; width: 1280px; height: 720px;
    background-image: url(data:image/jpeg;base64,${imageBase64});
    background-size: cover; background-position: center;
    animation: sceneZoom 6s ease-in-out forwards;
    animation-play-state: paused;
  }
  ${safeMotion}
  .overlay { position: absolute; bottom: 0; left: 0; width: 100%; padding: 40px; background: linear-gradient(transparent, rgba(0,0,0,0.7)); }
  .label { font-size: 36px; color: white; font-weight: bold; text-shadow: 2px 2px 6px rgba(0,0,0,0.8); }
</style>
</head>
<body>
  <div class="scene">
    <div class="bgimg"></div>
    <div class="overlay"><div class="label">${safeLabel}</div></div>
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

async function captureImageSceneFrames(page, sceneParams, numFrames, frameDurationMs) {
  const html = buildImageSceneHtml(sceneParams);
  await page.setContent(html);

  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    const timeMs = i * frameDurationMs;
    await page.evaluate((ms) => { window.setSceneTime(ms); }, timeMs);
    const screenshot = await page.screenshot({ type: "jpeg", quality: 80 });
    frames.push(screenshot);
  }
  return frames;
}

async function captureSceneFrames(page, sceneParams, numFrames, frameDurationMs) {
  const html = buildSceneHtml(sceneParams);
  await page.setContent(html);

  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    const timeMs = i * frameDurationMs;
    await page.evaluate((ms) => { window.setSceneTime(ms); }, timeMs);
    const screenshot = await page.screenshot({ type: "jpeg", quality: 80 });
    frames.push(screenshot);
  }
  return frames;
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
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const scopes = [
        "https://www.googleapis.com/auth/youtube",
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
        "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
      ].join(" ");

      const redirectUri = `${url.origin}/oauth/callback`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;

      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing authorization code", { status: 400 });
      }

      const redirectUri = `${url.origin}/oauth/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        }).toString()
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        return new Response(`Token exchange failed: ${errBody}`, { status: 500 });
      }

      const tokenData = await tokenRes.json();
      if (!tokenData.refresh_token) {
        return new Response("No refresh token returned. Try visiting /authorize again (Google only returns a refresh token on first consent or with prompt=consent).", { status: 400 });
      }

      await env.ai_ceo_memory.prepare(
        "INSERT INTO oauth_tokens (purpose, refresh_token, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(purpose) DO UPDATE SET refresh_token = ?, updated_at = datetime('now')"
      ).bind("youtube_main", tokenData.refresh_token, tokenData.refresh_token).run();

      return new Response("Authorization successful! The refresh token has been saved. You can close this page.", { status: 200 });
    }

    const result = await env.ai_ceo_memory.prepare(
      "SELECT * FROM trends ORDER BY id DESC LIMIT 10"
    ).all();

    return new Response(JSON.stringify(result.results, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  },

  async scheduled(event, env, ctx) {
    try {
      const channelSetupDone = await env.ai_ceo_memory.prepare(
        "SELECT id FROM channel_setup LIMIT 1"
      ).first();

      if (!channelSetupDone) {
        try {
          console.log("Running one-time channel identity setup...");
          const identity = await generateChannelIdentity(env);
          const accessToken = await getYoutubeAccessToken(env);
          const channelId = await getOwnChannelId(accessToken);

          let bannerUrl = null;
          try {
            const bannerResp = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
              prompt: `${identity.bannerPrompt}, 16:9 widescreen banner, no text, no logos`
            });
            const bannerBinaryString = atob(bannerResp.image);
            const bannerBytes = Uint8Array.from(bannerBinaryString, (m) => m.codePointAt(0));
            const bannerResult = await uploadChannelBanner(accessToken, bannerBytes);
            bannerUrl = bannerResult.url;
          } catch (bannerErr) {
            console.log("Non-fatal: banner generation/upload failed:", bannerErr.message);
          }

          await applyChannelBranding(accessToken, channelId, identity.name, identity.description, bannerUrl);

          await env.ai_ceo_memory.prepare(
            "INSERT INTO channel_setup (completed_at) VALUES (datetime('now'))"
          ).run();

          console.log(`Channel identity setup complete: "${identity.name}"`);
        } catch (setupErr) {
          console.log("ERROR during channel identity setup:", setupErr.message);

          if (setupErr.message.includes("youtubeSignupRequired")) {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("CHANNEL_SETUP_NEEDED", "YouTube channel has not been created yet for this account. Visit youtube.com while signed into the channel account and create the channel, then setup will work automatically.").run();
          }
        }
      }
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
        let generatedTitle, generatedScript, contentPlanId, sceneDescriptions, thumbnailDescription;

        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          try {
            const isCommentary = opp.status === "needs_commentary_angle";
            const cleanTitle = opp.title.split(": ").slice(1).join(": ").replace(/[\u2013\u2014]/g, "-").replace(/"/g, "");

            const memoryNote = recentTitles
              ? `\n\nFor context, your recent videos covered: ${recentTitles}. If relevant, you may briefly reference one of these for continuity, but don't force it.`
              : "";

            const prompt = `${PERSONA}\n\nWrite a 20-25 second video script (just the spoken narration, no stage directions) about this trending topic: ${cleanTitle}.${memoryNote}\n\nWrite this in a natural, conversational tone with appropriate punctuation for text-to-speech - use contractions, vary your rhythm, and write the way someone would actually speak out loud, not like formal writing.\n\nStructure your script in three parts:\n1. HOOK (first 1-2 sentences): State what this is about, then immediately contrast it with what people usually assume - create a "wait, really?" moment that makes them want to keep watching\n2. BODY: Build real tension - raise a question or a stake, delay your full answer for a beat, then deliver your actual take with conviction\n3. OUTRO (final 1-2 sentences): A clear payoff or takeaway - leave the viewer with your real opinion stated plainly, don't just trail off\n\nWriting style for text-to-speech: write the way you'd actually talk, not like an essay. Use short sentences. Use natural punctuation - commas, periods, dashes - to create pauses where you'd naturally pause speaking. Vary your sentence length: mix short punchy lines with slightly longer ones, the way real speech actually flows.\n\nAlso suggest a catchy, clickable video title under 60 characters that reflects your personality.\n\nFinally, describe 3 distinct visual scenes representing the subject matter, plus one SEPARATE thumbnail concept. For each scene, give: a single relevant emoji, and a short 3-5 word label phrase (not the title, never include literal words like "text" or "title"). For the thumbnail specifically, choose the single most dramatic, attention-grabbing emoji and phrase that captures the core hook of the video - this is what people see before clicking. Format your response exactly as:\nTITLE: <title>\nSCRIPT: <script>\nSCENE1_EMOJI: <emoji>\nSCENE1_LABEL: <short phrase>\nSCENE2_EMOJI: <emoji>\nSCENE2_LABEL: <short phrase>\nSCENE3_EMOJI: <emoji>\nSCENE3_LABEL: <short phrase>\nTHUMBNAIL_EMOJI: <emoji>\nTHUMBNAIL_LABEL: <short dramatic phrase>`;

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
            const te = responseText.match(/THUMBNAIL_EMOJI:\s*(.+)/i);
            const tl = responseText.match(/THUMBNAIL_LABEL:\s*(.+)/i);

            generatedTitle = titleMatch ? titleMatch[1].trim() : cleanTitle;
            generatedScript = scriptMatch ? scriptMatch[1].trim() : responseText.trim();

            sceneDescriptions = [
              { emoji: e1 ? e1[1].trim().split(" ")[0] : "🎬", label: l1 ? cleanImageDescription(l1[1].trim()) : cleanTitle },
              { emoji: e2 ? e2[1].trim().split(" ")[0] : "🎬", label: l2 ? cleanImageDescription(l2[1].trim()) : cleanTitle },
              { emoji: e3 ? e3[1].trim().split(" ")[0] : "🎬", label: l3 ? cleanImageDescription(l3[1].trim()) : cleanTitle }
            ];

            thumbnailDescription = {
              emoji: te ? te[1].trim().split(" ")[0] : "🔥",
              label: tl ? cleanImageDescription(tl[1].trim()) : cleanTitle
            };

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
            ).bind(opp.id, generatedTitle, generatedScript, JSON.stringify({ style: isCommentary ? "commentary" : "direct", persona: "skeptical_fan", sceneDescriptions, thumbnailDescription })).first();

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

          const economicsCheck = passesEconomicsGate(opp, generatedScript);
          if (!economicsCheck.passes) {
            console.log(`ECONOMICS GATE BLOCKED content_plan_id=${contentPlanId}: ${economicsCheck.reason}`);
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("ECONOMICS_GATE_BLOCKED", `content_plan_id=${contentPlanId}: ${economicsCheck.reason}`).run();
            continue;
          }

          const canProceedAudio = await checkAndIncrementDailyLimit(env, "b2_audio_upload");
          const canProceedFrames = await checkAndIncrementDailyLimit(env, "browser_render_scene");
          const canProceedThumbnail = await checkAndIncrementDailyLimit(env, "thumbnail_generation");

          if (!canProceedAudio || !canProceedFrames || !canProceedThumbnail) {
            console.log(`Daily operation limit reached, skipping asset generation for content_plan_id=${contentPlanId}`);
            continue;
          }

          const canProceedNeuronBudget = await checkNeuronBudget(env, "tts");
          if (!canProceedNeuronBudget) {
            console.log(`Skipping asset generation for content_plan_id=${contentPlanId}: estimated neuron budget exhausted for today`);
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

          const browser = await puppeteer.launch(env.BROWSER);
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 720 });

          const sceneFrameUrls = [];
          try {
            for (let sceneIdx = 0; sceneIdx < sceneDescriptions.length; sceneIdx++) {
              const motionType = MOTION_TYPES[(contentPlanId + sceneIdx) % MOTION_TYPES.length];

              const canProceedSceneImage = await checkNeuronBudget(env, "image_generation");
              let frames;
              if (canProceedSceneImage) {
                try {
                  const sceneImagePrompt = `${sceneDescriptions[sceneIdx].label}, cinematic, dramatic lighting, vibrant colors, professional illustration, no text, no logos`;
                  const sceneImageResp = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: sceneImagePrompt });
                  const sceneImageBase64 = sceneImageResp.image;

                  frames = await captureImageSceneFrames(page, {
                    imageBase64: sceneImageBase64,
                    motionType: motionType,
                    labelText: sceneDescriptions[sceneIdx].label
                  }, 6, 150);
                } catch (sceneImgErr) {
                  console.log(`Non-fatal: scene image generation failed for scene ${sceneIdx}, falling back to gradient:`, sceneImgErr.message);
                  const colorPair = COLOR_PAIRS[(contentPlanId + sceneIdx) % COLOR_PAIRS.length];
                  frames = await captureSceneFrames(page, {
                    emoji: sceneDescriptions[sceneIdx].emoji,
                    primaryColor: colorPair[0],
                    secondaryColor: colorPair[1],
                    motionType: motionType,
                    labelText: sceneDescriptions[sceneIdx].label
                  }, 6, 150);
                }
              } else {
                console.log(`Neuron budget exhausted, using gradient fallback for scene ${sceneIdx}`);
                const colorPair = COLOR_PAIRS[(contentPlanId + sceneIdx) % COLOR_PAIRS.length];
                frames = await captureSceneFrames(page, {
                  emoji: sceneDescriptions[sceneIdx].emoji,
                  primaryColor: colorPair[0],
                  secondaryColor: colorPair[1],
                  motionType: motionType,
                  labelText: sceneDescriptions[sceneIdx].label
                }, 6, 150);
              }

              const frameUrls = [];
              for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
                const uploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.B2_BUCKET_ID);
                const frameFileName = `frames/content_plan_${contentPlanId}_scene${sceneIdx}_frame${frameIdx}.jpg`;
                await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, frameFileName, new Uint8Array(frames[frameIdx]), "image/jpeg");
                frameUrls.push(`${downloadUrlBase}/file/ai-ceo-media/${frameFileName}?Authorization=${authToken}`);
              }
              sceneFrameUrls.push(frameUrls);
            }
          } finally {
            await browser.close();
          }

          console.log(`Generating dedicated thumbnail for content_plan_id=${contentPlanId}...`);
          const thumbnailPrompt = `${thumbnailDescription.label}, dramatic high-contrast lighting, single clear focal point, rule of thirds composition, vibrant saturated colors, professional photography style, eye-catching`;
          const thumbResp = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
            prompt: thumbnailPrompt
          });
          const thumbBinaryString = atob(thumbResp.image);
          const thumbBytes = Uint8Array.from(thumbBinaryString, (m) => m.codePointAt(0));

          const thumbUploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.B2_BUCKET_ID);
          const thumbnailFileName = `thumbnails/content_plan_${contentPlanId}_thumb.jpg`;
          const thumbUploadResult = await b2UploadFile(thumbUploadUrlData.uploadUrl, thumbUploadUrlData.authorizationToken, thumbnailFileName, thumbBytes, "image/jpeg");
          const thumbnailDownloadUrl = `${downloadUrlBase}/file/ai-ceo-media/${thumbnailFileName}?Authorization=${authToken}`;
          console.log(`Thumbnail generated and uploaded: ${thumbnailFileName}`);

          const uploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.B2_BUCKET_ID);
          const audioFileName = `audio/content_plan_${contentPlanId}.mp3`;
          const audioUploadResult = await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, audioFileName, audioBytes, "audio/mpeg");

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

          const b2FileIds = JSON.stringify({
            video: { fileId: assembleResult.fileId, fileName: finalVideoFileName },
            thumbnail: { fileId: thumbUploadResult.fileId, fileName: thumbnailFileName },
            audio: { fileId: audioUploadResult.fileId, fileName: audioFileName }
          });

          await env.ai_ceo_memory.prepare(
            "INSERT INTO videos (content_plan_id, status, thumbnail_url, video_file_name, b2_file_ids) VALUES (?, ?, ?, ?, ?)"
          ).bind(contentPlanId, "video_ready", thumbnailDownloadUrl, finalVideoFileName, b2FileIds).run();

          console.log(`Video fully assembled for content_plan_id=${contentPlanId}: ${finalVideoFileName} (fileId: ${assembleResult.fileId})`);
        } catch (videoErr) {
          console.log(`ERROR generating/uploading video assets for content_plan_id=${contentPlanId}:`, videoErr.message);
        }
      }

      const videosToPublish = await env.ai_ceo_memory.prepare(
        "SELECT * FROM videos WHERE status = 'video_ready' ORDER BY id ASC LIMIT 1"
      ).all();

      for (const video of videosToPublish.results) {
        try {
          const canProceedUpload = await checkAndIncrementDailyLimit(env, "youtube_upload");
          if (!canProceedUpload) {
            console.log(`Daily upload limit reached, skipping publish for video id=${video.id}`);
            continue;
          }

          const plan = await env.ai_ceo_memory.prepare(
            "SELECT title, script FROM content_plans WHERE id = ?"
          ).bind(video.content_plan_id).first();

          if (!plan) {
            console.log(`No content_plan found for video id=${video.id}, content_plan_id=${video.content_plan_id}`);
            continue;
          }

          if (!video.video_file_name) {
            console.log(`Skipping video id=${video.id}: video_file_name is missing (likely an old/incomplete record)`);
            continue;
          }

          console.log(`Publishing video id=${video.id} (content_plan_id=${video.content_plan_id}) to YouTube...`);

          const accessToken = await getYoutubeAccessToken(env);

          const publishAuthData = await b2Authorize(env);
          const publishDownloadBase = publishAuthData.apiInfo.storageApi.downloadUrl;
          const publishAuthToken = publishAuthData.authorizationToken;

          const videoDownloadUrl = `${publishDownloadBase}/file/ai-ceo-media/${video.video_file_name}?Authorization=${publishAuthToken}`;
          const videoFileRes = await fetch(videoDownloadUrl);
          if (!videoFileRes.ok) throw new Error(`Failed to download video file from B2: ${videoFileRes.status}`);
          const videoBytes = new Uint8Array(await videoFileRes.arrayBuffer());

          const uploadResult = await uploadVideoToYoutube(accessToken, videoBytes, plan.title, plan.script);
          const youtubeVideoId = uploadResult.id;

          console.log(`Video uploaded to YouTube: videoId=${youtubeVideoId}`);

          if (video.thumbnail_url) {
            try {
              const thumbFileRes = await fetch(video.thumbnail_url);
              if (thumbFileRes.ok) {
                const thumbnailBytes = new Uint8Array(await thumbFileRes.arrayBuffer());
                await setYoutubeThumbnail(accessToken, youtubeVideoId, thumbnailBytes);
                console.log(`Thumbnail set for videoId=${youtubeVideoId}`);
              }
            } catch (thumbErr) {
              console.log(`Non-fatal: failed to set thumbnail for videoId=${youtubeVideoId}:`, thumbErr.message);
            }
          }

          await env.ai_ceo_memory.prepare(
            "UPDATE videos SET status = ?, youtube_video_id = ?, published_at = datetime('now') WHERE id = ?"
          ).bind("published", youtubeVideoId, video.id).run();

          console.log(`Video id=${video.id} marked as published with youtube_video_id=${youtubeVideoId}`);

          if (video.b2_file_ids) {
            try {
              const fileIds = JSON.parse(video.b2_file_ids);
              const cleanupAuthData = await b2Authorize(env);
              const cleanupApiUrl = cleanupAuthData.apiInfo.storageApi.apiUrl;
              const cleanupAuthToken = cleanupAuthData.authorizationToken;

              for (const key of ["video", "thumbnail", "audio"]) {
                const fileInfo = fileIds[key];
                if (fileInfo && fileInfo.fileId && fileInfo.fileName) {
                  await b2DeleteFileVersion(cleanupApiUrl, cleanupAuthToken, fileInfo.fileId, fileInfo.fileName);
                  console.log(`Deleted B2 file after publish: ${fileInfo.fileName}`);
                }
              }
            } catch (cleanupErr) {
              console.log(`Non-fatal: B2 cleanup failed for video id=${video.id}:`, cleanupErr.message);
            }
          }
        } catch (publishErr) {
          console.log(`ERROR publishing video id=${video.id}:`, publishErr.message);

          if (publishErr.message.includes("youtubeSignupRequired")) {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("CHANNEL_SETUP_NEEDED", "YouTube channel has not been created yet for this account. Visit youtube.com while signed into the channel account and create the channel, then publishing will work automatically.").run();
          }
        }
      }

      const publishedVideos = await env.ai_ceo_memory.prepare(
        "SELECT v.id, v.content_plan_id, v.youtube_video_id, cp.title, cp.script FROM videos v JOIN content_plans cp ON v.content_plan_id = cp.id WHERE v.status = 'published' AND v.youtube_video_id IS NOT NULL"
      ).all();

      for (const pubVideo of publishedVideos.results) {
        try {
          const modAccessToken = await getYoutubeAccessToken(env);
          const videoStatus = await getVideoStatus(modAccessToken, pubVideo.youtube_video_id);

          if (!videoStatus.exists || videoStatus.privacyStatus === "private" || videoStatus.rejectionReason) {
            const reason = !videoStatus.exists
              ? "video no longer exists on YouTube"
              : videoStatus.rejectionReason
                ? `rejected: ${videoStatus.rejectionReason}`
                : "privacy status changed to private (likely a platform strike)";

            console.log(`MODERATION: video id=${pubVideo.id} (youtube_video_id=${pubVideo.youtube_video_id}) flagged: ${reason}`);

            await env.ai_ceo_memory.prepare(
              "INSERT INTO removed_videos (original_video_id, content_plan_id, title, script, youtube_video_id, removal_reason, views_at_removal) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).bind(pubVideo.id, pubVideo.content_plan_id, pubVideo.title, pubVideo.script, pubVideo.youtube_video_id, reason, videoStatus.viewCount || 0).run();

            if (videoStatus.exists) {
              await deleteYoutubeVideo(modAccessToken, pubVideo.youtube_video_id);
            }

            await env.ai_ceo_memory.prepare(
              "UPDATE videos SET status = ? WHERE id = ?"
            ).bind("removed", pubVideo.id).run();

            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("VIDEO_REMOVED", `video id=${pubVideo.id} removed: ${reason}`).run();

            console.log(`Video id=${pubVideo.id} removed and data preserved in removed_videos`);
          }
        } catch (modErr) {
          console.log(`Non-fatal: moderation check failed for video id=${pubVideo.id}:`, modErr.message);
        }
      }

      console.log("scheduled() completed successfully");
    } catch (outerErr) {
      console.log("FATAL ERROR in scheduled():", outerErr.message, outerErr.stack);
    }
  }
};




































