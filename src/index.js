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
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=10&regionCode=US&key=${env.YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.items) {
      console.log("No items returned", JSON.stringify(data));
      return;
    }

    const unsafeKeywords = ["shooting", "murder", "death", "war crime", "suicide", "explosion", "terrorist"];
    const repostKeywords = ["official video", "official music video", "official trailer", "official audio", "official teaser", "official lyric video", "lyric video", "music video", "full movie", "full episode"];

    for (const item of data.items) {
      const title = item.snippet.title;
      const views = parseInt(item.statistics.viewCount || "0", 10);
      const lowerTitle = title.toLowerCase();

      const insertedTrend = await env.ai_ceo_memory.prepare(
        "INSERT INTO trends (topic, source, score) VALUES (?, ?, ?) RETURNING id"
      ).bind(title, "youtube_trending", views).first();

      const trendId = insertedTrend.id;

      const isUnsafe = unsafeKeywords.some(word => lowerTitle.includes(word));
      if (isUnsafe) {
        console.log("Skipped unsafe trend:", title);
        continue;
      }

      const isRepost = repostKeywords.some(word => lowerTitle.includes(word));

      const competitionCheck = await env.ai_ceo_memory.prepare(
        "SELECT COUNT(*) as cnt FROM trends WHERE topic LIKE ? AND id != ?"
      ).bind(`%${title.split(" ").slice(0, 3).join(" ")}%`, trendId).first();

      const competitionPenalty = Math.min(competitionCheck.cnt * 0.05, 0.5);

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
    }
  }
};
