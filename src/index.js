import puppeteer from "@cloudflare/puppeteer";
import { passesPlatformSafetyGate, passesEconomicsGate, containsForbiddenPaymentField, MIN_PROFIT_SCORE, MIN_SCRIPT_LENGTH } from "./protected-core.js";

async function b2Authorize(env, keyId, applicationKey) {
  const useKeyId = keyId || env.B2_KEY_ID;
  const useAppKey = applicationKey || env.B2_APPLICATION_KEY;
  const credentials = btoa(`${useKeyId}:${useAppKey}`);
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

async function uploadVideoToYoutube(accessToken, videoBytes, title, description, categoryId = "24", tags = []) {
  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
      categoryId: categoryId,
      tags: tags.slice(0, 15)
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

async function fetchVideoAnalytics(accessToken, channelId, videoId) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    ids: `channel==${channelId}`,
    startDate: startDate,
    endDate: endDate,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained",
    filters: `video==${videoId}`
  });

  const res = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`YouTube Analytics fetch failed: ${res.status} ${errBody}`);
  }

  const data = await res.json();
  if (!data.rows || !data.rows[0]) {
    return { views: 0, watchTimeMinutes: 0, averageViewDuration: 0, likes: 0, comments: 0, subscribersGained: 0 };
  }

  const row = data.rows[0];
  return {
    views: row[0] || 0,
    watchTimeMinutes: row[1] || 0,
    averageViewDuration: row[2] || 0,
    likes: row[3] || 0,
    comments: row[4] || 0,
    subscribersGained: row[5] || 0
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

async function assessMonetizationTrajectory(env) {
  const statsHistory = await env.ai_ceo_memory.prepare(
    "SELECT subscriber_count, recorded_at FROM channel_stats ORDER BY id ASC"
  ).all();

  if (statsHistory.results.length < 2) {
    return { hasEnoughData: false };
  }

  const oldest = statsHistory.results[0];
  const newest = statsHistory.results[statsHistory.results.length - 1];
  const daysElapsed = (new Date(newest.recorded_at + "Z").getTime() - new Date(oldest.recorded_at + "Z").getTime()) / (1000 * 60 * 60 * 24);
  const subsGained = newest.subscriber_count - oldest.subscriber_count;
  const subsPerDay = daysElapsed > 0 ? subsGained / daysElapsed : 0;

  const watchTimeTotal = await env.ai_ceo_memory.prepare("SELECT SUM(watch_time_minutes) as total_minutes FROM video_performance").first();
  const totalWatchHours = watchTimeTotal?.total_minutes ? (watchTimeTotal.total_minutes / 60) : 0;

  const subsNeeded = Math.max(0, 1000 - newest.subscriber_count);
  const daysToSubsThreshold = subsPerDay > 0 ? Math.ceil(subsNeeded / subsPerDay) : null;

  return {
    hasEnoughData: true,
    currentSubscribers: newest.subscriber_count,
    subsPerDay: subsPerDay,
    totalWatchHours: totalWatchHours,
    daysToSubsThreshold: daysToSubsThreshold,
    daysElapsed: daysElapsed
  };
}

async function researchExternalGrowthBenchmark(env) {
  const niches = ["movie trailer reaction commentary", "gaming news commentary", "music video reaction"];
  const channelIds = new Set();

  for (const query of niches) {
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&q=${encodeURIComponent(query)}&key=${env.YOUTUBE_API_KEY}`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      for (const item of (searchData.items || [])) {
        if (item.snippet && item.snippet.channelId) channelIds.add(item.snippet.channelId);
      }
    } catch (searchErr) {
      console.log(`Non-fatal: benchmark search failed for query "${query}":`, searchErr.message);
    }
  }

  if (channelIds.size === 0) {
    return { sampleSize: 0, note: "No comparable channels found" };
  }

  const idsParam = Array.from(channelIds).slice(0, 50).join(",");
  const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${idsParam}&key=${env.YOUTUBE_API_KEY}`;
  const channelsRes = await fetch(channelsUrl);
  const channelsData = await channelsRes.json();

  const comparable = (channelsData.items || []).filter(ch => {
    const subs = parseInt(ch.statistics.subscriberCount || "0", 10);
    return subs >= 500 && subs <= 50000 && !ch.statistics.hiddenSubscriberCount;
  });

  if (comparable.length === 0) {
    return { sampleSize: 0, note: "No channels in comparable size range (500-50000 subs) found" };
  }

  const now = Date.now();
  let totalVideos = 0;
  let totalAgeDays = 0;
  let totalSubs = 0;

  for (const ch of comparable) {
    totalVideos += parseInt(ch.statistics.videoCount || "0", 10);
    totalSubs += parseInt(ch.statistics.subscriberCount || "0", 10);
    const ageDays = (now - new Date(ch.snippet.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
    totalAgeDays += ageDays;
  }

  const avgVideoCount = totalVideos / comparable.length;
  const avgChannelAgeDays = totalAgeDays / comparable.length;
  const avgSubs = totalSubs / comparable.length;

  return {
    sampleSize: comparable.length,
    avgVideoCount: avgVideoCount,
    avgChannelAgeDays: avgChannelAgeDays,
    avgSubs: avgSubs,
    note: `Across ${comparable.length} comparable channels (500-50k subs) in this niche, average channel has ${avgVideoCount.toFixed(0)} videos and is ${(avgChannelAgeDays / 30).toFixed(1)} months old with ${avgSubs.toFixed(0)} avg subscribers.`
  };
}

async function reasonAboutStrategy(env, trajectory, benchmark) {
  const benchmarkSection = benchmark && benchmark.sampleSize > 0
    ? `\n\nExternal benchmark (from researching comparable channels in this niche):\n${benchmark.note}`
    : "";

  let taughtStrategySection = "";
  try {
    const taughtInstructions = await env.ai_ceo_memory.prepare(
      "SELECT instruction_text FROM user_instructions ORDER BY id DESC LIMIT 5"
    ).all();
    if (taughtInstructions.results && taughtInstructions.results.length > 0) {
      const instructionList = taughtInstructions.results.map(r => r.instruction_text).join(" | ");
      taughtStrategySection = `\n\nIMPORTANT - direct strategic instructions from your operator (these take priority over your own judgment and the benchmark above, factor them into your assessment and recommendation): ${instructionList}`;
    }
  } catch (taughtErr) {
    console.log("Non-fatal: could not fetch taught instructions for strategy reasoning:", taughtErr.message);
  }

  const strategyPrompt = `You are the strategic self-assessment layer for an automated YouTube commentary channel. Review your own growth trajectory and decide if any strategic change is warranted.${benchmarkSection}${taughtStrategySection}

Current trajectory:
- Subscribers: ${trajectory.currentSubscribers} (need 1000 for monetization)
- Growth rate: ${trajectory.subsPerDay.toFixed(2)} subscribers/day
- Total watch hours: ${trajectory.totalWatchHours.toFixed(1)} (need 4000 for monetization)
- Projected days to subscriber threshold: ${trajectory.daysToSubsThreshold || "unknown (no growth yet)"}
- Days of data so far: ${trajectory.daysElapsed.toFixed(1)}

Standing rules: you may only recommend changes within existing approved capabilities (topic selection, content style, posting frequency/timing) - you cannot recommend new payment methods, new legal/financial setups, or anything requiring human identity verification.

Given this data (which may still be very early/limited), is the current trajectory concerning enough to warrant a strategic note, or is it too early to draw conclusions? Respond in 1-3 sentences with your honest assessment and any recommendation.`;

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: strategyPrompt }]
  });

  return (aiResponse.response || "").trim();
}

async function extractFramesChunked(env, videoUrl, totalDurationSeconds, b2KeyId, b2ApplicationKey, b2BucketId) {
  const CHUNK_SECONDS = 1200;
  let allFrames = [];
  for (let startSeconds = 0; startSeconds < totalDurationSeconds; startSeconds += CHUNK_SECONDS) {
    const chunkDuration = Math.min(CHUNK_SECONDS, totalDurationSeconds - startSeconds);
    console.log(`Chunked extraction: processing window ${startSeconds}s-${startSeconds + chunkDuration}s...`);
    const res = await fetch("https://ai-ceo-video-assembler.onrender.com/analyze-extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoUrl: videoUrl,
        b2KeyId: b2KeyId,
        b2ApplicationKey: b2ApplicationKey,
        b2BucketId: b2BucketId,
        startSeconds: startSeconds,
        chunkDuration: chunkDuration
      })
    });
    if (!res.ok) throw new Error(`Chunked extraction failed at ${startSeconds}s: ${res.status} ${await res.text()}`);
    const data = await res.json();
    allFrames = allFrames.concat(data.frames);
  }
  return allFrames;
}

async function extractAudioOnly(env, videoUrl, b2KeyId, b2ApplicationKey, b2BucketId) {
  const res = await fetch("https://ai-ceo-video-assembler.onrender.com/analyze-extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoUrl: videoUrl,
      b2KeyId: b2KeyId,
      b2ApplicationKey: b2ApplicationKey,
      b2BucketId: b2BucketId,
      audioOnly: true
    })
  });
  if (!res.ok) throw new Error(`Audio-only extraction failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.audio;
}

async function probeVideoDuration(env, fileName, fileId) {
  const videoUrl = fileId ? await getAnalyzerDownloadUrlById(env, fileId) : await getAnalyzerDownloadUrl(env, fileName);
  const res = await fetch("https://ai-ceo-video-assembler.onrender.com/video-duration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoUrl: videoUrl })
  });
  if (!res.ok) throw new Error(`Duration probe failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.durationSeconds;
}

async function getAnalyzerDownloadUrl(env, fileName) {
  const authData = await b2Authorize(env, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY);
  const downloadUrlBase = authData.apiInfo.storageApi.downloadUrl;
  const authToken = authData.authorizationToken;
  return `${downloadUrlBase}/file/ai-ceo-analyzer-inputs/${encodeURIComponent(fileName)}?Authorization=${authToken}`;
}

async function getAnalyzerDownloadUrlById(env, fileId) {
  const authData = await b2Authorize(env, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY);
  const downloadUrlBase = authData.apiInfo.storageApi.downloadUrl;
  const authToken = authData.authorizationToken;
  return `${downloadUrlBase}/b2api/v3/b2_download_file_by_id?fileId=${fileId}&Authorization=${authToken}`;
}

async function transcribeAudioWhisper(env, audioBuffer) {
  const bytes = new Uint8Array(audioBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);

  const response = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: base64
  });
  return {
    text: response.text || "",
    segments: response.segments || []
  };
}

async function getB2FileId(apiUrl, authToken, bucketId, fileName) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_list_file_names?bucketId=${bucketId}&startFileName=${encodeURIComponent(fileName)}&maxFileCount=1`, {
    headers: { Authorization: authToken }
  });
  if (!res.ok) throw new Error(`b2_list_file_names failed: ${res.status}`);
  const data = await res.json();
  const match = data.files.find(f => f.fileName === fileName);
  if (!match) throw new Error(`File not found in bucket: ${fileName}`);
  return match.fileId;
}

async function deriveTopicFromAnalysis(env, transcription, frameAnalyses) {
  const frameDescriptions = frameAnalyses.map((a, i) => `Frame ${i+1}: ${a}`).join("\n");
  const prompt = `Based on this video's transcript and visual content, identify the topic/niche in 2-4 words (e.g. "cooking tutorial", "gaming commentary", "fitness routine").

Transcript: "${transcription.text.slice(0, 1000)}"

Visual frames:
${frameDescriptions}

Respond with ONLY the topic phrase, nothing else.`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });
  return (response.response || "general content").trim();
}

async function synthesizeAnalyzerInsight(env, transcription, frameAnalyses, topic, benchmarkNote) {
  const frameDescriptions = frameAnalyses.map((a, i) => `Frame ${i+1}: ${a}`).join("\n");
  const benchmarkSection = benchmarkNote ? `\n\nFor context, here's what is known to perform well in this niche currently: ${benchmarkNote}` : "";

  const prompt = `You are analyzing a video to extract ONE abstracted, reusable insight about what makes content engaging. Do NOT describe the specific content - extract a general PATTERN about structure, pacing, or presentation that could apply to other videos in this niche.

Topic: ${topic}
Transcript: "${transcription.text.slice(0, 1500)}"
Visual analysis:
${frameDescriptions}${benchmarkSection}

Respond in this exact format:
PATTERN: <short pattern name, e.g. "question-hook" or "fast-cut-pacing">
TIMING: <approximate seconds into the video where this pattern occurs, or 0 if not time-specific>
EFFECT: <what effect this likely has on viewer engagement, 1 sentence>
CONFIDENCE: <a number 0.0-1.0 for how confident you are this is a genuine, reusable pattern>`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });
  const text = response.response || "";

  const pattern = (text.match(/PATTERN:\s*(.+)/i) || [])[1]?.trim() || "general-pattern";
  const timing = parseFloat((text.match(/TIMING:\s*([\d.]+)/i) || [])[1]) || 0;
  const effect = (text.match(/EFFECT:\s*(.+)/i) || [])[1]?.trim() || "";
  const confidence = parseFloat((text.match(/CONFIDENCE:\s*([\d.]+)/i) || [])[1]) || 0.5;

  return { pattern, timing, effect, confidence };
}

