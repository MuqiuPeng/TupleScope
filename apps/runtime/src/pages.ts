/**
 * The page a person sees when they land on the runtime without a token.
 *
 * Returning `{"error":"UNAUTHORISED"}` to a browser is technically correct and
 * practically useless: the reader is already in a browser, so "open the URL the
 * runtime printed" tells them nothing they can act on. This page tells them
 * where the token actually is.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0d1413; color: #e3ebe8; padding: 32px;
    font: 15px/1.65 -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
  main { max-width: 34rem; }
  h1 { font-size: 1.15rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #55c4b3; margin-right: 8px; }
  p { color: #b6c6c2; margin: 0 0 16px; }
  pre { font-family: "SFMono-Regular", ui-monospace, Menlo, monospace; font-size: 12.5px;
    background: #101917; border: 1px solid #26332f; border-left: 3px solid #55c4b3;
    padding: 12px 14px; overflow-x: auto; margin: 0 0 16px; }
  .note { color: #869b96; font-size: 13px; border-top: 1px solid #26332f; padding-top: 14px; }
  code { font-family: "SFMono-Regular", ui-monospace, Menlo, monospace; font-size: 0.88em;
    background: #101917; border: 1px solid #26332f; border-radius: 3px; padding: 1px 5px; }
`;

export function unauthorisedPage(port: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StateScope — access token required</title><style>${STYLE}</style></head>
<body><main>
  <h1><span class="dot"></span>This page needs an access token</h1>
  <p>StateScope minted one when it started. It is printed with the URL, and it changes
     every time the runtime restarts.</p>

  <p>Ask this instance for it — the answer is right whoever started it, and a
     dead instance is never reported as live:</p>
  <pre>open "$(statescope url)"</pre>

  <p>Or read the URL and open it yourself:</p>
  <pre>statescope url
http://127.0.0.1:${port}/?token=&lt;the token&gt;</pre>

  <div class="note">
    Why the token: this process holds write credentials for your development
    database. Every page in your browser can reach <code>127.0.0.1</code>, so
    "it is only on localhost" is not by itself a way to keep them out.
  </div>
</main></body></html>`;
}
