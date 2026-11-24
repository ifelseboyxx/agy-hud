import { INSPECTOR_RENDER_SCRIPT } from './hud-inspector-render-script.ts';

export const INSPECTOR_SCRIPT: string = `(function () {
  var POLL_INTERVAL_MS = 2000;
  var SEP_PROTOCOL_VERSION = "2026-01-26";
  var FILE_ICO = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>';
  var REFRESH_ICO = '<svg class="ico" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.3-3.4"/><path d="M13 2.5v2.8h-2.8"/></svg>';
  var EMPTY_ICO = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>';

  var state = {
    nextId: 1,
    pending: new Map(),
    initialized: false,
    isGlobal: false,
    inFlight: false,
    pollTimer: null,
    etag: null,
    selectedSessionId: null,
    sourceFilter: "auto",
    sessions: [],
    snapshot: null,
    tab: "overview",
    query: "",
    expandedTool: null,
    errorNote: ""
  };

${INSPECTOR_RENDER_SCRIPT}

  function postToHost(msg) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, "*");
      }
    } catch (_err) {
      return;
    }
  }

  function sendRequest(method, params) {
    var id = state.nextId++;
    return new Promise(function (resolve, reject) {
      state.pending.set(id, { resolve: resolve, reject: reject });
      postToHost({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }

  function sendNotification(method, params) {
    postToHost({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function applyHostContext(ctx, caps) {
    if (ctx && typeof ctx === "object") {
      if (ctx.theme === "light" || ctx.theme === "dark") {
        document.documentElement.setAttribute("data-theme", ctx.theme);
        document.documentElement.style.colorScheme = ctx.theme;
      }
      var vars = ctx.styles && ctx.styles.variables;
      if (vars && typeof vars === "object") {
        var keys = Object.keys(vars);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = vars[k];
          if (k && k.indexOf("--") === 0 && typeof v === "string") {
            document.documentElement.style.setProperty(k, v);
          }
        }
      }
      if (ctx.entrypoint === "global" || ctx.surface === "global" || ctx.viewMode === "global") {
        state.isGlobal = true;
      } else if (ctx.entrypoint === "aux_pane" || ctx.surface === "aux_pane") {
        state.isGlobal = false;
      }
    }
    if (caps && typeof caps === "object") {
      var hasConvCap = Boolean(caps.message || caps.updateModelContext);
      if (!hasConvCap) state.isGlobal = true;
    }
    var shell = document.getElementById("app-shell");
    if (shell) shell.classList.toggle("mode-global", state.isGlobal);
  }

  function extractStructured(toolResult) {
    if (!toolResult || typeof toolResult !== "object") return null;
    if (toolResult.structuredContent && typeof toolResult.structuredContent === "object") {
      return toolResult.structuredContent;
    }
    if (Array.isArray(toolResult.content) && toolResult.content[0] && typeof toolResult.content[0].text === "string") {
      try {
        return JSON.parse(toolResult.content[0].text);
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  function ingestPollPayload(data) {
    if (!data || typeof data !== "object") return;
    if (typeof data.error === "string" && data.error.length > 0) {
      state.errorNote = data.error;
      renderAll();
      return;
    }
    state.errorNote = "";
    if (typeof data.etag === "string") state.etag = data.etag;
    if (data.unchanged === true) return;
    if (Array.isArray(data.sessions)) state.sessions = data.sessions;
    state.snapshot = data.snapshot || null;
    renderAll();
  }

  function openLocalFile(fileUri) {
    if (typeof fileUri !== "string" || fileUri.indexOf("file:///") !== 0) return;
    sendRequest("com.google.antigravity/toggle-aux-pane", {
      tabType: "fileView",
      uri: fileUri
    }).catch(function (err) {
      if (err && err.code === -32601) return;
    });
  }

  function pollSnapshot(force) {
    if (!state.initialized || state.inFlight) return;
    if (!force && document.visibilityState !== "visible") return;
    state.inFlight = true;
    var args = {};
    if (state.selectedSessionId) args.sessionId = state.selectedSessionId;
    if (state.sourceFilter && state.sourceFilter !== "auto") args.source = state.sourceFilter;
    if (!force && state.etag) args.etag = state.etag;
    sendRequest("tools/call", { name: "hud_poll_snapshot", arguments: args })
      .then(function (res) { ingestPollPayload(extractStructured(res)); })
      .catch(function (err) {
        state.errorNote = err && err.message ? err.message : "Poll error";
        renderAll();
      })
      .finally(function () { state.inFlight = false; });
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (document.visibilityState !== "visible") return;
    state.pollTimer = setInterval(function () { pollSnapshot(false); }, POLL_INTERVAL_MS);
  }

  document.addEventListener("click", function (ev) {
    var target = ev.target;
    if (!(target instanceof Element)) return;
    var tabBtn = target.closest("[data-va-tab]");
    if (tabBtn) { state.tab = tabBtn.getAttribute("data-va-tab") || "overview"; renderMainPanel(); return; }
    var jumpBtn = target.closest("[data-va-jump]");
    if (jumpBtn) { state.tab = jumpBtn.getAttribute("data-va-jump") || "overview"; renderMainPanel(); return; }
    var toolRow = target.closest("[data-va-tool]");
    if (toolRow) {
      var k = toolRow.getAttribute("data-va-tool");
      state.expandedTool = state.expandedTool === k ? null : k;
      renderMainPanel();
      return;
    }
    var fileBtn = target.closest("[data-file-uri]");
    if (fileBtn) { var uri = fileBtn.getAttribute("data-file-uri"); if (uri) openLocalFile(uri); return; }
    var pickSess = target.closest("[data-pick-session]");
    if (pickSess) { state.selectedSessionId = pickSess.getAttribute("data-pick-session"); state.etag = null; pollSnapshot(true); return; }
    var srcPill = target.closest("[data-src-filter]");
    if (srcPill) { state.sourceFilter = srcPill.getAttribute("data-src-filter") || "auto"; state.selectedSessionId = null; state.etag = null; pollSnapshot(true); return; }
    if (target.closest("#va-refresh")) { state.etag = null; pollSnapshot(true); }
  });

  document.addEventListener("change", function (ev) {
    var target = ev.target;
    if (target instanceof HTMLSelectElement && target.id === "va-sess-select") {
      state.selectedSessionId = target.value || null;
      state.etag = null;
      pollSnapshot(true);
    }
  });

  document.addEventListener("input", function (ev) {
    var target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "va-search") {
      state.query = target.value;
      renderMainPanel();
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { pollSnapshot(false); startPolling(); }
    else stopPolling();
  });

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    if (typeof msg.method === "string") {
      if (msg.method === "ping" && msg.id !== undefined) {
        postToHost({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      if (msg.method === "ui/notifications/host-context-changed") { applyHostContext(msg.params, null); return; }
      if (msg.method === "ui/notifications/tool-input" && msg.params && msg.params.arguments) {
        var inArgs = msg.params.arguments;
        if (typeof inArgs.sessionId === "string" && inArgs.sessionId) state.selectedSessionId = inArgs.sessionId;
        if (typeof inArgs.source === "string" && inArgs.source) state.sourceFilter = inArgs.source;
        return;
      }
      if (msg.method === "ui/notifications/tool-result") { ingestPollPayload(extractStructured(msg.params)); }
      return;
    }
    if (msg.id !== undefined && state.pending.has(msg.id)) {
      var entry = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
    }
  });

  renderAll();
  sendRequest("ui/initialize", {
    appInfo: { name: "HUD Inspector", version: "0.1.0" },
    appCapabilities: {},
    protocolVersion: SEP_PROTOCOL_VERSION
  })
    .then(function (res) {
      state.initialized = true;
      if (res && typeof res === "object") applyHostContext(res.hostContext, res.hostCapabilities);
      sendNotification("ui/notifications/initialized", {});
      startPolling();
      if (!state.snapshot) pollSnapshot(true);
    })
    .catch(function () { state.initialized = true; renderAll(); });
})();
`;
