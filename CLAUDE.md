# CLAUDE.md - Library Reservations

## Project Overview

A web-based library resource reservation/scheduling system. Staff use it to manage bookings for library rooms, equipment, and other resources. Built as a single-page application with vanilla JavaScript and Firebase (Firestore + Auth) as the backend.

**There is no build step or bundler.** The app runs directly as static files served to the browser. npm is used only for the dev-side test runner (Jest).

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JavaScript (no frameworks)
- **Backend:** Google Firebase (Firestore NoSQL database + Firebase Authentication)
- **External CDN dependencies loaded in index.html:**
  - Firebase SDK v8.10.1 (app, auth, firestore)
  - marked.js (Markdown rendering for sidebar)

## File Structure

```
app.js           (~5,950 lines)  - Application logic (DOM, Firebase, UI interactions)
utils.js         (~490 lines)    - Pure utility functions (testable, no DOM/Firebase deps)
utils.test.js    (~800 lines)    - Jest tests for utils.js
index.html       (~710 lines)    - HTML markup, 13 modals, UI structure
styles.css       (~1,275 lines)  - All styling, 5 color palettes
package.json                     - Dev dependencies (Jest only)
```

**`utils.js`** is a dual-mode file: it defines globals when loaded as a `<script>` tag in the browser, and exports via `module.exports` when required by Node/Jest. This is the place for all pure, testable logic. When adding new utility functions, put them here rather than in app.js.

## Architecture

### How It Works

1. User logs in with a shared password. The app authenticates via Firebase Auth using one of two hardcoded internal emails to determine the role (admin vs. staff/viewer).
2. The app loads the resource list from a single Firestore document (`system/resources`).
3. A real-time listener subscribes to the `appointments` collection, filtered by the current resource and date range.
4. The grid is rendered as DOM elements. Bookings are positioned as absolutely-positioned overlays on top of time-slot cells.
5. Users interact via drag-to-create, drag-to-move, resize handles, and modal forms.

### Authentication & Roles

- **Admin role:** email `staff@library.internal` - can edit all resources, access admin panel
- **Staff/Viewer role:** email `viewer@library.internal` - can edit non-admin-only resources, no admin panel access
- Login uses a Firebase account password (set on the accounts in the Firebase console), not a value in the source.
- The admin panel and delete-confirmation prompts are gated by the `ADMIN_PASS` constant in app.js — a **separate** client-side password from the login. This is a speed bump only: it ships in app.js and is readable in the browser.
- **Real access control is enforced server-side by Firestore Security Rules** (`firestore.rules`), which require authentication for all access and block destructive writes to `system/resources` (an empty/missing list is rejected). Never rely on client-side checks alone for security.

### Firestore Data Model

**`system/resources` (single document):**
```
{
  list: [
    {
      id: string,                    // e.g. "res-default"
      name: string,                  // display name
      viewMode: "week" | "day",      // grid layout mode
      hours: number[14],             // operating hours: [Sun_start, Sun_end, Mon_start, Mon_end, ...]
      maxDuration: number,           // max booking hours (e.g. 2)
      closuresByYear: {              // keyed by year string
        "2025": [{ start: "YYYY-MM-DD", end: "YYYY-MM-DD", reason: string }]
      },
      subRooms: [                    // only used when viewMode = "day"
        { name: string, active: boolean, _arrayIndex: number }
      ],
      colorPalette: string,          // "default" | "warm" | "slate" | "ocean" | "accessible"
      useQuarterHour: boolean,       // 15-min vs 30-min slots
      hasStaffField: boolean,        // enable staff assistance tracking
      defaultShowNotes: boolean,
      allowRecurring: boolean,
      advanceLimitEnabled: boolean,
      advanceLimitDays: number,
      advanceLimitAdminBypass: boolean,
      adminOnly: boolean,            // restrict to admin role
      cosmeticCloseMinutes: number,  // display closing time N minutes early (0 = disabled)
      enableSidebar: boolean,
      sidebarText: string            // Markdown content for info sidebar
    }
  ]
}
```

**`appointments` collection (one document per booking):**

Document ID format: `{resId}_{weekKey}_{dayIndex}_{startTime}` or `{resId}_{weekKey}_{dayIndex}_{startTime}_{subRoomIndex}`

- `weekKey`: formatted as `YYYY-M-D` (week start date, Sunday-based)
- `dayIndex`: 0-6 (Sunday=0 through Saturday=6)
- `startTime`: float (e.g. 10.5 = 10:30 AM)
- `subRoomIndex`: integer, only present for day-view resources with sub-rooms

