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

## Notes on the free plan

- Render's free web services **spin down after 15 minutes of no traffic** and take ~30–60
  seconds to wake back up on the next visit. That's normal, not a bug.
- Free plan storage is **ephemeral** — if Render restarts the container, both properties' data
  resets back to the imported 13-month seed on next boot. For anything you actually rely on day to
  day, upgrade to a paid instance with a persistent disk (a few dollars/month) - then the app
  remembers new readings and bills you capture between restarts.
- If you outgrow SQLite (e.g. once several people are using this at once), Render also offers a
  free PostgreSQL instance you can switch to later — ask me and I'll wire it up.

## If you'd rather I drive this with you live

If you install the Claude in Chrome extension and connect it to this conversation, I can click
through the GitHub/Render screens with you in real time instead of you following steps here -
just say the word.
