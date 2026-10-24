# Daman Group — Vehicle Position Tracker

Website that shows **where every vehicle is and what it is doing**, live from the
Google Sheet tab **Calling Sheet**, caller wise.

| Screen | What it does |
|---|---|
| **Board** | All vehicles with caller chips (Sandhya, Renuka, Tanisha, Kiran, Manshi…), status tiles (Loading, Unloading, Running, Empty Running, No Program, Repair, Halted / No Driver, Load / No Driver, Emergency, Others), search, filters (location, item, program, late, follow-up due, not called today). View by status, location, caller or as a table. Tap a vehicle → full details, call / WhatsApp driver. |
| **Programs** | No Program + Unloading vehicles. **Director** writes the program (where to go / load from, broker). **Caller** calls the driver and taps **"Driver ko bataya? → Yes, told"**. |
| **Route** | Every route (From → To) as a road with its vehicles as coloured dots (colour = status, Repair red): at the loading point, on the way (grouped by current location, e.g. "MANPUR ×3") or at the unloading point. Count per route and per status, search, a colour guide under every route, tap a status to show only it; hover a vehicle (tap on a phone) for a small window with its details. Moving road line, dots pop in, running vehicles pulse. The sheet has no distances / GPS, so the place on the road comes from the status and current location. |
| **Print** | One page each: **Caller wise** (same layout as the sheet's **printf** tab, one page per caller; repair dates from R&H), **U&N**, **L&R** (2 pages: Loading · Running + Empty Running), **R&H** (all callers, for the Director). Text size shrinks automatically to fit one A4 page. Programs given on the website appear in the "Next Load" column (✓ = driver informed). |

**Live sync:** the site reads the Calling Sheet straight from the Fleet sheet (`CALLING_SOURCE` in `config.js`, about 1 second; the copy is the fallback) every 15 seconds (`REFRESH_SECONDS` in `config.js`),
and right away when the page is opened again. Whatever changes in the sheet shows on the site by itself —
changed vehicles flash and get an **"Updated 3:20 PM"** tag for 3 minutes (filter: *Show only → Just updated*).
The green dot next to **Live** in the header means it is connected; click it to check immediately.
Programs given by one user reach everybody else within ~10–20 seconds (they flash and a note pops up).

**Pending calls** button (top of every page): caller-wise Calls done / Pending / Morning / Evening from the
**Dashboard** tab of the Fleet sheet (`CALLS_SHEET_ID` / `CALLS_GID` in `config.js`, checked every minute).
It blinks red while any call is pending; callers with pending calls blink in the list.

**Director → Manager → Caller** (Inbox 🔔 button, `FLOW` in `config.js` / `CONFIG.FLOW` in Code.gs):
a program or remark the **Director** gives goes to the **Manager** first (tab *With Manager*; the caller does not
see it yet). The Manager taps **Send to <caller>** (or *Send all*) and the vehicle's caller gets it; the Manager's
own programs / remarks go straight to the caller, and the Director's remark goes along when the Manager sends. The Director can also skip the Manager with **Direct → <caller>** (card, With Manager card, bulk bar). Whoever it is for taps **Dekh liya ✓**; the sender sees
"✓ Seen 10:42". Kept in the **Messages** tab. The Inbox blinks red while something is unseen; new ones pop up,
buzz the phone and (if alerts are turned on) show a phone alert.

**Login:** pick your name, tap your PIN on the keypad. On a phone that logged in before, the name shows
"⚡ Quick login" and opens at once on the last digit (Google confirms it in the background).
*Switch user* lets the next person log in; *Log out from this phone* forgets the quick login.

The website **only reads** the Calling Sheet — it never changes it.
Programs are saved in a separate tab **Programs** (made by Code.gs), one row per vehicle per day.
After running **linkPrintSheets** once (Apps Script editor), the sheet's own **U&N** tab shows them too
("Next Load" and "Broker" columns, ✓ = driver informed) via a small helper tab **Next Load**.

## Files
- `index.html`, `styles.css`, `app.js` — the website
- `config.js` — settings (Sheet ID, Calling Sheet gid, Apps Script URL, refresh time)
- `Code.gs` — Google Apps Script backend that saves the programs
- `logo.webp` — company logo
- `sw.js` — keeps a copy of the site on the phone so it opens at once on slow internet (sheet data is always live)
- `.server/serve.ps1` — local preview server

## Setup (one time) — so everyone shares the programs
Until this is done the site works, but programs are saved only in the browser where they were typed.

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Delete the sample code, paste all of `Code.gs`, **Save**.
3. Pick the function **setup** → **▶ Run** → allow permissions. (Creates the "Programs" tab.)
4. **Deploy → New deployment → Web app** — Execute as: **Me**, Who has access: **Anyone** → Deploy.
5. Copy the Web app URL (ends with `/exec`) into `config.js` → `APPS_SCRIPT_URL`.

The Google Sheet must stay shared as **Anyone with the link → Viewer** (the site reads it directly).

## Run on this computer
Double-clicking `index.html` does **not** work (Google blocks file:// pages). Run:

```
powershell -ExecutionPolicy Bypass -File ".server\serve.ps1"
```
then open http://localhost:8790/

For phones, put the folder on a web host (GitHub Pages / Vercel) — static files only, no build step.