```
{
  name: string,           // patron/event name
  duration: number,        // hours (e.g. 1.5)
  notes: string,
  showNotes: boolean,      // display notes on the grid
  hasStaff: boolean,
  staffName: string,       // only if hasStaff
  seriesId: string,        // only for recurring bookings, links the series
  createdAt: timestamp
}
```

**Important:** The booking document ID encodes its position (resource, week, day, time, sub-room). Moving a booking means deleting the old document and creating a new one with a different ID.

## app.js Section Map

The file is organized into labeled sections. Use these markers to navigate:

| Line | Section Marker | What It Contains |
|------|---------------|-----------------|
| ~1 | `// --- FIREBASE CONFIG ---` | Firebase initialization, auth constants |
| ~43 | `// --- STATE ---` | All global state variables (resources, bookings, drag/selection/resize state objects) |
| ~123 | `function init()` | Bootstrap: sets current week, auth state listener, date picker setup |
| ~163 | `// --- AUTH ACTIONS ---` | `doLogin()`, `doLogout()`, `canEditResource()`, `setupRealtimeListeners()` |
| ~217 | `// --- CORE LOGIC ---` | `loadBookingsForCurrentView()`, `handleResourceUpdate()`, navigation, `renderGrid()` |
| ~423 | `function renderGrid()` | Main grid rendering (~414 lines). Builds time slots, positions booking overlays, attaches event listeners |
| ~839 | `// --- CURRENT TIME INDICATOR ---` | Time indicator line for day view (`setupTimeIndicator`, `placeTimeIndicator`) |
| ~905 | `// --- DRAG-AND-DROP HANDLERS ---` | Moving existing bookings via drag. Includes validation, conflict checking, drop confirmation |
| ~1555 | `// --- DRAG-TO-CREATE HANDLERS ---` | Creating new bookings by clicking and dragging on empty slots |
| ~1946 | `// --- RESIZE HANDLERS ---` | Changing booking duration by dragging the bottom edge |
| ~2262 | `// --- RESCHEDULE MODE ---` | Multi-step rescheduling: enter mode, navigate to target day/week, click to place |
| ~2512 | `// --- MODAL & SAVE ---` | Booking modal form population, `saveBooking()`, `saveRecurringBooking()`, recurring pattern logic |
| ~3031 | `// --- ADMIN PANEL ---` | Admin settings UI, resource management, sub-room editing, staffing config |
| ~3420 | `// --- CLOSURE DATE MANAGEMENT ---` | Add/remove closure dates, year-based storage, apply closures across resources |
| ~3837 | `// --- STAFF NAME LIST MANAGEMENT ---` | Configure staff names per resource, apply across resources |
| ~4071 | `// --- NEW RESOURCE WITH IMPORT OPTION ---` | Creating resources with option to clone settings from existing ones |
| ~4261 | `async function deleteResource()` | Delete resource with password protection |
| ~4299 | `async function saveAllSettings()` | Main settings save, also triggers lazy janitor |
| ~4356 | `async function checkAndRunJanitor()` | Monthly check for old booking scrubbing (anonymization) |
| ~4501 | `// --- BOOKING POPOVER & HIGHLIGHTS ---` | Hover popover, highlighting, `deleteBooking()` with series-aware logic |
| ~4657 | `// --- UTILITY FUNCTIONS ---` | `closeModal()`, `createDiv()`, `showLoading()`, modal toggles, advance limit checking |
| ~4788 | `// --- STATS FUNCTIONS ---` | Statistics modal, heatmap, dashboard charts, CSV export (~1,160 lines to end of file) |

## Key Patterns & Conventions

### DOM Manipulation
- All UI is built with direct DOM manipulation (`document.createElement`, `innerHTML`).
- Modals are shown/hidden by toggling `style.display` between `'flex'` and `'none'`.
- The grid is fully re-rendered on every data change via `renderGrid()`.

### Data Flow
- Firestore real-time listeners (`onSnapshot`) update the in-memory `allBookings` map and trigger `renderGrid()`.
- Resources are stored in-memory in the `resources` array and synced to a single Firestore document.
- A `bookingVersion` counter prevents stale listener callbacks from overwriting newer data.

### Slot ID Convention
Slot IDs encode position: `{resId}_{weekKey}_{dayIndex}_{time}[_{subRoomIndex}]`. This is used both as Firestore document IDs and as HTML `data-slot-id` attributes. Many functions parse these IDs to extract day index, time, etc.

### State Objects
Three state objects track interactive operations:
- `dragState` - dragging an existing booking to a new slot
- `selectionState` - drag-to-create a new booking
- `resizeState` - dragging the bottom edge of a booking to change duration

