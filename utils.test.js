const {
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
    isBookingAnonymized,
    checkTimeConflict,
    formatCosmeticTime,
    getCurrentTimeFloat,
    normalizeStaffName
} = require('./utils');

// ============================================================
// formatTime
// ============================================================

describe('formatTime', () => {
    test('formats whole hours (AM)', () => {
        expect(formatTime(10)).toBe('10:00am');
        expect(formatTime(9)).toBe('9:00am');
        expect(formatTime(0)).toBe('12:00am');
    });

    test('formats whole hours (PM)', () => {
        expect(formatTime(12)).toBe('12:00pm');
        expect(formatTime(13)).toBe('1:00pm');
        expect(formatTime(23)).toBe('11:00pm');
    });

    test('formats half hours', () => {
        expect(formatTime(10.5)).toBe('10:30am');
        expect(formatTime(13.5)).toBe('1:30pm');
    });

    test('formats quarter hours', () => {
        expect(formatTime(10.25)).toBe('10:15am');
        expect(formatTime(10.75)).toBe('10:45am');
        expect(formatTime(14.25)).toBe('2:15pm');
    });

    test('handles noon and midnight', () => {
        expect(formatTime(0)).toBe('12:00am');
        expect(formatTime(12)).toBe('12:00pm');
    });
});

// ============================================================
// formatDateISO
// ============================================================

describe('formatDateISO', () => {
    test('formats date as YYYY-MM-DD with zero padding', () => {
        expect(formatDateISO(new Date(2025, 0, 5))).toBe('2025-01-05');
        expect(formatDateISO(new Date(2025, 11, 25))).toBe('2025-12-25');
    });

    test('handles single-digit months and days', () => {
        expect(formatDateISO(new Date(2025, 2, 3))).toBe('2025-03-03');
    });
});

// ============================================================
// formatDateShort
// ============================================================

describe('formatDateShort', () => {
    test('formats as M/D without zero padding', () => {
        expect(formatDateShort(new Date(2025, 0, 5))).toBe('1/5');
        expect(formatDateShort(new Date(2025, 11, 25))).toBe('12/25');
    });
});

// ============================================================
// getWeekKey
// ============================================================

describe('getWeekKey', () => {
    test('returns Sunday-based week key', () => {
        // Wednesday Jan 8, 2025 → week starts Sunday Jan 5
        expect(getWeekKey(new Date(2025, 0, 8))).toBe('2025-01-05');
    });

    test('Sunday returns itself', () => {
        expect(getWeekKey(new Date(2025, 0, 5))).toBe('2025-01-05');
    });

    test('Saturday returns prior Sunday', () => {
        // Saturday Jan 11, 2025 → Sunday Jan 5
        expect(getWeekKey(new Date(2025, 0, 11))).toBe('2025-01-05');
    });
});

// ============================================================
// getWeekStart
// ============================================================

describe('getWeekStart', () => {
    test('returns Date object for week start Sunday', () => {
        const result = getWeekStart(new Date(2025, 0, 8)); // Wednesday
        expect(result.getDay()).toBe(0); // Sunday
        expect(result.getDate()).toBe(5);
    });

    test('Sunday returns itself', () => {
        const sunday = new Date(2025, 0, 5);
        const result = getWeekStart(sunday);
        expect(result.getDate()).toBe(5);
    });
});

// ============================================================
// escapeHtml
// ============================================================

