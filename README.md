# What's On – London

A phone app (installable web app) listing concerts, theatre, football, classical music,
ballet and comedy in London and places within about two hours by train.

**App:** https://newbieoo7.github.io/london-events/

## How it works

- `fetch_events.py` collects events from Ticketmaster, Skiddle and football-data.org,
  groups repeat performances together, and writes `site/events.json`.
- `.github/workflows/update.yml` runs that every morning on GitHub and publishes the `site/`
  folder to GitHub Pages. It also runs whenever a change is pushed.
- `site/` is the app itself (`index.html`, `app.js`, `style.css`).
- The API keys are stored as GitHub secrets (Settings → Secrets and variables → Actions),
  never in the code.

## Common tweaks

- **Places covered:** edit the `AREAS` list at the top of `fetch_events.py`.
- **How far ahead:** `DAYS_AHEAD` in `fetch_events.py`.
- **Refresh now:** GitHub → Actions → "Update events" → Run workflow.