Each follows the pattern: start handler sets state, move handler updates visuals, end handler shows confirmation or saves.

### Reschedule Mode
Distinct from drag-to-move. Allows navigating to a different week before placing a booking. Flow: enter reschedule mode → navigate to target date → click target slot → confirm. Managed by the `rescheduleMode` state object.

### Lazy Janitor (Anonymization)
`checkAndRunJanitor()` runs once per session when settings are saved. It scrubs old booking patron names based on `anonymityBufferMonths` (0–3 months). Processes in 500-document batches with cursor-based pagination and checkpoint tracking.

### Stats Caching
Multi-layer caching for statistics performance:
- **Session cache:** In-memory `statsBookingsCache` map with 5-minute TTL
- **Firestore cache:** Year and monthly cache documents created on-demand
- YTD calculations only include bookings up to today

### Error Handling
- Firestore operations are wrapped in try/catch with `showToast()` for error display.
- A loading overlay (`showLoading(true/false)`) is shown during saves.
- Navigation is debounced (150ms) to batch quick successive clicks.

### Time Representation
- Times are floats: 10.0 = 10:00 AM, 10.5 = 10:30 AM, 10.25 = 10:15 AM.
- Duration is also in float hours: 1.5 = 1 hour 30 minutes.
- `formatTime(val)` converts float to display string (e.g. "10:30am").

## Common Tasks

### Adding a new field to bookings
1. Add the field to the save logic in `saveBooking()` (around line ~2770)
2. Add it to the modal form in `index.html` inside `#bookingModal`
3. Populate it in `openBookingModal()` (around line ~2610)
4. If it should display on the grid, update the booking overlay rendering in `renderGrid()` (around line ~700+)
5. If it should appear in the popover, update `showBookingPopover()` (around line ~4520)
6. If it should appear in stats/CSV export, update `renderStatsChart()` and `exportStatsCSV()`

### Adding a new resource setting
1. Add the form control to the admin panel in `index.html` inside `#settingsOverlay`
2. Load the value in `loadSettingsForEditor()` (around line ~3140)
3. Save the value in `saveAllSettings()` (around line ~4299)
4. Use the setting where needed (typically in `renderGrid()` or `openBookingModal()`)

### Adding a new pure utility function
1. Add the function to `utils.js` in the appropriate section
2. Add it to the `module.exports` block at the bottom of `utils.js`
3. Write tests in `utils.test.js` and verify with `npm test`
4. The function is automatically available as a global in the browser (no import needed in app.js)

### Adding a new modal
1. Add the HTML markup in `index.html` following the existing modal pattern (class="modal" wrapper with class="modal-content" child)
2. Show it with `document.getElementById('myModal').style.display = 'flex'`
3. Hide it with `closeModal('myModal')`

## Testing

Run the test suite with:

```
npm test             # run all tests once
npm run test:watch   # re-run on file changes
npm run test:verbose # show individual test names
```

Tests cover the 24 pure utility functions in `utils.js` (99 tests across 24 test groups). After making changes to any utility function, run `npm test` to verify nothing is broken.

### What's tested

- Time/date formatting (`formatTime`, `formatDateISO`, `formatDateShort`, `getWeekKey`, `getWeekStart`, `getCurrentTimeFloat`, `formatCosmeticTime`)
- HTML escaping (`escapeHtml`)
- Slot ID parsing and construction (`parseSlotId`, `buildSlotId`, `normalizeSubIndex`)
- Closure date logic (`getClosureReason`, `migrateClosureDates`, `getClosuresForYear`, `getAllClosures`)
- Sub-room helpers (`getActiveSubRooms`, `migrateSubRooms`, `getSubRoomName`)
- Recurring date math (`getNthWeekdayOfMonth`, `getLastWeekdayOfMonth`)
- Booking anonymization (`isBookingAnonymized`, `isBookingLocked`)
- Conflict detection (`checkTimeConflict`)
- Staff name normalization (`normalizeStaffName`)

### Adding new tests

When adding a pure function to `utils.js`, add corresponding tests in `utils.test.js`. The pattern:
1. Add the function to `utils.js`
2. Add it to the `module.exports` block at the bottom of `utils.js`
3. Add it to the `require('./utils')` destructure at the top of `utils.test.js`
4. Write test cases in a new `describe()` block

### What's NOT tested

DOM-dependent code in `app.js` (grid rendering, drag handlers, modal logic, Firebase operations) is not unit tested. These are tested manually in the browser.

## Deployment

Static file hosting. No build step required. Just serve `index.html`, `utils.js`, `app.js`, and `styles.css`. The `node_modules/`, `package.json`, and test files are dev-only.
