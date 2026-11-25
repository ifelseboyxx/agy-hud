export const INSPECTOR_STATE_SCRIPT: string = `  var MAX_UNSETTLED_HOST_PUSH_ENTRIES = 64;

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function normalizeSessionId(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function normalizeSource(raw) {
    return typeof raw === "string" && raw.length > 0 ? raw : "auto";
  }

  function sessionsMayOverlap(a, b) {
    if (a === "" || b === "") return true;
    return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
  }

  function hasOverlappingUnsettledHostPush(source, sessLower) {
    if (state.hostPushOverflow) return true;
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.count > 0 && entry.source === source && sessionsMayOverlap(entry.sessionLower, sessLower)) {
        return true;
      }
    }
    return false;
  }

  function recordHostPushRequest(source, sessionId) {
    var src = normalizeSource(source);
    var sess = normalizeSessionId(sessionId);
    var sessLower = sess ? sess.toLowerCase() : "";
    var overlapping = hasOverlappingUnsettledHostPush(src, sessLower);
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.source === src && entry.sessionLower === sessLower) {
        entry.count += 1;
        return overlapping;
      }
    }
    if (state.unsettledHostPushes.length >= MAX_UNSETTLED_HOST_PUSH_ENTRIES) {
      state.hostPushOverflow = true;
      return true;
    }
    state.unsettledHostPushes.push({ source: src, sessionLower: sessLower, count: 1 });
    return overlapping;
  }

  function decrementHostPushAt(idx) {
    var entry = state.unsettledHostPushes[idx];
    if (!entry) return;
    if (entry.count <= 1) state.unsettledHostPushes.splice(idx, 1);
    else entry.count -= 1;
    if (state.unsettledHostPushes.length === 0) state.hostPushOverflow = false;
  }

  function findNarrowestCoveringPushIndex(src, targetLower) {
    var bestIdx = -1;
    var bestLen = -1;
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.count <= 0 || entry.source !== src) continue;
      var s = entry.sessionLower;
      if (s === "" || targetLower === s || targetLower.indexOf(s) === 0) {
        if (s.length > bestLen) {
          bestLen = s.length;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }

  function settleHostPush(pushed) {
    if (state.unsettledHostPushes.length === 0) return;
    if (typeof pushed.error === "string" && pushed.error.length > 0) {
      if (typeof pushed.source !== "string" || pushed.source.length === 0) return;
      if (!Object.prototype.hasOwnProperty.call(pushed, "sessionId")) return;
      if (pushed.sessionId !== null && typeof pushed.sessionId !== "string") return;
      var errSess = normalizeSessionId(pushed.sessionId);
      if (pushed.sessionId !== null && errSess === null) return;
      var errLower = errSess ? errSess.toLowerCase() : "";
      for (var i = 0; i < state.unsettledHostPushes.length; i++) {
        var entry = state.unsettledHostPushes[i];
        if (entry.source === pushed.source && entry.sessionLower === errLower) {
          decrementHostPushAt(i);
          return;
        }
      }
      var coverIdx = findNarrowestCoveringPushIndex(pushed.source, errLower);
      if (coverIdx !== -1) decrementHostPushAt(coverIdx);
      return;
    }
    if (pushed.unchanged === true) {
      if (typeof pushed.source !== "string" || pushed.source.length === 0) return;
      if (
        Object.prototype.hasOwnProperty.call(pushed, "sessionId") &&
        pushed.sessionId !== undefined &&
        pushed.sessionId !== null &&
        (typeof pushed.sessionId !== "string" || normalizeSessionId(pushed.sessionId) === null)
      ) {
        return;
      }
      var unchSess = typeof pushed.sessionId === "string" ? normalizeSessionId(pushed.sessionId) : null;
      var unchLower = unchSess ? unchSess.toLowerCase() : "";
      var unchIdx = findNarrowestCoveringPushIndex(pushed.source, unchLower);
      if (unchIdx !== -1) decrementHostPushAt(unchIdx);
      return;
    }
    var src = normalizeSource(pushed.source);
    if (pushed.snapshot === null) {
      for (var j = 0; j < state.unsettledHostPushes.length; j++) {
        var autoEntry = state.unsettledHostPushes[j];
        if (autoEntry.source === src && autoEntry.sessionLower === "") {
          decrementHostPushAt(j);
          return;
        }
      }
      return;
    }
    if (!isObj(pushed.snapshot) || typeof pushed.snapshot.convId !== "string") return;
    var narrowIdx = findNarrowestCoveringPushIndex(src, pushed.snapshot.convId.toLowerCase());
    if (narrowIdx !== -1) decrementHostPushAt(narrowIdx);
  }

  function matchesCurrentSelection(data) {
    if (!isObj(data)) return false;
    if (typeof data.error === "string" && data.error.length > 0) {
      if (typeof data.source !== "string" || data.source !== state.sourceFilter) return false;
      if (!Object.prototype.hasOwnProperty.call(data, "sessionId")) return false;
      if (data.sessionId !== null && typeof data.sessionId !== "string") return false;
      var errSess = normalizeSessionId(data.sessionId);
      if (data.sessionId !== null && errSess === null) return false;
      return state.selectedSessionId
        ? errSess !== null && errSess.toLowerCase() === state.selectedSessionId.toLowerCase()
        : errSess === null;
    }
    if (data.unchanged === true) {
      return data.source === undefined || (typeof data.source === "string" && data.source === state.sourceFilter);
    }
    if (typeof data.source === "string" && data.source !== state.sourceFilter) return false;
    if (state.selectedSessionId) {
      if (!isObj(data.snapshot) || typeof data.snapshot.convId !== "string") return false;
      var sel = state.selectedSessionId.toLowerCase();
      var got = data.snapshot.convId.toLowerCase();
      if (got !== sel && got.indexOf(sel) !== 0) return false;
    }
    return true;
  }

  function isValidSessionItem(s) {
    return (
      isObj(s) &&
      typeof s.convId === "string" &&
      s.convId.length > 0 &&
      typeof s.surface === "string" &&
      typeof s.title === "string" &&
      (s.workspace === undefined || typeof s.workspace === "string")
    );
  }

  function isValidSnapshotPayload(snap) {
    if (snap === null) return true;
    return (
      isObj(snap) &&
      typeof snap.convId === "string" &&
      snap.convId.length > 0 &&
      typeof snap.surface === "string" &&
      typeof snap.title === "string" &&
      Array.isArray(snap.completedTools) &&
      Array.isArray(snap.skills) &&
      Array.isArray(snap.mcps) &&
      Array.isArray(snap.agents) &&
      (snap.runningTools == null || Array.isArray(snap.runningTools))
    );
  }

  function isValidPollPayload(data) {
    if (!isObj(data)) return false;
    if (typeof data.error === "string" && data.error.length > 0) return true;
    if (data.unchanged === true) return data.etag === undefined || typeof data.etag === "string";
    if (!Object.prototype.hasOwnProperty.call(data, "snapshot")) return false;
    if (!isValidSnapshotPayload(data.snapshot)) return false;
    if (data.sessions !== undefined && !Array.isArray(data.sessions)) return false;
    return true;
  }

  function ingestPollPayload(data) {
    if (!isValidPollPayload(data)) return;
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
    if (Array.isArray(data.sessions)) {
      state.sessions = data.sessions.filter(isValidSessionItem);
    }
    state.snapshot = data.snapshot != null ? data.snapshot : null;
    renderAll();
  }`;
