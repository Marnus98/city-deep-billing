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

**Update 2026-09-28: this is now live.** The service is on `plan: starter` with a 2GB persistent
disk mounted at `/var/data` (added via the Render dashboard's Disks tab, since Render doesn't offer
disks below Starter), and a `DATA_DIR=/var/data` environment variable so the app actually writes its
SQLite files there instead of its own ephemeral folder - `db.js` defaults to `./data` (reset on every
deploy and spin-down) unless `DATA_DIR` is set. Both are reflected in `render.yaml` now, so a fresh
Blueprint deploy reproduces the same setup.

Render doesn't allow changing a disk's mount path after creation (only its size), which is why
`DATA_DIR` points at `/var/data` specifically rather than the app's own `data/` folder path - no
need to delete and recreate the disk, the env var does the job either way.

One consequence worth knowing: the disk started out empty, so the very first boot after this change
re-ran every property's initial seed from scratch (expected, one-time). From here on, the `data/`
folder equivalent (`/var/data`) survives deploys and spin-downs - only a full disk delete (not
something you'd do by accident) wipes it. Anything typed into the live app from now on (readings,
edited tariffs, new billing slips) sticks.

If you ever need to bump the disk size, that's **Disks → Edit** in the Render dashboard (disks can
only grow, never shrink) - update the `sizeGB` in `render.yaml` to match afterward so they don't
drift apart.

If you outgrow SQLite (e.g. once several people are using this at once), Render also offers a
free PostgreSQL instance you can switch to later — ask me and I'll wire it up.

## If you'd rather I drive this with you live

If you install the Claude in Chrome extension and connect it to this conversation, I can click
through the GitHub/Render screens with you in real time instead of you following steps here -
just say the word.
