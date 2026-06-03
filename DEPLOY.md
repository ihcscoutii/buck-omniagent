# Deploying Buck to Azure App Service

Hosting Buck on Azure gives a **permanent public URL**, so you no longer need a
tunnel (cloudflared/ngrok) — Napster's cloud calls your tools at the stable
Azure address. The app is a zero-dependency Node HTTP server that already reads
its config from environment variables and listens on `process.env.PORT`, so it
runs on App Service with no code changes.

> Target: **Azure App Service (Linux, Node 20)**. Not Static Web Apps — we need a
> long-running process for SSE and server-side token minting.

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
