# Chromebook Setup

1. On the Chromebook, open Settings and enable Linux development environment (Crostini).
2. In the Linux terminal:
   - `sudo apt update`
   - `sudo apt install -y nodejs npm chromium`
   - `mkdir -p ~/ugc-browser-host && cd ~/ugc-browser-host`
   - `npm init -y`
   - `npm install playwright`
   - `npx playwright install chromium`
3. Run a Playwright smoke test:
   - `node -e "const { chromium } = require('playwright'); (async()=>{const b=await chromium.launch();const p=await b.newPage();await p.goto('http://example.com');console.log(await p.title());await b.close();})()"`
4. Start the supplied reference runtime host and record its URL.
5. From Termux, set:
   - `BROWSER_RUNTIME_URL=http://<chromebook-ip>:3200`
   - `BROWSER_RUNTIME_TOKEN=<long random token>`
6. Restart UGC and check `/api/browser/status`.

Do not expose the port through the public internet.
