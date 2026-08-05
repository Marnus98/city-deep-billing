# Getting a live URL — 5 minutes, no coding, no credit card

I can't create hosting accounts on your behalf (that needs your own login), but this is genuinely
short. No git command line needed — everything below is clicking in a browser.

## Step 1 — Put the code on GitHub (2 min)

1. Go to https://github.com/new (sign up first if you don't have an account — free).
2. Repository name: `city-deep-billing` &rarr; Create repository (leave it empty, public or private, either is fine).
3. On the new repo's page, click **"uploading an existing file"**.
4. Drag in every file from this `city-deep-billing-app` folder (not the `data` folder — that gets
   created automatically) and click **Commit changes**.

## Step 2 — Deploy on Render (3 min)

1. Go to https://render.com &rarr; sign up free (you can sign up directly with your GitHub account,
   which also connects them automatically).
2. Click **New +** &rarr; **Blueprint**.
3. Pick the `city-deep-billing` repo you just created. Render will read the included
   `render.yaml` and configure everything itself (Node web service, free plan, start command).
4. Click **Apply** / **Deploy**. First deploy takes 1–2 minutes.
5. When it's done, Render gives you a URL like `https://holmstone-utility-management-platform.onrender.com`
   — that's your live app. Both properties' databases seed themselves automatically on first boot
   (13 months each, July 2025 - July 2026) — City Deep Industrial Park and Wingfield Business
   Park, switchable from the dropdown on the Dashboard.

Sign in with `admin` / `admin123` (see README for all 4 demo logins) — **change these passwords
first thing**, there's no edit-user screen yet so for now that means editing the `seedUsers()`
list in `seed.js`, committing, and letting Render redeploy.

## Notes on persistence (read this if you're relying on the live site day to day)

`render.yaml` is currently on `plan: free`, which means Render's filesystem - including the SQLite
files under `data/` - is **ephemeral**: it resets on every deploy, *and* separately whenever a free
service spins down from 15 minutes of inactivity and wakes back up. So anything typed into the live
app (readings, edited water/sewer values, new billing slips) beyond what a seed/import script
reproduces can vanish at any time, not just when I push an update. The seed/import scripts
(`seed.js`, `import_history.js`, etc.) are the safety net in the meantime - whenever you tell me
about data you've entered manually, I fold it back into one of those scripts so a filesystem reset
regenerates it instead of losing it, but that only works for what you've told me about.

**When you're ready to go live for real, switch to a persistent disk:**

1. In `render.yaml`, change `plan: free` to `plan: starter`, and add this block at the same
   indentation level as `plan:` (right before `envVars:`):
   ```yaml
   disk:
     name: holmstone-data
     mountPath: /opt/render/project/src/data
     sizeGB: 1
   ```
2. Push to GitHub as usual.
3. Render usually needs a manual nudge for plan/billing changes on an existing service - open the
   service in the Render dashboard. If the Starter plan + disk aren't picked up automatically from
   the Blueprint sync, go to **Settings → Instance Type** and switch to **Starter**, then
   **Disks → Add Disk** with mount path `/opt/render/project/src/data` and size `1 GB`.
4. Redeploy. From this point on, the `data/` folder survives deploys and spin-downs - only a full
   disk delete (not something you'd do by accident) wipes it.

Cost: Starter is ~$7/month, the 1GB disk is ~$0.25/month. Just ask and I'll make this change for
you when you're ready - it's a 5-minute edit.

If you outgrow SQLite (e.g. once several people are using this at once), Render also offers a
free PostgreSQL instance you can switch to later — ask me and I'll wire it up.

## If you'd rather I drive this with you live

If you install the Claude in Chrome extension and connect it to this conversation, I can click
through the GitHub/Render screens with you in real time instead of you following steps here -
just say the word.