describe('escapeHtml', () => {
    test('escapes all HTML special characters', () => {
        expect(escapeHtml('<script>"test" & \'alert\'</script>')).toBe(
            '&lt;script&gt;&quot;test&quot; &amp; &#039;alert&#039;&lt;/script&gt;'
        );
    });

    test('returns empty string for falsy input', () => {
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('passes through plain text unchanged', () => {
        expect(escapeHtml('Hello World')).toBe('Hello World');
    });
});

// ============================================================
// normalizeSubIndex
// ============================================================

describe('normalizeSubIndex', () => {
    test('returns null for empty/null/undefined values', () => {
        expect(normalizeSubIndex(null)).toBeNull();
        expect(normalizeSubIndex(undefined)).toBeNull();
        expect(normalizeSubIndex('')).toBeNull();
        expect(normalizeSubIndex('null')).toBeNull();
        expect(normalizeSubIndex('undefined')).toBeNull();
    });

    test('parses numeric strings to integers', () => {
        expect(normalizeSubIndex('0')).toBe(0);
        expect(normalizeSubIndex('3')).toBe(3);
        expect(normalizeSubIndex('12')).toBe(12);
    });

    test('handles numeric input', () => {
        expect(normalizeSubIndex(0)).toBe(0);
        expect(normalizeSubIndex(5)).toBe(5);
    });
});

// ============================================================
// parseSlotId / buildSlotId
// ============================================================

describe('parseSlotId', () => {
    test('parses standard slot ID (no sub-room)', () => {
        const result = parseSlotId('res-default_2025-01-05_3_10.5', 'res-default');
        expect(result).toEqual({
            weekKey: '2025-01-05',
            dayIndex: 3,
            startTime: 10.5,
            subRoomIndex: null
        });
    });

    test('parses slot ID with sub-room index', () => {
        const result = parseSlotId('res-default_2025-01-05_3_10.5_2', 'res-default');
        expect(result).toEqual({
            weekKey: '2025-01-05',
            dayIndex: 3,
            startTime: 10.5,
            subRoomIndex: 2
        });
    });

    test('handles resource IDs with hyphens', () => {
        const result = parseSlotId('my-res-id_2025-01-05_0_8', 'my-res-id');
        expect(result.weekKey).toBe('2025-01-05');
        expect(result.dayIndex).toBe(0);
        expect(result.startTime).toBe(8);
    });
});

describe('buildSlotId', () => {
    test('builds slot ID without sub-room', () => {
        expect(buildSlotId('res-default', '2025-01-05', 3, 10.5, null))
            .toBe('res-default_2025-01-05_3_10.5');
    });

    test('builds slot ID with sub-room', () => {
        expect(buildSlotId('res-default', '2025-01-05', 3, 10.5, 2))
            .toBe('res-default_2025-01-05_3_10.5_2');
    });

    test('roundtrips with parseSlotId', () => {
        const original = 'res-default_2025-01-05_3_10.5_2';
        const parsed = parseSlotId(original, 'res-default');
        const rebuilt = buildSlotId('res-default', parsed.weekKey, parsed.dayIndex, parsed.startTime, parsed.subRoomIndex);
        expect(rebuilt).toBe(original);
    });
});

// ============================================================
// getClosureReason
// ============================================================

describe('getClosureReason', () => {
    test('returns reason for a single-day closure', () => {
        const res = {
            closuresByYear: {
                '2025': [{ date: '2025-07-04', reason: 'Independence Day' }]
            }
        };
        expect(getClosureReason(res, new Date(2025, 6, 4))).toBe('Independence Day');
    });

    test('returns null for non-closure date', () => {
        const res = {
            closuresByYear: {
                '2025': [{ date: '2025-07-04', reason: 'Independence Day' }]
            }
        };
        expect(getClosureReason(res, new Date(2025, 6, 5))).toBeNull();
    });

    test('handles date ranges', () => {
        const res = {
            closuresByYear: {
                '2025': [{ date: '2025-12-24', endDate: '2025-12-26', reason: 'Holiday Break' }]
            }
        };
        expect(getClosureReason(res, new Date(2025, 11, 24))).toBe('Holiday Break');
        expect(getClosureReason(res, new Date(2025, 11, 25))).toBe('Holiday Break');
        expect(getClosureReason(res, new Date(2025, 11, 26))).toBe('Holiday Break');
        expect(getClosureReason(res, new Date(2025, 11, 27))).toBeNull();
    });

    test('handles legacy closureDates array', () => {
        const res = {
            closureDates: [{ date: '2025-01-01', reason: 'New Year' }]
        };
        expect(getClosureReason(res, new Date(2025, 0, 1))).toBe('New Year');
    });

    test('returns null for resource with no closures', () => {
        expect(getClosureReason({}, new Date(2025, 6, 4))).toBeNull();
    });
});

// ============================================================
// migrateClosureDates
// ============================================================

describe('migrateClosureDates', () => {
    test('migrates legacy closureDates to closuresByYear', () => {
        const res = {
            closureDates: [
                { date: '2025-07-04', reason: 'July 4th' },
                { date: '2024-12-25', reason: 'Christmas' }
            ]
        };
        const result = migrateClosureDates(res);
        expect(result).toBe(true);
        expect(res.closureDates).toBeUndefined();
        expect(res.closuresByYear['2025']).toHaveLength(1);
        expect(res.closuresByYear['2024']).toHaveLength(1);
    });

    test('avoids duplicate entries during migration', () => {
        const res = {
            closuresByYear: { '2025': [{ date: '2025-07-04', reason: 'July 4th' }] },
            closureDates: [{ date: '2025-07-04', reason: 'July 4th' }]
        };
        migrateClosureDates(res);
        expect(res.closuresByYear['2025']).toHaveLength(1);
    });

    test('returns false when no migration needed', () => {
        const res = { closuresByYear: { '2025': [] } };
        expect(migrateClosureDates(res)).toBe(false);
    });

    test('initializes closuresByYear if missing', () => {
        const res = {};
        migrateClosureDates(res);
        expect(res.closuresByYear).toEqual({});
    });
});

// ============================================================
// getClosuresForYear / getAllClosures
// ============================================================

describe('getClosuresForYear', () => {
    test('returns closures for the specified year', () => {
        const res = {
            closuresByYear: {
                '2025': [{ date: '2025-07-04', reason: 'July 4th' }],
                '2024': [{ date: '2024-12-25', reason: 'Christmas' }]
            }
        };
        expect(getClosuresForYear(res, 2025)).toHaveLength(1);
        expect(getClosuresForYear(res, 2024)).toHaveLength(1);
        expect(getClosuresForYear(res, 2023)).toHaveLength(0);
    });

    test('returns empty array for resource with no closures', () => {
        expect(getClosuresForYear({}, 2025)).toEqual([]);
    });
});

describe('getAllClosures', () => {
    test('returns flat array of all closures across years', () => {
        const res = {
            closuresByYear: {
                '2025': [{ date: '2025-07-04' }],
                '2024': [{ date: '2024-12-25' }, { date: '2024-01-01' }]
            }
        };
        expect(getAllClosures(res)).toHaveLength(3);
    });

    test('returns empty array for resource with no closures', () => {
        expect(getAllClosures({})).toEqual([]);
    });
});

// ============================================================
// migrateSubRooms
// ============================================================

describe('migrateSubRooms', () => {
    test('migrates comma-separated string to array of objects', () => {
        const res = { subRooms: 'Room A, Room B, Room C' };
        const result = migrateSubRooms(res);
        expect(result).toBe(true);
        expect(res.subRooms).toHaveLength(3);
        expect(res.subRooms[0].name).toBe('Room A');
        expect(res.subRooms[1].name).toBe('Room B');
        expect(res.subRooms[2].name).toBe('Room C');
        expect(res.subRooms[0].active).toBe(true);
        expect(res.subRooms[0].displayOrder).toBe(0);
    });

    test('initializes empty array for empty/missing subRooms', () => {
        const res1 = {};
        migrateSubRooms(res1);
        expect(res1.subRooms).toEqual([]);

        const res2 = { subRooms: '' };
        migrateSubRooms(res2);
        expect(res2.subRooms).toEqual([]);
    });

    test('returns false when no migration needed', () => {
        const res = { subRooms: [{ name: 'Room A', active: true }] };
        expect(migrateSubRooms(res)).toBe(false);
    });
});

// ============================================================
// getActiveSubRooms
// ============================================================

describe('getActiveSubRooms', () => {
    test('returns only active sub-rooms with _arrayIndex', () => {
        const res = {
            subRooms: [
                { name: 'A', active: true, displayOrder: 0 },
                { name: 'B', active: false, displayOrder: 1 },
                { name: 'C', active: true, displayOrder: 2 }
            ]
        };
        const result = getActiveSubRooms(res);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('A');
        expect(result[0]._arrayIndex).toBe(0);
        expect(result[1].name).toBe('C');
        expect(result[1]._arrayIndex).toBe(2);
    });

    test('sorts by displayOrder', () => {
        const res = {
            subRooms: [
                { name: 'C', active: true, displayOrder: 2 },
                { name: 'A', active: true, displayOrder: 0 },
                { name: 'B', active: true, displayOrder: 1 }
            ]
        };
        const result = getActiveSubRooms(res);
        expect(result[0].name).toBe('A');
        expect(result[1].name).toBe('B');
        expect(result[2].name).toBe('C');
    });

    test('returns empty array for no sub-rooms', () => {
        expect(getActiveSubRooms({})).toEqual([]);
        expect(getActiveSubRooms({ subRooms: [] })).toEqual([]);
    });
});

// ============================================================
// getSubRoomName
// ============================================================

describe('getSubRoomName', () => {
    test('returns sub-room name by index', () => {
        const res = {
            subRooms: [{ name: 'Lab A' }, { name: 'Lab B' }]
        };
        expect(getSubRoomName(res, 0)).toBe('Lab A');
        expect(getSubRoomName(res, 1)).toBe('Lab B');
    });

    test('falls back to "Room N" for missing index', () => {
        const res = { subRooms: [{ name: 'Lab A' }] };
        expect(getSubRoomName(res, 5)).toBe('Room 6');
    });

    test('falls back to "Room N" for non-array subRooms', () => {
        expect(getSubRoomName({}, 0)).toBe('Room 1');
    });
});

// ============================================================
// getNthWeekdayOfMonth
// ============================================================

describe('getNthWeekdayOfMonth', () => {
    test('finds 1st Monday of January 2025', () => {
        // Jan 2025: 1st is Wednesday, so 1st Monday is Jan 6
        const result = getNthWeekdayOfMonth(2025, 0, 1, 1);
        expect(result.getDate()).toBe(6);
        expect(result.getMonth()).toBe(0);
    });

    test('finds 3rd Thursday of November 2025 (Thanksgiving)', () => {
        // Nov 2025: 1st is Saturday, so Thursdays are: 6, 13, 20, 27
        const result = getNthWeekdayOfMonth(2025, 10, 4, 4);
        expect(result.getDate()).toBe(27);
    });

    test('returns null for non-existent 5th occurrence', () => {
        // Not every month has a 5th Monday
        const result = getNthWeekdayOfMonth(2025, 1, 1, 5); // Feb 2025
        expect(result).toBeNull();
    });
});

// ============================================================
// getLastWeekdayOfMonth
// ============================================================

describe('getLastWeekdayOfMonth', () => {
    test('finds last Friday of January 2025', () => {
        // Jan 31, 2025 is a Friday
        const result = getLastWeekdayOfMonth(2025, 0, 5);
        expect(result.getDate()).toBe(31);
    });

    test('finds last Monday of February 2025', () => {
        // Feb 2025: 28 days, Feb 28 is a Friday. Last Monday is Feb 24.
        const result = getLastWeekdayOfMonth(2025, 1, 1);
        expect(result.getDate()).toBe(24);
    });
});

// ============================================================
// isBookingAnonymized
// ============================================================

describe('isBookingAnonymized', () => {
    // Use a fixed "today" for deterministic tests: Wednesday Jan 8, 2025
    const today = new Date(2025, 0, 8);

    test('day view: past booking is anonymized', () => {
        const res = { viewMode: 'day' };
        // Jan 7 (yesterday) - dayIndex 2 means Tuesday in week starting Jan 5
        expect(isBookingAnonymized('2025-01-05', 2, res, today)).toBe(true);
    });

    test('day view: today booking is NOT anonymized', () => {
        const res = { viewMode: 'day' };
        // Jan 8 (today) - dayIndex 3 means Wednesday in week starting Jan 5
        expect(isBookingAnonymized('2025-01-05', 3, res, today)).toBe(false);
    });

    test('day view: future booking is NOT anonymized', () => {
        const res = { viewMode: 'day' };
        expect(isBookingAnonymized('2025-01-05', 4, res, today)).toBe(false);
    });

    test('week view: booking in current week is NOT anonymized', () => {
        const res = { viewMode: 'week' };
        // Week of Jan 5 is current week (today is Jan 8)
        expect(isBookingAnonymized('2025-01-05', 0, res, today)).toBe(false);
    });

    test('week view: booking in prior week IS anonymized', () => {
        const res = { viewMode: 'week' };
        // Week of Dec 29 is previous week
        expect(isBookingAnonymized('2024-12-29', 0, res, today)).toBe(true);
    });
});

// ============================================================
// checkTimeConflict
// ============================================================

describe('checkTimeConflict', () => {
    const bookings = {
        'res-1_2025-01-05_3_10': { duration: 1.5 },   // 10:00 - 11:30
        'res-1_2025-01-05_3_13': { duration: 1 },      // 1:00 - 2:00
        'res-1_2025-01-05_3_10_1': { duration: 1 }     // 10:00 - 11:00 in sub-room 1
    };

    test('detects overlap with existing booking', () => {
        // Trying to book 10:30 - 11:30 on day 3 (overlaps 10:00-11:30)
        const result = checkTimeConflict(10.5, 1, 3, null, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(true);
    });

    test('allows booking in gap between existing bookings', () => {
        // 11:30 - 13:00 (between existing 10-11:30 and 13-14)
        const result = checkTimeConflict(11.5, 1.5, 3, null, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(false);
    });

    test('allows booking on different day', () => {
        // 10:00 on day 4 (existing is on day 3)
        const result = checkTimeConflict(10, 1, 4, null, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(false);
    });

    test('allows booking in different sub-room', () => {
        // 10:00 in sub-room 2 (existing is in null and sub-room 1)
        const result = checkTimeConflict(10, 1, 3, 2, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(false);
    });

    test('excludes the specified slot from conflict check', () => {
        // 10:00 overlaps, but we're editing that exact booking
        const result = checkTimeConflict(10, 1.5, 3, null, bookings, 'res-1', '2025-01-05', 'res-1_2025-01-05_3_10');
        expect(result.hasConflict).toBe(false);
    });

    test('detects exact overlap (same time)', () => {
        const result = checkTimeConflict(10, 1, 3, null, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(true);
    });

    test('no conflict when booking ends exactly when another starts', () => {
        // 9:00-10:00 ends exactly when 10:00-11:30 starts - no overlap
        const result = checkTimeConflict(9, 1, 3, null, bookings, 'res-1', '2025-01-05');
        expect(result.hasConflict).toBe(false);
    });
});

// ============================================================
// formatCosmeticTime
// ============================================================

describe('formatCosmeticTime', () => {
    test('applies offset when time equals dayEnd', () => {
        // 18.0 (6:00pm) with 10 min offset → 5:50pm
        expect(formatCosmeticTime(18, 18, 10)).toBe('5:50pm');
    });

    test('does not apply offset to non-closing times', () => {
        // 10:30am is not the closing time, should be unchanged
        expect(formatCosmeticTime(10.5, 18, 10)).toBe('10:30am');
    });

    test('returns normal time when cosmeticCloseMinutes is 0', () => {
        expect(formatCosmeticTime(18, 18, 0)).toBe('6:00pm');
    });

    test('handles 15 minute offset', () => {
        // 17.0 (5:00pm) with 15 min offset → 4:45pm
        expect(formatCosmeticTime(17, 17, 15)).toBe('4:45pm');
    });

    test('handles 5 minute offset', () => {
        // 20.0 (8:00pm) with 5 min offset → 7:55pm
        expect(formatCosmeticTime(20, 20, 5)).toBe('7:55pm');
    });

    test('does not affect times before closing', () => {
        expect(formatCosmeticTime(14.5, 18, 10)).toBe('2:30pm');
        expect(formatCosmeticTime(9, 18, 10)).toBe('9:00am');
    });
});

// ============================================================
// getCurrentTimeFloat
// ============================================================

describe('getCurrentTimeFloat', () => {
    test('converts midnight to 0', () => {
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 0, 0))).toBe(0);
    });

    test('converts whole hours', () => {
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 9, 0))).toBe(9);
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 14, 0))).toBe(14);
    });

    test('converts half hours', () => {
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 10, 30))).toBe(10.5);
    });

    test('converts quarter hours', () => {
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 10, 15))).toBe(10.25);
        expect(getCurrentTimeFloat(new Date(2025, 0, 1, 14, 45))).toBe(14.75);
    });

    test('converts arbitrary minutes', () => {
        // 10:07 → 10 + 7/60 ≈ 10.1167
        const result = getCurrentTimeFloat(new Date(2025, 0, 1, 10, 7));
        expect(result).toBeCloseTo(10.1167, 3);
    });

    test('defaults to current time when no argument', () => {
        const result = getCurrentTimeFloat();
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(24);
    });
});

