// ============================================================
// PASTE THIS BLOCK into src/index.js, alongside the other
// `if (url.pathname === ...)` blocks (e.g. right after the
// /analyzer/upload block, or wherever makes sense to you).
//
// Routes added:
//   GET  /self-mod/report          - the reporting page itself (HTML)
//   GET  /self-mod/api/entries     - JSON: open self-mod entries
//   GET  /self-mod/api/payments    - JSON: pending payment proposals
//   POST /self-mod/api/payments/:id/approve
//   POST /self-mod/api/payments/:id/reject
//   GET  /self-mod/api/notifications  - current mute state
//   POST /self-mod/api/notifications  - toggle mute state
// ============================================================

    if (url.pathname === "/self-mod/api/entries" && request.method === "GET") {
      const { results } = await env.ai_ceo_memory
        .prepare("SELECT * FROM self_mod_entries WHERE status = 'open' ORDER BY opened_at DESC")
        .all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/self-mod/api/payments" && request.method === "GET") {
      const { results } = await env.ai_ceo_memory
        .prepare("SELECT * FROM payment_proposals WHERE status = 'pending' ORDER BY created_at DESC")
        .all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname.match(/^\/self-mod\/api\/payments\/(\d+)\/approve$/) && request.method === "POST") {
      const id = url.pathname.match(/^\/self-mod\/api\/payments\/(\d+)\/approve$/)[1];
      const now = Math.floor(Date.now() / 1000);
      await env.ai_ceo_memory
        .prepare("UPDATE payment_proposals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'")
        .bind(now, id)
        .run();
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname.match(/^\/self-mod\/api\/payments\/(\d+)\/reject$/) && request.method === "POST") {
      const id = url.pathname.match(/^\/self-mod\/api\/payments\/(\d+)\/reject$/)[1];
      const now = Math.floor(Date.now() / 1000);
      await env.ai_ceo_memory
        .prepare("UPDATE payment_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'")
        .bind(now, id)
        .run();
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/self-mod/api/notifications" && request.method === "GET") {
      const row = await env.ai_ceo_memory
        .prepare("SELECT enabled FROM notification_settings WHERE id = 1")
        .first();
      return new Response(JSON.stringify({ enabled: row ? row.enabled === 1 : true }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/self-mod/api/notifications" && request.method === "POST") {
      const body = await request.json();
      const enabled = body.enabled ? 1 : 0;
      await env.ai_ceo_memory
        .prepare("UPDATE notification_settings SET enabled = ? WHERE id = 1")
        .bind(enabled)
        .run();
      return new Response(JSON.stringify({ ok: true, enabled: enabled === 1 }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/self-mod/report") {
      return new Response(SELF_MOD_REPORT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