async function processAnalyzerInput(env, inputId) {
  const inputRow = await env.ai_ceo_memory.prepare(
    "SELECT * FROM analyzer_inputs WHERE id = ?"
  ).bind(inputId).first();
  if (!inputRow) throw new Error(`No analyzer_input found for id=${inputId}`);

  const videoUrl = inputRow.b2_file_id ? await getAnalyzerDownloadUrlById(env, inputRow.b2_file_id) : await getAnalyzerDownloadUrl(env, inputRow.b2_file_name);

  const LONG_VIDEO_THRESHOLD_SECONDS = 3600;
  const isLongVideo = inputRow.duration_seconds !== null && inputRow.duration_seconds > LONG_VIDEO_THRESHOLD_SECONDS;

  let audioResult, frameResults;

  if (isLongVideo) {
    console.log(`analyzer_input_id=${inputId}: long video (${inputRow.duration_seconds}s) - using chunked extraction...`);
    audioResult = await extractAudioOnly(env, videoUrl, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY, env.ANALYZER_B2_BUCKET_ID);
    frameResults = await extractFramesChunked(env, videoUrl, inputRow.duration_seconds, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY, env.ANALYZER_B2_BUCKET_ID);
  } else {
    console.log(`Calling Render /analyze-extract for analyzer_input_id=${inputId}...`);
    const extractRes = await fetch("https://ai-ceo-video-assembler.onrender.com/analyze-extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoUrl: videoUrl,
        b2KeyId: env.ANALYZER_B2_KEY_ID,
        b2ApplicationKey: env.ANALYZER_B2_APPLICATION_KEY,
        b2BucketId: env.ANALYZER_B2_BUCKET_ID
      })
    });
    if (!extractRes.ok) throw new Error(`Render extraction failed: ${extractRes.status} ${await extractRes.text()}`);
    const extractData = await extractRes.json();
    audioResult = extractData.audio;
    frameResults = extractData.frames;
  }

  console.log(`Transcribing extracted audio for analyzer_input_id=${inputId}...`);
  const audioDownloadUrl = await getAnalyzerDownloadUrl(env, audioResult.fileName);
  const audioRes = await fetch(audioDownloadUrl);
  const audioBuffer = await audioRes.arrayBuffer();
  const transcription = await transcribeAudioWhisper(env, audioBuffer);

  console.log(`Analyzing ${frameResults.length} extracted frames for analyzer_input_id=${inputId}...`);
  const frameAnalyses = [];
  for (const frameResult of frameResults) {
    try {
      const frameDownloadUrl = await getAnalyzerDownloadUrl(env, frameResult.fileName);
      const analysis = await analyzeThumbnail(env, frameDownloadUrl);
      frameAnalyses.push(analysis);
    } catch (frameErr) {
      console.log(`Non-fatal: frame analysis failed for ${frameResult.fileName}:`, frameErr.message);
    }
  }

  const topic = await deriveTopicFromAnalysis(env, transcription, frameAnalyses);
  console.log(`Derived topic for analyzer_input_id=${inputId}: ${topic}`);

  let benchmarkNote = null;
  try {
    await collectCompetitorInsights(env, topic);
    const recentPattern = await env.ai_ceo_memory.prepare(
      "SELECT analysis FROM title_pattern_insights WHERE query = ? ORDER BY id DESC LIMIT 1"
    ).bind(topic).first();
    benchmarkNote = recentPattern ? recentPattern.analysis : null;
  } catch (benchmarkErr) {
    console.log(`Non-fatal: competitor cross-referencing failed for analyzer_input_id=${inputId}:`, benchmarkErr.message);
  }

  const insight = await synthesizeAnalyzerInsight(env, transcription, frameAnalyses, topic, benchmarkNote);

  await env.ai_ceo_memory.prepare(
    "INSERT INTO analyzer_insights (analyzer_input_id, pattern, timing_seconds, observed_effect, niche, confidence) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(inputId, insight.pattern, insight.timing, insight.effect, topic, insight.confidence).run();

  console.log(`Stored insight for analyzer_input_id=${inputId}: ${insight.pattern} (confidence=${insight.confidence})`);

  if (inputRow.mode === "teach") {
    const trimmedTranscript = (transcription.text || "").trim();
    const MIN_INSTRUCTION_LENGTH = 15;
    if (trimmedTranscript.length < MIN_INSTRUCTION_LENGTH) {
      console.log(`Teach mode: skipping storage for analyzer_input_id=${inputId} - transcript too short/empty (likely silence or transcription failure): "${trimmedTranscript}"`);
    } else {
    try {
      await env.ai_ceo_memory.prepare(
        "INSERT INTO user_instructions (source_file, instruction_text) VALUES (?, ?)"
      ).bind(inputRow.b2_file_name, trimmedTranscript).run();
      console.log(`Teach mode: stored direct instruction for analyzer_input_id=${inputId}`);
    } catch (teachErr) {
      console.log(`Non-fatal: storing teach instruction failed for analyzer_input_id=${inputId}:`, teachErr.message);
    }
    }
  }

  try {
    const authData = await b2Authorize(env, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY);
    const apiUrl = authData.apiInfo.storageApi.apiUrl;
    const authToken = authData.authorizationToken;

    await b2DeleteFileVersion(apiUrl, authToken, audioResult.fileId, audioResult.fileName);
    for (const frameResult of frameResults) {
      await b2DeleteFileVersion(apiUrl, authToken, frameResult.fileId, frameResult.fileName);
    }

    const originalFileId = await getB2FileId(apiUrl, authToken, env.ANALYZER_B2_BUCKET_ID, inputRow.b2_file_name);
    await b2DeleteFileVersion(apiUrl, authToken, originalFileId, inputRow.b2_file_name);

    console.log(`Cleaned up original video + extracted audio/frames for analyzer_input_id=${inputId}`);
  } catch (cleanupErr) {
    console.log(`Non-fatal: cleanup failed for analyzer_input_id=${inputId}:`, cleanupErr.message);
  }

  try {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
    ).bind("ANALYZER_PROCESSING_SUCCESS", `analyzer_input_id=${inputId} mode=${inputRow.mode} pattern=${insight.pattern} confidence=${insight.confidence}`).run();
  } catch (successAlertErr) {
    console.log("Non-fatal: could not log analyzer success to system_alerts:", successAlertErr.message);
  }

  await env.ai_ceo_memory.prepare(
    "UPDATE analyzer_inputs SET status = ? WHERE id = ?"
  ).bind("analyzed", inputId).run();

  return { topic, insight };
}

async function getAnalyzerUploadUrl(env, fileName) {
  const authData = await b2Authorize(env, env.ANALYZER_B2_KEY_ID, env.ANALYZER_B2_APPLICATION_KEY);
  const apiUrl = authData.apiInfo.storageApi.apiUrl;
  const authToken = authData.authorizationToken;
  const uploadUrlData = await b2GetUploadUrl(apiUrl, authToken, env.ANALYZER_B2_BUCKET_ID);
  return {
    uploadUrl: uploadUrlData.uploadUrl,
    authToken: uploadUrlData.authorizationToken,
    fileName: fileName
  };
}

async function getTaughtVariantPreference(env, variantList, variantTypeLabel) {
  const cacheKey = `variant_preference_${variantTypeLabel}`;
  const cached = await env.ai_ceo_memory.prepare(
    "SELECT value, updated_at FROM taught_preferences WHERE key = ?"
  ).bind(cacheKey).first();

  if (cached) {
    const ageHours = (Date.now() - new Date(cached.updated_at + "Z").getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      return cached.value === "NONE" ? null : variantList.find(v => v.id === cached.value) || null;
    }
  }

  const recentInstructions = await env.ai_ceo_memory.prepare(
    "SELECT instruction_text FROM user_instructions ORDER BY id DESC LIMIT 5"
  ).all();

  if (!recentInstructions.results || recentInstructions.results.length === 0) {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO taught_preferences (key, value, updated_at) VALUES (?, 'NONE', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'NONE', updated_at = datetime('now')"
    ).bind(cacheKey).run();
    return null;
  }

  const instructionList = recentInstructions.results.map(r => r.instruction_text).join(" | ");
  const optionsList = variantList.map(v => `${v.id}: ${v.instruction}`).join("\n");
  const prompt = `Review these instructions from a YouTube channel operator. Do any of them express a preference that matches one of these specific style options?

Instructions: ${instructionList}

Options:
${optionsList}

Respond with EXACTLY one line: MATCH: <option id> or MATCH: NONE if no instruction clearly matches one of these specific options.`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });
  const text = response.response || "";
  const match = text.match(/MATCH:\s*(\S+)/i);
  const result = match ? match[1] : "NONE";
  const validResult = variantList.find(v => v.id === result) ? result : "NONE";

  await env.ai_ceo_memory.prepare(
    "INSERT INTO taught_preferences (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).bind(cacheKey, validResult, validResult).run();

  return validResult === "NONE" ? null : variantList.find(v => v.id === validResult);
}

async function selectTitleVariant(env) {
  const MIN_SAMPLE_SIZE = 5;
  const performanceRows = await env.ai_ceo_memory.prepare(`
    SELECT pv.variant_text,
           COUNT(*) as sample_size,
           AVG(vp.views) as avg_views
    FROM prompt_variants pv
    JOIN videos v ON v.content_plan_id = pv.content_plan_id
    JOIN video_performance vp ON vp.video_id = v.id
    WHERE pv.variant_type = 'title_style'
    GROUP BY pv.variant_text
  `).all();

  const scored = performanceRows.results.filter(r => r.sample_size >= MIN_SAMPLE_SIZE && r.avg_views != null);
  if (scored.length > 0) {
    const best = scored.reduce((a, b) => (a.avg_views > b.avg_views ? a : b));
    const bestVariant = TITLE_STYLE_VARIANTS.find(v => v.id === best.variant_text);
    if (bestVariant) {
      console.log(`Title variant selected by performance: ${bestVariant.id} (avg_views=${best.avg_views.toFixed(1)}, n=${best.sample_size})`);
      return bestVariant;
    }
  }

  try {
    const taughtVariant = await getTaughtVariantPreference(env, TITLE_STYLE_VARIANTS, "title_style");
    if (taughtVariant) {
      console.log(`Title variant selected by taught preference: ${taughtVariant.id} (not enough performance data yet to override)`);
      return taughtVariant;
    }
  } catch (taughtVariantErr) {
    console.log("Non-fatal: could not check taught title-variant preference:", taughtVariantErr.message);
  }

  const variantCounts = await env.ai_ceo_memory.prepare(
    "SELECT variant_text, COUNT(*) as cnt FROM prompt_variants WHERE variant_type = 'title_style' GROUP BY variant_text"
  ).all();

  const countMap = {};
  for (const row of variantCounts.results) {
    countMap[row.variant_text] = row.cnt;
  }

  let leastUsed = TITLE_STYLE_VARIANTS[0];
  let leastCount = countMap[leastUsed.id] || 0;
  for (const variant of TITLE_STYLE_VARIANTS) {
    const count = countMap[variant.id] || 0;
    if (count < leastCount) {
      leastUsed = variant;
      leastCount = count;
    }
  }

  return leastUsed;
}