// ============================================================
// normalizeStaffName
// ============================================================

describe('normalizeStaffName', () => {
    test('title-cases a lowercase name', () => {
        expect(normalizeStaffName('john smith')).toBe('John Smith');
    });

    test('title-cases an uppercase name', () => {
        expect(normalizeStaffName('JOHN SMITH')).toBe('John Smith');
    });

    test('title-cases mixed case', () => {
        expect(normalizeStaffName('jOHN sMITH')).toBe('John Smith');
    });

    test('trims leading and trailing whitespace', () => {
        expect(normalizeStaffName('  John  ')).toBe('John');
    });

    test('collapses internal whitespace', () => {
        expect(normalizeStaffName('John   Smith')).toBe('John Smith');
    });

    test('returns Unknown for empty string', () => {
        expect(normalizeStaffName('')).toBe('Unknown');
    });

    test('returns Unknown for whitespace-only string', () => {
        expect(normalizeStaffName('   ')).toBe('Unknown');
    });

    test('returns Unknown for null', () => {
        expect(normalizeStaffName(null)).toBe('Unknown');
    });

    test('returns Unknown for undefined', () => {
        expect(normalizeStaffName(undefined)).toBe('Unknown');
    });

    test('handles single word', () => {
        expect(normalizeStaffName('alice')).toBe('Alice');
    });
});
