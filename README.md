# Daman Group — Vehicle Position Tracker

Website that shows **where every vehicle is and what it is doing**, live from the
Google Sheet tab **Calling Sheet**, caller wise.

| Screen | What it does |
|---|---|
| **Board** | All vehicles with caller chips (Sandhya, Renuka, Tanisha, Kiran, Manshi…), status tiles (Loading, Unloading, Running, Empty Running, No Program, Repair, Halted / No Driver, Load / No Driver, Emergency, Others), search, filters (location, item, program, late, follow-up due, not called today). View by status, location, caller or as a table. Tap a vehicle → full details, call / WhatsApp driver. |
| **Programs** | No Program + Unloading vehicles. **Director** writes the program (where to go / load from, broker). **Caller** calls the driver and taps **"Driver ko bataya? → Yes, told"**. |
| **Route** | Every route (From → To) as a road with its vehicles as little trucks labelled BA42 / AX31 (colour = status, Repair red; on phones the road runs top to bottom): at the loading point, on the way (one stop per current location, spellings merged, e.g. "MANPUR ×3", in the order a truck from A meets them — Vizag → Vizianagaram → Pottangi → Koraput → Jagdalpur — with about how many km from A; a place far off the way says, red and blinking, "⚠ Current location galat hai" — check that truck's current location in the Calling Sheet) or at the unloading point — a vehicle that has reached A or B (status Loading / Unloading, or its current location is that place) stands right on that pin, not before it. Count per route and per status, search, a colour guide under every route, tap a status to show only it; hover a vehicle (tap on a phone) for a small window with its details. Moving road line, dots pop in, running vehicles pulse. The sheet has no distances / GPS, so the place on the road comes from the status and current location. |
| **Hub Analyzer** | Pick a hub. **Loading point** (e.g. KONSARI): empty trucks coming to load and where they are now (an empty truck's From = the loading point it is heading to; trucks with a program to the place count too), trucks loading there now, and where the loaded trucks are going (by To). **Unloading point** (e.g. SHREE CEMENT): loaded trucks on the way and where they loaded, trucks unloading now, and where they go after (empty trucks' next loading point, next-load programs). One short flow: coming-from places (left) → hub box (middle) → going-to places (right), slim yellow / pink rows with a status bar and count, elbow lines with arrows; under every place a small **now** line says where those trucks are right now (e.g. "now KORAPUT ×3 · reached ×5"), and every truck shows its current location (📍 KORAPUT, green "reached" / "at hub"); tap a place for its trucks, tap the hub for the trucks there, busiest 7 then "+ N more". Phones: top to bottom, places 2 per line, with animated lines (moving dots) joining the places into the hub and forking out of it. Spellings that differ only in vowels (VIZIANAGRAM / VIZIANAGARAM) count as one place. |
| **Map** (Route: Road / Map · Hub: Flow / Map) | The same trucks on a real map (free, no key). Background: the **clean map** from OpenFreeMap (free, no key, no limits, commercial use allowed; drawn by MapLibre — "Loading the map…" the first few seconds; a phone without WebGL gets OpenStreetMap's plain tiles). ⛶ shows the map full screen (back button / Esc closes it). Layers button: Trucks now / Route lines on or off. Route: every route along its **real road** (like Google Maps, from OSRM — OpenStreetMap's free route finder; `roads.js` + looked up once per new pair) with running white dashes (the way the trucks go), A / B pins; pick a **Point** (loading / unloading point — or tap its pin → "Show every route to / from here") to light up every road coming to it (blue, with a km / truck-time box on each — loaded trucks on routes ending there, and for a loading point the empty trucks driving there to load, from where they are now) and going out from it (green), the rest greyed; or pick a route (or tap its line) to see it alone: thick blue road, Google-style pins (A orange, B red) and a box with **km and truck time** (≈ 1.4 × car time, at most 45 km/h on average); trucks at their **current location**, moved onto their own route's road when the town is on it (one truck = lorry + number, more = a ring in their status colours with the count; nearby towns merge when zoomed out and split when zoomed in). Hub: places they come from → hub box → places they go to along the roads, every road lit up (thick, dark edge, running dashes) with a km / truck-time box on the busiest roads coming in and the km on every place, plus the trucks where they are now. A truck standing away from every road on the map gets its own road from where it is now to where it goes (to the hub / its To / the loading point it heads to), thinner, with the time box when it is coming in — no truck floats alone. Tap a number for its trucks, tap a truck for full details. The sheet has town names, not GPS: where each place is comes from `places.js` (add / fix a place there); a new name is looked up once on OpenStreetMap and listed under the map as "found by itself" to check; unknown places (OFFICE, DM AGRO…) are listed under the map too. |
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
- `places.js` — where each place is on the map (latitude, longitude)
- `roads.js` — the real roads between places for the map (made once; new ones are looked up by the website)
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