async function selectHookVariant(env) {
  const MIN_SAMPLE_SIZE = 5;
  const performanceRows = await env.ai_ceo_memory.prepare(`
    SELECT pv.variant_text,
           COUNT(*) as sample_size,
           AVG(vp.average_view_duration) as avg_duration
    FROM prompt_variants pv
    JOIN videos v ON v.content_plan_id = pv.content_plan_id
    JOIN video_performance vp ON vp.video_id = v.id
    WHERE pv.variant_type = 'hook_intensity'
    GROUP BY pv.variant_text
  `).all();

  const scored = performanceRows.results.filter(r => r.sample_size >= MIN_SAMPLE_SIZE && r.avg_duration != null);
  if (scored.length > 0) {
    const best = scored.reduce((a, b) => (a.avg_duration > b.avg_duration ? a : b));
    const bestVariant = HOOK_INTENSITY_VARIANTS.find(v => v.id === best.variant_text);
    if (bestVariant) {
      console.log(`Hook variant selected by performance: ${bestVariant.id} (avg_duration=${best.avg_duration.toFixed(1)}s, n=${best.sample_size})`);
      return bestVariant;
    }
  }

  try {
    const taughtVariant = await getTaughtVariantPreference(env, HOOK_INTENSITY_VARIANTS, "hook_intensity");
    if (taughtVariant) {
      console.log(`Hook variant selected by taught preference: ${taughtVariant.id} (not enough performance data yet to override)`);
      return taughtVariant;
    }
  } catch (taughtVariantErr) {
    console.log("Non-fatal: could not check taught hook-variant preference:", taughtVariantErr.message);
  }

  const variantCounts = await env.ai_ceo_memory.prepare(
    "SELECT variant_text, COUNT(*) as cnt FROM prompt_variants WHERE variant_type = 'hook_intensity' GROUP BY variant_text"
  ).all();

  const countMap = {};
  for (const row of variantCounts.results) {
    countMap[row.variant_text] = row.cnt;
  }

  let leastUsed = HOOK_INTENSITY_VARIANTS[0];
  let leastCount = countMap[leastUsed.id] || 0;
  for (const variant of HOOK_INTENSITY_VARIANTS) {
    const count = countMap[variant.id] || 0;
    if (count < leastCount) {
      leastUsed = variant;
      leastCount = count;
    }
  }

  return leastUsed;
}

async function reasonTopicSelection(env, candidates, recentTitles) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let pastReasoningNote = "";
  try {
    const pastHistory = await env.ai_ceo_memory.prepare(
      "SELECT chosen_value, reasoning FROM reasoning_history WHERE decision_type = 'topic_selection' ORDER BY id DESC LIMIT 5"
    ).all();
    if (pastHistory.results.length > 0) {
      const historyList = pastHistory.results.map(h => `- Chose "${h.chosen_value}" because: ${h.reasoning}`).join("\n");
      pastReasoningNote = `\n\nYour past reasoning on similar decisions (for context, learn from your own patterns):\n${historyList}`;
    }
  } catch (historyFetchErr) {
    console.log("Non-fatal: could not fetch reasoning history:", historyFetchErr.message);
  }

  const candidateList = candidates.map((c, i) => `${i + 1}. "${c.title}" (profit_score: ${c.profit_score.toFixed(0)}, status: ${c.status})`).join("\n");

  const reasoningPrompt = `You are the decision-making layer for an automated YouTube commentary channel ("The Skeptical Fan" persona). You must choose ONE topic from the candidates below to produce a video about today.

Standing rules you MUST follow:
- Never choose anything involving real-world violence, hate, self-harm, child safety risks, or illegal activity (these are already filtered out, but use judgment on borderline cases)
- Prefer topics that are durable/evergreen and could support real audience value over purely disposable trending noise, when the difference is meaningful
- Consider the channel's recent history below to avoid repetitive or stale coverage
- Your job is to maximize long-term channel growth and profit potential, not just raw view count

Candidates (already pre-filtered for basic eligibility, ranked by a simple view-based score):
${candidateList}

Recent videos covered: ${recentTitles || "none yet"}${pastReasoningNote}

Pick the single best candidate by NUMBER, and explain your reasoning in 1-2 sentences. Format exactly as:
CHOICE: <number>
REASONING: <your reasoning>`;

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: reasoningPrompt }]
  });

  const responseText = aiResponse.response || "";
  const choiceMatch = responseText.match(/CHOICE:\s*(\d+)/i);
  const reasoningMatch = responseText.match(/REASONING:\s*(.+)/i);

  const chosenIndex = choiceMatch ? parseInt(choiceMatch[1], 10) - 1 : 0;
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "No reasoning provided";

  const chosen = candidates[chosenIndex] || candidates[0];
  return { ...chosen, _reasoning: reasoning };
}

async function critiqueScriptOriginality(env, script, title) {
  const recentPlans = await env.ai_ceo_memory.prepare(
    "SELECT title FROM content_plans WHERE script IS NOT NULL ORDER BY id DESC LIMIT 15"
  ).all();
  const recentTitles = recentPlans.results.map(r => r.title).join("; ");

  const critiquePrompt = `You are a strict, skeptical content critic reviewing a YouTube Shorts script BEFORE it gets published. Your job is to catch generic, templated, or low-effort writing that would feel like "AI slop" to a real viewer, AND to catch content that's too similar to what's already been covered recently.

Title: ${title}
Script: ${script}

Recently covered topics/titles on this channel (for novelty comparison): ${recentTitles || "none yet"}

Evaluate honestly:
1. Does this sound like a real person with an opinion, or like a generic template filled with this topic's name swapped in?
2. Are there any cliche phrases that overused AI-generated content tends to use (e.g. "here we go again", "let's be real", excessive rhetorical questions stacked together)?
3. Does the ending feel like a genuine conclusion, or does it trail off generically?
4. NOVELTY CHECK: is this title/topic too similar in subject, angle, or structure to anything in the recent list above? Score 0.0 (basically a repeat) to 1.0 (completely fresh territory).

Respond in exactly this format:
VERDICT: PASS or REVISE
REASON: <one sentence explaining your verdict>
NOVELTY_SCORE: <a number 0.0 to 1.0>`;

  const critiqueResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: critiquePrompt }]
  });

  const responseText = critiqueResponse.response || "";
  const verdictMatch = responseText.match(/VERDICT:\s*(PASS|REVISE)/i);
  const reasonMatch = responseText.match(/REASON:\s*(.+)/i);
  const noveltyMatch = responseText.match(/NOVELTY_SCORE:\s*([\d.]+)/i);

  const noveltyScore = noveltyMatch ? parseFloat(noveltyMatch[1]) : 1.0;
  const writingPasses = verdictMatch ? verdictMatch[1].toUpperCase() === "PASS" : true;
  const NOVELTY_THRESHOLD = 0.3;

  return {
    passes: writingPasses && noveltyScore >= NOVELTY_THRESHOLD,
    reason: reasonMatch ? reasonMatch[1].trim() : "No reason provided",
    noveltyScore: noveltyScore
  };
}

async function generateChannelIdentity(env) {
  const prompt = `${PERSONA}\n\nYou need to design the YouTube channel identity for this persona. Generate:\n1. A catchy channel NAME under 30 characters that reflects this skeptical-but-passionate commentator persona (not generic, memorable, fits a trending pop-culture/gaming/music commentary channel)\n2. A channel DESCRIPTION under 800 characters that tells potential subscribers what to expect, written in the persona voice\n3. A BANNER_PROMPT - a short visual description (for an AI image generator) for a YouTube channel banner background that fits this persona and content (dramatic, eye-catching, NOT containing any text/words/logos)\n4. KEYWORDS - 10-15 relevant search keywords/phrases (comma-separated) that describe this channel's content for YouTube search discovery (e.g. topics, genres, persona traits)\n\nFormat exactly as:\nNAME: <name>\nDESCRIPTION: <description>\nBANNER_PROMPT: <prompt>\nKEYWORDS: <keyword1, keyword2, keyword3, ...>`;

  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });

  const responseText = aiResponse.response || "";
  const nameMatch = responseText.match(/NAME:\s*(.+)/i);
  const descMatch = responseText.match(/DESCRIPTION:\s*([\s\S]+?)(?=BANNER_PROMPT:|$)/i);
  const bannerMatch = responseText.match(/BANNER_PROMPT:\s*(.+)/i);
  const keywordsMatch = responseText.match(/KEYWORDS:\s*(.+)/i);

  const cleanName = nameMatch ? nameMatch[1].trim().replace(/["`]/g, "").replace(/\s+/g, " ").slice(0, 30).trim() : "";
  const cleanDescription = descMatch ? descMatch[1].trim().replace(/["`]/g, "").slice(0, 800).trim() : "";

  return {
    name: (cleanName.length >= 3) ? cleanName : "The Skeptical Fan",
    description: (cleanDescription.length >= 10) ? cleanDescription : "Calling out the hype, one trend at a time.",
    bannerPrompt: bannerMatch ? bannerMatch[1].trim().replace(/["`]/g, "") : "dramatic dark cinematic background, bold colors",
    keywords: keywordsMatch ? keywordsMatch[1].trim().replace(/["`]/g, "") : ""
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

async function applyChannelBranding(accessToken, channelId, title, description, bannerUrl, keywords) {
  const body = {
    id: channelId,
    brandingSettings: {
      channel: {
        title: title,
        description: description,
        keywords: keywords || ""
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

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function searchPexelsVideo(apiKey, query) {
  const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=5`, {
    headers: { Authorization: apiKey }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Pexels search failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.videos || data.videos.length === 0) {
    return null;
  }

  const video = data.videos[0];
  if (!video.image) return null;

  const sdFile = (video.video_files || []).find(f => f.quality === "sd" && f.width && f.width <= 1080)
    || (video.video_files || []).find(f => f.quality === "sd")
    || (video.video_files || [])[0];

  return {
    previewImageUrl: video.image,
    videoUrl: sdFile ? sdFile.link : null,
    photographer: video.user?.name || "Pexels"
  };
}

async function createPlaylist(accessToken, title, description) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      snippet: { title: title.slice(0, 150), description: description.slice(0, 5000) },
      status: { privacyStatus: "public" }
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Create playlist failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  return data.id;
}

async function addVideoToPlaylist(accessToken, playlistId, videoId) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      snippet: {
        playlistId: playlistId,
        resourceId: { kind: "youtube#video", videoId: videoId }
      }
    })
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Add to playlist failed: ${res.status} ${errBody}`);
  }
  return await res.json();
}

async function getCurrentBranding(accessToken, channelId) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=brandingSettings&id=${channelId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Get current branding failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.items || !data.items[0]) throw new Error("No channel found for branding lookup");
  return data.items[0].brandingSettings.channel || {};
}

async function generateKeywordsOnly(env) {
  const prompt = `${PERSONA}\n\nGenerate 10-15 relevant search keywords/phrases (comma-separated) that describe this YouTube channel's content for search discovery (topics, genres, persona traits). Respond with only the comma-separated list, nothing else.`;
  const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });
  return (aiResponse.response || "").trim().replace(/["`]/g, "").slice(0, 500);
}

async function fetchVideoComments(accessToken, videoId) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=20&order=relevance`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 403) {
      return [];
    }
    const errBody = await res.text();
    throw new Error(`Fetch comments failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.items) return [];

  return data.items.map(item => {
    const snippet = item.snippet.topLevelComment.snippet;
    return {
      commentId: item.snippet.topLevelComment.id,
      author: snippet.authorDisplayName,
      text: snippet.textDisplay,
      likeCount: snippet.likeCount,
      publishedAt: snippet.publishedAt
    };
  });
}

async function getChannelStats(accessToken) {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Get channel stats failed: ${res.status} ${errBody}`);
  }
  const data = await res.json();
  if (!data.items || !data.items[0]) throw new Error("No channel found for stats");
  const stats = data.items[0].statistics;
  return {
    subscriberCount: parseInt(stats.subscriberCount || "0", 10),
    viewCount: parseInt(stats.viewCount || "0", 10),
    videoCount: parseInt(stats.videoCount || "0", 10)
  };
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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function analyzeThumbnail(env, imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Thumbnail fetch failed: ${imgRes.status}`);
  const buffer = await imgRes.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const contentType = imgRes.headers.get("content-type") || "image/jpeg";

  const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
    messages: [{ role: "user", content: "Describe this YouTube Shorts thumbnail in 1-2 sentences: composition, color scheme, text overlay if any, and main focal point. Be specific and concise." }],
    image: `data:${contentType};base64,${base64}`
  });

  return (response.response || "").trim();
}

async function analyzeTitlePatterns(env, query, insights) {
  if (insights.length === 0) return null;

  const digest = insights.map((ins, i) =>
    `${i + 1}. Title: "${ins.title}" | Views: ${ins.viewCount}${ins.description ? ` | Description: "${ins.description}"` : ""}${ins.tags && ins.tags.length > 0 ? ` | Tags: ${ins.tags.slice(0, 5).join(", ")}` : ""}`
  ).join("\n");

  const prompt = `You are analyzing YouTube Shorts titles and descriptions from top-performing videos in the niche: "${query}".

${digest}

Identify structural patterns across these titles and descriptions - NOT the specific topics, but the FORM: are titles phrased as questions, direct statements, or number/list framing? Is there a common hook style in descriptions? Any recurring tag themes? Respond in 2-3 sentences describing the patterns, not the content.`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });

  return (response.response || "").trim();
}

async function collectCompetitorInsights(env, query) {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10&q=${encodeURIComponent(query)}&key=${env.YOUTUBE_API_KEY}`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();

  if (!searchData.items || searchData.items.length === 0) {
    console.log(`No competitor videos found for query: ${query}`);
    return [];
  }

  const videoIds = searchData.items.map(item => item.id.videoId).filter(Boolean).join(",");
  if (!videoIds) return [];

  const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds}&key=${env.YOUTUBE_API_KEY}`;
  const statsRes = await fetch(statsUrl);
  const statsData = await statsRes.json();

  if (!statsData.items) return [];

  const insights = statsData.items.map(item => ({
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    viewCount: parseInt(item.statistics.viewCount || "0", 10),
    thumbnailUrl: (item.snippet.thumbnails && (item.snippet.thumbnails.high || item.snippet.thumbnails.medium || item.snippet.thumbnails.default)) ? (item.snippet.thumbnails.high || item.snippet.thumbnails.medium || item.snippet.thumbnails.default).url : null,
    description: (item.snippet.description || "").slice(0, 300),
    tags: item.snippet.tags || []
  }));

  for (const insight of insights) {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO competitor_insights (query, video_title, view_count, channel_title) VALUES (?, ?, ?, ?)"
    ).bind(query, insight.title, insight.viewCount, insight.channelTitle).run();
  }

  const topByViews = [...insights].sort((a, b) => b.viewCount - a.viewCount).slice(0, 3);
  for (const top of topByViews) {
    if (!top.thumbnailUrl) continue;
    try {
      const analysis = await analyzeThumbnail(env, top.thumbnailUrl);
      await env.ai_ceo_memory.prepare(
        "INSERT INTO thumbnail_insights (video_title, channel_title, view_count, thumbnail_url, analysis) VALUES (?, ?, ?, ?, ?)"
      ).bind(top.title, top.channelTitle, top.viewCount, top.thumbnailUrl, analysis).run();
      console.log(`Thumbnail analyzed for "${top.title}": ${analysis}`);
    } catch (thumbErr) {
      const isLicenseIssue = thumbErr.message && thumbErr.message.toLowerCase().includes("agree");
      if (isLicenseIssue) {
        await env.ai_ceo_memory.prepare(
          "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
        ).bind("VISION_MODEL_LICENSE_NEEDED", "The vision model (@cf/meta/llama-3.2-11b-vision-instruct) requires one-time license agreement. Send a request with {\"prompt\": \"agree\"} to this model via the Cloudflare dashboard or API to enable it.").run();
      }
      console.log(`Non-fatal: thumbnail analysis failed for "${top.title}":`, thumbErr.message);
    }
  }

  try {
    const titlePatternAnalysis = await analyzeTitlePatterns(env, query, insights);
    if (titlePatternAnalysis) {
      await env.ai_ceo_memory.prepare(
        "INSERT INTO title_pattern_insights (query, analysis, sample_size) VALUES (?, ?, ?)"
      ).bind(query, titlePatternAnalysis, insights.length).run();
      console.log(`Title pattern analysis for "${query}": ${titlePatternAnalysis}`);
    }
  } catch (patternErr) {
    console.log(`Non-fatal: title pattern analysis failed for query "${query}":`, patternErr.message);
  }

  return insights;
}

async function parseTaughtTimePreference(env) {
  const cached = await env.ai_ceo_memory.prepare(
    "SELECT value, updated_at FROM taught_preferences WHERE key = 'publish_hour'"
  ).first();

  if (cached) {
    const ageHours = (Date.now() - new Date(cached.updated_at + "Z").getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      return cached.value === "NONE" ? null : parseInt(cached.value, 10);
    }
  }

  const recentInstructions = await env.ai_ceo_memory.prepare(
    "SELECT instruction_text FROM user_instructions ORDER BY id DESC LIMIT 5"
  ).all();

  if (!recentInstructions.results || recentInstructions.results.length === 0) {
    await env.ai_ceo_memory.prepare(
      "INSERT INTO taught_preferences (key, value, updated_at) VALUES ('publish_hour', 'NONE', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'NONE', updated_at = datetime('now')"
    ).run();
    return null;
  }

  const instructionList = recentInstructions.results.map(r => r.instruction_text).join(" | ");
  const prompt = `Review these instructions from a YouTube channel operator. Does ANY of them specify a preferred publishing hour or time of day?

Instructions: ${instructionList}

Respond with EXACTLY one line:
HOUR: <a number 0-23, representing UTC hour> or HOUR: NONE if no specific time/hour preference is mentioned.`;

  const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }]
  });
  const text = response.response || "";
  const match = text.match(/HOUR:\s*(\d+|NONE)/i);
  const result = match ? match[1].toUpperCase() : "NONE";

  await env.ai_ceo_memory.prepare(
    "INSERT INTO taught_preferences (key, value, updated_at) VALUES ('publish_hour', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
  ).bind(result, result).run();

  return result === "NONE" ? null : parseInt(result, 10);
}

