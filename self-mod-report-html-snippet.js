// ============================================================
// PASTE THIS near the top of src/index.js, as a top-level const
// (outside the fetch handler), e.g. right before "export default {".
// It's referenced by the /self-mod/report route in self-mod-routes.js.
// ============================================================

const SELF_MOD_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Self-mod report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 1rem;
    transition: background 0.15s, color 0.15s;
  }
  #root { width: 100%; max-width: 420px; }
  #page-frame { border-radius: 14px; overflow: hidden; position: relative; }
  #topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; }
  #topbar button { border: none; background: none; padding: 4px; display: flex; cursor: pointer; }
  #page-title { font-weight: 500; font-size: 14px; margin: 0; letter-spacing: 0.04em; text-transform: uppercase; }
  .icon { font-size: 20px; }
  #entries-list { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .entry-card { border-radius: 12px; padding: 1rem 1.1rem; }
  .entry-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 11px; }
  .entry-title { font-size: 14px; font-weight: 500; margin: 0 0 6px; }
  .entry-desc { font-size: 12px; margin: 0 0 6px; line-height: 1.6; }
  .entry-meta { display: flex; gap: 16px; margin-top: 8px; font-size: 11px; }
  .payment-badge { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 500; }
  .decision-btns { display: flex; gap: 8px; margin-top: 10px; }
  .decision-btns button { flex: 1; border-radius: 6px; padding: 8px; font-size: 12px; cursor: pointer; transition: background 0.1s, color 0.1s, border-color 0.1s; }
  .empty-state { text-align: center; padding: 40px 20px; font-size: 13px; }
  .overlay { display: none; position: absolute; inset: 0; align-items: flex-start; padding-top: 56px; }
  #bell-overlay { justify-content: flex-start; padding-left: 16px; }
  #menu-overlay { justify-content: flex-end; padding-right: 16px; }
  #bell-panel { width: 220px; border-radius: 12px; padding: 14px; }
  #menu-panel { width: 200px; border-radius: 12px; overflow: hidden; }
  .menu-item { width: 100%; text-align: left; display: flex; align-items: center; gap: 10px; padding: 12px 14px; font-size: 13px; border: none; background: none; cursor: pointer; }
  .mute-row { display: flex; align-items: center; justify-content: space-between; }
  #mute-switch { width: 40px; height: 22px; border-radius: 11px; border: none; padding: 2px; position: relative; cursor: pointer; }
  #mute-knob { display: block; width: 18px; height: 18px; border-radius: 50%; transition: transform 0.15s; }
</style>
</head>
<body>
<div id="root">
  <div id="page-frame">
    <div id="topbar">
      <button id="btn-bell" aria-label="Notifications"><i class="icon">&#128276;</i></button>
      <p id="page-title">Self-mod report</p>
      <button id="btn-menu" aria-label="Menu"><i class="icon">&#9776;</i></button>
    </div>
    <div id="entries-list"></div>
  </div>

  <div id="bell-overlay" class="overlay">
    <div id="bell-panel">
      <div class="mute-row">
        <span id="mute-label">Notifications</span>
        <button id="mute-switch" role="switch"><span id="mute-knob"></span></button>
      </div>
      <p id="mute-status" style="font-size: 12px; margin-top: 8px;"></p>
    </div>
  </div>

  <div id="menu-overlay" class="overlay">
    <div id="menu-panel">
      <button class="menu-item" data-action="page-analyzer">&#11014; Analyzer</button>
      <button class="menu-item" data-action="page-self-mod">&#128196; Self-mod report</button>
      <button class="menu-item" data-action="theme"><span id="theme-icon">&#127769;</span> <span id="theme-label">Light mode</span></button>
    </div>
  </div>
</div>

