import { INSPECTOR_SCRIPT } from './hud-inspector-script.ts';
import { INSPECTOR_STYLES } from './hud-inspector-styles.ts';

export const INSPECTOR_RESOURCE_URI: string = 'ui://agy-hud/inspector.html';
export const INSPECTOR_MIME_TYPE: string = 'text/html;profile=mcp-app';

export function buildInspectorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HUD Inspector</title>
  <style>${INSPECTOR_STYLES}</style>
</head>
<body>
  <div id="app-shell" class="app-shell">
    <aside id="global-sess-mount" class="global-sess-list" aria-label="Local Antigravity sessions"></aside>
    <main id="inspector-main" class="inspector-main"></main>
  </div>
  <script>${INSPECTOR_SCRIPT}</script>
</body>
</html>
`;
}