async function getNextRotationHour(env) {
  try {
    const taughtHour = await parseTaughtTimePreference(env);
    if (taughtHour !== null) {
      const recentUse = await env.ai_ceo_memory.prepare(
        "SELECT last_used_at FROM publish_hour_rotation WHERE hour = ?"
      ).bind(taughtHour).first();
      const hoursSinceUsed = recentUse
        ? (Date.now() - new Date(recentUse.last_used_at + "Z").getTime()) / (1000 * 60 * 60)
        : 999;
      if (hoursSinceUsed >= 12) {
        console.log(`Using taught publish-hour preference: ${taughtHour} UTC`);
        return taughtHour;
      }
    }
  } catch (taughtHourErr) {
    console.log("Non-fatal: could not check taught publish-hour preference:", taughtHourErr.message);
  }

  for (let h = 0; h < 24; h++) {
    const row = await env.ai_ceo_memory.prepare(
      "SELECT hour FROM publish_hour_rotation WHERE hour = ?"
    ).bind(h).first();
    if (!row) {
      return h;
    }
  }

  const leastRecent = await env.ai_ceo_memory.prepare(
    "SELECT hour FROM publish_hour_rotation ORDER BY last_used_at ASC LIMIT 1"
  ).first();
  return leastRecent ? leastRecent.hour : 0;
}

async function markHourUsed(env, hour) {
  await env.ai_ceo_memory.prepare(
    "INSERT INTO publish_hour_rotation (hour, last_used_at) VALUES (?, datetime('now')) ON CONFLICT(hour) DO UPDATE SET last_used_at = datetime('now')"
  ).bind(hour).run();
}

const DAILY_NEURON_BUDGET = 10000;
const ESTIMATED_NEURON_COST = {
  text_generation: 150,
  tts: 8200,
  image_generation: 700
};

async function checkNeuronBudgetCustomCost(env, estimatedCost) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.ai_ceo_memory.prepare(
    "SELECT count FROM daily_usage WHERE usage_date = ? AND op_type = ?"
  ).bind(today, "neurons_estimated").first();

  const usedSoFar = row ? row.count : 0;

  if (usedSoFar + estimatedCost > DAILY_NEURON_BUDGET) {
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

function estimateAnalyzerCost(durationSeconds) {
  const VISION_ANALYSIS_PER_FRAME = 150;
  const AUDIO_TRANSCRIPTION_BASE = 600;
  const frameCount = Math.ceil(durationSeconds / 2);
  const visionCost = frameCount * VISION_ANALYSIS_PER_FRAME;
  const transcriptionCost = AUDIO_TRANSCRIPTION_BASE;
  const llmCost = 2 * (ESTIMATED_NEURON_COST.text_generation || 150);
  return visionCost + transcriptionCost + llmCost;
}

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

const CATEGORY_KEYWORDS = {
  "20": ["game", "gaming", "gameplay", "esports", "playstation", "xbox", "nintendo", "steam", "fortnite", "minecraft", "valorant", "ps5", "rpg", "fps", "speedrun", "dlc", "patch notes", "league of legends", "call of duty", "roblox"],
  "10": ["music", "song", "album", "official video", "lyric", "rapper", "concert", "remix", "singer", "band", "tour", "spotify", "billboard", "grammy"],
  "1": ["movie", "trailer", "film", "actor", "actress", "box office", "cinema", "director", "sequel", "prequel", "marvel", "dc comics", "blockbuster", "anime", "manga", "animated", "animation", "studio ghibli"],
  "24": ["show", "series", "episode", "drama", "celebrity", "tv", "reality tv", "talk show", "interview"]
};

function detectVideoCategory(title) {
  const lower = title.toLowerCase();
  for (const [categoryId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) {
      return categoryId;
    }
  }
  return "24";
}

function generateTags(title) {
  const stopWords = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "this", "that"]);
  const words = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  return [...new Set(words)].slice(0, 10);
}

const EVERGREEN_KEYWORDS = [
  "explained", "lore", "history of", "origin of", "every", "ranked", "tier list",
  "strongest", "weakest", "all characters", "timeline", "guide", "evolution of",
  "biggest", "best", "worst", "top 10", "top 5", "complete guide", "everything you need to know",
  "true story", "real story", "backstory", "deep dive", "breakdown", "analysis",
  "secrets", "facts", "theory", "theories", "mystery", "mysteries", "hidden details",
  "what happened to", "whatever happened", "untold story", "forgotten", "underrated"
];

function isEvergreenTopic(title) {
  const lower = title.toLowerCase();
  return EVERGREEN_KEYWORDS.some(keyword => lower.includes(keyword));
}

const TITLE_STYLE_VARIANTS = [
  { id: "direct_claim", instruction: "Make the title a direct, confident claim or verdict about the topic - no question marks." },
  { id: "question", instruction: "Make the title a pointed question that creates curiosity about your take." },
  { id: "number_list", instruction: "Make the title reference a specific number or count if natural to the topic (e.g. a ranking, a count of reasons), otherwise default to a direct claim." }
];

const HOOK_INTENSITY_VARIANTS = [
  { id: "direct", instruction: "State your contrarian take immediately and plainly in the first sentence - no buildup." },
  { id: "delayed", instruction: "Open by stating the topic neutrally, then pivot to your contrarian take in the second sentence." },
  { id: "question", instruction: "Open with a pointed rhetorical question that implies your contrarian take, before stating it directly." }
];

