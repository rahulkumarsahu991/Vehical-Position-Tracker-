/* =====================================================================
 * Daman Group — Vehicle Position Tracker · settings
 *
 * SHEET_ID / CALLING_GID: the Google Sheet and its "Calling Sheet" tab.
 *   The sheet must be shared as "Anyone with the link → Viewer"
 *   (the website reads the vehicles straight from it).
 *
 * APPS_SCRIPT_URL: after deploying Code.gs as a Web App, paste the
 *   "/exec" URL between the quotes. Left empty (""), programs given on
 *   the website are saved only in this browser (not shared with others).
 * ===================================================================== */
window.VPT_CONFIG = {
  COMPANY: "Daman Group",
  APP_NAME: "Vehicle Position Tracker",

  SHEET_ID: "1YpK_o9T-3SF_j8Z4hpMsukJDF5IFnDvfDZKPMLMZRLc",
  CALLING_GID: "211120940",

  // Fastest + freshest: read the Calling Sheet straight from the Fleet sheet (≈1 s, no IMPORTRANGE delay).
  // If that fails, the copy above (SHEET_ID / CALLING_GID) is used. DATE_ORDER: how that sheet writes dates.
  CALLING_SOURCE: { SHEET_ID: "1wgG2K9phHMQPvIskvXF1OBHxNHFk8pegrKCi0hvuF6U", GID: "855099761", DATE_ORDER: "DMY" },
  RH_GID: "853440745",      // R&H tab: repair date + reason for the Caller wise print

  // "Pending calls" button: caller-wise calls from the Dashboard tab of the Fleet sheet
  CALLS_SHEET_ID: "1wgG2K9phHMQPvIskvXF1OBHxNHFk8pegrKCi0hvuF6U",
  CALLS_GID: "1316490922",
  CALLS_REFRESH_SECONDS: 60,

  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwnifG3RsawGDBd7jYMywoNM75vWDlP6SgTRK_ceLdHr1tbhwX476fTyPoUeTJ1y53d/exec",

  REFRESH_SECONDS: 15,  // check the Google Sheet for changes every N seconds (live sync)
  PROGRAM_DAYS: 3,      // programs older than this are not shown

  // Names shown in "Who are you?" besides the callers found in the sheet
  EXTRA_USERS: ["Director", "Office"]
};
