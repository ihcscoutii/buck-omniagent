# Deploying Buck to Azure App Service

Hosting Buck on Azure gives a **permanent public URL**, so you no longer need a
tunnel (cloudflared/ngrok) — Napster's cloud calls your tools at the stable
Azure address. The app is a zero-dependency Node HTTP server that already reads
its config from environment variables and listens on `process.env.PORT`, so it
runs on App Service with no code changes.

> Target: **Azure App Service (Linux, Node 20)**. Not Static Web Apps — we need a
> long-running process for SSE and server-side token minting.

## Live deployment (current)
- **App:** `buck-scorekeeper-en` — resource group `buck-rg`
- **URL:** `https://buck-scorekeeper-en.azurewebsites.net`
- **Agent (production key):** `04cc9f3f-6d0c-44ef-bde1-1825f8efa460` (companion "Thijm Vermeerden")
- App settings live on the web app: `NAPSTER_API_KEY`, `PUBLIC_TOOL_URL`, `TOOL_SECRET`, `AGENT_ID`.

The steps below are the from-scratch recipe. To swap in a new key or agent on the
existing app, see [Rotating to a new API key](#rotating-to-a-new-api-key-or-agent).

## Prerequisites
- Azure CLI: `az login`
- Your hackathon `NAPSTER_API_KEY`

## 1. Create the web app + deploy the code
```bash
# From the project root. Creates resource group, plan, and web app, then uploads.
az webapp up \
  --name buck-scorekeeper \
  --runtime "NODE:20-lts" \
  --sku B1 \
  --location eastus
```
Note the URL it prints: `https://buck-scorekeeper.azurewebsites.net`.

App Service runs `npm start` (`node src/server.js`) automatically. Turn on
**Always On** so SSE connections aren't dropped when idle:
```bash
az webapp config set --name buck-scorekeeper -g <resource-group> --always-on true
```

## 2. Configure secrets as App Settings (never commit these)
```bash
APP=buck-scorekeeper; RG=<resource-group>
URL=https://buck-scorekeeper.azurewebsites.net

az webapp config appsettings set --name $APP -g $RG --settings \
  NAPSTER_API_KEY='Napster_xxx' \
  PUBLIC_TOOL_URL="$URL" \
  TOOL_SECRET='buck_pick_a_long_random_value'
```
- `PUBLIC_TOOL_URL` is the app's **own** public URL (where Napster calls the tools).
- `TOOL_SECRET` gates `/tools/*` and `/api/token`. Use a long random value.
- `PORT` is provided by App Service automatically — don't set it.

## 3. Register Buck's tools + agent against the Azure URL (run locally, once)
The tools must point at the Azure URL and carry the same secret. Run setup with
those values; it prints an `agentId`:
```bash
NAPSTER_API_KEY='Napster_xxx' \
PUBLIC_TOOL_URL="https://buck-scorekeeper.azurewebsites.net" \
TOOL_SECRET='same-value-as-the-app-setting' \
node src/setup-napster.js
```

## 4. Tell the hosted app which agent to use
On Azure, `.agent.json` isn't deployed (it's gitignored), so set the id explicitly:
```bash
az webapp config appsettings set --name $APP -g $RG --settings \
  AGENT_ID='<agentId from step 3>'
```
(The server reads `AGENT_ID` from the environment when `.agent.json` is absent.)

## 5. Use it
Open `https://buck-scorekeeper.azurewebsites.net`, enter the **operator key**
(your `TOOL_SECRET`) in the Manual control panel, then **Connect Buck** and talk.
Spectators can open the same URL and watch the scoreboard read-only without the key.

## Redeploying
- Code change: `az webapp up` again (same name) — or set up CI (below).
- Changed `PUBLIC_TOOL_URL` or `TOOL_SECRET`: re-run **step 3** (setup upserts the
  tools so the new URL/secret are applied) and update the matching App Settings.

## Rotating to a new API key (or agent)
When you move to a different `NAPSTER_API_KEY` (e.g. hackathon → production), the
old agent id belongs to the old account and is gone — you register a fresh one.
No code deploy is needed; only the app settings change (which auto-restarts the app).

```bash
APP=buck-scorekeeper-en; RG=buck-rg
URL=https://buck-scorekeeper-en.azurewebsites.net

# 1. Force a fresh agent create (don't PATCH the old id) — setup reuses .agent.json
#    / AGENT_ID by default, so move it aside first.
mv .agent.json .agent.json.bak

# 2. Register a new agent + re-register all tools against the Azure URL.
#    TOOL_SECRET must match what the app enforces (pull it from the app settings).
NAPSTER_API_KEY='<new key>' \
PUBLIC_TOOL_URL="$URL" \
TOOL_SECRET="$(az webapp config appsettings list -n $APP -g $RG \
  --query "[?name=='TOOL_SECRET'].value | [0]" -o tsv | tr -d '[:space:]')" \
node src/setup-napster.js          # prints + saves the new agentId to .agent.json

# 3. Point the live app at the new key + agent (auto-restarts).
az webapp config appsettings set -n $APP -g $RG --settings \
  NAPSTER_API_KEY='<new key>' \
  AGENT_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.agent.json')).agentId)")"

# 4. Verify the whole chain end-to-end (should return a token, not an error):
curl -s -X POST "$URL/api/token?channel=webrtc" \
  -H "x-tool-secret: $(az webapp config appsettings list -n $APP -g $RG \
     --query "[?name=='TOOL_SECRET'].value | [0]" -o tsv | tr -d '[:space:]')"
```
Right after step 3 the app restarts; the first `/api/token` may return
`502 No token from Napster` during cold start — retry once it's warm.

## Gotchas
- **`az` on WSL emits CRLF.** The Azure CLI here is Windows `az.exe` running under
  WSL, so `... -o tsv` values come back with a trailing `\r`. In `$(...)` the `\n`
  is stripped but the `\r` survives, so a clean 64-char key reads back as 65 chars.
  It's a **readback artifact — the stored value is clean.** Always pipe secret
  reads through `tr -d '[:space:]'` (as above) before comparing or reusing them,
  or you'll chase a phantom trailing character.
- **`setup-napster.js` reuses the existing agent by default** (reads `.agent.json`
  / `AGENT_ID` and PATCHes it in place so the id is stable). To create a *new*
  agent — e.g. under a new key where the old id doesn't exist — move `.agent.json`
  aside first, otherwise it will try (and fail) to patch the stale id.
- **`.agent.json` is gitignored** and not deployed, which is why Azure needs
  `AGENT_ID` set explicitly.

## Optional: push-to-deploy with GitHub Actions
`.github/workflows/azure.yml` deploys on every push to `main`. To enable it:
1. Create a GitHub repo and push.
2. In the Azure Portal → your web app → *Get publish profile* (downloads XML).
3. Add it as a GitHub repo secret named `AZURE_WEBAPP_PUBLISH_PROFILE`.
4. Edit `AZURE_WEBAPP_NAME` in the workflow if you used a different app name.

## Cost
- **B1** (~$13/mo, Always On) is the sweet spot for SSE and easily covered by dev credits.
- **F1 (Free)** works for quick tests but sleeps and has no Always On (SSE drops).

## Security notes
- `TOOL_SECRET` keeps anonymous visitors from driving the game or spending your
  Napster minutes via `/api/token`. Reads (scoreboard) remain public by design.
- Rotating the secret = update the App Setting **and** re-run step 3.
