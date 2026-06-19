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

    for (const item of data.items) {
      const title = item.snippet.title;
      const views = parseInt(item.statistics.viewCount || "0", 10);

      await env.ai_ceo_memory.prepare(
        "INSERT INTO trends (topic, source, score) VALUES (?, ?, ?)"
      ).bind(title, "youtube_trending", views).run();
    }
  }
};
