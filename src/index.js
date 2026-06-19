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
    await env.ai_ceo_memory.prepare(
      "INSERT INTO trends (topic, source, score) VALUES (?, ?, ?)"
    ).bind("auto-collected trend", "scheduled-job", Math.random()).run();
  }
};
