# Draft Tool — Setup Checklist

## 1. Google API Key ✅
- Key is set in `app.js`
- Referrer restriction added: `https://levarhiggs.github.io/*`

---

## 2. Firebase Setup ✅
- Config is set in `firebase-config.js`
- Project: `csbc-2026-summer-draft`

**Firestore rules now live in `firestore.rules` and deploy from the CLI.**

    firebase deploy --only firestore:rules

That file is the source of truth — a deploy OVERWRITES the Console, so never
edit rules there without copying the change back, or the next deploy silently
reverts it.

⚠ **The rule list that used to be printed here was incomplete and dangerous.**
It named only `players`, `coaches`, `scheduleGames` and `rotationConfigs`.
Probing production on 2026-09-20 found `liveStatLogs` (9 docs) and
`gameLogNotes` (4 docs) also had live rules that were never written down —
deploying from this doc's old list would have DELETED them and silently broken
Gameboard's Live Stat mode. It also found `gameboardGhosts` has **no** rule
despite `saveGameboardGhosts()` writing to it, so that feature has been failing
silently; `firestore.rules` now adds it.

See the comments in `firestore.rules` for what each collection holds.

---

## 3. Google Drive Folders ✅
- Photos folder ID: `1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV`
- Videos folder ID: `1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q`
- Name every photo file as the player's ID: `101.jpg`, `102.jpg`, etc.
- Name every video file the same way: `101.mp4`, `102.mp4`, etc.
- Both folders must be shared: right-click → Share → Anyone with the link → Viewer

---

## 4. Google Sheets ✅
- CSV URL is set in `app.js`
- Column headers must match exactly:
  - `ID`, `Name`, `Age`, `Grade`, `Size (1-5)`, `Handles (1-5)`
  - `Coach Rank`, `Photo Path/Link`, `Video Path/Link`, `Team Assignment`, `Notes`
- `Photo Path/Link` and `Video Path/Link` are optional — leave blank if files are named by player ID

---

## 5. Coach Config
- Edit `coaches-config.js` to update coach names, PINs, and team names

---

## 6. GitHub Pages ✅
- Site is live at: https://levarhiggs.github.io/draft-tool/
- To update the site: upload changed files via github.com or push via GitHub Desktop

---

## File Naming Quick Reference

| Player ID | Photo filename | Video filename |
|-----------|---------------|----------------|
| 101       | 101.jpg       | 101.mp4        |
| 102       | 102.png       | 102.mov        |
| 103       | 103.jpg       | 103.mp4        |

Any common image format works (jpg, png, webp). Any common video format works (mp4, mov, avi).
