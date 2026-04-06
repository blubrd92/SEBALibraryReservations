// --- SHARED UTILITY FUNCTIONS ---
// Pure functions extracted from app.js for testability.
// Loaded as a <script> tag in the browser (defines globals) and as a
// CommonJS module in Node (for Jest tests).

// ============================================================
// TIME & DATE FORMATTING
// ============================================================

/**
 * Convert a float hour value to a display string.
 * Examples: 10.0 → "10:00am", 10.5 → "10:30am", 13.25 → "1:15pm"
 */
function formatTime(val) {
    const h = Math.floor(val);
    const frac = val % 1;
    let m;
    if (frac === 0) m = '00';
    else if (frac === 0.25) m = '15';
    else if (frac === 0.5) m = '30';
    else if (frac === 0.75) m = '45';
    else m = String(Math.round(frac * 60)).padStart(2, '0');
    const suffix = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    return `${h12}:${m}${suffix}`;
}

/**
 * Format a Date as "YYYY-MM-DD" for ISO string comparisons.
 */
function formatDateISO(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Format a Date as a short "M/D" display string.
 */
function formatDateShort(d) {
    return (d.getMonth() + 1) + "/" + d.getDate();
}

/**
 * Get the week key for a date (the Sunday that starts the week).
 * Returns a string like "YYYY-MM-DD" with zero-padded month/day.
 */
function getWeekKey(d) {
    const d2 = new Date(d);
    const day = d2.getDay();
    const diff = d2.getDate() - day;
    const s = new Date(d2.setDate(diff));
    return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
}

/**
 * Get the Date object for the Sunday that starts the week containing `date`.
 */
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day;
    return new Date(d.setDate(diff));
}

// ============================================================
// STRING UTILITIES
// ============================================================

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ============================================================
// SLOT ID UTILITIES
// ============================================================

/**
 * Normalize a sub-room index value from a slot ID part.
 * Handles null, undefined, empty string, and the strings "null"/"undefined".
 * Returns null or a parsed integer.
 */
function normalizeSubIndex(val) {
    if (val === null || val === undefined || val === '' || val === 'null' || val === 'undefined') {
        return null;
    }
    return parseInt(val);
}

/**
 * Parse a slot ID into its component parts.
 * Slot ID format: "{resId}_{weekKey}_{dayIndex}_{startTime}[_{subRoomIndex}]"
 *
 * @param {string} slotId - The full slot ID string
 * @param {string} resId  - The resource ID prefix to strip
 * @returns {{ weekKey: string, dayIndex: number, startTime: number, subRoomIndex: number|null }}
 */
function parseSlotId(slotId, resId) {
    const prefix = resId + "_";
    const suffix = slotId.substring(prefix.length);
    const parts = suffix.split('_');
    return {
        weekKey: parts[0],
        dayIndex: parseInt(parts[1]),
        startTime: parseFloat(parts[2]),
        subRoomIndex: normalizeSubIndex(parts[3])
    };
}

/**
 * Build a slot ID string from component parts.
 */
function buildSlotId(resId, weekKey, dayIndex, startTime, subRoomIndex) {
    let id = `${resId}_${weekKey}_${dayIndex}_${startTime}`;
    if (subRoomIndex !== null && subRoomIndex !== undefined) {
        id += `_${subRoomIndex}`;
    }
    return id;
}

// ============================================================
// CLOSURE DATE HELPERS
// ============================================================

/**
 * Check if a date is a closure date for the given resource.
 * Returns the closure reason string if closed, or null if open.
 *
 * @param {object} res  - Resource object with closuresByYear (and optionally legacy closureDates)
 * @param {Date}   date - The date to check
 * @returns {string|null}
 */
