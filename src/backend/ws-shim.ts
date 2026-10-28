/**
 * Core serves sockets at /plugin-ws/<id>/<exact path> and its nginx only
 * upgrades that prefix, while code-server opens its sockets relative to the
 * page it was served from, under /plugin-api. This script runs first in
 * code-server's page and points those sockets at the one route the plugin
 * registers, carrying the session and the original path in the query.
 *
 * It is served as a file rather than inlined so a Content-Security-Policy that
 * forbids inline scripts cannot block it.
 */
export const WS_SHIM_PATH = "/_termix/ws-shim.js";
export const WS_ROUTE = "/vscode";

export const WS_SHIM_SOURCE = `(function () {
  var script = document.currentScript;
  if (!script || !script.src) return;
  var base = new URL(script.src);
  var suffix = ${JSON.stringify(WS_SHIM_PATH)};
  if (base.pathname.slice(-suffix.length) !== suffix) return;
  var prefix = base.pathname.slice(0, base.pathname.length - suffix.length + 1);
  var match = /^(.*)\\/plugin-api\\/([^/]+)\\/session\\/([0-9a-f]{16})\\/$/.exec(prefix);
  if (!match) return;
  var Native = window.WebSocket;

  function rewrite(input) {
    var url;
    try { url = new URL(String(input), location.href); } catch (e) { return input; }
    if (url.host !== location.host || url.pathname.indexOf(prefix) !== 0) return input;
    var target = new URL(match[1] + "/plugin-ws/" + match[2] + ${JSON.stringify(WS_ROUTE)}, location.href);
    target.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("s", match[3]);
    target.searchParams.set("p", "/" + url.pathname.slice(prefix.length) + url.search);
    return target.href;
  }

  function TermixWebSocket(url, protocols) {
    return protocols === undefined ? new Native(rewrite(url)) : new Native(rewrite(url), protocols);
  }
  TermixWebSocket.prototype = Native.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (name) {
    Object.defineProperty(TermixWebSocket, name, { value: Native[name] });
  });
  window.WebSocket = TermixWebSocket;
})();
`;

/** Puts the shim first in the document, ahead of code-server's own scripts. */
export function injectShim(html: string): string {
  const tag = `<script src=".${WS_SHIM_PATH}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}
