export const INSPECTOR_RENDER_SCRIPT: string = `  function esc(val) {
    return String(val == null ? "" : val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtTok(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "\u2014";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }
  function toneForCtx(pct) {
    if (pct == null) return "ok";
    return pct >= 85 ? "danger" : pct >= 68 ? "warn" : "ok";
  }
  function toneForCache(pct) {
    if (pct == null) return "ok";
    return pct < 50 ? "danger" : pct < 80 ? "warn" : "ok";
  }
  function shortWorkspace(ws) {
    if (!ws) return "workspace";
    var parts = ws.split(/[\\\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : ws;
  }
  function agentDotClass(agentState) {
    return agentState === "working" ? "pulse" : agentState === "waiting" ? "warn" : "ok";
  }
  function renderGlobalSidebar() {
    var mount = document.getElementById("global-sess-mount");
    if (!mount) return;
    var filters = [
      { id: "auto", label: "All" },
      { id: "app", label: "App" },
      { id: "cli", label: "CLI" }
    ];
    var pillsHtml = filters
      .map(function (f) {
        var on = state.sourceFilter === f.id ? " on" : "";
        return '<button type="button" class="src-pill' + on + '" data-src-filter="' + f.id + '">' + f.label + "</button>";
      })
      .join("");
    var rowsHtml =
      state.sessions.length === 0
        ? '<div class="va-row" style="color:var(--text-tertiary)">No local sessions found.</div>'
        : state.sessions
            .map(function (s) {
              var on = s.convId === state.selectedSessionId ? " on" : "";
              return (
                '<button type="button" class="global-sess-item' + on + '" data-pick-session="' + esc(s.convId) + '">' +
                '<div class="global-sess-top"><span class="badge-surf ' + esc(s.surface) + '">' + esc(s.surface) + "</span>" +
                '<span class="global-sess-name" title="' + esc(s.title) + '">' + esc(s.title) + "</span></div>" +
                '<div class="global-sess-sub"><span>' + esc(shortWorkspace(s.workspace)) + "</span>" +
                '<span class="num">' + (s.running ? "Live" : esc(s.ageLabel)) + "</span></div></button>"
              );
            })
            .join("");
    mount.innerHTML =
      '<div class="global-list-hd"><div class="global-list-title"><span>Sessions</span><span class="num">' +
      state.sessions.length + '</span></div><div class="src-pills">' + pillsHtml + "</div></div>" +
      '<div class="global-list-body">' + rowsHtml + "</div>";
  }
  function renderToolTargetItem(target, uri) {
    if (uri) {
      return (
        '<button type="button" class="va-target-btn" data-file-uri="' + esc(uri) +
        '" title="Open in side pane: ' + esc(target) + '">' + FILE_ICO + "<span>" + esc(target) + "</span></button>"
      );
    }
    return '<span class="va-target-text" title="' + esc(target) + '">' + esc(target) + "</span>";
  }
  function renderToolsTab(d) {
    var q = state.query.trim().toLowerCase();
    var maxCnt = 1;
    for (var i = 0; i < d.completedTools.length; i++) {
      if (d.completedTools[i].count > maxCnt) maxCnt = d.completedTools[i].count;
    }
    var filtered = d.completedTools.filter(function (t) {
      if (!q) return true;
      if (t.disp.toLowerCase().indexOf(q) !== -1) return true;
      if ((t.latestTarget || "").toLowerCase().indexOf(q) !== -1) return true;
      return (t.recentTargets || []).some(function (rt) { return rt.toLowerCase().indexOf(q) !== -1; });
    });
    var rows = filtered.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No matching tools.</div>'
      : filtered.map(function (t) {
          var open = state.expandedTool === t.disp;
          var pct = Math.max(4, Math.round((t.count / maxCnt) * 100));
          var targets = Array.isArray(t.recentTargets) ? t.recentTargets : [];
          var uris = t.targetUris || {};
          var targetsHtml = open && targets.length > 0
            ? '<div class="va-targets">' + targets.map(function (p) { return renderToolTargetItem(p, uris[p] || null); }).join("") + "</div>"
            : "";
          return (
            '<div class="va-row"><div class="va-row-main clickable" data-va-tool="' + esc(t.disp) + '">' +
            '<span class="va-name">' + esc(t.disp) + '</span><span class="num" style="color:var(--text-tertiary)">&times;' + t.count + "</span>" +
            '<span class="va-tgt">' + esc(t.latestTarget || "\u2014") + "</span></div>" +
            '<div class="va-bar-bg"><div class="va-bar-fg" style="width:' + pct + '%"></div></div>' + targetsHtml + "</div>"
          );
        }).join("");
    return (
      '<input id="va-search" class="search-input" type="search" placeholder="Filter ' +
      d.completedTools.length + ' tool types or file paths\u2026" value="' + esc(state.query) + '">' +
      '<div class="va-card">' + rows + "</div>"
    );
  }
  function renderContextTab(d) {
    var mcpRows = d.mcps.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No MCP server calls recorded.</div>'
      : d.mcps.map(function (m) {
          var subs = m.subtools.map(function (s) {
            return '<span class="va-chip num">' + esc(s.name) + " &times;" + s.count + "</span>";
          }).join("");
          return (
            '<div class="va-row"><div class="va-row-main"><span class="dot" style="background:var(--accent-mcp)"></span>' +
            '<span class="va-name">' + esc(m.server) + '</span><span class="va-tgt num">' + m.totalCalls + " calls</span></div>" +
            '<div class="va-chips">' + subs + "</div></div>"
          );
        }).join("");
    var skillChips = d.skills.length === 0
      ? '<span style="color:var(--text-tertiary)">No skills loaded.</span>'
      : d.skills.map(function (s, idx) {
          return '<span class="va-chip"><span class="num" style="color:var(--text-tertiary)">' + (idx + 1) + ".</span>" + esc(s) + "</span>";
        }).join("");
    return (
      '<div class="va-card"><div class="va-card-hd"><span>MCP Servers (' + d.mcps.length + ")</span></div>" + mcpRows + "</div>" +
      '<div class="va-card"><div class="va-card-hd"><span>Loaded Skills (Chronological &middot; ' + d.skills.length + ")</span></div>" +
      '<div class="va-row"><div class="va-chips">' + skillChips + "</div></div></div>"
    );
  }
  function renderAgentsTab(d) {
    var title = (d.agentsKind === "swarm" ? "Swarm Members" : "Session Subagents") + " (" + d.agents.length + ")";
    var rows = d.agents.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No subagents or swarm workers.</div>'
      : d.agents.map(function (a) {
          return (
            '<div class="va-row"><div class="va-row-main"><span class="dot ' + agentDotClass(a.state) + '"></span>' +
            '<span class="va-name">' + esc(a.name) + '</span><span class="badge-surf">' + esc(a.type) + "</span>" +
            '<span class="badge-surf">' + esc(a.model) + '</span><span class="va-tgt">' + esc(a.ageLabel) + "</span></div></div>"
          );
        }).join("");
    return '<div class="va-card"><div class="va-card-hd"><span>' + title + "</span></div>" + rows + "</div>";
  }
  function renderOverviewTab(d) {
    var runHtml = d.runningTools.length === 0 ? "" :
      '<div class="va-run-banner">' + d.runningTools.map(function (rt) {
        return '<div class="va-run-item"><span class="dot warn"></span><span class="va-name">' + esc(rt.disp) +
          '</span><span class="va-run-tgt">' + esc(rt.target) + "</span></div>";
      }).join("") + "</div>";
    var hiddenTools = Math.max(0, d.completedTools.length - 4);
    var hiddenAgents = Math.max(0, d.agents.length - 4);
    var topTools = d.completedTools.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No tool calls yet.</div>'
      : d.completedTools.slice(0, 4).map(function (t) {
          var first = (t.recentTargets && t.recentTargets[0]) || t.fullTarget || "";
          var uri = first && t.targetUris ? t.targetUris[first] || "" : "";
          var attr = uri ? ' data-file-uri="' + esc(uri) + '" class="va-row-main clickable"' : ' class="va-row-main"';
          return '<div class="va-row"><div' + attr + '><span class="dot ok"></span><span class="va-name">' + esc(t.disp) +
            '</span><span class="num" style="color:var(--text-tertiary)">&times;' + t.count +
            '</span><span class="va-tgt">' + esc(t.latestTarget || "\u2014") + "</span></div></div>";
        }).join("");
    var mcpChips = d.mcps.map(function (m) {
      return '<span class="va-chip"><span class="dot" style="background:var(--accent-mcp)"></span><span class="num">' +
        esc(m.server) + " (" + m.totalCalls + ")</span></span>";
    }).join("");
    var skillChips = d.skills.slice(0, 5).map(function (s) { return '<span class="va-chip">' + esc(s) + "</span>"; }).join("");
    var moreSkills = d.skills.length > 5
      ? '<button type="button" data-va-jump="context" class="va-more-btn">+' + (d.skills.length - 5) + " more</button>"
      : "";
    var emptyCtx = d.mcps.length === 0 && d.skills.length === 0 ? '<span style="color:var(--text-tertiary)">None recorded.</span>' : "";
    var agentRows = d.agents.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No subagents spawned in this session.</div>'
      : d.agents.slice(0, 4).map(function (a) {
          return '<div class="va-row"><div class="va-row-main"><span class="dot ' + agentDotClass(a.state) +
            '"></span><span class="va-name">' + esc(a.name) + '</span><span class="badge-surf">' + esc(a.model) +
            '</span><span class="va-tgt">' + esc(a.ageLabel) + "</span></div></div>";
        }).join("");
    return (
      runHtml +
      '<div class="va-card"><div class="va-card-hd"><span>Top Tools (' + d.totalToolCalls + " calls)</span>" +
      (hiddenTools > 0 ? '<button type="button" data-va-jump="tools" class="action-link">+' + hiddenTools + " more &rarr;</button>" : "") +
      "</div>" + topTools + "</div>" +
      '<div class="va-card"><div class="va-card-hd"><span>Skills (' + d.skills.length + ") &amp; MCPs (" + d.mcps.length +
      ')</span><button type="button" data-va-jump="context" class="action-link">Inspect &rarr;</button></div>' +
      '<div class="va-row"><div class="va-chips">' + mcpChips + skillChips + moreSkills + emptyCtx + "</div></div></div>" +
      '<div class="va-card"><div class="va-card-hd"><span>' + (d.agentsKind === "swarm" ? "Swarm Roster" : "Subagents") +
      " (" + d.agents.length + ")</span>" +
      (hiddenAgents > 0 ? '<button type="button" data-va-jump="agents" class="action-link">+' + hiddenAgents + " more &rarr;</button>" : "") +
      "</div>" + agentRows + "</div>"
    );
  }
  function renderHeader(d) {
    var tel = d.telemetry || {};
    var ctxPct = typeof tel.ctxPct === "number" ? tel.ctxPct : null;
    var ctxTone = toneForCtx(ctxPct);
    var cacheTone = toneForCache(tel.cachePct);
    var barColor = ctxTone === "danger" ? "var(--accent-danger)" : ctxTone === "warn" ? "var(--accent-warn)" : "var(--accent-ok)";
    var selectHtml = state.sessions.length > 1
      ? '<select id="va-sess-select" class="va-sess-select" aria-label="Select session">' +
        state.sessions.map(function (s) {
          var sel = s.convId === d.convId ? " selected" : "";
          return '<option value="' + esc(s.convId) + '"' + sel + ">[" + esc(s.surface.toUpperCase()) + "] " + esc(s.title) + "</option>";
        }).join("") + "</select>"
      : "";
    var agentTabLabel = d.agentsKind === "swarm" ? "Swarm" : "Agents";
    var tabBtn = function (id, label, cnt) {
      var active = state.tab === id;
      var cntHtml = cnt == null ? "" : '<span class="va-cnt">' + cnt + "</span>";
      return '<button type="button" role="tab" aria-selected="' + active + '" data-va-tab="' + id +
        '" class="va-tab ' + (active ? "active" : "") + '">' + label + cntHtml + "</button>";
    };
    return (
      '<div class="va-header"><div class="va-title-row">' +
      '<span class="badge-surf ' + esc(d.surface) + '">' + esc(d.surface) + "</span>" +
      '<h1 class="va-title" title="' + esc(d.title) + '">' + esc(d.title) + "</h1>" +
      '<span class="live-pill"><span class="dot ' + (d.running ? "pulse" : "ok") + '"></span><span>' +
      (d.running ? "Live" : esc(d.ageLabel)) + "</span></span>" +
      '<button type="button" id="va-refresh" class="icon-btn" title="Refresh snapshot" aria-label="Refresh">' + REFRESH_ICO + "</button></div>" +
      selectHtml +
      '<div class="va-ribbon num"><span title="Context window usage"><span class="va-ctx-track"><span class="va-ctx-fill" style="width:' +
      (ctxPct != null ? Math.min(100, ctxPct) : 0) + "%;background:" + barColor + '"></span></span><strong>' +
      (ctxPct != null ? ctxPct.toFixed(0) + "%" : "\u2014") + '</strong> <span style="color:var(--text-tertiary)">(' +
      fmtTok(tel.ctxUsed) + "/" + fmtTok(tel.ctxMax) + ")</span></span>" +
      "<span>TPS <strong>" + (typeof tel.tps === "number" ? tel.tps.toFixed(0) : "\u2014") + "</strong></span>" +
      "<span>TTFT <strong>" + (typeof tel.ttft === "number" ? tel.ttft.toFixed(2) + "s" : "\u2014") + "</strong></span>" +
      '<span>Cache <strong style="color:var(--accent-' + cacheTone + ')">' +
      (typeof tel.cachePct === "number" ? tel.cachePct.toFixed(0) + "%" : "\u2014") + "</strong></span></div>" +
      '<nav class="va-tabs" role="tablist">' +
      tabBtn("overview", "Overview", null) +
      tabBtn("tools", "Tools", d.completedTools.length) +
      tabBtn("context", "Skills &amp; MCP", d.skills.length + d.mcps.length) +
      tabBtn("agents", agentTabLabel, d.agents.length) +
      "</nav></div>"
    );
  }
  function renderMainPanel() {
    var main = document.getElementById("inspector-main");
    if (!main) return;
    var activeEl = document.activeElement;
    var restoreSearch = activeEl && activeEl.id === "va-search";
    var selStart = restoreSearch ? activeEl.selectionStart : null;
    var d = state.snapshot;
    if (!d) {
      var msg = state.errorNote ? esc(state.errorNote) : state.initialized ? "No local Antigravity sessions detected yet." : "Connecting to Antigravity host\u2026";
      main.innerHTML = '<div class="empty-state">' + EMPTY_ICO + "<strong>HUD Inspector</strong><span>" + msg + "</span></div>";
      return;
    }
    var note = state.errorNote ? '<div class="status-note">' + esc(state.errorNote) + "</div>" : "";
    var tabBody = state.tab === "tools" ? renderToolsTab(d)
      : state.tab === "context" ? renderContextTab(d)
      : state.tab === "agents" ? renderAgentsTab(d)
      : renderOverviewTab(d);
    main.innerHTML = renderHeader(d) + '<div class="va-body">' + note + tabBody + "</div>";
    if (restoreSearch) {
      var nextInput = document.getElementById("va-search");
      if (nextInput) {
        nextInput.focus();
        var pos = selStart == null ? state.query.length : selStart;
        nextInput.setSelectionRange(pos, pos);
      }
    }
  }
  function renderAll() {
    renderGlobalSidebar();
    renderMainPanel();
  }`;