function getClosureReason(res, date) {
    const dateStr = formatDateISO(date);
    const year = String(date.getFullYear());

    // Check closuresByYear (new format)
    if (res.closuresByYear) {
        // Check the date's year and prior year (for ranges spanning year boundaries)
        const yearsToCheck = [String(parseInt(year) - 1), year];
        for (const y of yearsToCheck) {
            const closures = res.closuresByYear[y];
            if (!closures || !Array.isArray(closures)) continue;
            for (const closure of closures) {
                if (!closure.endDate) {
                    if (closure.date === dateStr) return closure.reason;
                } else {
                    if (dateStr >= closure.date && dateStr <= closure.endDate) return closure.reason;
                }
            }
        }
    }

    // Fallback: check legacy closureDates array (pre-migration)
    if (res.closureDates && Array.isArray(res.closureDates)) {
        for (const closure of res.closureDates) {
            if (!closure.endDate) {
                if (closure.date === dateStr) return closure.reason;
            } else {
                if (dateStr >= closure.date && dateStr <= closure.endDate) return closure.reason;
            }
        }
    }

    return null;
}

/**
 * Migrate legacy closureDates array to closuresByYear format.
 * Mutates the resource object. Returns true if migration occurred.
 */
function migrateClosureDates(res) {
    if (res.closureDates && Array.isArray(res.closureDates) && res.closureDates.length > 0) {
        if (!res.closuresByYear) res.closuresByYear = {};
        res.closureDates.forEach(c => {
            const year = c.date.substring(0, 4);
            if (!res.closuresByYear[year]) res.closuresByYear[year] = [];
            // Avoid duplicates
            if (!res.closuresByYear[year].some(existing => existing.date === c.date && existing.endDate === c.endDate)) {
                res.closuresByYear[year].push({ ...c });
            }
        });
        delete res.closureDates;
        return true;
    }
    if (!res.closuresByYear) res.closuresByYear = {};
    return false;
}

/**
 * Get all closures for a specific year from a resource.
 */
function getClosuresForYear(res, year) {
    if (!res.closuresByYear) return [];
    return res.closuresByYear[String(year)] || [];
}

/**
 * Get all closures across all years (flat list).
 */
function getAllClosures(res) {
    if (!res.closuresByYear) return [];
    let all = [];
    Object.values(res.closuresByYear).forEach(yearClosures => {
        all = all.concat(yearClosures);
    });
    return all;
}

// ============================================================
// SUB-ROOM HELPERS
// ============================================================

/**
 * Migrate legacy comma-separated subRooms string to array of objects.
 * Mutates the resource object. Returns true if migration occurred.
 *
 * Note: Uses Date.now() for ID generation, so output IDs are non-deterministic.
 */
function migrateSubRooms(res) {
    if (typeof res.subRooms === 'string' && res.subRooms.trim()) {
        const names = res.subRooms.split(',').map(s => s.trim()).filter(s => s);
        res.subRooms = names.map((name, idx) => ({
            id: 'sr-' + Date.now().toString(36) + idx,
            name: name,
            active: true,
            displayOrder: idx
        }));
        return true;
    }
    if (!res.subRooms || res.subRooms === '') {
        res.subRooms = [];
    }
    return false;
}

/**
 * Get active sub-rooms sorted by displayOrder.
 * Returns array with _arrayIndex added to each sub-room.
 */
function getActiveSubRooms(res) {
    if (!Array.isArray(res.subRooms) || res.subRooms.length === 0) return [];
    return res.subRooms
        .map((sr, idx) => ({ ...sr, _arrayIndex: idx }))
        .filter(sr => sr.active !== false)
        .sort((a, b) => (a.displayOrder ?? a._arrayIndex) - (b.displayOrder ?? b._arrayIndex));
}

/**
 * Get sub-room name by array index. Falls back to "Room N" if not found.
 */
function getSubRoomName(res, arrayIndex) {
    if (!Array.isArray(res.subRooms)) return 'Room ' + (arrayIndex + 1);
    const sr = res.subRooms[arrayIndex];
    return sr ? sr.name : 'Room ' + (arrayIndex + 1);
}

// ============================================================
// RECURRING BOOKING DATE HELPERS
// ============================================================

/**
 * Get the Nth occurrence of a weekday in a month (1-indexed N).
 * Returns null if that occurrence doesn't exist (e.g., 5th Wednesday).
 *
 * @param {number} year    - Full year (e.g. 2025)
 * @param {number} month   - 0-indexed month (0=January)
 * @param {number} weekday - Day of week (0=Sunday, 6=Saturday)
 * @param {number} n       - Which occurrence (1=first, 2=second, etc.)
 * @returns {Date|null}
 */
