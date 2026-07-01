# Library Reservations

A web-based library resource reservation and scheduling system. Staff use it to manage bookings for library rooms, equipment, and other resources through an interactive calendar grid.

## Features

### Booking Management
- **Drag-to-create** bookings by clicking and dragging on empty time slots
- **Drag-to-move** existing bookings to new time slots with conflict validation
- **Resize** bookings by dragging the bottom edge to change duration
- **Reschedule mode** for moving bookings across different weeks
- **Recurring bookings** with patterns: weekly, biweekly, monthly (by date, weekday, or last occurrence), custom interval, and manual date selection
- **Series-aware deletion** (delete single occurrence or entire series)
- **Staff assistance tracking** with per-resource staff name lists

### Calendar Views
- **Week view** showing 7-day calendar with time slots
- **Day view** with multiple sub-rooms displayed as columns
- **Quarter-hour slots** (15-min) or standard 30-minute slots per resource
- **Current time indicator** (red line in day view)
- **Info sidebar** with Markdown-rendered instructions per resource

### Administration
- **Resource management** (create, delete, clone settings between resources)
- **Operating hours** configurable per day of week
- **Closure dates** with date ranges, reasons, and bulk-apply across resources
- **Sub-room management** with drag-to-reorder, activate/deactivate
- **Advance booking limits** with optional admin bypass
- **5 color palettes** (default, warm, slate, ocean, accessible)
- **Patron anonymization** with configurable buffer (0-3 months), automated lazy janitor cleanup
- **Admin-only resources** restricted by role

### Statistics & Reporting
- **Heatmap calendar** showing daily hours booked across the year
- **Dashboard charts**: utilization ring, duration distribution, room distribution, weekly/monthly usage bars
- **Weekly rhythm heatmap** (day-of-week x hour-of-day)
- **Staff assistance breakdown** by month
- **CSV export** with daily, monthly, hourly, and staff data
- **Multi-layer caching** for stats performance (in-memory session cache + Firestore year/month caches)

### Authentication
- Two roles: **Admin** (full access) and **Staff/Viewer** (limited)
- Shared password authentication via Firebase Auth
- Admin panel protected by additional password prompt

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JavaScript (no frameworks, no build step)
- **Backend:** Google Firebase (Firestore + Firebase Authentication)
- **CDN Dependencies:**
  - Firebase SDK v8.10.1 (app, auth, firestore)
  - marked.js (Markdown rendering)
- **Testing:** Jest v29

## Project Structure

```
app.js           (~6,300 lines)  - Application logic (DOM, Firebase, UI interactions)
utils.js         (~540 lines)    - Pure utility functions (testable, no DOM/Firebase deps)
utils.test.js    (~870 lines)    - Jest unit tests for utils.js
index.html       (~720 lines)    - HTML markup, ~15 modal/overlay dialogs, UI structure
styles.css       (~1,270 lines)  - All styling (layout, grid, modals, components)
package.json                     - Dev dependencies (Jest only)
CLAUDE.md                        - Detailed developer documentation
```

(Line counts are approximate; run `wc -l` for current values. The color palettes are defined in `app.js` as the `COLOR_PALETTES` object, not in `styles.css`.)

## Getting Started

### Prerequisites
- A web server to serve static files (or open `index.html` directly)
- A Firebase project with Firestore and Authentication enabled
- Node.js (only needed for running tests)

### Setup
1. Clone the repository
2. Configure your Firebase project credentials in `app.js` (the `// --- FIREBASE CONFIG ---` section)
3. Set up Firebase Authentication with email/password sign-in
4. Serve the static files (`index.html`, `app.js`, `utils.js`, `styles.css`)

### Running Tests
```bash
npm install          # install Jest (dev dependency only)
npm test             # run all tests once
npm run test:watch   # re-run on file changes
npm run test:verbose # show individual test names
```

## Deployment

Static file hosting. No build step required. Serve `index.html`, `utils.js`, `app.js`, and `styles.css`. The `node_modules/`, `package.json`, and test files are dev-only and should not be deployed.

## Documentation

See [CLAUDE.md](CLAUDE.md) for detailed developer documentation including:
- Architecture and data flow
- Firestore data model
- app.js section map for navigation
- Code patterns and conventions
- Common tasks (adding fields, settings, modals, utilities)