const SCRIPT_STRUCTURES = [
  `Structure your script in three parts:\n1. HOOK (first 1-2 sentences): State what this is about, then immediately contrast it with what people usually assume - create a "wait, really?" moment that makes them want to keep watching\n2. BODY: Build real tension - raise a question or a stake, delay your full answer for a beat, then deliver your actual take with conviction\n3. OUTRO (final 1-2 sentences): A clear payoff or takeaway - leave the viewer with your real opinion stated plainly, don't just trail off`,
  `Structure your script as a quick countdown or list:\n1. OPENING (1 sentence): Name the topic directly, no preamble\n2. POINTS: Give 2-3 short, specific observations or examples about it, building from least to most surprising or strongest\n3. CLOSING (1 sentence): A sharp final judgment that ties the points together - don't just summarize, conclude`,
  `Structure your script as a direct question to the viewer:\n1. QUESTION (1-2 sentences): Open with a provocative, specific question related to the topic that the viewer will want answered\n2. ANSWER: Work through your actual answer with real reasoning, not just an assertion\n3. TURN (final 1-2 sentences): End by turning the question back to the viewer - ask them what they think, inviting a comment, without sounding like generic engagement-bait`
];

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
  body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; font-family: Arial, sans-serif; }
  .scene { width: 1080px; height: 1920px; position: relative; overflow: hidden; background: #000; }
  .bgimg {
    position: absolute; top: 0; left: 0; width: 1080px; height: 1920px;
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
  body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; font-family: Arial, sans-serif; }
  .scene {
    width: 1080px; height: 1920px;
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

    if (url.pathname === "/status") {
      try {
        const today = new Date().toISOString().slice(0, 10);

        const totalVideos = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM videos WHERE status = 'published'").first();
        const readyVideos = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM videos WHERE status = 'video_ready'").first();
        const backlogPlans = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM content_plans cp WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)").first();
        const analyzerBacklog = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM analyzer_inputs WHERE status = 'uploaded'").first();
        const analyzerFailed = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM analyzer_inputs WHERE status = 'failed'").first();
        const recentInstructions = await env.ai_ceo_memory.prepare("SELECT instruction_text, source_file, created_at FROM user_instructions ORDER BY id DESC LIMIT 10").all();
        const removedVideos = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM removed_videos").first();
        const latestStats = await env.ai_ceo_memory.prepare("SELECT subscriber_count, view_count, video_count, recorded_at FROM channel_stats ORDER BY id DESC LIMIT 1").first();

        const watchTimeTotal = await env.ai_ceo_memory.prepare("SELECT SUM(watch_time_minutes) as total_minutes FROM video_performance").first();
        const totalWatchHours = watchTimeTotal?.total_minutes ? (watchTimeTotal.total_minutes / 60) : 0;
        const currentSubs = latestStats?.subscriber_count || 0;

        const monetizationProgress = {
          subscribers: { current: currentSubs, needed: 1000, percent: Math.min(100, (currentSubs / 1000) * 100).toFixed(1) },
          watch_hours: { current: totalWatchHours.toFixed(1), needed: 4000, percent: Math.min(100, (totalWatchHours / 4000) * 100).toFixed(1) },
          eligible: currentSubs >= 1000 && totalWatchHours >= 4000
        };

        const latestStrategyRow = await env.ai_ceo_memory.prepare(
          "SELECT chosen_value, reasoning, created_at FROM reasoning_history WHERE decision_type = 'strategy_assessment' ORDER BY id DESC LIMIT 1"
        ).first();
        const latestStrategyAssessment = latestStrategyRow ? { metrics: latestStrategyRow.chosen_value, assessment: latestStrategyRow.reasoning, at: latestStrategyRow.created_at } : null;

        const recentComments = await env.ai_ceo_memory.prepare(
          "SELECT youtube_video_id, author, text, like_count FROM video_comments ORDER BY id DESC LIMIT 10"
        ).all();

        const todayUsage = await env.ai_ceo_memory.prepare("SELECT op_type, count FROM daily_usage WHERE usage_date = ?").bind(today).all();
        const recentAlerts = await env.ai_ceo_memory.prepare("SELECT alert_type, message, created_at FROM system_alerts ORDER BY id DESC LIMIT 5").all();
        const rotationStatus = await env.ai_ceo_memory.prepare("SELECT hour, last_used_at FROM publish_hour_rotation ORDER BY hour ASC").all();

        return new Response(JSON.stringify({
          published_videos: totalVideos?.cnt || 0,
          videos_awaiting_publish: readyVideos?.cnt || 0,
          unused_content_plans_backlog: backlogPlans?.cnt || 0,
          analyzer_backlog: analyzerBacklog?.cnt || 0,
          analyzer_failed: analyzerFailed?.cnt || 0,
          recent_instructions: recentInstructions.results || [],
          videos_removed_for_moderation: removedVideos?.cnt || 0,
          channel_stats: latestStats || null,
          monetization_progress: monetizationProgress,
          latest_strategy_assessment: latestStrategyAssessment || null,
          recent_comments: recentComments.results,
          today_usage: todayUsage.results,
          recent_alerts: recentAlerts.results,
          publish_hour_rotation: rotationStatus.results
        }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (statusErr) {
        return new Response(JSON.stringify({ error: statusErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/analyzer/upload-url" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!body.fileName) {
          return new Response(JSON.stringify({ error: "fileName is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const result = await getAnalyzerUploadUrl(env, body.fileName);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      } catch (uploadUrlErr) {
        return new Response(JSON.stringify({ error: uploadUrlErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/analyzer/register" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!body.fileName) {
          return new Response(JSON.stringify({ error: "fileName is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const mode = (body.mode === "teach") ? "teach" : "analyze";
        const matchField = body.b2FileId ? "b2_file_id" : "b2_file_name";
        const matchValue = body.b2FileId || body.fileName;

        const existingSameMode = await env.ai_ceo_memory.prepare(
          `SELECT id FROM analyzer_inputs WHERE ${matchField} = ? AND mode = ? AND status IN ('uploaded', 'analyzed')`
        ).bind(matchValue, mode).first();

        if (existingSameMode) {
          return new Response(JSON.stringify({ error: "DUPLICATE_SAME_MODE", message: "This exact video has already been uploaded in this mode - skipping to avoid wasting budget on a redundant analysis." }), { status: 409, headers: { "Content-Type": "application/json" } });
        }

        const existingDifferentMode = await env.ai_ceo_memory.prepare(
          `SELECT id, mode, status, b2_file_name FROM analyzer_inputs WHERE ${matchField} = ? AND mode != ? ORDER BY id DESC LIMIT 1`
        ).bind(matchValue, mode).first();

        let correctionNote = null;
        if (existingDifferentMode) {
          if (existingDifferentMode.mode === "teach" && existingDifferentMode.status === "analyzed") {
            await env.ai_ceo_memory.prepare(
              "DELETE FROM user_instructions WHERE source_file = ?"
            ).bind(existingDifferentMode.b2_file_name).run();
            console.log(`Mode correction: deleted taught instruction(s) from source_file=${existingDifferentMode.b2_file_name} (was wrongly taught, now re-fed as ${mode})`);
          }
          await env.ai_ceo_memory.prepare(
            "DELETE FROM analyzer_inputs WHERE id = ?"
          ).bind(existingDifferentMode.id).run();
          correctionNote = `Corrected: removed previous ${existingDifferentMode.mode}-mode entry${existingDifferentMode.mode === "teach" ? " and any taught instruction from it" : ""} for this video.`;
          console.log(`Mode correction: removed old analyzer_inputs id=${existingDifferentMode.id} (mode=${existingDifferentMode.mode}) in favor of new mode=${mode}`);
        }

        const insertResult = await env.ai_ceo_memory.prepare(
          "INSERT INTO analyzer_inputs (b2_file_name, niche_tag, status, mode, b2_file_id) VALUES (?, ?, ?, ?, ?) RETURNING id"
        ).bind(body.fileName, body.nicheTag || null, "uploaded", mode, body.b2FileId || null).first();
        return new Response(JSON.stringify({ success: true, id: insertResult.id, correctionNote: correctionNote }), { headers: { "Content-Type": "application/json" } });
      } catch (registerErr) {
        return new Response(JSON.stringify({ error: registerErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/analyzer/upload") {
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Analyzer Intake</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  :root {
    --bg: #0E0F11;
    --surface: #16181B;
    --border: #25282D;
    --text: #E7E8EA;
    --text-dim: #6B7280;
    --accent: #E8A23D;
    --accent-dim: #E8A23D33;
    --success: #4ADE80;
    --error: #F87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 64px 24px;
  }
  .header { text-align: center; margin-bottom: 48px; max-width: 480px; }
  .header .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 12px;
  }
  .header h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px 0; letter-spacing: -0.01em; }
  .header p { color: var(--text-dim); font-size: 15px; line-height: 1.5; margin: 0; }
  .dropzone {
    width: 100%;
    max-width: 560px;
    min-height: 220px;
    border: 1.5px dashed var(--border);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    cursor: pointer;
    transition: border-color 0.25s ease, background 0.25s ease, box-shadow 0.25s ease;
    background: var(--surface);
    position: relative;
    overflow: hidden;
  }
  .dropzone::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 50%, var(--accent-dim), transparent 70%);
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  .dropzone.dragover {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 0 32px var(--accent-dim);
  }
  .dropzone.dragover::before { opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 0.5; }
    50% { transform: scale(1.15); opacity: 0.9; }
  }
  .dropzone-icon { width: 40px; height: 40px; color: var(--text-dim); transition: color 0.25s ease; z-index: 1; }
  .dropzone.dragover .dropzone-icon { color: var(--accent); }
  .dropzone-label { font-size: 15px; font-weight: 500; z-index: 1; }
  .dropzone-sub { font-size: 13px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; z-index: 1; }
  input[type="file"] { display: none; }
  .niche-input { width: 100%; max-width: 560px; margin-top: 16px; }
  .niche-input input {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s ease;
  }
  .niche-input input:focus { border-color: var(--accent); }
  .niche-input input::placeholder { color: var(--text-dim); }
  .mode-toggle { display: flex; gap: 8px; width: 100%; max-width: 560px; margin-top: 16px; }
  .mode-btn {
    flex: 1;
    padding: 10px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .mode-btn.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .queue { width: 100%; max-width: 560px; margin-top: 40px; }
  .queue-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 12px;
  }
  .queue-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 8px;
    font-size: 14px;
  }
  .queue-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queue-item-status { font-family: 'JetBrains Mono', monospace; font-size: 12px; flex-shrink: 0; }
  .status-uploading { color: var(--accent); }
  .status-done { color: var(--success); }
  .status-error { color: var(--error); }
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">Learning Analyzer</div>
    <h1>Feed the system</h1>
    <p>Drop videos here. They're stored separately from your channel's assets, analyzed for what works, then discarded - only the patterns stay.</p>
  </div>
  <div class="dropzone" id="dropzone">
    <svg class="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 16V4M12 4L7 9M12 4l5 5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="dropzone-label">Drop videos here, or tap to choose</div>
    <div class="dropzone-sub" id="dropzone-sub">.mp4 / .mov / .webm - one or many at once</div>
    <input type="file" id="fileInput" accept="video/*" multiple>
  </div>
  <div class="mode-toggle" id="modeToggle">
    <button class="mode-btn active" data-mode="analyze">Analyze</button>
    <button class="mode-btn" data-mode="teach">Teach</button>
  </div>
  <div class="niche-input">
    <input type="text" id="nicheTag" placeholder="niche / topic tag (optional) - e.g. cooking, commentary, gaming">
  </div>
  <div class="queue" id="queue" style="display:none;">
    <div class="queue-title">Intake queue</div>
    <div id="queueList"></div>
  </div>
<script>
  const WORKER_BASE = 'https://ai-ceo-orchestrator.jacklabs.workers.dev';
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const nicheTag = document.getElementById('nicheTag');
  const queue = document.getElementById('queue');
  const queueList = document.getElementById('queueList');
  let currentMode = 'analyze';
  document.querySelectorAll('.mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
    files.forEach(uploadFile);
  });
  fileInput.addEventListener('change', (e) => {
    Array.from(e.target.files).forEach(uploadFile);
    fileInput.value = '';
  });
  function addQueueItem(fileName) {
    queue.style.display = 'block';
    const id = 'item-' + Math.random().toString(36).slice(2);
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.id = id;
    el.innerHTML = '<div class="spinner"></div><div class="queue-item-name">' + fileName + '</div><div class="queue-item-status status-uploading">uploading</div>';
    queueList.prepend(el);
    return id;
  }
  function updateQueueItem(id, status, label) {
    const el = document.getElementById(id);
    if (!el) return;
    const spinner = el.querySelector('.spinner');
    const statusEl = el.querySelector('.queue-item-status');
    if (status === 'done') {
      spinner.remove();
      statusEl.className = 'queue-item-status status-done';
      statusEl.textContent = label || 'analyzed';
    } else if (status === 'error') {
      spinner.remove();
      statusEl.className = 'queue-item-status status-error';
      statusEl.textContent = label || 'failed';
    } else {
      statusEl.textContent = label || status;
    }
  }
  async function uploadFile(file) {
    const itemId = addQueueItem(file.name);
    if (!file.type || !file.type.startsWith('video/')) {
      updateQueueItem(itemId, 'error', 'not a video file');
      return;
    }
    try {
      let urlRes;
      try {
        urlRes = await fetch(WORKER_BASE + '/analyzer/upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: file.name })
        });
      } catch (e) { throw new Error('STEP1-getUploadUrl: ' + e.message); }
      if (!urlRes.ok) throw new Error('STEP1-getUploadUrl: HTTP ' + urlRes.status);
      const urlData = await urlRes.json();
      const uploadUrl = urlData.uploadUrl;
      const authToken = urlData.authToken;
      const fileName = urlData.fileName;
      const sha1 = await crypto.subtle.digest('SHA-1', await file.arrayBuffer());
      const sha1Hex = Array.from(new Uint8Array(sha1)).map(b => b.toString(16).padStart(2, '0')).join('');
      let uploadRes;
      try {
        uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': authToken,
            'X-Bz-File-Name': encodeURIComponent(fileName),
            'Content-Type': file.type || 'video/mp4',
            'X-Bz-Content-Sha1': sha1Hex
          },
          body: file
        });
      } catch (e) { throw new Error('STEP2-uploadToB2: ' + e.message); }
      if (!uploadRes.ok) throw new Error('STEP2-uploadToB2: HTTP ' + uploadRes.status);
      const uploadResultData = await uploadRes.json();
      const b2FileId = uploadResultData.fileId;
      updateQueueItem(itemId, 'uploading', 'registering');
      let registerRes;
      try {
        registerRes = await fetch(WORKER_BASE + '/analyzer/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: fileName, nicheTag: nicheTag.value.trim() || null, mode: currentMode, b2FileId: b2FileId })
        });
      } catch (e) { throw new Error('STEP3-register: ' + e.message); }
      if (!registerRes.ok) {
        let errMsg = 'STEP3-register: HTTP ' + registerRes.status;
        try {
          const errBody = await registerRes.json();
          if (errBody.message) errMsg = errBody.message;
        } catch (parseErr) {}
        throw new Error(errMsg);
      }
      const registerResultData = await registerRes.json();
      const successLabel = registerResultData.correctionNote ? registerResultData.correctionNote : 'queued for analysis';
      updateQueueItem(itemId, 'done', successLabel);
    } catch (err) {
      updateQueueItem(itemId, 'error', err.message);
    }
  }
</script>
</body>
</html>
`, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/sponsor-kit") {
      try {
        const latestStats = await env.ai_ceo_memory.prepare(
          "SELECT subscriber_count, view_count, video_count, recorded_at FROM channel_stats ORDER BY id DESC LIMIT 1"
        ).first();

        const totalWatchTime = await env.ai_ceo_memory.prepare("SELECT SUM(watch_time_minutes) as total_minutes FROM video_performance").first();

        const topVideo = await env.ai_ceo_memory.prepare(
          "SELECT v.youtube_video_id, cp.title, vp.views, vp.likes, vp.comments FROM video_performance vp JOIN videos v ON v.id = vp.video_id JOIN content_plans cp ON cp.id = v.content_plan_id ORDER BY vp.views DESC LIMIT 1"
        ).first();

        const avgEngagement = await env.ai_ceo_memory.prepare(
          "SELECT AVG(views) as avg_views, AVG(likes) as avg_likes, AVG(comments) as avg_comments FROM video_performance"
        ).first();

        const totalPublished = await env.ai_ceo_memory.prepare("SELECT COUNT(*) as cnt FROM videos WHERE status = 'published'").first();

        return new Response(JSON.stringify({
          channel_name: "pop jack",
          channel_handle: "@popjack-l7y",
          niche: "Pop culture, gaming, and music commentary - the skeptical-but-passionate fan perspective",
          subscriber_count: latestStats?.subscriber_count || 0,
          total_channel_views: latestStats?.view_count || 0,
          total_videos_published: totalPublished?.cnt || 0,
          total_watch_time_hours: totalWatchTime?.total_minutes ? (totalWatchTime.total_minutes / 60).toFixed(1) : "0.0",
          average_views_per_video: avgEngagement?.avg_views ? Math.round(avgEngagement.avg_views) : 0,
          average_likes_per_video: avgEngagement?.avg_likes ? Math.round(avgEngagement.avg_likes) : 0,
          average_comments_per_video: avgEngagement?.avg_comments ? Math.round(avgEngagement.avg_comments) : 0,
          top_performing_video: topVideo ? { title: topVideo.title, url: `https://youtube.com/watch?v=${topVideo.youtube_video_id}`, views: topVideo.views, likes: topVideo.likes, comments: topVideo.comments } : null,
          stats_as_of: latestStats?.recorded_at || null,
          note: "All figures are real, automatically-tracked channel statistics."
        }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (sponsorKitErr) {
        return new Response(JSON.stringify({ error: sponsorKitErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
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
      const today = new Date().toISOString().slice(0, 10);
      const competitorCheckDone = await env.ai_ceo_memory.prepare(
        "SELECT count FROM daily_usage WHERE usage_date = ? AND op_type = ?"
      ).bind(today, "competitor_check").first();

      if (!competitorCheckDone) {
        try {
          console.log("Running daily competitor insights collection...");
          const competitorQueries = ["movie trailer reaction commentary", "gaming news commentary", "music video reaction"];
          for (const query of competitorQueries) {
            const insights = await collectCompetitorInsights(env, query);
            console.log(`Collected ${insights.length} competitor insights for query: ${query}`);
          }
          await env.ai_ceo_memory.prepare(
            "INSERT INTO daily_usage (usage_date, op_type, count) VALUES (?, ?, 1)"
          ).bind(today, "competitor_check").run();

          await env.ai_ceo_memory.prepare(
            "DELETE FROM competitor_insights WHERE collected_at < datetime('now', '-7 days')"
          ).run();
          console.log("Cleaned up competitor_insights rows older than 7 days");
        } catch (competitorErr) {
          console.log("Non-fatal: competitor insights collection failed:", competitorErr.message);
        }
      }

      const channelSetupDone = await env.ai_ceo_memory.prepare(
        "SELECT id FROM channel_setup LIMIT 1"
      ).first();

      if (channelSetupDone) {
        const keywordsBackfillDone = await env.ai_ceo_memory.prepare(
          "SELECT id FROM keywords_backfill LIMIT 1"
        ).first();

        if (!keywordsBackfillDone) {
          try {
            console.log("Running one-time channel keywords backfill...");
            const backfillAccessToken = await getYoutubeAccessToken(env);
            const backfillChannelId = await getOwnChannelId(backfillAccessToken);
            const currentBranding = await getCurrentBranding(backfillAccessToken, backfillChannelId);
            const newKeywords = await generateKeywordsOnly(env);

            await applyChannelBranding(backfillAccessToken, backfillChannelId, currentBranding.title, currentBranding.description, null, newKeywords);

            await env.ai_ceo_memory.prepare(
              "INSERT INTO keywords_backfill (id, completed_at) VALUES (1, datetime('now'))"
            ).run();

            console.log(`Channel keywords backfill complete: ${newKeywords}`);
          } catch (backfillErr) {
            console.log("Non-fatal: channel keywords backfill failed:", backfillErr.message);
          }
        }
      }

      const setupAttemptsRow = await env.ai_ceo_memory.prepare(
        "SELECT attempts FROM channel_setup_attempts WHERE id = 1"
      ).first();
      const setupAttempts = setupAttemptsRow ? setupAttemptsRow.attempts : 0;
      const MAX_CHANNEL_SETUP_ATTEMPTS = 3;

      if (!channelSetupDone && setupAttempts >= MAX_CHANNEL_SETUP_ATTEMPTS) {
        console.log(`Channel identity setup has failed ${setupAttempts} times, pausing retries. Check system_alerts for details.`);
      } else if (!channelSetupDone) {
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

          await applyChannelBranding(accessToken, channelId, identity.name, identity.description, bannerUrl, identity.keywords);

          await env.ai_ceo_memory.prepare(
            "INSERT INTO channel_setup (completed_at) VALUES (datetime('now'))"
          ).run();

          console.log(`Channel identity setup complete: "${identity.name}"`);

          try {
            const playlistId = await createPlaylist(accessToken, `${identity.name} - All Videos`, "All videos from this channel, organized in one place.");
            await env.ai_ceo_memory.prepare(
              "INSERT INTO channel_playlist (id, playlist_id) VALUES (1, ?)"
            ).bind(playlistId).run();
            console.log(`Created channel playlist: ${playlistId}`);
          } catch (playlistErr) {
            console.log("Non-fatal: playlist creation failed:", playlistErr.message);
          }
        } catch (setupErr) {
          console.log("ERROR during channel identity setup:", setupErr.message);

          const newAttemptCount = setupAttempts + 1;
          await env.ai_ceo_memory.prepare(
            "INSERT INTO channel_setup_attempts (id, attempts) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET attempts = ?"
          ).bind(newAttemptCount, newAttemptCount).run();

          if (setupErr.message.includes("youtubeSignupRequired")) {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("CHANNEL_SETUP_NEEDED", "YouTube channel has not been created yet for this account. Visit youtube.com while signed into the channel account and create the channel, then setup will work automatically.").run();
          } else if (newAttemptCount >= MAX_CHANNEL_SETUP_ATTEMPTS) {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("CHANNEL_SETUP_PAUSED", `Channel identity setup failed ${newAttemptCount} times (last error: ${setupErr.message}). Pausing automatic retries to save quota. Manual investigation needed.`).run();
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

          const isEvergreen = isEvergreenTopic(title);
          if (isEvergreen) {
            profitScore = profitScore * 1.3;
            note = note + " [evergreen topic - durable, product-linkable potential]";
          }

          await env.ai_ceo_memory.prepare(
            "INSERT INTO opportunities (trend_id, title, profit_score, status) VALUES (?, ?, ?, ?)"
          ).bind(trendId, `${note}: ${title}`, profitScore, status).run();
        } catch (innerErr) {
          console.log("ERROR processing item:", item?.snippet?.title, innerErr.message);
        }
      }

      const candidateOpportunities = await env.ai_ceo_memory.prepare(
        "SELECT * FROM opportunities WHERE status IN ('ready', 'needs_commentary_angle') ORDER BY profit_score DESC LIMIT 5"
      ).all();

      const recentPlans = await env.ai_ceo_memory.prepare(
        "SELECT title FROM content_plans ORDER BY id DESC LIMIT 3"
      ).all();
      const recentTitles = recentPlans.results.map(p => p.title).join(", ");

      const topCompetitorTitles = await env.ai_ceo_memory.prepare(
        "SELECT video_title FROM competitor_insights ORDER BY view_count DESC LIMIT 5"
      ).all();
      const competitorTitleExamples = topCompetitorTitles.results.map(r => r.video_title).join(", ");

      let titlePatternHint = "";
      try {
        const recentTitlePattern = await env.ai_ceo_memory.prepare(
          "SELECT analysis FROM title_pattern_insights ORDER BY id DESC LIMIT 1"
        ).first();
        if (recentTitlePattern && recentTitlePattern.analysis) {
          titlePatternHint = recentTitlePattern.analysis;
        }
      } catch (patternHintErr) {
        console.log("Non-fatal: could not fetch title pattern hint:", patternHintErr.message);
      }

      const backlogCheck = await env.ai_ceo_memory.prepare(
        "SELECT COUNT(*) as cnt FROM content_plans cp WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id)"
      ).first();
      const unusedPlanCount = backlogCheck ? backlogCheck.cnt : 0;
      const MAX_CONTENT_BACKLOG = 5;

      if (unusedPlanCount >= MAX_CONTENT_BACKLOG) {
        console.log(`Skipping new content generation: ${unusedPlanCount} unused content plans already in backlog (max ${MAX_CONTENT_BACKLOG}). Letting asset generation catch up first.`);
      } else {
      let reasonedChoice = null;
      try {
        reasonedChoice = await reasonTopicSelection(env, candidateOpportunities.results, recentTitles);
        if (reasonedChoice) {
          console.log(`AI topic reasoning chose: "${reasonedChoice.title}" - ${reasonedChoice._reasoning || "no reasoning logged"}`);

          try {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO reasoning_history (opportunity_id, decision_type, chosen_value, reasoning) VALUES (?, ?, ?, ?)"
            ).bind(reasonedChoice.id, "topic_selection", reasonedChoice.title, reasonedChoice._reasoning || "").run();
          } catch (historyErr) {
            console.log("Non-fatal: failed to log reasoning history:", historyErr.message);
          }
        }
      } catch (reasoningErr) {
        console.log("Non-fatal: topic reasoning failed, falling back to top-scored candidate:", reasoningErr.message);
        reasonedChoice = candidateOpportunities.results[0] || null;
      }

      const selectedOpportunities = reasonedChoice ? [reasonedChoice] : [];

      for (const opp of selectedOpportunities) {
        let success = false;
        let generatedTitle, generatedScript, contentPlanId, sceneDescriptions, thumbnailDescription;

        for (let attempt = 1; attempt <= 2 && !success; attempt++) {
          try {
            const isCommentary = opp.status === "needs_commentary_angle";
            const cleanTitle = opp.title.split(": ").slice(1).join(": ").replace(/[\u2013\u2014]/g, "-").replace(/"/g, "");

            const selectedStructure = SCRIPT_STRUCTURES[opp.id % SCRIPT_STRUCTURES.length];
            const selectedHookVariant = await selectHookVariant(env);
            const selectedTitleVariant = await selectTitleVariant(env);

            const memoryNote = recentTitles
              ? `\n\nFor context, your recent videos covered: ${recentTitles}. If relevant, you may briefly reference one of these for continuity, but don't force it.`
              : "";

            const competitorNote = competitorTitleExamples
              ? `\n\nFor reference, here are some currently high-performing video titles from similar commentary channels: ${competitorTitleExamples}. Use these only to understand what title styles and angles are resonating right now - do not copy them, write something original in your own voice.`
              : "";

            const titlePatternNote = titlePatternHint
              ? `\n\nObserved structural pattern currently performing well in this niche (a pattern to inform your approach, not specific examples to copy): ${titlePatternHint}`
              : "";

            const userInstructionRows = await env.ai_ceo_memory.prepare(
              "SELECT instruction_text FROM user_instructions ORDER BY id DESC LIMIT 5"
            ).all();
            const userInstructionNote = (userInstructionRows.results && userInstructionRows.results.length > 0)
              ? `\n\nIMPORTANT - direct instructions from your operator (these take priority over everything else above, follow them closely): ${userInstructionRows.results.map(r => r.instruction_text).join(" | ")}`
              : "";

            const prompt = `${PERSONA}\n\nWrite a 20-25 second video script (just the spoken narration, no stage directions) about this trending topic: ${cleanTitle}.${userInstructionNote}${memoryNote}${competitorNote}${titlePatternNote}\n\nWrite this in a natural, conversational tone with appropriate punctuation for text-to-speech - use contractions, vary your rhythm, and write the way someone would actually speak out loud, not like formal writing.\n\n${selectedStructure}\n\nFor your HOOK specifically: ${selectedHookVariant.instruction}\n\nWriting style for text-to-speech: write the way you'd actually talk, not like an essay. Use short sentences. Use natural punctuation - commas, periods, dashes - to create pauses where you'd naturally pause speaking. Vary your sentence length: mix short punchy lines with slightly longer ones, the way real speech actually flows.\n\nAlso suggest a catchy, clickable video title under 60 characters that reflects your personality. For the TITLE specifically: ${selectedTitleVariant.instruction}\n\nFinally, describe 3 distinct visual scenes representing the subject matter, plus one SEPARATE thumbnail concept. For each scene, give: a single relevant emoji, and a short 3-5 word label phrase (not the title, never include literal words like "text" or "title"). For the thumbnail specifically, choose the single most dramatic, attention-grabbing emoji and phrase that captures the core hook of the video - this is what people see before clicking. Format your response exactly as:\nTITLE: <title>\nSCRIPT: <script>\nSCENE1_EMOJI: <emoji>\nSCENE1_LABEL: <short phrase>\nSCENE2_EMOJI: <emoji>\nSCENE2_LABEL: <short phrase>\nSCENE3_EMOJI: <emoji>\nSCENE3_LABEL: <short phrase>\nTHUMBNAIL_EMOJI: <emoji>\nTHUMBNAIL_LABEL: <short dramatic phrase>`;

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

            try {
              await env.ai_ceo_memory.prepare(
                "INSERT INTO prompt_variants (variant_type, variant_text, content_plan_id) VALUES (?, ?, ?)"
              ).bind("hook_intensity", selectedHookVariant.id, contentPlanId).run();

              await env.ai_ceo_memory.prepare(
                "INSERT INTO prompt_variants (variant_type, variant_text, content_plan_id) VALUES (?, ?, ?)"
              ).bind("title_style", selectedTitleVariant.id, contentPlanId).run();
            } catch (variantLogErr) {
              console.log("Non-fatal: failed to log prompt variant:", variantLogErr.message);
            }

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
      }
      }

      const unusedPlansForAssets = await env.ai_ceo_memory.prepare(
        "SELECT cp.id as content_plan_id, cp.title as generated_title, cp.script as generated_script, cp.metadata, o.id as opp_id, o.created_at as opp_created_at FROM content_plans cp JOIN opportunities o ON o.id = cp.opportunity_id WHERE NOT EXISTS (SELECT 1 FROM videos v WHERE v.content_plan_id = cp.id) ORDER BY cp.id ASC LIMIT 1"
      ).all();

      for (const planRow of unusedPlansForAssets.results) {
        const contentPlanId = planRow.content_plan_id;
        const generatedTitle = planRow.generated_title;
        const generatedScript = planRow.generated_script;
        const metadata = JSON.parse(planRow.metadata || "{}");
        const sceneDescriptions = metadata.sceneDescriptions || [{ emoji: "🎬", label: generatedTitle }, { emoji: "🎬", label: generatedTitle }, { emoji: "🎬", label: generatedTitle }];
        const thumbnailDescription = metadata.thumbnailDescription || { emoji: "🔥", label: generatedTitle };
        const opp = { id: planRow.opp_id, created_at: planRow.opp_created_at, profit_score: 999 };

        try {
          const existingVideo = await env.ai_ceo_memory.prepare(
            "SELECT id FROM videos WHERE content_plan_id = ?"
          ).bind(contentPlanId).first();

          if (existingVideo) {
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

          const AURA2_VOICES = ["luna", "asteria", "athena", "hera", "aurora", "iris", "thalia", "orion", "apollo", "atlas"];
          const selectedVoice = AURA2_VOICES[contentPlanId % AURA2_VOICES.length];
          console.log(`Using voice: ${selectedVoice} for content_plan_id=${contentPlanId}`);

          const ttsResp = await env.AI.run("@cf/deepgram/aura-2-en", {
            text: generatedScript,
            speaker: selectedVoice
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
          await page.setViewport({ width: 1080, height: 1920 });

          const sceneFrameUrls = [];
          try {
            for (let sceneIdx = 0; sceneIdx < sceneDescriptions.length; sceneIdx++) {
              const motionType = MOTION_TYPES[(contentPlanId + sceneIdx) % MOTION_TYPES.length];

              let frames;
              let pexelsResult = null;
              if (env.PEXELS_API_KEY) {
                try {
                  pexelsResult = await searchPexelsVideo(env.PEXELS_API_KEY, sceneDescriptions[sceneIdx].label);
                } catch (pexelsErr) {
                  console.log(`Non-fatal: Pexels search failed for scene ${sceneIdx}:`, pexelsErr.message);
                }
              }

              if (pexelsResult) {
                try {
                  const pexelsImageBase64 = await fetchImageAsBase64(pexelsResult.previewImageUrl);
                  frames = await captureImageSceneFrames(page, {
                    imageBase64: pexelsImageBase64,
                    motionType: motionType,
                    labelText: sceneDescriptions[sceneIdx].label
                  }, 6, 150);
                  console.log(`Scene ${sceneIdx} using Pexels photo by ${pexelsResult.photographer}`);
                } catch (pexelsImgErr) {
                  console.log(`Non-fatal: Pexels image processing failed for scene ${sceneIdx}, trying AI generation:`, pexelsImgErr.message);
                  pexelsResult = null;
                }
              }

              const canProceedSceneImage = !pexelsResult && await checkNeuronBudget(env, "image_generation");
              if (!pexelsResult && canProceedSceneImage) {
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
              } else if (!frames) {
                console.log(`No Pexels match and neuron budget exhausted, using gradient fallback for scene ${sceneIdx}`);
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
              sceneVideoUrls.push(pexelsResult && pexelsResult.videoUrl ? pexelsResult.videoUrl : null);
            }
          } finally {
            await browser.close();
          }

          console.log(`Generating dedicated thumbnail for content_plan_id=${contentPlanId}...`);

          let thumbBytes;
          let thumbPexelsResult = null;
          if (env.PEXELS_API_KEY) {
            try {
              thumbPexelsResult = await searchPexelsVideo(env.PEXELS_API_KEY, thumbnailDescription.label);
            } catch (thumbPexelsErr) {
              console.log(`Non-fatal: Pexels thumbnail search failed:`, thumbPexelsErr.message);
            }
          }

          if (thumbPexelsResult) {
            try {
              const thumbPexelsBase64 = await fetchImageAsBase64(thumbPexelsResult.previewImageUrl);
              const thumbPexelsBinary = atob(thumbPexelsBase64);
              thumbBytes = Uint8Array.from(thumbPexelsBinary, (m) => m.codePointAt(0));
              console.log(`Thumbnail using Pexels photo by ${thumbPexelsResult.photographer}`);
            } catch (thumbPexelsImgErr) {
              console.log(`Non-fatal: Pexels thumbnail image processing failed, falling back to AI generation:`, thumbPexelsImgErr.message);
              thumbBytes = null;
            }
          }

          if (!thumbBytes) {
            let competitorThumbnailHint = "";
            try {
              const recentThumbInsight = await env.ai_ceo_memory.prepare(
                "SELECT analysis FROM thumbnail_insights ORDER BY id DESC LIMIT 1"
              ).first();
              if (recentThumbInsight && recentThumbInsight.analysis) {
                competitorThumbnailHint = `, inspired by this observed pattern in high-performing thumbnails: ${recentThumbInsight.analysis}`;
              }
            } catch (hintErr) {
              console.log("Non-fatal: could not fetch thumbnail insight hint:", hintErr.message);
            }

            const thumbnailPrompt = `${thumbnailDescription.label}, dramatic high-contrast lighting, single clear focal point, rule of thirds composition, vibrant saturated colors, professional photography style, eye-catching${competitorThumbnailHint}`;
            const thumbResp = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
              prompt: thumbnailPrompt
            });
            const thumbBinaryString = atob(thumbResp.image);
            thumbBytes = Uint8Array.from(thumbBinaryString, (m) => m.codePointAt(0));
          }

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
            sceneVideoUrls: sceneVideoUrls,
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

          const oppAgeHours = opp.created_at ? (Date.now() - new Date(opp.created_at + "Z").getTime()) / (1000 * 60 * 60) : 999;
          const isFreshTrend = oppAgeHours <= 3;
          const targetHour = isFreshTrend ? null : await getNextRotationHour(env);

          await env.ai_ceo_memory.prepare(
            "INSERT INTO videos (content_plan_id, status, thumbnail_url, video_file_name, b2_file_ids, target_publish_hour) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(contentPlanId, "video_ready", thumbnailDownloadUrl, finalVideoFileName, b2FileIds, targetHour).run();

          console.log(`Video for content_plan_id=${contentPlanId} is ${isFreshTrend ? "fresh (publishing immediately)" : `not fresh, targeting hour ${targetHour} for rotation`}`);
          console.log(`Video fully assembled for content_plan_id=${contentPlanId}: ${finalVideoFileName} (fileId: ${assembleResult.fileId})`);
        } catch (videoErr) {
          console.log(`ERROR generating/uploading video assets for content_plan_id=${contentPlanId}:`, videoErr.message);
          try {
            await env.ai_ceo_memory.prepare(
              "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
            ).bind("ASSET_GENERATION_FAILED", `content_plan_id=${contentPlanId}: ${videoErr.message}`).run();
          } catch (alertErr) {
            console.log("Non-fatal: could not log asset generation failure to system_alerts:", alertErr.message);
          }
        }
      }

      const currentUtcHour = new Date().getUTCHours();
      const videosToPublish = await env.ai_ceo_memory.prepare(
        "SELECT * FROM videos WHERE status = 'video_ready' AND (target_publish_hour IS NULL OR target_publish_hour = ?) ORDER BY id ASC LIMIT 1"
      ).bind(currentUtcHour).all();

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

          const shortsDescription = `${plan.script}\n\nNew videos posted regularly - subscribe so you don't miss the next one.\n\n#Shorts`;
          const videoCategoryId = detectVideoCategory(plan.title);
          const videoTags = generateTags(plan.title);
          const uploadResult = await uploadVideoToYoutube(accessToken, videoBytes, plan.title, shortsDescription, videoCategoryId, videoTags);
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

          if (video.target_publish_hour !== null && video.target_publish_hour !== undefined) {
            await markHourUsed(env, video.target_publish_hour);
            console.log(`Marked hour ${video.target_publish_hour} as used in rotation`);
          }

          try {
            const playlistRow = await env.ai_ceo_memory.prepare("SELECT playlist_id FROM channel_playlist WHERE id = 1").first();
            if (playlistRow && playlistRow.playlist_id) {
              await addVideoToPlaylist(accessToken, playlistRow.playlist_id, youtubeVideoId);
              console.log(`Added video id=${video.id} to channel playlist`);
            }
          } catch (playlistAddErr) {
            console.log(`Non-fatal: failed to add video id=${video.id} to playlist:`, playlistAddErr.message);
          }

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
          } else {
            try {
              const analyticsChannelId = await getOwnChannelId(modAccessToken);
              const analytics = await fetchVideoAnalytics(modAccessToken, analyticsChannelId, pubVideo.youtube_video_id);

              await env.ai_ceo_memory.prepare(
                "INSERT INTO video_performance (video_id, views, watch_time_minutes, average_view_duration, likes, comments) VALUES (?, ?, ?, ?, ?, ?)"
              ).bind(pubVideo.id, analytics.views, analytics.watchTimeMinutes, analytics.averageViewDuration, analytics.likes, analytics.comments).run();

              console.log(`Analytics recorded for video id=${pubVideo.id}: ${analytics.views} views, ${analytics.watchTimeMinutes} min watched`);

              try {
                const usedVariants = await env.ai_ceo_memory.prepare(
                  "SELECT variant_type, variant_text FROM prompt_variants WHERE content_plan_id = ?"
                ).bind(pubVideo.content_plan_id).all();
                const variantSummary = usedVariants.results.map(v => `${v.variant_type}=${v.variant_text}`).join(", ") || "unknown";

                const postMortemPrompt = `You are reviewing the performance of a published YouTube Short. Write a short, plain-English reflection (1-2 sentences) on why it likely did well or badly. Be specific and causal, not just a restatement of the numbers.

Title: "${pubVideo.title}"
Variants used: ${variantSummary}
Views: ${analytics.views}
Average view duration: ${analytics.averageViewDuration}s
Watch time: ${analytics.watchTimeMinutes} minutes
Likes: ${analytics.likes}
Comments: ${analytics.comments}

Respond with only the reflection, no preamble.`;

                const postMortemResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                  messages: [{ role: "user", content: postMortemPrompt }]
                });
                const postMortemText = (postMortemResponse.response || "").trim();

                if (postMortemText) {
                  await env.ai_ceo_memory.prepare(
                    "UPDATE video_performance SET post_mortem = ? WHERE video_id = ?"
                  ).bind(postMortemText, pubVideo.id).run();
                  console.log(`Post-mortem for video id=${pubVideo.id}: ${postMortemText}`);
                }
              } catch (postMortemErr) {
                console.log(`Non-fatal: post-mortem generation failed for video id=${pubVideo.id}:`, postMortemErr.message);
              }

              try {
                const freshComments = await fetchVideoComments(modAccessToken, pubVideo.youtube_video_id);
                for (const comment of freshComments) {
                  await env.ai_ceo_memory.prepare(
                    "INSERT OR IGNORE INTO video_comments (youtube_video_id, comment_id, author, text, like_count, published_at) VALUES (?, ?, ?, ?, ?, ?)"
                  ).bind(pubVideo.youtube_video_id, comment.commentId, comment.author, comment.text, comment.likeCount, comment.publishedAt).run();
                }
                if (freshComments.length > 0) {
                  console.log(`Fetched ${freshComments.length} comments for video id=${pubVideo.id}`);
                }
              } catch (commentErr) {
                console.log(`Non-fatal: comment fetch failed for video id=${pubVideo.id}:`, commentErr.message);
              }

              try {
                const hoursAge = (Date.now() - new Date(pubVideo.published_at + "Z").getTime()) / (1000 * 60 * 60);
                const flagAlreadyExists = await env.ai_ceo_memory.prepare(
                  "SELECT id FROM system_alerts WHERE alert_type = 'UNDERPERFORMING_24H' AND message LIKE ?"
                ).bind(`%video id=${pubVideo.id}%`).first();

                if (hoursAge >= 24 && hoursAge < 48 && !flagAlreadyExists && analytics.views < 10) {
                  await env.ai_ceo_memory.prepare(
                    "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
                  ).bind("UNDERPERFORMING_24H", `video id=${pubVideo.id} has only ${analytics.views} views after ~24 hours - may be worth reviewing`).run();
                  console.log(`Flagged video id=${pubVideo.id} as underperforming at 24h: ${analytics.views} views`);
                }
              } catch (flagErr) {
                console.log(`Non-fatal: underperformance flag check failed for video id=${pubVideo.id}:`, flagErr.message);
              }
            } catch (analyticsErr) {
              console.log(`Non-fatal: analytics fetch failed for video id=${pubVideo.id}:`, analyticsErr.message);
            }
          }
        } catch (modErr) {
          console.log(`Non-fatal: moderation check failed for video id=${pubVideo.id}:`, modErr.message);
        }
      }

      try {
        const statsCheckDone = await env.ai_ceo_memory.prepare(
          "SELECT count FROM daily_usage WHERE usage_date = ? AND op_type = ?"
        ).bind(today, "channel_stats_check").first();

        if (!statsCheckDone) {
          const statsAccessToken = await getYoutubeAccessToken(env);
          const channelStats = await getChannelStats(statsAccessToken);

          await env.ai_ceo_memory.prepare(
            "INSERT INTO channel_stats (subscriber_count, view_count, video_count) VALUES (?, ?, ?)"
          ).bind(channelStats.subscriberCount, channelStats.viewCount, channelStats.videoCount).run();

          await env.ai_ceo_memory.prepare(
            "INSERT INTO daily_usage (usage_date, op_type, count) VALUES (?, ?, 1)"
          ).bind(today, "channel_stats_check").run();

          console.log(`Channel stats recorded: ${channelStats.subscriberCount} subscribers, ${channelStats.viewCount} views, ${channelStats.videoCount} videos`);

          try {
            const trajectory = await assessMonetizationTrajectory(env);
            if (trajectory.hasEnoughData) {
              let benchmark = null;
              try {
                const lastBenchmark = await env.ai_ceo_memory.prepare(
                  "SELECT chosen_value, reasoning, created_at FROM reasoning_history WHERE decision_type = 'growth_benchmark' ORDER BY id DESC LIMIT 1"
                ).first();
                const daysSinceLastBenchmark = lastBenchmark
                  ? (Date.now() - new Date(lastBenchmark.created_at + "Z").getTime()) / (1000 * 60 * 60 * 24)
                  : 999;

                if (daysSinceLastBenchmark >= 30) {
                  console.log("Running monthly external growth benchmark research...");
                  benchmark = await researchExternalGrowthBenchmark(env);
                  await env.ai_ceo_memory.prepare(
                    "INSERT INTO reasoning_history (decision_type, chosen_value, reasoning) VALUES (?, ?, ?)"
                  ).bind("growth_benchmark", `sampleSize=${benchmark.sampleSize}`, benchmark.note || "").run();
                } else if (lastBenchmark) {
                  benchmark = { sampleSize: 1, note: lastBenchmark.reasoning };
                }
              } catch (benchmarkErr) {
                console.log("Non-fatal: external growth benchmark failed:", benchmarkErr.message);
              }

              const assessment = await reasonAboutStrategy(env, trajectory, benchmark);
              console.log(`Strategy self-assessment: ${assessment}`);

              await env.ai_ceo_memory.prepare(
                "INSERT INTO reasoning_history (decision_type, chosen_value, reasoning) VALUES (?, ?, ?)"
              ).bind("strategy_assessment", `${trajectory.currentSubscribers} subs, ${trajectory.subsPerDay.toFixed(2)}/day`, assessment).run();
            } else {
              console.log("Not enough historical data yet for strategy self-assessment");
            }
          } catch (trajectoryErr) {
            console.log("Non-fatal: strategy self-assessment failed:", trajectoryErr.message);
          }
        }
      } catch (statsErr) {
        console.log("Non-fatal: channel stats fetch failed:", statsErr.message);
      }

      try {
        const pendingInputs = await env.ai_ceo_memory.prepare(
          "SELECT id, b2_file_name, b2_file_id, duration_seconds, attempt_count FROM analyzer_inputs WHERE status = 'uploaded' ORDER BY id ASC LIMIT 50"
        ).all();

        const MAX_PROBES_PER_TICK = 15;
        let probesThisTick = 0;
        for (const inputRow of pendingInputs.results) {
          if (inputRow.duration_seconds === null) {
            if (probesThisTick >= MAX_PROBES_PER_TICK) {
              continue;
            }
            try {
              const probed = await probeVideoDuration(env, inputRow.b2_file_name, inputRow.b2_file_id);
              await env.ai_ceo_memory.prepare(
                "UPDATE analyzer_inputs SET duration_seconds = ? WHERE id = ?"
              ).bind(probed, inputRow.id).run();
              inputRow.duration_seconds = probed;
              probesThisTick++;
              console.log(`Probed duration for analyzer_input_id=${inputRow.id}: ${probed}s`);
            } catch (probeErr) {
              probesThisTick++;
              console.log(`Non-fatal: duration probe failed for analyzer_input_id=${inputRow.id}:`, probeErr.message);
            }
          }
        }

        const probedInputs = pendingInputs.results.filter(r => r.duration_seconds !== null);
        const unprobedInputs = pendingInputs.results.filter(r => r.duration_seconds === null);
        probedInputs.sort((a, b) => a.duration_seconds - b.duration_seconds);
        const orderedInputs = [...probedInputs, ...unprobedInputs];

        let processedCount = 0;
        for (const inputRow of orderedInputs) {
          const estimatedCost = inputRow.duration_seconds !== null
            ? estimateAnalyzerCost(inputRow.duration_seconds)
            : (ESTIMATED_NEURON_COST.tts || 8200);

          const canAfford = await checkNeuronBudgetCustomCost(env, estimatedCost);
          if (!canAfford) {
            console.log(`Skipping analyzer_input_id=${inputRow.id} this tick: estimated cost ${estimatedCost} would exceed remaining daily budget`);
            continue;
          }

          console.log(`Processing analyzer_input_id=${inputRow.id} (duration=${inputRow.duration_seconds}s, estimated cost=${estimatedCost})...`);
          try {
            await processAnalyzerInput(env, inputRow.id);
            processedCount++;
          } catch (itemErr) {
            console.log(`Non-fatal: analyzer input processing failed for id=${inputRow.id}:`, itemErr.message);
            try {
              await env.ai_ceo_memory.prepare(
                "INSERT INTO system_alerts (alert_type, message) VALUES (?, ?)"
              ).bind("ANALYZER_PROCESSING_FAILED", `analyzer_input_id=${inputRow.id}: ${itemErr.message}`).run();
            } catch (alertErr) {
              console.log("Non-fatal: could not log analyzer failure to system_alerts:", alertErr.message);
            }
            try {
              const updatedRow = await env.ai_ceo_memory.prepare(
                "UPDATE analyzer_inputs SET attempt_count = attempt_count + 1 WHERE id = ? RETURNING attempt_count"
              ).bind(inputRow.id).first();
              if (updatedRow && updatedRow.attempt_count >= 3) {
                await env.ai_ceo_memory.prepare(
                  "UPDATE analyzer_inputs SET status = ? WHERE id = ?"
                ).bind("failed", inputRow.id).run();
                console.log(`analyzer_input_id=${inputRow.id} failed ${updatedRow.attempt_count} times, marking as permanently failed`);
              }
            } catch (attemptErr) {
              console.log("Non-fatal: could not update attempt_count:", attemptErr.message);
            }
          }
        }
        console.log(`Analyzer scheduling complete: processed ${processedCount} item(s) this tick`);
      } catch (analyzerErr) {
        console.log("Non-fatal: analyzer scheduling failed:", analyzerErr.message);
        try {
          const updatedRow = await env.ai_ceo_memory.prepare(
            "UPDATE analyzer_inputs SET attempt_count = attempt_count + 1 WHERE id = ? RETURNING attempt_count"
          ).bind(pendingAnalyzerInput.id).first();
          if (updatedRow && updatedRow.attempt_count >= 3) {
            await env.ai_ceo_memory.prepare(
              "UPDATE analyzer_inputs SET status = ? WHERE id = ?"
            ).bind("failed", pendingAnalyzerInput.id).run();
            console.log(`analyzer_input_id=${pendingAnalyzerInput.id} failed ${updatedRow.attempt_count} times, marking as permanently failed and advancing the queue`);
          }
        } catch (attemptErr) {
          console.log("Non-fatal: could not update attempt_count:", attemptErr.message);
        }
      }
      console.log("scheduled() completed successfully");
    } catch (outerErr) {
      console.log("FATAL ERROR in scheduled():", outerErr.message, outerErr.stack);
    }
  }
};



























































































































































































