function getNthWeekdayOfMonth(year, month, weekday, n) {
    const first = new Date(year, month, 1);
    let dayOffset = weekday - first.getDay();
    if (dayOffset < 0) dayOffset += 7;
    const firstOccurrence = 1 + dayOffset;
    const target = firstOccurrence + (n - 1) * 7;
    const result = new Date(year, month, target);
    if (result.getMonth() !== month) return null;
    return result;
}

/**
 * Get the last occurrence of a weekday in a month.
 *
 * @param {number} year    - Full year (e.g. 2025)
 * @param {number} month   - 0-indexed month (0=January)
 * @param {number} weekday - Day of week (0=Sunday, 6=Saturday)
 * @returns {Date}
 */
function getLastWeekdayOfMonth(year, month, weekday) {
    const lastDay = new Date(year, month + 1, 0);
    let dayOffset = lastDay.getDay() - weekday;
    if (dayOffset < 0) dayOffset += 7;
    return new Date(year, month, lastDay.getDate() - dayOffset);
}

// ============================================================
// BOOKING ANONYMIZATION
// ============================================================

/**
 * Determine if a booking should be locked (read-only).
 * Day view: lock bookings before today.
 * Week view: lock bookings before the current week's Sunday.
 *
 * @param {string} weekKey  - Week key string "YYYY-M-D"
 * @param {number} dayIndex - Day index 0-6
 * @param {object} res      - Resource object (needs viewMode)
 * @param {Date}   [today]  - Override "today" for testing (defaults to new Date())
 * @returns {boolean}
 */
function isBookingLocked(weekKey, dayIndex, res, today) {
    const [y, m, d] = weekKey.split('-').map(Number);
    const bookingDate = new Date(y, m - 1, d);
    bookingDate.setDate(bookingDate.getDate() + dayIndex);
    bookingDate.setHours(0, 0, 0, 0);

    if (!today) today = new Date();
    today = new Date(today);
    today.setHours(0, 0, 0, 0);

    if (res.viewMode === 'day') {
        return bookingDate < today;
    } else {
        const day = today.getDay();
        const thisWeekStart = new Date(today);
        thisWeekStart.setDate(today.getDate() - day);
        return bookingDate < thisWeekStart;
    }
}

/**
 * Determine if a booking should be anonymized (past data privacy).
 * Checks the anonymityBufferMonths setting.
 *
 * @param {string} weekKey  - Week key string "YYYY-M-D"
 * @param {number} dayIndex - Day index 0-6
 * @param {object} res      - Resource object (needs viewMode and anonymityBufferMonths)
 * @param {Date}   [today]  - Override "today" for testing (defaults to new Date())
 * @returns {boolean}
 */
function isBookingAnonymized(weekKey, dayIndex, res, today) {
    const buffer = parseInt(res.anonymityBufferMonths || 0, 10);
    if (buffer === 0) {
        return isBookingLocked(weekKey, dayIndex, res, today);
    }

    const [y, m, d] = weekKey.split('-').map(Number);
    const bookingDate = new Date(y, m - 1, d);
    bookingDate.setDate(bookingDate.getDate() + dayIndex);
    bookingDate.setHours(0, 0, 0, 0);

    if (!today) today = new Date();
    today = new Date(today);
    today.setHours(0, 0, 0, 0);

    const cutoffDate = new Date(today.getFullYear(), today.getMonth() - buffer, 1);
    return bookingDate < cutoffDate;
}

// ============================================================
// CONFLICT DETECTION
// ============================================================

/**
 * Check if a proposed booking time conflicts with existing bookings.
 * Pure function - takes all needed data as arguments.
 *
 * @param {number} startTime   - Proposed start time (float hours)
 * @param {number} duration    - Proposed duration (float hours)
 * @param {number} dayIndex    - Day index (0-6)
 * @param {number|null} subRoomIndex - Sub-room index or null
 * @param {object} allBookings - Map of slotId → booking data
 * @param {string} resId       - Resource ID
 * @param {string} weekKey     - Week key string
 * @param {string} [excludeSlotId] - Slot ID to exclude (for editing existing bookings)
 * @returns {{ hasConflict: boolean, conflictingId?: string }}
 */
