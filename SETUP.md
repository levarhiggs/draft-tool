# Draft Tool — Setup Checklist

## 1. Google API Key (required for auto photo/video loading)

The app scans your Drive folders automatically, but needs a free Google API key to do it.

1. Go to https://console.cloud.google.com/
2. Create a project (or use an existing one)
3. Go to **APIs & Services → Library** → search "Google Drive API" → Enable it
4. Go to **APIs & Services → Credentials → Create Credentials → API Key**
5. Click **Restrict Key**:
   - Under **API restrictions** → select "Google Drive API" only
   - Under **Website restrictions** → add your GitHub Pages URL (e.g. `https://yourusername.github.io/*`)
6. Copy the key
7. Open `app.js` and replace `AIzaSyD-PLACEHOLDER` with your key

**Cost:** Free. The Drive API free quota is 1 billion requests/day — this app uses ~2 per page load.

---

## 2. Firebase Setup

1. Go to https://console.firebase.google.com/
2. Create a project → Add a web app → copy the config object
3. Paste the config into `firebase-config.js` (replace all the REPLACE_WITH_ values)
4. Go to **Firestore Database → Create database** (Start in test mode is fine)
5. Go to **Rules** tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /players/{id} {
      allow read, write: if true;
    }
  }
}
```

---

## 3. Google Drive Folders

- Photos folder ID: `1oJCTtCalNQTcQbMsZaOAa4VyAnJr35EV` (already in app.js)
- Videos folder ID: `1xJq9RH6DTvP3xsAwABlBzBqWw2NtX63q` (already in app.js)
- Name every photo file exactly as the player's ID: `101.jpg`, `102.jpg`, etc.
- Name every video file the same way: `101.mp4`, `102.mp4`, etc.
- Both folders must be shared: right-click folder → Share → Anyone with the link → Viewer

---

## 4. Google Sheets

- Sheet CSV URL is already set in `app.js`
- Column headers must match exactly:
  - `ID`, `Name`, `Age`, `Grade`, `Size (1-5)`, `Handles (1-5)`
  - `Coach Rank`, `Photo Path/Link`, `Video Path/Link`, `Team Assignment`, `Notes`
- The `Photo Path/Link` and `Video Path/Link` columns are optional overrides —
  leave them blank if files are named by player ID in Drive

---

## 5. Coach Config

- Open `coaches-config.js`
- Replace the placeholder coach names and PINs with your real coaching staff
- Update the `TEAMS` array with your actual team names (e.g. "Blue", "Red", "Gold")

---

## 6. GitHub Pages Deployment

1. Create a free account at https://github.com
2. Create a new repository named `draft-tool` (public)
3. Upload all files from this folder to the repo
4. Go to repo **Settings → Pages → Source → Deploy from branch → main → / (root)**
5. Your site will be live at: `https://yourusername.github.io/draft-tool/`
6. Share that URL with all coaches

---

## File Naming Quick Reference

| Player ID | Photo filename | Video filename |
|-----------|---------------|----------------|
| 101       | 101.jpg       | 101.mp4        |
| 102       | 102.png       | 102.mov        |
| 103       | 103.jpg       | 103.mp4        |

Any common image format works (jpg, png, webp). Any common video format works (mp4, mov, avi).
