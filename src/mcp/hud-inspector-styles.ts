export const INSPECTOR_STYLES: string = `:root {
  color-scheme: dark;
  --bg-primary: var(--color-background-primary, #0b0c0e);
  --bg-secondary: var(--color-background-secondary, #141619);
  --bg-tertiary: var(--color-background-tertiary, #17191d);
  --text-primary: var(--color-text-primary, #eceef0);
  --text-secondary: var(--color-text-secondary, #b8bfc6);
  --text-tertiary: var(--color-text-tertiary, #7f8892);
  --border-primary: var(--color-border-primary, rgba(255, 255, 255, 0.09));
  --border-secondary: var(--color-border-secondary, rgba(255, 255, 255, 0.16));
  --accent-info: var(--color-text-info, #4da3ff);
  --accent-ok: var(--color-text-success, #7aae66);
  --accent-warn: var(--color-text-warning, #d4b44a);
  --accent-danger: var(--color-text-danger, #e06c6c);
  --accent-mcp: #9d84f5;
  --bg-info-tint: var(--color-background-info, rgba(77, 163, 255, 0.14));
  --bg-warn-tint: var(--color-background-warning, rgba(212, 180, 74, 0.12));
  --hover: rgba(128, 128, 128, 0.1);
  --fill: rgba(128, 128, 128, 0.14);
  --font-ui: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
  --font-code: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg-primary: var(--color-background-primary, #ffffff);
  --bg-secondary: var(--color-background-secondary, #f6f7f9);
  --bg-tertiary: var(--color-background-tertiary, #eef0f3);
  --text-primary: var(--color-text-primary, #1b1e23);
  --text-secondary: var(--color-text-secondary, #474e57);
  --text-tertiary: var(--color-text-tertiary, #68717c);
  --border-primary: var(--color-border-primary, rgba(0, 0, 0, 0.09));
  --border-secondary: var(--color-border-secondary, rgba(0, 0, 0, 0.16));
  --accent-info: var(--color-text-info, #1a6dd4);
  --accent-ok: var(--color-text-success, #2d7a36);
  --accent-warn: var(--color-text-warning, #a67300);
  --accent-danger: var(--color-text-danger, #c43737);
  --accent-mcp: #6b4cd8;
  --bg-info-tint: var(--color-background-info, rgba(26, 109, 212, 0.1));
  --bg-warn-tint: var(--color-background-warning, rgba(166, 115, 0, 0.1));
  --hover: rgba(0, 0, 0, 0.045);
  --fill: rgba(0, 0, 0, 0.07);
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.45;
  background: var(--bg-primary);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; }
.num { font-variant-numeric: tabular-nums; font-family: var(--font-code); }
.ico { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; flex: none; }
.app-shell { display: flex; height: 100%; width: 100%; background: var(--bg-primary); }
.global-sess-list {
  display: none;
  width: 264px;
  flex: none;
  border-right: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  flex-direction: column;
  min-height: 0;
}
.app-shell.mode-global .global-sess-list { display: flex; }
@media (max-width: 639px) {
  .app-shell.mode-global .global-sess-list { display: none; }
}
.global-list-hd {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.global-list-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.src-pills { display: flex; gap: 4px; }
.src-pill {
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--fill);
}
.src-pill.on { background: var(--bg-info-tint); color: var(--accent-info); font-weight: 600; }
.global-list-body { flex: 1 1 auto; overflow-y: auto; }
.global-sess-item {
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.global-sess-item:hover { background: var(--hover); }
.global-sess-item.on {
  background: var(--bg-info-tint);
  border-left: 2px solid var(--accent-info);
  padding-left: 10px;
}
.global-sess-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.global-sess-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.global-sess-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.inspector-main {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}
.va-header {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-primary);
  padding: 11px 14px 0;
  border-bottom: 1px solid var(--border-primary);
}
.va-title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.badge-surf {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-code);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  background: var(--fill);
  color: var(--text-secondary);
  flex: none;
}
.badge-surf.app { background: var(--bg-info-tint); color: var(--accent-info); }
.badge-surf.ide { background: rgba(157, 132, 245, 0.16); color: var(--accent-mcp); }
.va-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.va-sess-select {
  margin-top: 7px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11.5px;
}
.app-shell.mode-global .va-sess-select { display: none; }
@media (max-width: 639px) {
  .app-shell.mode-global .va-sess-select { display: block; }
}
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex: none;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: var(--text-tertiary);
  flex: none;
}
.icon-btn:hover { background: var(--hover); color: var(--text-primary); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.dot.ok { background: var(--accent-ok); }
.dot.warn { background: var(--accent-warn); }
.dot.danger { background: var(--accent-danger); }
.dot.pulse { background: var(--accent-ok); box-shadow: 0 0 0 3px rgba(122, 174, 102, 0.25); }
.va-ribbon {
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  white-space: nowrap;
  gap: 10px;
  font-size: 11.5px;
}
.va-ribbon > span { flex: none; white-space: nowrap; }
.va-ctx-track {
  width: 48px;
  height: 5px;
  border-radius: 3px;
  background: var(--fill);
  overflow: hidden;
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
}
.va-ctx-fill { height: 100%; border-radius: 3px; background: var(--accent-ok); }
.va-tabs { display: flex; gap: 15px; margin-top: 8px; overflow-x: auto; }
.va-tab {
  position: relative;
  height: 32px;
  padding: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.va-tab:hover { color: var(--text-secondary); }
.va-tab.active { color: var(--text-primary); }
.va-tab.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent-info);
}
.va-cnt { font-size: 10.5px; color: var(--text-tertiary); font-family: var(--font-code); }
.va-body { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.va-run-banner {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-warn-tint);
  border: 1px solid var(--border-secondary);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.va-run-item { display: flex; align-items: center; gap: 7px; font-size: 12px; min-width: 0; }
.va-run-tgt {
  color: var(--text-tertiary);
  font-family: var(--font-code);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-card {
  border: 1px solid var(--border-primary);
  border-radius: 7px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.va-card-hd {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.va-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.va-row:last-child { border-bottom: 0; }
.va-row:hover { background: var(--hover); }
.va-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.va-row-main.clickable { cursor: pointer; }
.va-name { font-family: var(--font-code); font-size: 12px; font-weight: 500; color: var(--text-primary); }
.va-tgt {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-bar-bg { height: 3px; border-radius: 2px; background: var(--fill); overflow: hidden; }
.va-bar-fg { height: 100%; background: var(--accent-info); opacity: 0.78; }
.va-targets {
  padding: 5px 8px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.va-target-btn, .va-target-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-secondary);
  padding: 2px 4px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-target-btn:hover { background: var(--hover); color: var(--accent-info); }
.va-target-text { color: var(--text-tertiary); }
.search-input {
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
}
.action-link { font-size: 11px; color: var(--accent-info); padding: 2px 6px; border-radius: 4px; }
.action-link:hover { background: var(--hover); }
.va-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.va-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  font-size: 11px;
}
.va-more-btn {
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-code);
  font-size: 11px;
  background: var(--bg-info-tint);
  color: var(--accent-info);
}
.empty-state {
  margin: auto;
  padding: 28px 20px;
  text-align: center;
  color: var(--text-tertiary);
  max-width: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-state strong { color: var(--text-primary); font-size: 13px; }
.status-note {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
}
`;