function checkTimeConflict(startTime, duration, dayIndex, subRoomIndex, allBookings, resId, weekKey, excludeSlotId) {
    const proposedEnd = startTime + duration;
    const prefix = resId + "_" + weekKey;

    for (const [slotId, booking] of Object.entries(allBookings)) {
        if (!slotId.startsWith(prefix)) continue;
        if (excludeSlotId && slotId === excludeSlotId) continue;

        const parsed = parseSlotId(slotId, resId);
        if (parsed.dayIndex !== dayIndex) continue;
        if (normalizeSubIndex(parsed.subRoomIndex) !== normalizeSubIndex(subRoomIndex)) continue;

        const existingStart = parsed.startTime;
        const existingEnd = existingStart + booking.duration;

        if (startTime < existingEnd && proposedEnd > existingStart) {
            return { hasConflict: true, conflictingId: slotId };
        }
    }

    return { hasConflict: false };
}

// ============================================================
// CURRENT TIME HELPER
// ============================================================

/**
 * Get the current time as a float hour value.
 * Example: 2:30 PM → 14.5, 9:15 AM → 9.25
 *
 * @param {Date} [now] - Override "now" for testing (defaults to new Date())
 * @returns {number}
 */
function getCurrentTimeFloat(now) {
    if (!now) now = new Date();
    return now.getHours() + now.getMinutes() / 60;
}

// ============================================================
// COSMETIC CLOSING TIME
// ============================================================

/**
 * Apply the cosmetic closing time offset for display purposes.
 * If a time value equals the day's closing hour and cosmeticCloseMinutes > 0,
 * the displayed time is shifted earlier by that many minutes.
 * Non-closing times are returned unchanged.
 *
 * Example: formatCosmeticTime(18, 18, 10) → formatTime(17.833...) → "5:50pm"
 *          formatCosmeticTime(10.5, 18, 10) → formatTime(10.5) → "10:30am"
 *
 * @param {number} timeVal             - The time value (float hours)
 * @param {number} dayEnd              - The day's actual closing hour (float)
 * @param {number} cosmeticCloseMinutes - Minutes to subtract from closing time display (0 = disabled)
 * @returns {string} Formatted time string
 */
function formatCosmeticTime(timeVal, dayEnd, cosmeticCloseMinutes) {
    if (cosmeticCloseMinutes > 0 && timeVal === dayEnd) {
        return formatTime(dayEnd - (cosmeticCloseMinutes / 60));
    }
    return formatTime(timeVal);
}

// ============================================================
// STAFF NAME NORMALIZATION
// ============================================================

/**
 * Normalize a staff name for consistent stats grouping.
 * Trims whitespace, collapses internal runs of whitespace,
 * and title-cases each word.
 *
 * @param {string} name - Raw staff name input
 * @returns {string} Normalized name, or "Unknown" if empty/falsy
 */
function normalizeStaffName(name) {
    if (!name || typeof name !== 'string') return 'Unknown';
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (trimmed === '') return 'Unknown';
    return trimmed.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ============================================================
// MODULE EXPORT (Node.js / Jest) — no-op in the browser
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatTime,
        formatDateISO,
        formatDateShort,
        getWeekKey,
        getWeekStart,
        escapeHtml,
        normalizeSubIndex,
        parseSlotId,
        buildSlotId,
        getClosureReason,
        migrateClosureDates,
        getClosuresForYear,
        getAllClosures,
        migrateSubRooms,
        getActiveSubRooms,
        getSubRoomName,
        getNthWeekdayOfMonth,
        getLastWeekdayOfMonth,
        isBookingLocked,
        isBookingAnonymized,
        checkTimeConflict,
        formatCosmeticTime,
        getCurrentTimeFloat,
        normalizeStaffName
    };
}
