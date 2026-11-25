import { INSPECTOR_RENDER_SCRIPT } from './hud-inspector-render-script.ts';

export const INSPECTOR_SCRIPT: string = `(function () {
  var POLL_INTERVAL_MS = 2000;
  var REQUEST_TIMEOUT_MS = 10000;
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
    pendingPoll: false,
    pendingForce: false,
    selectionSeq: 0,
    latestRequestSeq: 0,
    acceptHostPush: true,
    disposed: false,
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

  function sendRequest(method, params, timeoutMs) {
    var id = state.nextId++;
    return new Promise(function (resolve, reject) {
      var timer = null;
      if (timeoutMs > 0 && typeof setTimeout === "function") {
        timer = setTimeout(function () {
          if (!state.pending.has(id)) return;
          state.pending.delete(id);
          reject(new Error("Request timed out"));
        }, timeoutMs);
      }
      state.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
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

  function bumpSelection(fromUser) {
    state.selectionSeq += 1;
    state.etag = null;
    if (fromUser) state.acceptHostPush = false;
  }

  function matchesCurrentSelection(data) {
    if (!data || typeof data !== "object") return false;
    if (data.unchanged === true) return true;
    if (typeof data.source === "string" && data.source !== state.sourceFilter) return false;
    if (state.selectedSessionId) {
      if (!data.snapshot || typeof data.snapshot.convId !== "string") return false;
      var sel = state.selectedSessionId.toLowerCase();
      var got = data.snapshot.convId.toLowerCase();
      if (got !== sel && got.indexOf(sel) !== 0) return false;
    }
    return true;
  }

  function ingestPollPayload(data) {
    if (!data || typeof data !== "object") return;
    if (typeof data.error === "string" && data.error.length > 0) {
      state.errorNote = data.error;
      renderAll();
      return;
    }
    var hadError = state.errorNote.length > 0;
    state.errorNote = "";
    if (typeof data.etag === "string") state.etag = data.etag;
    if (data.unchanged === true) {
      if (hadError) renderAll();
      return;
    }
    if (Array.isArray(data.sessions)) state.sessions = data.sessions;
    state.snapshot = data.snapshot != null ? data.snapshot : null;
    renderAll();
  }

  function openLocalFile(fileUri) {
    if (typeof fileUri !== "string" || fileUri.indexOf("file:///") !== 0) return;
    sendRequest("com.google.antigravity/toggle-aux-pane", {
      tabType: "fileView",
      uri: fileUri
    }, REQUEST_TIMEOUT_MS).catch(function (err) {
      if (err && err.code === -32601) return;
    });
  }

  function pollSnapshot(force) {
    if (state.disposed) return;
    if (!state.initialized) {
      if (force) {
        state.pendingPoll = true;
        state.pendingForce = true;
      }
      return;
    }
    if (!force && document.visibilityState !== "visible") return;
    if (state.inFlight) {
      if (force) {
        state.pendingPoll = true;
        state.pendingForce = true;
      }
      return;
    }
    state.inFlight = true;
    state.pendingPoll = false;
    state.pendingForce = false;

    var reqSeq = ++state.latestRequestSeq;
    var reqSelectionSeq = state.selectionSeq;
    var reqSessionId = state.selectedSessionId;
    var reqSource = state.sourceFilter;

    var args = {};
    if (reqSessionId) args.sessionId = reqSessionId;
    if (reqSource && reqSource !== "auto") args.source = reqSource;
    if (!force && state.etag) args.etag = state.etag;

    function isCurrentRequest() {
      return (
        reqSeq === state.latestRequestSeq &&
        reqSelectionSeq === state.selectionSeq &&
        reqSessionId === state.selectedSessionId &&
        reqSource === state.sourceFilter
      );
    }

    sendRequest("tools/call", { name: "hud_poll_snapshot", arguments: args }, REQUEST_TIMEOUT_MS)
      .then(function (res) {
        if (!isCurrentRequest()) return;
        var data = extractStructured(res);
        if (!data) return;
        if (typeof data.error === "string" && data.error.length > 0) {
          ingestPollPayload(data);
          return;
        }
        if (!matchesCurrentSelection(data)) return;
        ingestPollPayload(data);
      })
      .catch(function (err) {
        if (!isCurrentRequest()) return;
        state.errorNote = err && err.message ? err.message : "Poll error";
        renderAll();
      })
      .finally(function () {
        state.inFlight = false;
        if (state.pendingPoll) {
          var nextForce = state.pendingForce;
          state.pendingPoll = false;
          state.pendingForce = false;
          pollSnapshot(nextForce);
        }
      });
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (state.disposed || document.visibilityState !== "visible") return;
    state.pollTimer = setInterval(function () { pollSnapshot(false); }, POLL_INTERVAL_MS);
  }

  function onDocClick(ev) {
    var target = ev.target;
    if (!(target instanceof Element)) return;
    var tabBtn = target.closest("[data-va-tab]");
    if (tabBtn) {
      var nextTab = tabBtn.getAttribute("data-va-tab");
      state.tab = nextTab && nextTab.length > 0 ? nextTab : "overview";
      renderMainPanel();
      return;
    }
    var jumpBtn = target.closest("[data-va-jump]");
    if (jumpBtn) {
      var jumpTab = jumpBtn.getAttribute("data-va-jump");
      state.tab = jumpTab && jumpTab.length > 0 ? jumpTab : "overview";
      renderMainPanel();
      return;
    }
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
    if (pickSess) {
      var picked = pickSess.getAttribute("data-pick-session");
      state.selectedSessionId = picked && picked.length > 0 ? picked : null;
      bumpSelection(true);
      pollSnapshot(true);
      return;
    }
    var srcPill = target.closest("[data-src-filter]");
    if (srcPill) {
      var srcVal = srcPill.getAttribute("data-src-filter");
      state.sourceFilter = srcVal && srcVal.length > 0 ? srcVal : "auto";
      state.selectedSessionId = null;
      bumpSelection(true);
      pollSnapshot(true);
      return;
    }
    if (target.closest("#va-refresh")) { bumpSelection(true); pollSnapshot(true); }
  }

  function onDocChange(ev) {
    var target = ev.target;
    if (target instanceof HTMLSelectElement && target.id === "va-sess-select") {
      state.selectedSessionId = target.value.length > 0 ? target.value : null;
      bumpSelection(true);
      pollSnapshot(true);
    }
  }

  function onDocInput(ev) {
    var target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "va-search") {
      state.query = target.value;
      renderMainPanel();
    }
  }

  function onVisibilityChange() {
    if (state.disposed) return;
    if (document.visibilityState === "visible") { pollSnapshot(false); startPolling(); }
    else stopPolling();
  }

  function onWindowMessage(ev) {
    if (state.disposed) return;
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
        var nextSess = typeof inArgs.sessionId === "string" && inArgs.sessionId.length > 0 ? inArgs.sessionId : null;
        var nextSrc = typeof inArgs.source === "string" && inArgs.source.length > 0 ? inArgs.source : "auto";
        var changed = nextSess !== state.selectedSessionId || nextSrc !== state.sourceFilter;
        state.selectedSessionId = nextSess;
        state.sourceFilter = nextSrc;
        state.acceptHostPush = true;
        if (changed) {
          bumpSelection(false);
          pollSnapshot(true);
        }
        return;
      }
      if (msg.method === "ui/notifications/tool-result") {
        if (!state.acceptHostPush) return;
        var pushed = extractStructured(msg.params);
        if (pushed && matchesCurrentSelection(pushed)) ingestPollPayload(pushed);
      }
      return;
    }
    if (msg.id !== undefined && state.pending.has(msg.id)) {
      var entry = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      if (entry.timer !== null && typeof clearTimeout === "function") {
        clearTimeout(entry.timer);
      }
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
    }
  }

  function cleanupResources() {
    state.disposed = true;
    stopPolling();
    state.pending.forEach(function (entry) {
      if (entry.timer !== null && typeof clearTimeout === "function") {
        clearTimeout(entry.timer);
      }
    });
    state.pending.clear();
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("change", onDocChange);
      document.removeEventListener("input", onDocInput);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("message", onWindowMessage);
      window.removeEventListener("pagehide", cleanupResources);
      window.removeEventListener("unload", cleanupResources);
    }
  }

  document.addEventListener("click", onDocClick);
  document.addEventListener("change", onDocChange);
  document.addEventListener("input", onDocInput);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("message", onWindowMessage);
  window.addEventListener("pagehide", cleanupResources);
  window.addEventListener("unload", cleanupResources);

  renderAll();
  sendRequest("ui/initialize", {
    appInfo: { name: "HUD Inspector", version: "0.1.0" },
    appCapabilities: {},
    protocolVersion: SEP_PROTOCOL_VERSION
  }, REQUEST_TIMEOUT_MS)
    .then(function (res) {
      state.initialized = true;
      if (res && typeof res === "object") applyHostContext(res.hostContext, res.hostCapabilities);
      sendNotification("ui/notifications/initialized", {});
      startPolling();
      if (state.pendingPoll || !state.snapshot) pollSnapshot(true);
    })
    .catch(function () {
      state.initialized = true;
      startPolling();
      if (state.pendingPoll || !state.snapshot) pollSnapshot(true);
      else renderAll();
    });
})();
`;
