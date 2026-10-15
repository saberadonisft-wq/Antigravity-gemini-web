import http from "node:http";

export interface FixtureServerOptions {
  port?: number;
  signedIn?: boolean;
  streamDelayMs?: number;
}

export class GeminiDomFixtureServer {
  private server: http.Server | null = null;
  public port: number;
  public signedIn: boolean;
  public streamDelayMs: number;
  public turnsReceived: string[] = [];

  constructor(options: FixtureServerOptions = {}) {
    this.port = options.port ?? 0;
    this.signedIn = options.signedIn ?? true;
    this.streamDelayMs = options.streamDelayMs ?? 50;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/app`;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === "/app") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(this.renderHtml());
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        resolve(this.port);
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.closeAllConnections();
        this.server.close((error) => { if (error) reject(error); else resolve(); });
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  private renderHtml(): string {
    const avatarHtml = this.signedIn
      ? '<img data-test-id="user-avatar" class="user-avatar" aria-label="Google Account: testuser@example.com" src="avatar.png" />'
      : '<a data-test-id="sign-in-button" href="https://accounts.google.com/signin">Sign in</a>';

    const scriptLines = [
      'let turnCount = 0;',
      'let streamTimer = null;',
      'const conversation = document.getElementById("conversation");',
      'const composer = document.getElementById("composerInput");',
      'const sendBtn = document.getElementById("sendBtn");',
      'const stopBtn = document.getElementById("stopBtn");',
      '',
      'const turnResponses = [',
      '  "Hello! I am Gemini. This is Turn 1 text response confirming our connection.",',
      '  "### Turn 2 Markdown Header\\n- Item 1: Planning\\n- Item 2: Execution\\n- Item 3: Verification",',
      '  "```typescript\\n// Turn 3 Code Fence\\nexport function runTask(): string {\\n  return \'PASS\';\\n}\\n```"',
      '];',
      '',
      'sendBtn.addEventListener("click", () => {',
      '  const comp = document.getElementById("composerInput") || document.querySelector("rich-textarea");',
      '  const prompt = (comp ? (comp.innerText || comp.textContent || "") : "").trim();',
      '  if (!prompt) return;',
      '  const userEl = document.createElement("div");',
      '  userEl.className = "user-query";',
      '  userEl.textContent = prompt;',
      '  conversation.appendChild(userEl);',
      '  if (comp) { comp.innerText = ""; comp.textContent = ""; }',
      '  sendBtn.style.display = "none";',
      '  stopBtn.style.display = "inline-block";',
      '  const respEl = document.createElement("div");',
      '  respEl.className = "model-response";',
      '  const respText = document.createElement("div");',
      '  respText.className = "model-response-text";',
      '  respEl.appendChild(respText);',
      '  conversation.appendChild(respEl);',
      '  const fullText = turnCount >= 3 ? "SYNTHETIC LONG RESPONSE ".repeat(2000) : turnResponses[turnCount % turnResponses.length];',
      '  turnCount++;',
      '  let charIdx = 0;',
      '  streamTimer = setInterval(() => {',
      '    if (charIdx < fullText.length) {',
      '      charIdx += 8;',
      '      const chunk = fullText.substring(0, Math.min(charIdx, fullText.length));',
      '      if (chunk.includes("```")) {',
      '        respText.innerHTML = "<pre class=\'code-block\'><code>" + chunk + "</code></pre>";',
      '      } else {',
      '        respText.innerText = chunk;',
      '      }',
      '    } else {',
      '      clearInterval(streamTimer);',
      '      streamTimer = null;',
      '      stopBtn.style.display = "none";',
      '      sendBtn.style.display = "inline-block";',
      '    }',
      '  }, ' + this.streamDelayMs + ');',
      '});',
      '',
      'stopBtn.addEventListener("click", () => {',
      '  if (streamTimer) {',
      '    clearInterval(streamTimer);',
      '    streamTimer = null;',
      '  }',
      '  stopBtn.style.display = "none";',
      '  sendBtn.style.display = "inline-block";',
      '  const respElements = document.querySelectorAll(".model-response-text");',
      '  if (respElements.length > 0) {',
      '    respElements[respElements.length - 1].innerText += " [GENERATION CANCELLED]";',
      '  }',
      '});',
    ];

    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <title>Google Gemini (Fixture)</title>',
      '  <style>',
      '    body { font-family: sans-serif; margin: 20px; background: #131314; color: #e3e3e3; }',
      '    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; }',
      '    .model-selector { padding: 8px 16px; background: #282a2c; color: white; border: none; border-radius: 8px; }',
      '    .conversation-container { min-height: 250px; margin: 20px 0; display: flex; flex-direction: column; gap: 15px; }',
      '    .user-query { align-self: flex-end; background: #2b3137; padding: 10px 15px; border-radius: 12px; max-width: 70%; }',
      '    .model-response { align-self: flex-start; background: #1e1f20; padding: 12px 18px; border-radius: 12px; max-width: 80%; }',
      '    .code-block { background: #0d1117; padding: 10px; border-radius: 6px; font-family: monospace; overflow-x: auto; }',
      '    .composer-container { display: flex; gap: 10px; margin-top: 20px; }',
      '    .ql-editor { flex: 1; min-height: 40px; padding: 10px; background: #1e1f20; border: 1px solid #444; border-radius: 8px; color: white; outline: none; }',
      '    .send-button, .stop-button { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; }',
      '    .send-button { background: #1a73e8; color: white; }',
      '    .stop-button { background: #d93025; color: white; display: none; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div class="header">',
      '    <button data-test-id="model-selector" class="model-selector">Gemini 1.5 Pro</button>',
      '    ' + avatarHtml,
      '  </div>',
      '  <div id="conversation" class="conversation-container"></div>',
      '  <div class="composer-container">',
      '    <rich-textarea>',
      '      <div id="composerInput" class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>',
      '    </rich-textarea>',
      '    <button id="sendBtn" class="send-button" aria-label="Send message">Send</button>',
      '    <button id="stopBtn" class="stop-button" aria-label="Stop response">Stop</button>',
      '  </div>',
      '  <script>',
      scriptLines.join('\n'),
      '  </script>',
      '</body>',
      '</html>',
    ].join('\n');
  }
}