<script>
(function() {
  var dark = {
    bg: "#0d0d0f", frame: "#0d0d0f", card: "#131315", border: "#232326",
    text: "#e8e6e0", heading: "#f2f1ec", muted: "#8a8a90", dim: "#6a6a70",
    accent: "#3ecf9b", accentDim: "#0f3a2d", panel: "#1a1a1c"
  };
  var light = {
    bg: "#eceae2", frame: "#fdfcf8", card: "#f4f2ec", border: "#d9d6cc",
    text: "#3a3a36", heading: "#16160f", muted: "#6e6e64", dim: "#8a8a7e",
    accent: "#0f6e56", accentDim: "#dff3ec", panel: "#ffffff"
  };

  var isDark = true;
  var muted = false;
  var entries = [];
  var payments = [];
  var decided = {}; // local-only lock so a click can't flip back after a real decision is sent

  function t() { return isDark ? dark : light; }

  function paintShell() {
    var c = t();
    document.body.style.background = c.bg;
    document.body.style.color = c.text;
    document.getElementById("page-frame").style.background = c.frame;
    document.getElementById("page-frame").style.border = "0.5px solid " + c.border;
    document.getElementById("topbar").style.borderBottom = "0.5px solid " + c.border;
    document.getElementById("page-title").style.color = c.accent;

    document.getElementById("bell-panel").style.background = c.panel;
    document.getElementById("bell-panel").style.border = "0.5px solid " + c.border;
    document.getElementById("menu-panel").style.background = c.panel;
    document.getElementById("menu-panel").style.border = "0.5px solid " + c.border;
    document.querySelectorAll(".menu-item").forEach(function(el) {
      el.style.color = c.text;
      el.style.borderBottom = "0.5px solid " + c.border;
    });
    document.getElementById("mute-label").style.color = c.text;
    document.getElementById("mute-status").style.color = c.muted;
    document.getElementById("theme-icon").textContent = isDark ? "\\u2600\\uFE0F" : "\\uD83C\\uDF19";
    document.getElementById("theme-label").textContent = isDark ? "Light mode" : "Dark mode";

    var sw = document.getElementById("mute-switch");
    var knob = document.getElementById("mute-knob");
    sw.style.background = muted ? c.border : c.accentDim;
    knob.style.background = muted ? c.dim : c.accent;
    knob.style.transform = muted ? "translateX(0)" : "translateX(18px)";
    document.getElementById("mute-status").textContent = muted
      ? "Off, you will not get emails until you turn this back on"
      : "On, you will get an email when entries open or close";
  }

  function renderEntries() {
    var c = t();
    var list = document.getElementById("entries-list");
    list.innerHTML = "";

    if (entries.length === 0 && payments.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.style.color = c.muted;
      empty.textContent = "Nothing open right now.";
      list.appendChild(empty);
      return;
    }

    entries.forEach(function(entry) {
      var card = document.createElement("div");
      card.className = "entry-card";
      card.style.background = c.card;
      card.style.border = "0.5px solid " + c.border;

      var daysLeft = Math.max(0, Math.ceil((entry.deadline_at - Date.now() / 1000) / 86400));

      card.innerHTML =
        '<div class="entry-top">' +
          '<span style="color:' + c.dim + '; font-weight:500;">Open' + (entry.extension_count > 0 ? " \\u00b7 extended " + entry.extension_count + "x" : "") + '</span>' +
          '<span style="color:' + c.muted + ';">Deadline: ' + daysLeft + ' day' + (daysLeft === 1 ? "" : "s") + '</span>' +
        '</div>' +
        '<p class="entry-title" style="color:' + c.heading + ';">' + escapeHtml(entry.what_changed) + '</p>' +
        '<p class="entry-desc" style="color:' + c.muted + ';">' + escapeHtml(entry.why) + '</p>' +
        '<div class="entry-meta"><span style="color:' + c.dim + ';">Tracking</span><span style="color:' + c.text + '; font-weight:500;">' + escapeHtml(entry.metric_name) + '</span></div>';

      list.appendChild(card);
    });

    payments.forEach(function(p) {
      var card = document.createElement("div");
      card.className = "entry-card";
      card.style.background = c.card;
      card.style.border = "0.5px solid " + c.accent;

      var lock = decided[p.id];

      card.innerHTML =
        '<div class="entry-top">' +
          '<span class="payment-badge" style="background:' + c.accentDim + '; color:' + c.accent + ';">Payment requested</span>' +
          '<span style="color:' + c.muted + ';">Risk: ' + escapeHtml(p.danger_level) + '</span>' +
        '</div>' +
        '<p class="entry-title" style="color:' + c.heading + ';">' + escapeHtml(p.title) + '</p>' +
        '<p class="entry-desc" style="color:' + c.muted + ';">' + escapeHtml(p.description) + ' (' + escapeHtml(p.cost_summary) + ')</p>' +
        '<a href="' + p.payment_url + '" target="_blank" style="font-size:13px; color:' + c.accent + '; display:inline-block; margin-bottom:8px;">Payment page &#8599;</a>' +
        (lock ? '<p style="font-size:12px; font-weight:500; color:' + (lock === "approved" ? c.accent : c.muted) + ';">' + (lock === "approved" ? "Approved" : "Rejected") + '</p>' :
        '<div class="decision-btns">' +
          '<button class="btn-approve" data-id="' + p.id + '" style="background:' + c.accentDim + '; border:0.5px solid ' + c.accent + '; color:' + c.accent + ';">Approve</button>' +
          '<button class="btn-reject" data-id="' + p.id + '" style="background:' + c.card + '; border:0.5px solid ' + c.border + '; color:' + c.muted + ';">Reject</button>' +
        '</div>');

      list.appendChild(card);
    });

    document.querySelectorAll(".btn-approve").forEach(function(btn) {
      btn.addEventListener("click", function() { decidePayment(btn.dataset.id, "approve"); });
    });
    document.querySelectorAll(".btn-reject").forEach(function(btn) {
      btn.addEventListener("click", function() { decidePayment(btn.dataset.id, "reject"); });
    });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function decidePayment(id, action) {
    decided[id] = action === "approve" ? "approved" : "rejected";
    renderEntries();
    try {
      await fetch("/self-mod/api/payments/" + id + "/" + action, { method: "POST" });
    } catch (e) {
      console.error("Failed to record decision", e);
    }
  }

  async function loadData() {
    try {
      var [entriesRes, paymentsRes] = await Promise.all([
        fetch("/self-mod/api/entries").then(function(r) { return r.json(); }),
        fetch("/self-mod/api/payments").then(function(r) { return r.json(); })
      ]);
      entries = entriesRes;
      payments = paymentsRes;
      renderEntries();
    } catch (e) {
      console.error("Failed to load self-mod data", e);
    }
  }

  async function loadMuteState() {
    try {
      var res = await fetch("/self-mod/api/notifications").then(function(r) { return r.json(); });
      muted = !res.enabled;
      paintShell();
    } catch (e) {
      console.error("Failed to load notification state", e);
    }
  }

  document.getElementById("btn-bell").addEventListener("click", function() {
    document.getElementById("menu-overlay").style.display = "none";
    var ov = document.getElementById("bell-overlay");
    ov.style.display = ov.style.display === "none" || !ov.style.display ? "flex" : "none";
  });

  document.getElementById("btn-menu").addEventListener("click", function() {
    document.getElementById("bell-overlay").style.display = "none";
    var ov = document.getElementById("menu-overlay");
    ov.style.display = ov.style.display === "none" || !ov.style.display ? "flex" : "none";
  });

  document.getElementById("bell-overlay").addEventListener("click", function(e) {
    if (e.target === this) this.style.display = "none";
  });
  document.getElementById("menu-overlay").addEventListener("click", function(e) {
    if (e.target === this) this.style.display = "none";
  });

  document.getElementById("mute-switch").addEventListener("click", async function() {
    muted = !muted;
    paintShell();
    try {
      await fetch("/self-mod/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !muted })
      });
    } catch (e) {
      console.error("Failed to update notification state", e);
    }
  });

  document.querySelectorAll(".menu-item").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var action = btn.dataset.action;
      if (action === "theme") {
        isDark = !isDark;
        paintShell();
        renderEntries();
      } else if (action === "page-analyzer") {
        window.location.href = "/analyzer/upload";
      } else {
        document.getElementById("menu-overlay").style.display = "none";
      }
    });
  });

  paintShell();
  loadData();
  loadMuteState();
})();
</script>
</body>
</html>`;
