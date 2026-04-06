// --- FIREBASE CONFIG ---
const firebaseConfig = {
  apiKey: "AIzaSyAKLTLBTH5KaJ0DiK2AUphu1w80yJwUwTI",
  authDomain: "libraryscheduler-faf2f.firebaseapp.com",
  projectId: "libraryscheduler-faf2f",
  storageBucket: "libraryscheduler-faf2f.firebasestorage.app",
  messagingSenderId: "286899383584",
  appId: "1:286899383584:web:5826c1297f3c5bd28afb45"
};
    // --- END CONFIG ---

    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
    const auth = firebase.auth();

    const STAFF_EMAIL = "staff@library.internal"; 
    const VIEWER_EMAIL = "viewer@library.internal";
    let currentUserRole = null; // 'admin' or 'staff' 
    const ADMIN_PASS = "library"; 

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DEFAULT_HOURS = [0,0, 10,18, 10,20, 10,18, 10,18, 10,17, 10,17]; 
    const COLOR_PALETTES = {
        default: ['#5c6bc0', '#26a69a', '#E5B829'],
        warm:    ['#b5502f', '#4a7a5e', '#FFB300'],
        slate:   ['#546e7a', '#8b3a4a', '#D4A843'],
        ocean:   ['#2e6ea6', '#b55470', '#E6C24A'],
        accessible: ['#0077BB', '#B35000', '#FFEE58']
    };

    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`; 
        toast.innerText = message;
        container.appendChild(toast);
        requestAnimationFrame(() => { toast.classList.add('show'); });
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300); 
        }, 3000);
    }

    // --- STATE ---
    // Global state: resources array, current view position, bookings map, and
    // interaction state objects for drag-move, drag-to-create, and resize operations.
    let resources = [];
    let currentResId = null;
    let pendingSelectionId = null;
    let currentWeekStart = new Date(); 
    let currentDayDate = new Date();   
    let allBookings = {}; 
    let dailyMap = []; 
    let bookingColorMap = {};
    let activeListenerUnsub = null;
    let timeIndicatorIntervalId = null;
    let statsBookingsCache = {};  // key: `${resId}_${year}`, value: { bookings, fetchedAt }
    let statsMetaCache = null;    // cached stats_meta document data
    const STATS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Pending new resource data (for import closures flow)
    let pendingNewResource = null;
    let cloneSourceId = null;
    let pendingOpenSettings = false;

    // DRAG-AND-DROP STATE
    let dragState = {
        sourceId: null,
        sourceData: null,
        isDragging: false,
        isSaving: false,
        tooltipElement: null,
        highlightElement: null,
        lastInvalidReason: null,
        wasOverValidTarget: false
    };

    // DRAG-TO-CREATE SELECTION STATE
    let selectionState = {
        active: false,
        startSlotId: null,
        startTime: 0,
        startDayIndex: 0,
        subIndex: null,
        startY: 0,
        startSlotIndex: 0,
        slotPositions: [],
        slotHeight: 0,
        maxDuration: 0,
        currentDuration: 0.5,
        res: null,
        activeWeekKey: null,
        startSlotRect: null,
        overlayElement: null,
        labelElement: null,
        useQuarterHour: false,
        quarterOffset: 0
    };

    // RESIZE STATE (for existing bookings)
    let resizeState = {
        active: false,
        bookingId: null,
        bookingData: null,
        bookingStart: 0,
        col: null,
        res: null,
        activeWeekKey: null,
        startY: 0,
        startSlotIndex: 0,
        slotPositions: [],
        slotHeight: 0,
        originalDuration: 0,
        currentDuration: 0,
        minDuration: 0.5,
        maxDuration: 0,
        originalRect: null,
        overlayElement: null,
        labelElement: null,
        useQuarterHour: false
    };
    let resizeJustEnded = false;

    function init() {
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day; 
        const weekStart = new Date(d);
        weekStart.setDate(diff);
        weekStart.setHours(0,0,0,0);
        currentWeekStart = weekStart;
        
        currentDayDate = new Date();
        currentDayDate.setHours(0,0,0,0);

        auth.onAuthStateChanged(user => {
            if (user) {
                // Determine role based on which email logged in
                if (user.email === STAFF_EMAIL) {
                    currentUserRole = 'admin';
                    document.getElementById('status-bar').innerHTML = "<span class='online'>● Connected</span>";
                } else if (user.email === VIEWER_EMAIL) {
                    currentUserRole = 'staff';
                    document.getElementById('status-bar').innerHTML = "<span class='online'>● Connected (Staff)</span>";
                } else {
                    currentUserRole = 'staff'; // Default to limited permissions
                    document.getElementById('status-bar').innerHTML = "<span class='online'>● Connected</span>";
                }
                document.getElementById('loginOverlay').style.display = 'none';
                setupRealtimeListeners();
            } else {
                currentUserRole = null;
                document.getElementById('loginOverlay').style.display = 'flex';
                document.getElementById('status-bar').innerHTML = "<span class='offline'>Locked</span>";
            }
        });

        // Update current time indicator every 60 seconds
        if (!timeIndicatorIntervalId) {
            timeIndicatorIntervalId = setInterval(placeTimeIndicator, 60000);
        }
    }

    // --- AUTH ACTIONS ---
    function doLogin() {
        const pass = document.getElementById('loginPass').value;
        const err = document.getElementById('loginError');
        err.classList.add('hidden');
        
        // Try admin account first, then viewer account
        auth.signInWithEmailAndPassword(STAFF_EMAIL, pass)
            .catch(error => {
                // If admin login fails, try viewer account
                return auth.signInWithEmailAndPassword(VIEWER_EMAIL, pass);
            })
            .catch(error => {
                err.classList.remove('hidden');
                err.innerText = "Error: Invalid password";
            });
    }

    function doLogout() {
        auth.signOut();
        location.reload();
    }
    
    // Check if current user can edit this resource
    function canEditResource(res) {
        if (currentUserRole === 'admin') return true;
        if (!res) return false;
        return !res.adminOnly; // staff can edit if not admin-only
    }

    let hasCheckedJanitor = false;

    function setupRealtimeListeners() {
        db.collection('system').doc('resources').onSnapshot((doc) => {
            if (doc.exists) {
                resources = doc.data().list || [];
                // Migrate legacy closureDates to closuresByYear
                let needsSave = false;
                resources.forEach(r => { if (migrateClosureDates(r)) needsSave = true; });
                resources.forEach(r => { if (migrateSubRooms(r)) needsSave = true; });
                if (needsSave) db.collection('system').doc('resources').set({ list: resources });
            } else {
                resources = [{ id: 'res-default', name: 'General Area', viewMode: 'week', hours: DEFAULT_HOURS, closuresByYear: {} }];
                db.collection('system').doc('resources').set({ list: resources });
            }
            handleResourceUpdate();
            
            if (!hasCheckedJanitor) {
                hasCheckedJanitor = true;
                checkAndRunJanitor();
            }
        }, (err) => showToast("Permissions Error: " + err.message, "error"));
    }

    // --- CORE LOGIC ---
    // Data loading (Firestore real-time listeners), date navigation, UI controls,
    // and the main renderGrid() function that builds the entire scheduling grid.
    let loadVersion = 0; // Track which load request is current
    let activeQueryPrefix = null; // Track the current listener's query prefix

    function loadBookingsForCurrentView() {
        const res = resources.find(r => r.id === currentResId);
        if (!res) return;

        const isDayView = res.viewMode === 'day';
        const activeWeekKey = getWeekKey(isDayView ? currentDayDate : currentWeekStart);
        // For day-view resources, narrow query to just the displayed day
        const queryPrefix = isDayView
            ? `${res.id}_${activeWeekKey}_${currentDayDate.getDay()}_`
            : `${res.id}_${activeWeekKey}`;

        // If the listener is already watching this exact prefix, just re-render
        if (activeListenerUnsub && queryPrefix === activeQueryPrefix) {
            renderGrid();
            return;
        }

        if (activeListenerUnsub) {
            activeListenerUnsub();
            activeListenerUnsub = null;
            activeQueryPrefix = null;
        }

        activeQueryPrefix = queryPrefix;

        // Increment version for this load request
        loadVersion++;
        const thisVersion = loadVersion;

        activeListenerUnsub = db.collection('appointments')
            .where(firebase.firestore.FieldPath.documentId(), '>=', queryPrefix)
            .where(firebase.firestore.FieldPath.documentId(), '<', queryPrefix + '\uf8ff') 
            .onSnapshot((snapshot) => {
                // Only process if this is still the current request
                if (thisVersion !== loadVersion) return;
                
                allBookings = {}; 
                snapshot.forEach((doc) => { 
                    allBookings[doc.id] = doc.data(); 
                });
                renderGrid();
            }, (error) => {
                console.error("Data fetch error:", error);
                showToast("Sync Error: " + error.message, "error");
            });
    }
    
    function handleResourceUpdate() {
        const mainSel = document.getElementById('resourceSelect');
        const adminSel = document.getElementById('settingResSelect');

        if (!currentResId) {
            const urlParams = new URLSearchParams(window.location.search);
            const paramId = urlParams.get('resource');
            if (paramId && resources.some(r => r.id === paramId)) {
                currentResId = paramId;
            }
        }
        
        const populate = (sel, selectedId) => {
            sel.innerHTML = '';
            resources.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.innerText = r.name;
                sel.appendChild(opt);
            });
            if (selectedId && resources.find(r => r.id === selectedId)) sel.value = selectedId;
        };

        if (!currentResId && resources.length > 0) currentResId = resources[0].id;
        if (currentResId && !resources.find(r => r.id === currentResId) && resources.length > 0) {
            currentResId = resources[0].id;
        }
        if (pendingSelectionId && resources.find(r => r.id === pendingSelectionId)) {
            currentResId = pendingSelectionId;
        }
        populate(mainSel, currentResId);

        let adminVal = adminSel.value;
        if (pendingSelectionId) { adminVal = pendingSelectionId; pendingSelectionId = null; } 
        else if (!adminVal && resources.length > 0) { adminVal = resources[0].id; }
        populate(adminSel, adminVal);

        updateUIControls();
        loadBookingsForCurrentView();
        if(document.getElementById('settingsOverlay').style.display !== 'none') loadSettingsForEditor();
        
        if (pendingOpenSettings) {
            pendingOpenSettings = false;
            document.getElementById('settingsOverlay').style.display = 'flex';
            document.querySelector('.settings-body').scrollTop = 0;
            loadSettingsForEditor();
        }
    }

    let navDebounceTimeout = null;
    
    function navigateTime(dir) {
        hideBookingPopover();
        const res = resources.find(r => r.id === currentResId);
        const isDayView = res && res.viewMode === 'day';
        
        // Update dates immediately for responsive UI
        if (isDayView) {
            currentDayDate.setDate(currentDayDate.getDate() + dir);
            const d = new Date(currentDayDate);
            const day = d.getDay();
            const diff = d.getDate() - day;
            currentWeekStart = new Date(d.setDate(diff));
        } else {
            currentWeekStart.setDate(currentWeekStart.getDate() + (dir * 7));
            currentDayDate = new Date(currentWeekStart);
        }
        
        // Update UI immediately
        updateUIControls();
        
        // Debounce the data loading to avoid race conditions
        clearTimeout(navDebounceTimeout);
        navDebounceTimeout = setTimeout(() => {
            loadBookingsForCurrentView();
        }, 150);
    }

    function handleDatePick() {
        hideBookingPopover();
        const raw = document.getElementById('datePicker').value;
        if(!raw) return;
        const rawDate = new Date(raw + 'T00:00');
        currentDayDate = new Date(rawDate);
        const day = rawDate.getDay();
        const diff = rawDate.getDate() - day;
        currentWeekStart = new Date(rawDate.setDate(diff));
        updateUIControls();
        loadBookingsForCurrentView();
    }

    function goToToday() {
        hideBookingPopover();
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day;
        currentWeekStart = new Date(d);
        currentWeekStart.setDate(diff);
        currentWeekStart.setHours(0, 0, 0, 0);
        currentDayDate = new Date();
        currentDayDate.setHours(0, 0, 0, 0);
        updateUIControls();
        loadBookingsForCurrentView();
    }

    function updateUIControls() {
        const res = resources.find(x => x.id === currentResId);
        if(!res) return;
        const isDayView = res.viewMode === 'day';
        
        // --- NEW: Handle Sidebar Visibility & Text ---
        const sidebar = document.getElementById('infoSidebar');
        if (res.enableSidebar) {
            sidebar.classList.remove('hidden');
            sidebar.innerHTML = marked.parse(res.sidebarText || "");
        } else {
            sidebar.classList.add('hidden');
        }
        // ---------------------------------------------

        if (isDayView) {
            const d = currentDayDate;
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            document.getElementById('rangeDisplay').innerText = d.toLocaleDateString('en-US', options);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            document.getElementById('datePicker').value = `${y}-${m}-${day}`;
        } else {
            const endWeek = new Date(currentWeekStart);
            endWeek.setDate(endWeek.getDate() + 6);
            const sameMonth = currentWeekStart.getMonth() === endWeek.getMonth();
            const sameYear = currentWeekStart.getFullYear() === endWeek.getFullYear();
            const mo = { month: 'short' };
            if (sameMonth && sameYear) {
                document.getElementById('rangeDisplay').innerText = `${currentWeekStart.toLocaleDateString('en-US', mo)} ${currentWeekStart.getDate()} - ${endWeek.getDate()}, ${endWeek.getFullYear()}`;
            } else if (sameYear) {
                document.getElementById('rangeDisplay').innerText = `${currentWeekStart.toLocaleDateString('en-US', mo)} ${currentWeekStart.getDate()} - ${endWeek.toLocaleDateString('en-US', mo)} ${endWeek.getDate()}, ${endWeek.getFullYear()}`;
            } else {
                document.getElementById('rangeDisplay').innerText = `${currentWeekStart.toLocaleDateString('en-US', mo)} ${currentWeekStart.getDate()}, ${currentWeekStart.getFullYear()} - ${endWeek.toLocaleDateString('en-US', mo)} ${endWeek.getDate()}, ${endWeek.getFullYear()}`;
            }
            const y = currentWeekStart.getFullYear();
            const m = String(currentWeekStart.getMonth() + 1).padStart(2, '0');
            const d = String(currentWeekStart.getDate()).padStart(2, '0');
            document.getElementById('datePicker').value = `${y}-${m}-${d}`;
        }
        document.getElementById('headerResourceName').innerText = res.name;
    }

    // NOTE: getClosureReason, migrateClosureDates, getClosuresForYear, getAllClosures,
    // migrateSubRooms, getActiveSubRooms, getSubRoomName, and formatDateISO
    // are now defined in utils.js (loaded before this file).

    function renderGrid() {
        hideBookingPopover();
        const container = document.getElementById('gridContainer');
        container.innerHTML = '';
        const res = resources.find(r => r.id === currentResId);
        if(!res) return;
        
        // Apply color palette
        const palette = COLOR_PALETTES[res.colorPalette] || COLOR_PALETTES.default;
        document.documentElement.style.setProperty('--app-color-1', palette[0]);
        document.documentElement.style.setProperty('--app-color-2', palette[1]);
        document.documentElement.style.setProperty('--app-color-3', palette[2]);
        
        const isDayView = res.viewMode === 'day';
        
        let columns = []; 
        if (isDayView) {
            const dayIdx = currentDayDate.getDay(); 
            const subRooms = getActiveSubRooms(res);
            const subRoomList = subRooms.length > 0 ? subRooms : [{ name: 'Main', _arrayIndex: 0 }];
            container.style.gridTemplateColumns = `85px repeat(${subRoomList.length}, 1fr)`;
            subRoomList.forEach(sr => {
                columns.push({ header: sr.name, date: currentDayDate, dayIndex: dayIdx, subIndex: sr._arrayIndex });
            });
        } else {
            container.style.gridTemplateColumns = `85px repeat(7, 1fr)`;
            DAYS.forEach((name, i) => {
                const d = new Date(currentWeekStart);
                d.setDate(d.getDate() + i);
                columns.push({ header: `${name} <br><small style="font-weight:normal">${d.getMonth()+1}/${d.getDate()}</small>`, date: d, dayIndex: i, subIndex: null });
            });
        }

        container.appendChild(createDiv('header-cell', 'Time'));
        columns.forEach(col => { 
            const headerDiv = createDiv('header-cell', col.header);
            container.appendChild(headerDiv); 
        });

        const activeWeekKey = getWeekKey(isDayView ? currentDayDate : currentWeekStart);
        let gridBookings = [];
        Object.keys(allBookings).forEach(key => {
            if (key.startsWith(res.id + "_" + activeWeekKey)) {
                const prefix = res.id + "_";
                const suffix = key.substring(prefix.length); 
                const parts = suffix.split('_');
                const bkDayIdx = parseInt(parts[1]);
                const bkStart = parseFloat(parts[2]);
                const bkSubIdx = parts[3] ? parseInt(parts[3]) : null;
                gridBookings.push({ id: key, dayIndex: bkDayIdx, start: bkStart, end: bkStart + parseFloat(allBookings[key].duration), subIndex: bkSubIdx, data: allBookings[key] });
            }
        });

        bookingColorMap = {};
        let colGroups = {};
        gridBookings.forEach(b => {
            const k = b.dayIndex + "-" + (b.subIndex !== null ? b.subIndex : 'x');
            if(!colGroups[k]) colGroups[k] = [];
            colGroups[k].push(b);
        });
        Object.values(colGroups).forEach(group => {
            group.sort((a,b) => a.start - b.start);
            group.forEach((b, i) => bookingColorMap[b.id] = i % 2);
        });

        let minH = 24, maxH = 0;
        for(let i=0; i<14; i+=2) {
            if(res.hours[i] !== res.hours[i+1]) {
                if(res.hours[i] < minH) minH = res.hours[i];
                if(res.hours[i+1] > maxH) maxH = res.hours[i+1];
            }
        }
        if(minH > maxH) { minH = 9; maxH = 17; }

        const totalSlots = (maxH - minH) * 2;
        const middleSlotIndex = Math.floor(totalSlots / 2);
        
        // Track which columns have shown their closure reason
        const closureReasonShown = {};
        
        // Track slot elements for positioning bookings later
        const slotElements = {}; // key: "colIndex-slotIndex" -> element
        const printLabelsAdded = new Set(); // Track which bookings have print labels
        
        for (let i = 0; i < totalSlots; i++) {
            const timeVal = minH + (i * 0.5);
            const displayTime = formatTime(timeVal);
            const isAltRow = (i % 2 === 1);
            const rowClass = isAltRow ? 'row-alt' : '';
            
            container.appendChild(createDiv(`time-cell ${rowClass}`, displayTime));

            columns.forEach((col, colIndex) => {
                const closureReason = getClosureReason(res, col.date);
                const dayStart = res.hours[col.dayIndex * 2];
                const dayEnd = res.hours[(col.dayIndex * 2) + 1];
                const slot = document.createElement('div');
                slot.className = `slot ${rowClass}`;
                
                // Check for closure date first (entire day closed)
                if (closureReason) {
                    slot.classList.add('closed', 'closure-day');
                    
                    // Show reason text only in the middle cell of this column
                    const colKey = `${col.dayIndex}-${col.subIndex}`;
                    if (!closureReasonShown[colKey] && i === middleSlotIndex) {
                        slot.classList.add('has-reason');
                        slot.innerText = closureReason;
                        closureReasonShown[colKey] = true;
                    }
                    
                    container.appendChild(slot);
                } else if (timeVal < dayStart || timeVal >= dayEnd || dayStart === dayEnd) {
                    slot.classList.add('closed');
                    container.appendChild(slot);
                } else {
                    // Check if this slot is covered by a booking
                    const booking = gridBookings.find(b => b.dayIndex === col.dayIndex && (b.subIndex === col.subIndex) && timeVal >= b.start && timeVal < b.end);
                    // Check if slot is FULLY covered (no available quarter-hours)
                    const slotEnd = timeVal + 0.5;
                    const isFullyCovered = booking && booking.start <= timeVal && booking.end >= slotEnd;
                    // In quarter-hour mode, check if any quarter is available
                    const hasPartialAvailability = res.useQuarterHour && booking && !isFullyCovered;

                    if (booking) {
                        slot.classList.add('has-booking');
                        slot.dataset.bid = booking.id;
                        // Carry booking color to the slot for print styling
                        const printColorIdx = bookingColorMap[booking.id];
                        if (printColorIdx !== undefined) slot.classList.add(`print-color-${printColorIdx}`);
                        // Add inline print label on the first slot of each booking
                        if (!printLabelsAdded.has(booking.id)) {
                            printLabelsAdded.add(booking.id);
                            const anon = isBookingAnonymized(activeWeekKey, booking.dayIndex, res);
                            const printLabel = document.createElement('div');
                            printLabel.className = 'print-booking-label';
                            const bookingDayEnd = res.hours[(booking.dayIndex * 2) + 1];
                            const cosmeticMin = res.cosmeticCloseMinutes || 0;
                            const printName = anon ? 'Past Booking' : booking.data.name;
                            printLabel.textContent = printName + ' (' + formatTime(booking.start) + '-' + formatCosmeticTime(booking.end, bookingDayEnd, cosmeticMin) + ')';
                            slot.appendChild(printLabel);
                        }
                    }

                    // Set up interactions if slot is empty OR has partial availability in quarter-hour mode
                    if (!booking || hasPartialAvailability) {
                        let emptyId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${timeVal}`;
                        if (col.subIndex !== null) emptyId += `_${col.subIndex}`;

                        const canEdit = canEditResource(res);

                        // Always show time tooltip on hover
                        const slotCosmeticMin = res.cosmeticCloseMinutes || 0;
                        slot.setAttribute('data-time', `${displayTime} - ${formatCosmeticTime(timeVal + 0.5, dayEnd, slotCosmeticMin)}`);

                        // For quarter-hour mode, update tooltip and highlight dynamically
                        if (res.useQuarterHour) {
                            slot.classList.add('quarter-hour-slot');
                            slot.onmousemove = (e) => {
                                const offset = getQuarterHourOffset(e, slot, res);
                                const adjustedStart = timeVal + offset;
                                // Check if this specific quarter is available
                                const quarterEnd = adjustedStart + 0.25;
                                const quarterBlocked = gridBookings.some(b =>
                                    b.dayIndex === col.dayIndex &&
                                    b.subIndex === col.subIndex &&
                                    adjustedStart < b.end && quarterEnd > b.start
                                );
                                if (quarterBlocked) {
                                    slot.classList.remove('quarter-hover-top', 'quarter-hover-bottom', 'drag-over-valid', 'drag-over-invalid');
                                    slot.setAttribute('data-time', '');
                                } else {
                                    slot.setAttribute('data-time', `${formatTime(adjustedStart)} - ${formatCosmeticTime(adjustedStart + 0.5, dayEnd, slotCosmeticMin)}`);
                                    // Update half-highlight
                                    if (offset > 0) {
                                        slot.classList.remove('quarter-hover-top');
                                        slot.classList.add('quarter-hover-bottom');
                                    } else {
                                        slot.classList.remove('quarter-hover-bottom');
                                        slot.classList.add('quarter-hover-top');
                                    }
                                    // Reschedule mode: show valid/invalid feedback
                                    if (rescheduleMode.active) {
                                        let testSlotId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${adjustedStart}`;
                                        if (col.subIndex !== null) testSlotId += `_${col.subIndex}`;
                                        const rv = validateRescheduleTarget(testSlotId);
                                        slot.classList.remove('drag-over-valid', 'drag-over-invalid');
                                        slot.classList.add(rv.valid ? 'drag-over-valid' : 'drag-over-invalid');
                                    }
                                }
                            };
                            slot.onmouseleave = () => {
                                slot.classList.remove('quarter-hover-top', 'quarter-hover-bottom', 'drag-over-valid', 'drag-over-invalid');
                            };
                        } else {
                            // Standard mode: reschedule hover feedback
                            slot.onmouseenter = () => {
                                if (!rescheduleMode.active) return;
                                let testSlotId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${timeVal}`;
                                if (col.subIndex !== null) testSlotId += `_${col.subIndex}`;
                                const rv = validateRescheduleTarget(testSlotId);
                                slot.classList.add(rv.valid ? 'drag-over-valid' : 'drag-over-invalid');
                            };
                            slot.onmouseleave = () => {
                                slot.classList.remove('drag-over-valid', 'drag-over-invalid');
                            };
                        }

                        if (canEdit) {
                            slot.onclick = (e) => {
                                if (selectionState.active) return;
                                if (resizeJustEnded) return;

                                // For quarter-hour mode, check if clicked quarter is available
                                const offset = getQuarterHourOffset(e, slot, res);
                                const adjustedTime = timeVal + offset;
                                if (res.useQuarterHour) {
                                    const quarterEnd = adjustedTime + 0.25;
                                    const quarterBlocked = gridBookings.some(b =>
                                        b.dayIndex === col.dayIndex &&
                                        b.subIndex === col.subIndex &&
                                        adjustedTime < b.end && quarterEnd > b.start
                                    );
                                    if (quarterBlocked) return; // Don't allow clicking on blocked quarter
                                }

                                if (rescheduleMode.active) {
                                    let adjustedSlotId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${adjustedTime}`;
                                    if (col.subIndex !== null) adjustedSlotId += `_${col.subIndex}`;
                                    handleRescheduleSlotClick(adjustedSlotId, col.subIndex);
                                    return;
                                }
                                let adjustedSlotId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${adjustedTime}`;
                                if (col.subIndex !== null) adjustedSlotId += `_${col.subIndex}`;

                                const advCheck = checkAdvanceLimit(res, activeWeekKey, col.dayIndex);
                                if (!advCheck.allowed) { showToast(advCheck.message, "error"); return; }
                                openBookingModal(adjustedSlotId, null, col.subIndex);
                            };

                            // DRAG-AND-DROP: Set up empty slots as drop targets
                            slot.dataset.slotId = emptyId;
                            slot.dataset.dayIndex = col.dayIndex;
                            slot.dataset.timeVal = timeVal;
                            slot.dataset.subIndex = col.subIndex !== null ? col.subIndex : '';
                            slot.ondragover = handleDragOver;
                            slot.ondragleave = handleDragLeave;
                            slot.ondrop = handleDrop;

                            // DRAG-TO-CREATE: mousedown starts selection
                            slot.onmousedown = (e) => startSelection(e, emptyId, timeVal, col, res, activeWeekKey, slot);
                        } else {
                            slot.style.cursor = 'default';
                        }
                    }
                    
                    // Store reference to this slot for positioning bookings
                    slotElements[`${colIndex}-${i}`] = slot;
                    container.appendChild(slot);
                }
            });
        }
        
        // Now create absolutely positioned booking elements
        // Use requestAnimationFrame to ensure grid layout is complete
        requestAnimationFrame(() => {
            gridBookings.forEach(booking => {
                const col = columns.find(c => c.dayIndex === booking.dayIndex && c.subIndex === booking.subIndex);
                if (!col) return;
                
                const colIndex = columns.indexOf(col);
                // Handle quarter-hour positions: rawStartSlotIndex is time-based (e.g., 9.25 - 9 = 0.25 * 2 = 0.5)
                // startSlotIndex is floored to get the containing 30-min slot in the DOM
                const rawStartSlotIndex = (booking.start - minH) * 2;
                const startSlotIndex = Math.floor(rawStartSlotIndex);
                const startOffsetFraction = rawStartSlotIndex - startSlotIndex; // 0 or 0.5 for quarter-hour offset

                const startSlot = slotElements[`${colIndex}-${startSlotIndex}`];
                if (!startSlot) return;

                const startRect = startSlot.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();

                // Calculate pixel offset for quarter-hour start position
                const slotHeight = startRect.height;
                const startPixelOffset = startOffsetFraction * slotHeight;
                
                const colorIndex = bookingColorMap[booking.id];
                const colorClass = `bg-color-${colorIndex}`;
                
                const bookingEl = document.createElement('div');
                bookingEl.className = `booking-float ${colorClass}`;
                if (booking.data.hasStaff) bookingEl.classList.add('with-staff');
                if (rescheduleMode.active && booking.id === rescheduleMode.sourceId) {
                    bookingEl.classList.add('reschedule-source');
                }
                bookingEl.dataset.bid = booking.id;
                
                // Position relative to container, accounting for cell padding and quarter-hour offsets
                const padding = 2; // matches .slot padding
                bookingEl.style.position = 'absolute';
                bookingEl.style.left = (startRect.left - containerRect.left + container.scrollLeft + padding) + 'px';
                bookingEl.style.top = (startRect.top - containerRect.top + container.scrollTop + padding + startPixelOffset) + 'px';
                bookingEl.style.width = (startRect.width - padding * 2 - 1) + 'px'; // -1 for border-right
                // Height based on duration (each slot = 0.5 hours), subtract padding and bottom border
                const bookingHeight = (booking.data.duration * 2 * slotHeight) - padding * 2 - 1;
                bookingEl.style.height = Math.max(bookingHeight, 20) + 'px'; // minimum 20px for visibility
                
                // Content
                const anon = isBookingAnonymized(activeWeekKey, booking.dayIndex, res);
                const locked = isBookingLocked(activeWeekKey, booking.dayIndex, res);
                booking.anonymized = anon;
                booking.locked = locked;
                const displayName = anon ? 'Past Booking' : escapeHtml(booking.data.name);
                const seriesIcon = booking.data.seriesId ? '<span class="series-indicator" title="Recurring series">🔁</span> ' : '';
                bookingEl.innerHTML = `<span class="slot-name">${seriesIcon}${displayName}</span>`;
                const bookingDayEnd = res.hours[(booking.dayIndex * 2) + 1];
                const cosmeticMin = res.cosmeticCloseMinutes || 0;
                bookingEl.innerHTML += `<span class="slot-time">${formatTime(booking.start)} - ${formatCosmeticTime(booking.end, bookingDayEnd, cosmeticMin)} (${booking.data.duration}h)</span>`;
                
                if (booking.data.hasStaff) {
                    bookingEl.innerHTML += `<span class="slot-staff">w/ ${escapeHtml(booking.data.staffName)}</span>`;
                }
                
                if (anon) {
                    if (booking.data.notes) {
                        bookingEl.innerHTML += `<span class="slot-notes" style="font-size:0.8em; margin-top:4px; opacity:0.75; font-style:italic;">Past notes anonymized for patron privacy</span>`;
                    }
                } else if (booking.data.showNotes && booking.data.notes) {
                    bookingEl.innerHTML += `<span class="slot-notes" style="font-size:0.85em; margin-top:4px; opacity:0.9; border-top:1px solid rgba(255,255,255,0.2); padding-top:2px;">${escapeHtml(booking.data.notes)}</span>`;
                } else if (!booking.data.showNotes && booking.data.notes) {
                    bookingEl.innerHTML += `<span class="slot-notes" style="font-size:0.8em; margin-top:4px; opacity:0.75; font-style:italic;">📝 Click to view note</span>`;
                }
                
                const canEdit = canEditResource(res);
                
                // Add resize handle only if user can edit and booking is not locked
                if (canEdit && !locked) {
                    const resizeHandle = document.createElement('div');
                    resizeHandle.className = 'resize-handle';
                    resizeHandle.onmousedown = (e) => startResize(e, booking, col, res, activeWeekKey, bookingEl);
                    bookingEl.appendChild(resizeHandle);
                }
                
                // Event handlers - popover on hover
                bookingEl.onmouseenter = (e) => {
                    if (selectionState.active || resizeState.active) return;
                    highlightBooking(booking.id);
                    showBookingPopover(e, booking);
                };
                bookingEl.onmousemove = (e) => {
                    if (selectionState.active || resizeState.active) return;
                    updatePopoverPosition(e);
                };
                bookingEl.onmouseleave = () => {
                    unhighlightBooking(booking.id);
                    hideBookingPopover();
                };
                
                bookingEl.onclick = (e) => {
                    if (e.target.classList.contains('resize-handle')) return;
                    if (resizeJustEnded) return;
                    hideBookingPopover();
                    if (rescheduleMode.active) {
                        if (booking.id === rescheduleMode.sourceId) {
                            showToast("This is the booking you're moving. Click an empty slot.", "info");
                        } else {
                            showToast("This slot is occupied. Click an empty slot.", "info");
                        }
                        return;
                    }
                    openBookingModal(booking.id, booking.data, col.subIndex);
                };
                
                // DRAG-AND-DROP (only if user can edit and booking is not locked)
                if (canEdit && !locked) {
                    bookingEl.draggable = true;
                    bookingEl.ondragstart = (e) => handleDragStart(e, booking.id, booking.data);
                    bookingEl.ondragend = handleDragEnd;
                    
                    bookingEl.dataset.bookingId = booking.id;
                    bookingEl.dataset.bookingStart = booking.start;
                    bookingEl.dataset.bookingDuration = booking.data.duration;
                    bookingEl.dataset.dayIndex = col.dayIndex;
                    bookingEl.dataset.subIndex = col.subIndex !== null ? col.subIndex : '';
                    bookingEl.ondragover = (e) => handleBookedSlotDragOver(e, booking, col, res, activeWeekKey);
                    bookingEl.ondragleave = handleDragLeave;
                    bookingEl.ondrop = (e) => handleBookedSlotDrop(e, booking, col, res, activeWeekKey);
                } else {
                    bookingEl.style.cursor = 'default';
                }
                
                container.appendChild(bookingEl);
                
                // Check overflow after layout is fully complete (double rAF ensures paint)
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        if (bookingEl.scrollHeight > bookingEl.clientHeight) {
                            const indicator = document.createElement('span');
                            indicator.className = 'overflow-indicator';
                            indicator.innerText = 'Hover for details';
                            bookingEl.appendChild(indicator);
                        }
                    });
                });
            });

            // Position current time indicator (day view, today only)
            setupTimeIndicator(container, isDayView, minH, maxH, slotElements);
        });
    }

    // --- CURRENT TIME INDICATOR (day view) ---
    // A horizontal red line showing the current time, visible only when the
    // day view is displaying today's date.

    let timeIndicatorCtx = null; // stored context for interval-based updates

    /**
     * Set up the current time indicator after grid layout is complete.
     * Called from the requestAnimationFrame callback inside renderGrid().
     */
    function setupTimeIndicator(container, isDayView, minH, maxH, slotElements) {
        // Remove any existing indicator elements
        container.querySelectorAll('.time-indicator-line, .time-indicator-dot').forEach(el => el.remove());
        timeIndicatorCtx = null;

        if (!isDayView) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const viewDate = new Date(currentDayDate);
        viewDate.setHours(0, 0, 0, 0);
        if (viewDate.getTime() !== today.getTime()) return;

        // Store context so the interval can reposition the line
        timeIndicatorCtx = { container, minH, maxH, slotElements };
        placeTimeIndicator();
    }

    /**
     * Create (or reposition) the time indicator line and dot.
     * Called on initial render and every 60 seconds by the interval.
     */
    function placeTimeIndicator() {
        if (!timeIndicatorCtx) return;
        const { container, minH, maxH, slotElements } = timeIndicatorCtx;

        // Remove existing before re-placing
        container.querySelectorAll('.time-indicator-line, .time-indicator-dot').forEach(el => el.remove());

        const nowFloat = getCurrentTimeFloat();
        if (nowFloat < minH || nowFloat >= maxH) return;

        const rawSlotIndex = (nowFloat - minH) * 2;
        const slotIndex = Math.floor(rawSlotIndex);
        const offsetFraction = rawSlotIndex - slotIndex;

        // Measure position from the first column's slot at this row
        const refSlot = slotElements[`0-${slotIndex}`];
        if (!refSlot) return;

        const slotRect = refSlot.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const slotH = slotRect.height;
        const topPos = slotRect.top - containerRect.top + container.scrollTop + (offsetFraction * slotH);

        const line = document.createElement('div');
        line.className = 'time-indicator-line';
        line.style.top = topPos + 'px';
        container.appendChild(line);

        const dot = document.createElement('div');
        dot.className = 'time-indicator-dot';
        dot.style.top = topPos + 'px';
        container.appendChild(dot);
    }

    // --- DRAG-AND-DROP HANDLERS ---
    // Moving existing bookings to new time slots via HTML5 drag-and-drop.
    // Includes validation, conflict checking, and move confirmation modal.
    function handleDragStart(e, bookingId, bookingData) {
        // Don't start drag from resize handle
        if (e.target.classList.contains('resize-handle')) {
            e.preventDefault();
            return;
        }
        
        // Block if a move is already in progress, resize is active, or selection is active
        if (dragState.isSaving || resizeState.active || selectionState.active) {
            e.preventDefault();
            return;
        }
        
        // Hide any open popover
        hideBookingPopover();
        
        dragState.sourceId = bookingId;
        dragState.sourceData = bookingData;
        dragState.isDragging = true;
        
        // Firefox requires setData
        e.dataTransfer.setData('text/plain', bookingId);
        e.dataTransfer.effectAllowed = 'move';
        
        // Add dragging class after a small delay to not affect the drag image
        setTimeout(() => {
            e.target.classList.add('dragging');
        }, 0);
    }

    function handleDragEnd(e) {
        dragState.isDragging = false;
        e.target.classList.remove('dragging');
        
        // Show toast if user released on invalid target with a reason
        if (dragState.lastInvalidReason && !dragState.wasOverValidTarget) {
            showToast(dragState.lastInvalidReason, 'error');
        }
        
        // Clean up floating tooltip
        if (dragState.tooltipElement) {
            dragState.tooltipElement.remove();
            dragState.tooltipElement = null;
        }
        
        // Clean up highlight element
        if (dragState.highlightElement) {
            dragState.highlightElement.remove();
            dragState.highlightElement = null;
        }
        
        // Clean up any lingering drag-over classes and data-time attributes
        document.querySelectorAll('.drag-over-valid, .drag-over-invalid, .quarter-hover-top, .quarter-hover-bottom').forEach(el => {
            el.classList.remove('drag-over-valid', 'drag-over-invalid', 'quarter-hover-top', 'quarter-hover-bottom');
            if (el.classList.contains('booking-float')) {
                el.removeAttribute('data-time');
            }
        });

        // Clear drag state unless modal is open (user is confirming move)
        if (document.getElementById('moveModal').style.display !== 'flex') {
            dragState.sourceId = null;
            dragState.sourceData = null;
        }
        dragState.lastInvalidReason = null;
        dragState.wasOverValidTarget = false;
        dragState.adjustedTargetSlotId = null;
        dragState.quarterOffset = 0;
    }

    function handleDragOver(e) {
        e.preventDefault();
        if (!dragState.isDragging || !dragState.sourceId) return;

        const slot = e.currentTarget;
        const res = resources.find(r => r.id === currentResId);
        const useQuarter = res && res.useQuarterHour;
        const baseTimeVal = parseFloat(slot.dataset.timeVal);

        // Calculate quarter-hour offset if enabled
        let quarterOffset = 0;
        if (useQuarter) {
            const rect = slot.getBoundingClientRect();
            const relativeY = e.clientY - rect.top;
            quarterOffset = (relativeY >= rect.height / 2) ? 0.25 : 0;
        }
        const adjustedTime = baseTimeVal + quarterOffset;

        // Build adjusted slotId
        const dayIndex = slot.dataset.dayIndex;
        const subIndex = slot.dataset.subIndex;
        const prefix = res.id + "_";
        const suffix = slot.dataset.slotId.substring(prefix.length);
        const weekKey = suffix.split('_')[0];
        let adjustedSlotId = `${res.id}_${weekKey}_${dayIndex}_${adjustedTime}`;
        if (subIndex) adjustedSlotId += `_${subIndex}`;

        // Store for use in handleDrop
        dragState.adjustedTargetSlotId = adjustedSlotId;
        dragState.quarterOffset = quarterOffset;

        // Clean up drag-over classes from any other elements (in case dragLeave didn't fire)
        document.querySelectorAll('.drag-over-valid, .drag-over-invalid').forEach(el => {
            if (el !== e.currentTarget) {
                el.classList.remove('drag-over-valid', 'drag-over-invalid');
                el.classList.remove('quarter-hover-top', 'quarter-hover-bottom');
            }
        });

        // Remove existing classes
        slot.classList.remove('drag-over-valid', 'drag-over-invalid');
        slot.classList.remove('quarter-hover-top', 'quarter-hover-bottom');

        // For quarter-hour mode, show half-highlight and floating tooltip
        if (useQuarter) {
            // Clean up any existing tooltip/highlight and recreate for empty slot
            if (dragState.tooltipElement) {
                dragState.tooltipElement.remove();
                dragState.tooltipElement = null;
            }
            if (dragState.highlightElement) {
                dragState.highlightElement.remove();
                dragState.highlightElement = null;
            }

            // Add half-highlight class
            if (quarterOffset > 0) {
                slot.classList.add('quarter-hover-bottom');
            } else {
                slot.classList.add('quarter-hover-top');
            }

            // Create floating tooltip
            const rect = slot.getBoundingClientRect();
            const tooltip = document.createElement('div');
            tooltip.className = 'drag-tooltip';
            const dragDayEnd = res.hours[(parseInt(dayIndex) * 2) + 1];
            const dragCosmeticMin = res.cosmeticCloseMinutes || 0;
            tooltip.innerText = `${formatTime(adjustedTime)} - ${formatCosmeticTime(adjustedTime + 0.25, dragDayEnd, dragCosmeticMin)}`;
            tooltip.style.left = (rect.left + rect.width / 2) + 'px';
            tooltip.style.top = (rect.top - 35) + 'px';
            tooltip.style.transform = 'translateX(-50%)';
            document.body.appendChild(tooltip);
            dragState.tooltipElement = tooltip;
        } else {
            // Clean up floating tooltip/highlight from booked slot hover (in case dragLeave didn't fire)
            if (dragState.tooltipElement) {
                dragState.tooltipElement.remove();
                dragState.tooltipElement = null;
            }
            if (dragState.highlightElement) {
                dragState.highlightElement.remove();
                dragState.highlightElement = null;
            }
        }

        // Validate the drop target
        const validation = validateDropTarget(adjustedSlotId);

        if (validation.valid) {
            slot.classList.add('drag-over-valid');
            e.dataTransfer.dropEffect = 'move';
            dragState.lastInvalidReason = null;
            dragState.wasOverValidTarget = true;
        } else {
            slot.classList.add('drag-over-invalid');
            e.dataTransfer.dropEffect = 'none';
            dragState.lastInvalidReason = validation.reason;
            dragState.wasOverValidTarget = false;
        }
    }

    function handleDragLeave(e) {
        const el = e.currentTarget;
        el.classList.remove('drag-over-valid', 'drag-over-invalid');
        el.classList.remove('quarter-hover-top', 'quarter-hover-bottom');
        // Clean up data-time if it was set on a booked slot during drag
        if (el.classList.contains('booking-float')) {
            el.removeAttribute('data-time');
        }
        // Remove floating tooltip and highlight when leaving any slot
        if (dragState.tooltipElement) {
            dragState.tooltipElement.remove();
            dragState.tooltipElement = null;
        }
        if (dragState.highlightElement) {
            dragState.highlightElement.remove();
            dragState.highlightElement = null;
        }
    }

    // Calculate which time slot the mouse is over within a booked element
    function getTimeSlotFromPosition(e, bookingStart, bookingDuration, res) {
        const rect = e.currentTarget.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const useQuarter = res && res.useQuarterHour;
        const increment = useQuarter ? 0.25 : 0.5;
        const slotsPerHour = useQuarter ? 4 : 2;
        const slotHeight = rect.height / (bookingDuration * slotsPerHour);
        const slotIndex = Math.floor(relativeY / slotHeight);
        const targetTime = bookingStart + (slotIndex * increment);
        return targetTime;
    }

    function handleBookedSlotDragOver(e, booking, col, res, activeWeekKey) {
        e.preventDefault();
        if (!dragState.isDragging || !dragState.sourceId) return;

        // Clean up drag-over classes from any other elements (in case dragLeave didn't fire)
        document.querySelectorAll('.drag-over-valid, .drag-over-invalid').forEach(el => {
            if (el !== e.currentTarget) {
                el.classList.remove('drag-over-valid', 'drag-over-invalid');
            }
        });

        const bookingEl = e.currentTarget;
        bookingEl.classList.remove('drag-over-valid', 'drag-over-invalid');

        // Calculate target time based on mouse position (with quarter-hour support)
        const bookingRect = bookingEl.getBoundingClientRect();
        const relativeY = e.clientY - bookingRect.top;
        const useQuarter = res.useQuarterHour;
        const increment = useQuarter ? 0.25 : 0.5;
        const slotsPerHour = useQuarter ? 4 : 2;
        const bookingSlotHeight = bookingRect.height / (booking.data.duration * slotsPerHour);
        const maxSlotIndex = (booking.data.duration * slotsPerHour) - 1;
        const slotIndex = Math.max(0, Math.min(maxSlotIndex, Math.floor(relativeY / bookingSlotHeight)));
        const targetTime = booking.start + (slotIndex * increment);

        // Get grid slot positions to align highlight with actual grid (like empty slots)
        const container = document.getElementById('gridContainer');
        const minH = Math.min(...res.hours.filter((_, i) => i % 2 === 0).filter(h => h < 24));
        const gridSlotIndex = Math.floor((targetTime - minH) * 2); // Grid uses 30-min slots
        const quarterOffset = useQuarter ? ((targetTime - minH) * 2) % 1 : 0; // 0 or 0.5 for quarter offset

        // Find the grid slot element - slots are in grid order, find by querying
        const allSlots = Array.from(container.querySelectorAll('.slot'));
        const timeCells = Array.from(container.querySelectorAll('.time-cell'));

        // Use time-cell to get row position (they align with slot rows)
        const gridRowRect = timeCells[gridSlotIndex] ? timeCells[gridSlotIndex].getBoundingClientRect() : null;

        // Find a slot in the same column as the booking for width reference
        const columnSlots = allSlots.filter(s => {
            const slotRect = s.getBoundingClientRect();
            return Math.abs(slotRect.left - bookingRect.left) < 10; // Same column (with tolerance)
        });
        const refSlot = columnSlots[0];
        const slotRect = refSlot ? refSlot.getBoundingClientRect() : bookingRect;

        // Create or update slot highlight
        if (!dragState.highlightElement) {
            const highlight = document.createElement('div');
            highlight.className = 'drag-slot-highlight';
            document.body.appendChild(highlight);
            dragState.highlightElement = highlight;
        }

        // Position highlight to match actual grid slot (like empty slot behavior)
        const padding = 2;
        const gridSlotHeight = gridRowRect ? gridRowRect.height : slotRect.height;
        const highlightHeight = useQuarter ? (gridSlotHeight / 2) - padding - 1 : gridSlotHeight - padding * 2 - 1;
        const quarterPixelOffset = quarterOffset > 0 ? gridSlotHeight / 2 : 0;
        const highlightTop = (gridRowRect ? gridRowRect.top : slotRect.top) + padding + quarterPixelOffset;
        const highlightLeft = slotRect.left + padding;
        const highlightWidth = slotRect.width - padding * 2 - 1;

        dragState.highlightElement.style.left = highlightLeft + 'px';
        dragState.highlightElement.style.top = highlightTop + 'px';
        dragState.highlightElement.style.width = highlightWidth + 'px';
        dragState.highlightElement.style.height = Math.max(highlightHeight, 10) + 'px';

        // Create or update floating tooltip - position above the highlight
        const bsDayEnd = res.hours[(col.dayIndex * 2) + 1];
        const bsCosmeticMin = res.cosmeticCloseMinutes || 0;
        const tooltipText = `${formatTime(targetTime)} - ${formatCosmeticTime(targetTime + increment, bsDayEnd, bsCosmeticMin)}`;
        if (!dragState.tooltipElement) {
            const tooltip = document.createElement('div');
            tooltip.className = 'drag-tooltip';
            document.body.appendChild(tooltip);
            dragState.tooltipElement = tooltip;
        }
        dragState.tooltipElement.innerText = tooltipText;
        dragState.tooltipElement.style.left = (highlightLeft + highlightWidth / 2) + 'px';
        dragState.tooltipElement.style.transform = 'translateX(-50%)';
        dragState.tooltipElement.style.top = (highlightTop - 35) + 'px';
        
        // If dragging over a different booking, always invalid
        if (booking.id !== dragState.sourceId) {
            dragState.highlightElement.classList.add('invalid');
            e.dataTransfer.dropEffect = 'none';
            dragState.lastInvalidReason = "Cannot drop onto another booking.";
            dragState.wasOverValidTarget = false;
            return;
        }
        
        // Build virtual target slot ID
        let virtualTargetId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${targetTime}`;
        if (col.subIndex !== null) virtualTargetId += `_${col.subIndex}`;
        
        // Check if same slot
        if (isSameSlot(dragState.sourceId, virtualTargetId)) {
            dragState.highlightElement.classList.add('invalid');
            e.dataTransfer.dropEffect = 'none';
            dragState.lastInvalidReason = null; // Same slot is not an error
            dragState.wasOverValidTarget = false;
            return;
        }
        
        // Validate the virtual target
        const validation = validateDropTarget(virtualTargetId);
        
        if (validation.valid) {
            dragState.highlightElement.classList.remove('invalid');
            e.dataTransfer.dropEffect = 'move';
            dragState.lastInvalidReason = null;
            dragState.wasOverValidTarget = true;
        } else {
            dragState.highlightElement.classList.add('invalid');
            e.dataTransfer.dropEffect = 'none';
            dragState.lastInvalidReason = validation.reason;
            dragState.wasOverValidTarget = false;
        }
    }

    function handleBookedSlotDrop(e, booking, col, res, activeWeekKey) {
        e.preventDefault();
        
        const slot = e.currentTarget;
        slot.classList.remove('drag-over-valid', 'drag-over-invalid');
        slot.removeAttribute('data-time');
        
        // Clean up floating tooltip and highlight
        if (dragState.tooltipElement) {
            dragState.tooltipElement.remove();
            dragState.tooltipElement = null;
        }
        if (dragState.highlightElement) {
            dragState.highlightElement.remove();
            dragState.highlightElement = null;
        }
        
        if (!dragState.isDragging || !dragState.sourceId) return;
        
        // Only allow dropping on your own booking
        if (booking.id !== dragState.sourceId) {
            showToast("Cannot drop onto another booking.", "error");
            return;
        }
        
        // Calculate target time based on mouse position
        const targetTime = getTimeSlotFromPosition(e, booking.start, booking.data.duration, res);
        
        // Build virtual target slot ID
        let virtualTargetId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${targetTime}`;
        if (col.subIndex !== null) virtualTargetId += `_${col.subIndex}`;
        
        // Check for same-slot drop
        if (isSameSlot(dragState.sourceId, virtualTargetId)) {
            return;
        }
        
        // Validate the drop target
        const validation = validateDropTarget(virtualTargetId);
        
        if (!validation.valid) {
            showToast(validation.reason, "error");
            return;
        }
        
        // Show confirmation modal
        showMoveConfirmation(dragState.sourceId, virtualTargetId, dragState.sourceData);
    }

    function handleDrop(e) {
        e.preventDefault();

        const slot = e.currentTarget;
        slot.classList.remove('drag-over-valid', 'drag-over-invalid');
        slot.classList.remove('quarter-hover-top', 'quarter-hover-bottom');

        // Clean up floating tooltip/highlight
        if (dragState.tooltipElement) {
            dragState.tooltipElement.remove();
            dragState.tooltipElement = null;
        }
        if (dragState.highlightElement) {
            dragState.highlightElement.remove();
            dragState.highlightElement = null;
        }

        if (!dragState.isDragging || !dragState.sourceId) return;

        // Use adjusted slotId if available (for quarter-hour support)
        const targetSlotId = dragState.adjustedTargetSlotId || slot.dataset.slotId;

        // Check for same-slot drop
        if (isSameSlot(dragState.sourceId, targetSlotId)) {
            // Do nothing for same-slot drops
            return;
        }

        // Validate the drop target
        const validation = validateDropTarget(targetSlotId);

        if (!validation.valid) {
            showToast(validation.reason, 'error');
            return;
        }
        
        // Show confirmation modal
        showMoveConfirmation(dragState.sourceId, targetSlotId, dragState.sourceData);
    }

    function isSameSlot(sourceId, targetId) {
        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        
        const sourceSuffix = sourceId.substring(prefix.length);
        const targetSuffix = targetId.substring(prefix.length);
        
        const sourceParts = sourceSuffix.split('_');
        const targetParts = targetSuffix.split('_');
        
        const sourceDay = parseInt(sourceParts[1]);
        const sourceTime = parseFloat(sourceParts[2]);
        const sourceSubRaw = sourceParts[3];
        const sourceSub = normalizeSubIndex(sourceSubRaw);
        
        const targetDay = parseInt(targetParts[1]);
        const targetTime = parseFloat(targetParts[2]);
        const targetSubRaw = targetParts[3];
        const targetSub = normalizeSubIndex(targetSubRaw);
        
        return sourceDay === targetDay && 
               sourceTime === targetTime && 
               sourceSub === targetSub;
    }

    // NOTE: normalizeSubIndex is now defined in utils.js

    function validateDropTarget(targetSlotId) {
        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const isDayView = res.viewMode === 'day';
        
        // Parse target slot ID
        const targetSuffix = targetSlotId.substring(prefix.length);
        const targetParts = targetSuffix.split('_');
        const targetWeekKey = targetParts[0];
        const targetDay = parseInt(targetParts[1]);
        const targetTime = parseFloat(targetParts[2]);
        const targetSubRaw = targetParts[3];
        const targetSub = normalizeSubIndex(targetSubRaw);
        
        // Parse source slot ID
        const sourceSuffix = dragState.sourceId.substring(prefix.length);
        const sourceParts = sourceSuffix.split('_');
        const sourceWeekKey = sourceParts[0];
        
        // Check week boundaries
        if (sourceWeekKey !== targetWeekKey) {
            return { valid: false, reason: "Cannot move booking to a different week." };
        }
        
        // Check for closure date
        const targetDate = new Date(currentWeekStart);
        targetDate.setDate(targetDate.getDate() + targetDay);
        const closureReason = getClosureReason(res, targetDate);
        if (closureReason) {
            return { valid: false, reason: `Closed: ${closureReason}` };
        }

        // Check advance booking limit
        const advCheck = checkAdvanceLimit(res, targetWeekKey, targetDay);
        if (!advCheck.allowed) {
            return { valid: false, reason: advCheck.message };
        }
        
        // Get operating hours for target day
        const dayStart = res.hours[targetDay * 2];
        const dayEnd = res.hours[(targetDay * 2) + 1];
        
        // Check if slot is within operating hours
        if (targetTime < dayStart || targetTime >= dayEnd || dayStart === dayEnd) {
            return { valid: false, reason: "Target slot is outside operating hours." };
        }
        
        // Check if booking duration fits before closing
        const duration = dragState.sourceData.duration;
        const bookingEnd = targetTime + duration;
        if (bookingEnd > dayEnd) {
            return { valid: false, reason: "Booking duration exceeds closing time." };
        }
        
        // Check for conflicts with existing bookings
        const activeWeekKey = getWeekKey(isDayView ? currentDayDate : currentWeekStart);
        
        for (const key of Object.keys(allBookings)) {
            // Skip the booking we're moving
            if (key === dragState.sourceId) continue;
            
            // Only check bookings for the same resource and week
            if (!key.startsWith(res.id + "_" + activeWeekKey)) continue;
            
            const kSuffix = key.substring(prefix.length);
            const kParts = kSuffix.split('_');
            const kDay = parseInt(kParts[1]);
            const kTime = parseFloat(kParts[2]);
            const kSubRaw = kParts[3];
            const kSub = normalizeSubIndex(kSubRaw);
            
            // Only check same column (same day and sub-room)
            if (kDay !== targetDay) continue;
            if (kSub !== targetSub) continue;
            
            const kDuration = allBookings[key].duration;
            const kEnd = kTime + kDuration;
            
            // Check for overlap
            if (targetTime < kEnd && bookingEnd > kTime) {
                return { valid: false, reason: "Conflicts with existing booking." };
            }
        }
        
        return { valid: true };
    }

    function validateRescheduleTarget(targetSlotId) {
        if (!rescheduleMode.active || !rescheduleMode.sourceData) return { valid: false };
        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const isDayView = res.viewMode === 'day';

        const targetSuffix = targetSlotId.substring(prefix.length);
        const targetParts = targetSuffix.split('_');
        const targetWeekKey = targetParts[0];
        const targetDay = parseInt(targetParts[1]);
        const targetTime = parseFloat(targetParts[2]);
        const targetSub = targetParts[3] || '';

        if (targetSlotId === rescheduleMode.sourceId) return { valid: false };

        // Closure check
        const targetDate = new Date(targetWeekKey + 'T00:00:00');
        targetDate.setDate(targetDate.getDate() + targetDay);
        if (getClosureReason(res, targetDate)) return { valid: false };

        // Advance booking limit
        const advCheck = checkAdvanceLimit(res, targetWeekKey, targetDay);
        if (!advCheck.allowed) return { valid: false };

        // Operating hours
        const dayStart = res.hours[targetDay * 2];
        const dayEnd = res.hours[(targetDay * 2) + 1];
        if (targetTime < dayStart || targetTime >= dayEnd || dayStart === dayEnd) return { valid: false };

        // Duration fits
        const duration = rescheduleMode.sourceData.duration;
        const bookingEnd = targetTime + duration;
        if (bookingEnd > dayEnd) return { valid: false };

        // Conflict check
        const activeWeekKey = getWeekKey(isDayView ? currentDayDate : currentWeekStart);
        for (const key of Object.keys(allBookings)) {
            if (key === rescheduleMode.sourceId) continue;
            if (!key.startsWith(res.id + "_" + activeWeekKey)) continue;
            const kParts = key.substring(prefix.length).split('_');
            const kDay = parseInt(kParts[1]);
            const kTime = parseFloat(kParts[2]);
            const kSub = kParts[3] || '';
            if (kDay !== targetDay || kSub !== targetSub) continue;
            const kEnd = kTime + allBookings[key].duration;
            if (targetTime < kEnd && bookingEnd > kTime) return { valid: false };
        }

        return { valid: true };
    }

    function showMoveConfirmation(sourceId, targetId, bookingData) {
        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const isDayView = res.viewMode === 'day';
        
        // Parse source
        const sourceSuffix = sourceId.substring(prefix.length);
        const sourceParts = sourceSuffix.split('_');
        const sourceDay = parseInt(sourceParts[1]);
        const sourceTime = parseFloat(sourceParts[2]);
        
        // Parse target
        const targetSuffix = targetId.substring(prefix.length);
        const targetParts = targetSuffix.split('_');
        const targetDay = parseInt(targetParts[1]);
        const targetTime = parseFloat(targetParts[2]);
        
        const duration = bookingData.duration;
        
        // Get day names and dates
        let sourceDate, targetDate;
        if (isDayView) {
            sourceDate = new Date(currentDayDate);
            targetDate = new Date(currentDayDate);
        } else {
            sourceDate = new Date(currentWeekStart);
            sourceDate.setDate(sourceDate.getDate() + sourceDay);
            targetDate = new Date(currentWeekStart);
            targetDate.setDate(targetDate.getDate() + targetDay);
        }
        
        const sourceDayName = DAYS[sourceDay];
        const targetDayName = DAYS[targetDay];
        
        const moveCosmeticMin = res.cosmeticCloseMinutes || 0;
        const sourceDayEnd = res.hours[(sourceDay * 2) + 1];
        const targetDayEnd = res.hours[(targetDay * 2) + 1];

        // Include sub-room name for day-view resources
        const sourceSubIdx = sourceParts[3] || '';
        const targetSubIdx = targetParts[3] || '';
        const sourceRoomName = sourceSubIdx !== '' ? getSubRoomName(res, parseInt(sourceSubIdx)) : '';
        const targetRoomName = targetSubIdx !== '' ? getSubRoomName(res, parseInt(targetSubIdx)) : '';
        const sourceRoomSuffix = sourceRoomName ? ` (${sourceRoomName})` : '';
        const targetRoomSuffix = targetRoomName ? ` (${targetRoomName})` : '';

        const sourceFormatted = `${sourceDayName} ${sourceDate.getMonth()+1}/${sourceDate.getDate()}, ${formatTime(sourceTime)} - ${formatCosmeticTime(sourceTime + duration, sourceDayEnd, moveCosmeticMin)}${sourceRoomSuffix}`;
        const targetFormatted = `${targetDayName} ${targetDate.getMonth()+1}/${targetDate.getDate()}, ${formatTime(targetTime)} - ${formatCosmeticTime(targetTime + duration, targetDayEnd, moveCosmeticMin)}${targetRoomSuffix}`;
        
        // Populate modal
        document.getElementById('moveSourceId').value = sourceId;
        document.getElementById('moveTargetId').value = targetId;
        document.getElementById('movePatronName').innerText = bookingData.name;
        document.getElementById('moveFromTime').innerText = sourceFormatted;
        document.getElementById('moveToTime').innerText = targetFormatted;
        
        // Show modal
        document.getElementById('moveModal').style.display = 'flex';
    }

    // --- DRAG-TO-CREATE HANDLERS ---
    // Creating new bookings by clicking and dragging on empty time slots.
    // Shows a visual overlay during selection, then opens the booking modal.
    function startSelection(e, slotId, timeVal, col, res, activeWeekKey, slotElement) {
        // Only start on left click, not during other operations
        if (e.button !== 0) return;
        if (dragState.isSaving || dragState.isDragging || resizeState.active || selectionState.active) return;
        if (resizeJustEnded) return;
        if (rescheduleMode.active) return;

        // Check advance booking limit (no toast here; onclick handler shows it)
        const advCheck = checkAdvanceLimit(res, activeWeekKey, col.dayIndex);
        if (!advCheck.allowed) { return; }

        e.preventDefault();
        document.body.classList.add('is-dragging');

        // Calculate quarter-hour offset if enabled
        const quarterOffset = getQuarterHourOffset(e, slotElement, res);
        const adjustedTimeVal = timeVal + quarterOffset;

        // In quarter-hour mode, check if clicked quarter is blocked by existing booking
        if (res.useQuarterHour) {
            const quarterEnd = adjustedTimeVal + 0.25;
            const prefix = res.id + "_";
            const isBlocked = Object.keys(allBookings).some(key => {
                if (!key.startsWith(prefix + activeWeekKey)) return false;
                const kSuffix = key.substring(prefix.length);
                const kParts = kSuffix.split('_');
                const kDay = parseInt(kParts[1]);
                const kTime = parseFloat(kParts[2]);
                const kSubRaw = kParts[3];
                const kSub = normalizeSubIndex(kSubRaw);
                if (kDay !== col.dayIndex) return false;
                if (kSub !== normalizeSubIndex(col.subIndex)) return false;
                const bookingEnd = kTime + allBookings[key].duration;
                return adjustedTimeVal < bookingEnd && quarterEnd > kTime;
            });
            if (isBlocked) return;
        }

        // Build adjusted slotId with quarter offset
        let adjustedSlotId = `${res.id}_${activeWeekKey}_${col.dayIndex}_${adjustedTimeVal}`;
        if (col.subIndex !== null) adjustedSlotId += `_${col.subIndex}`;

        // Calculate max duration based on closing time and collisions
        const dayEnd = res.hours[(col.dayIndex * 2) + 1];
        const maxByClose = dayEnd - adjustedTimeVal;
        const maxByResource = res.maxDuration;

        // Find next booking in same column
        let nextBookingStart = dayEnd;
        const prefix = res.id + "_";
        Object.keys(allBookings).forEach(key => {
            if (!key.startsWith(prefix + activeWeekKey)) return;

            const kSuffix = key.substring(prefix.length);
            const kParts = kSuffix.split('_');
            const kDay = parseInt(kParts[1]);
            const kTime = parseFloat(kParts[2]);
            const kSubRaw = kParts[3];
            const kSub = normalizeSubIndex(kSubRaw);

            if (kDay !== col.dayIndex) return;
            if (kSub !== normalizeSubIndex(col.subIndex)) return;

            if (kTime >= adjustedTimeVal && kTime < nextBookingStart) {
                nextBookingStart = kTime;
            }
        });

        const maxByCollision = nextBookingStart - adjustedTimeVal;
        const maxDuration = Math.min(maxByClose, maxByResource, maxByCollision);

        const minDuration = res.useQuarterHour ? 0.25 : 0.5;
        if (maxDuration < minDuration) return;

        const rect = slotElement.getBoundingClientRect();

        // Build array of time cell positions for accurate slot detection
        const container = document.getElementById('gridContainer');
        const timeCells = Array.from(container.querySelectorAll('.time-cell'));
        const slotPositions = timeCells.map(cell => {
            const cellRect = cell.getBoundingClientRect();
            return { top: cellRect.top, bottom: cellRect.bottom, height: cellRect.height };
        });

        selectionState = {
            active: true,
            startSlotId: adjustedSlotId,
            startTime: adjustedTimeVal,
            startDayIndex: col.dayIndex,
            subIndex: col.subIndex,
            startY: e.clientY,
            startSlotIndex: 0, // Index into slotPositions array (not raw time-based slot index)
            slotPositions: slotPositions,
            maxDuration: maxDuration,
            currentDuration: minDuration,
            res: res,
            activeWeekKey: activeWeekKey,
            startSlotRect: rect,
            overlayElement: null,
            labelElement: null,
            useQuarterHour: res.useQuarterHour || false,
            quarterOffset: quarterOffset,
            dayEnd: dayEnd
        };

        // Find which slot index we're starting in
        for (let i = 0; i < slotPositions.length; i++) {
            if (e.clientY >= slotPositions[i].top && e.clientY < slotPositions[i].bottom) {
                selectionState.startSlotIndex = i;
                break;
            }
        }

        // Create overlay - position and size to match where booking will appear
        const overlayPadding = 2; // matches slot padding
        const overlay = document.createElement('div');
        overlay.className = 'selection-overlay';
        overlay.style.left = (rect.left + overlayPadding) + 'px';
        // Adjust overlay top position for quarter offset
        const overlayTop = slotPositions[selectionState.startSlotIndex].top + overlayPadding + (quarterOffset > 0 ? slotPositions[selectionState.startSlotIndex].height / 2 : 0);
        overlay.style.top = overlayTop + 'px';
        overlay.style.width = (rect.width - overlayPadding * 2 - 1) + 'px'; // match booking width
        // Initial height matches booking render (subtract padding and border)
        const initialHeight = (slotPositions[selectionState.startSlotIndex].height / (res.useQuarterHour ? 2 : 1)) - 5;
        overlay.style.height = Math.max(initialHeight, 10) + 'px';
        document.body.appendChild(overlay);
        selectionState.overlayElement = overlay;

        // Add centered label inside overlay
        const label = document.createElement('div');
        label.className = 'overlay-label';
        const selCosmeticMin = res.cosmeticCloseMinutes || 0;
        label.innerText = `${formatTime(adjustedTimeVal)} - ${formatCosmeticTime(adjustedTimeVal + minDuration, dayEnd, selCosmeticMin)} (${minDuration}h)`;
        overlay.appendChild(label);
        selectionState.labelElement = label;


        document.addEventListener('mousemove', doSelection);
        document.addEventListener('mouseup', endSelection);
    }
    
    function doSelection(e) {
        if (!selectionState.active) return;

        const positions = selectionState.slotPositions;
        const startIdx = selectionState.startSlotIndex;
        const useQuarter = selectionState.useQuarterHour;
        const increment = useQuarter ? 0.25 : 0.5;
        const minDuration = increment;

        // Find which slot the mouse is currently over
        let currentSlotIndex = startIdx;
        for (let i = startIdx; i < positions.length; i++) {
            if (e.clientY >= positions[i].top && e.clientY < positions[i].bottom) {
                currentSlotIndex = i;
                break;
            }
            // If mouse is below this slot, keep going
            if (e.clientY >= positions[i].bottom) {
                currentSlotIndex = i;
            }
        }

        // Calculate base duration from slots covered (each slot = 0.5h)
        const slotsCovered = currentSlotIndex - startIdx + 1;
        let baseDuration = slotsCovered * 0.5;

        // For quarter-hour mode, add finer granularity based on mouse position within current slot
        if (useQuarter && positions[currentSlotIndex]) {
            const currentSlotRect = positions[currentSlotIndex];
            const relativeY = e.clientY - currentSlotRect.top;
            const inBottomHalf = relativeY >= currentSlotRect.height / 2;

            // Adjust duration: subtract initial offset, add current position offset
            baseDuration = baseDuration - selectionState.quarterOffset;
            if (inBottomHalf) {
                baseDuration += 0.25;
            }
        }

        let newDuration = Math.max(minDuration, Math.min(selectionState.maxDuration, baseDuration));
        // Snap to increment
        newDuration = Math.round(newDuration / increment) * increment;
        newDuration = Math.max(minDuration, Math.min(selectionState.maxDuration, newDuration));

        selectionState.currentDuration = newDuration;

        // Update overlay to span from start to end
        if (selectionState.overlayElement && positions[startIdx]) {
            const slotHeight = positions[startIdx].height;
            const padding = 2;
            // quarterOffset is 0 or 0.25 (hours), convert to pixels: 0.25h = 0.5 slots
            const quarterOffset = selectionState.quarterOffset;
            const startPixelOffset = quarterOffset > 0 ? slotHeight / 2 : 0;
            const startTop = positions[startIdx].top + padding + startPixelOffset;

            // Height directly from duration (each hour = 2 slots), match booking render padding/border
            const overlayHeight = (newDuration * 2 * slotHeight) - padding * 2 - 1;

            selectionState.overlayElement.style.top = startTop + 'px';
            selectionState.overlayElement.style.height = Math.max(10, overlayHeight) + 'px';
        }

        if (selectionState.labelElement) {
            const endTime = selectionState.startTime + newDuration;
            const selDayEnd = selectionState.dayEnd;
            const selCosmetic = (selectionState.res && selectionState.res.cosmeticCloseMinutes) || 0;
            selectionState.labelElement.innerText = `${formatTime(selectionState.startTime)} - ${formatCosmeticTime(endTime, selDayEnd, selCosmetic)} (${newDuration}h)`;
        }
    }
    
    function endSelection(e) {
        if (!selectionState.active) return;
        
        document.removeEventListener('mousemove', doSelection);
        document.removeEventListener('mouseup', endSelection);
        document.body.classList.remove('is-dragging');
        
        if (selectionState.overlayElement) {
            selectionState.overlayElement.remove();
        }
        
        const duration = selectionState.currentDuration;
        const slotId = selectionState.startSlotId;
        const subIndex = selectionState.subIndex;
        
        selectionState = {
            active: false,
            startSlotId: null,
            startTime: 0,
            startDayIndex: 0,
            subIndex: null,
            startY: 0,
            startSlotIndex: 0,
            slotPositions: [],
            slotHeight: 0,
            maxDuration: 0,
            currentDuration: 0.5,
            res: null,
            activeWeekKey: null,
            startSlotRect: null,
            overlayElement: null,
            labelElement: null,
            useQuarterHour: false,
            quarterOffset: 0
        };
        
        openBookingModalWithDuration(slotId, subIndex, duration);
    }
    
    function openBookingModalWithDuration(slotId, subIndex, presetDuration) {
        const modal = document.getElementById('bookingModal');
        const res = resources.find(r => r.id === currentResId);
        
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length);
        const parts = suffix.split('_');
        const dayIdx = parseInt(parts[1]);
        const start = parseFloat(parts[2]);
        
        document.getElementById('subRoomIndex').value = (subIndex !== null && subIndex !== undefined) ? subIndex : '';

        const dayEnd = res.hours[(dayIdx * 2) + 1];
        const activeWeekKey = parts[0];
        const currentSubIdx = document.getElementById('subRoomIndex').value;
        let conflictingStarts = [];
        
        Object.keys(allBookings).forEach(k => {
            if (k.startsWith(res.id + "_" + activeWeekKey) && k !== slotId) {
                const pSuffix = k.substring(prefix.length);
                const p = pSuffix.split('_');
                const bDay = parseInt(p[1]);
                const bStart = parseFloat(p[2]);
                const bSub = p[3];
                
                if (bDay === dayIdx) {
                    const subMatch = (bSub == currentSubIdx) || (!bSub && !currentSubIdx);
                    if (subMatch) { if (bStart > start) conflictingStarts.push(bStart); }
                }
            }
        });
        
        conflictingStarts.sort((a,b) => a - b);
        const nextStart = conflictingStarts.length > 0 ? conflictingStarts[0] : dayEnd;
        const maxAvailable = nextStart - start;
        const limit = Math.min(maxAvailable, res.maxDuration);

        document.getElementById('slotId').value = slotId;
        document.getElementById('bookName').value = '';
        document.getElementById('bookNotes').value = '';
        document.getElementById('bookShowNotes').checked = res.defaultShowNotes || false;

        const showStaff = res.hasStaffField;
        document.getElementById('staffSection').style.display = showStaff ? 'block' : 'none';
        // Populate staff dropdown
        const staffSelDrag = document.getElementById('bookStaffName');
        const dragNames = (res.staffNames || []).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        let dragOptions = '<option value="">-- Select --</option>';
        dragNames.forEach(n => { dragOptions += '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; });
        staffSelDrag.innerHTML = dragOptions;
        document.getElementById('staffNameEmptyHint').classList.toggle('hidden', dragNames.length > 0);
        document.getElementById('bookHasStaff').checked = false;
        staffSelDrag.value = '';
        toggleStaffInput();

        const durSel = document.getElementById('bookDuration');
        durSel.innerHTML = '';
        const increment = res.useQuarterHour ? 0.25 : 0.5;
        const maxIterations = res.maxDuration / increment;
        for (let i = 1; i <= maxIterations; i++) {
            const val = i * increment;
            if (val > limit) continue;
            const opt = document.createElement('option');
            opt.value = val;
            const endVal = start + val;
            const dragModalCosmeticMin = res.cosmeticCloseMinutes || 0;
            opt.innerText = `${val} ${val === 1 ? "Hour" : "Hours"} (${formatTime(start)} - ${formatCosmeticTime(endVal, dayEnd, dragModalCosmeticMin)})`;
            if (val === presetDuration) opt.selected = true;
            durSel.appendChild(opt);
        }
        if (durSel.options.length === 0) {
            const opt = document.createElement('option');
            opt.innerText = "No time available";
            durSel.appendChild(opt);
        }
        
        // Check permissions and show/hide edit controls
        const canEdit = canEditResource(res);
        document.getElementById('btnSaveBooking').style.display = canEdit ? '' : 'none';
        document.getElementById('btnDeleteBooking').style.display = 'none'; // New booking, no delete
        document.getElementById('btnReschedule').classList.add('hidden'); // New booking, no reschedule
        document.getElementById('readOnlyNotice').style.display = canEdit ? 'none' : '';
        
        // Enable/disable form fields based on permissions
        document.getElementById('bookName').disabled = !canEdit;
        document.getElementById('bookDuration').disabled = !canEdit;
        document.getElementById('bookNotes').disabled = !canEdit;
        document.getElementById('bookShowNotes').disabled = !canEdit;
        document.getElementById('bookHasStaff').disabled = !canEdit;
        document.getElementById('bookStaffName').disabled = !canEdit;
        
        // Reset series info (not applicable for new bookings)
        document.getElementById('seriesInfo').classList.add('hidden');
        document.getElementById('seriesInfo').style.display = 'none';
        
        // Show recurring options if resource allows it and user can edit
        const recurSection = document.getElementById('recurringSection');
        if (canEdit && res.allowRecurring) {
            recurSection.style.display = '';
            document.getElementById('bookRecurring').checked = false;
            document.getElementById('recurringOptions').classList.add('hidden');
            document.getElementById('recurPattern').value = '7';
            document.getElementById('customDaysGroup').classList.add('hidden');
            document.getElementById('manualDatesGroup').classList.add('hidden');
            document.getElementById('recurEndControls').style.display = '';
            document.getElementById('recurEndType').value = 'count';
            document.getElementById('recurCount').value = '4';
            document.getElementById('recurCountGroup').classList.remove('hidden');
            document.getElementById('recurDateGroup').classList.add('hidden');
            manualSeriesDates = [];
            renderManualDates();
            
            // Set dynamic labels for monthly weekday options
            const slotDate = new Date(parts[0] + 'T00:00:00');
            slotDate.setDate(slotDate.getDate() + dayIdx);
            const weekdayName = slotDate.toLocaleDateString('en-US', { weekday: 'long' });
            const dayOfMonth = slotDate.getDate();
            const ordinal = Math.ceil(dayOfMonth / 7);
            const ordinalNames = ['', '1st', '2nd', '3rd', '4th', '5th'];
            document.getElementById('recurMonthlyWeekdayOpt').textContent = 
                `Monthly (${ordinalNames[ordinal]} ${weekdayName})`;
            document.getElementById('recurMonthlyLastOpt').textContent = 
                `Monthly (last ${weekdayName})`;
        } else {
            recurSection.style.display = 'none';
        }
        
        modal.style.display = 'flex';
        document.getElementById('bookName').focus();
    }

    function cancelMove() {
        closeModal('moveModal');
        // Clear drag state on cancel
        dragState.sourceId = null;
        dragState.sourceData = null;
    }

    // --- RESIZE HANDLERS ---
    // Changing booking duration by dragging the bottom edge of a booking element.
    // Shows overlay during resize, then shows confirmation modal.
    function startResize(e, booking, col, res, activeWeekKey, slotElement) {
        e.preventDefault();
        e.stopPropagation();
        
        // Block if saving or another operation is active
        if (dragState.isSaving || dragState.isDragging || resizeState.active || selectionState.active) return;
        
        // Hide any open popover
        hideBookingPopover();
        document.body.classList.add('is-dragging');
        
        // Calculate max duration based on closing time and collisions
        const dayEnd = res.hours[(col.dayIndex * 2) + 1];
        const maxByClose = dayEnd - booking.start;
        const maxByResource = res.maxDuration;
        
        // Find next booking in same column
        let nextBookingStart = dayEnd;
        const prefix = res.id + "_";
        Object.keys(allBookings).forEach(key => {
            if (key === booking.id) return;
            if (!key.startsWith(prefix + activeWeekKey)) return;
            
            const kSuffix = key.substring(prefix.length);
            const kParts = kSuffix.split('_');
            const kDay = parseInt(kParts[1]);
            const kTime = parseFloat(kParts[2]);
            const kSubRaw = kParts[3];
            const kSub = normalizeSubIndex(kSubRaw);
            
            if (kDay !== col.dayIndex) return;
            if (kSub !== normalizeSubIndex(col.subIndex)) return;
            
            // Only consider bookings that start after this one
            if (kTime > booking.start && kTime < nextBookingStart) {
                nextBookingStart = kTime;
            }
        });
        
        const maxByCollision = nextBookingStart - booking.start;
        const maxDuration = Math.min(maxByClose, maxByResource, maxByCollision);
        
        const rect = slotElement.getBoundingClientRect();
        
        // Build array of time cell positions for accurate slot detection
        const container = document.getElementById('gridContainer');
        const timeCells = Array.from(container.querySelectorAll('.time-cell'));
        const slotPositions = timeCells.map(cell => {
            const cellRect = cell.getBoundingClientRect();
            return { top: cellRect.top, bottom: cellRect.bottom, height: cellRect.height };
        });
        
        // Find which slot index the booking starts in (index into slotPositions array)
        let startSlotIndex = 0;
        const bookingTopY = rect.top;
        for (let i = 0; i < slotPositions.length; i++) {
            if (bookingTopY >= slotPositions[i].top && bookingTopY < slotPositions[i].bottom) {
                startSlotIndex = i;
                break;
            }
            if (bookingTopY >= slotPositions[i].top) {
                startSlotIndex = i;
            }
        }
        
        resizeState = {
            active: true,
            bookingId: booking.id,
            bookingData: booking.data,
            bookingStart: booking.start,
            col: col,
            res: res,
            activeWeekKey: activeWeekKey,
            startY: e.clientY,
            startSlotIndex: startSlotIndex,
            slotPositions: slotPositions,
            slotHeight: slotPositions.length > 0 ? slotPositions[0].height : 30,
            originalDuration: booking.data.duration,
            currentDuration: booking.data.duration,
            minDuration: res.useQuarterHour ? 0.25 : 0.5,
            maxDuration: maxDuration,
            originalRect: rect,
            overlayElement: null,
            labelElement: null,
            useQuarterHour: res.useQuarterHour || false
        };
        
        // Create overlay based on booking height (use same calculation as booking render)
        const slotHeight = slotPositions.length > 0 ? slotPositions[0].height : 30;
        const padding = 2; // matches booking element padding offset
        const overlayHeight = (booking.data.duration * 2 * slotHeight) - padding * 2 - 1;

        const overlay = document.createElement('div');
        overlay.className = 'resize-overlay';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        document.body.appendChild(overlay);
        resizeState.overlayElement = overlay;
        
        // Add centered label inside overlay
        const label = document.createElement('div');
        label.className = 'overlay-label';
        const resizeDayEnd = res.hours[(col.dayIndex * 2) + 1];
        const resizeCosmeticMin = res.cosmeticCloseMinutes || 0;
        label.innerText = `${formatTime(booking.start)} - ${formatCosmeticTime(booking.start + booking.data.duration, resizeDayEnd, resizeCosmeticMin)} (${booking.data.duration}h)`;
        overlay.appendChild(label);
        resizeState.labelElement = label;
        
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', endResize);
    }
    
    function doResize(e) {
        if (!resizeState.active) return;

        const useQuarter = resizeState.useQuarterHour;
        const increment = useQuarter ? 0.25 : 0.5;

        const deltaY = e.clientY - resizeState.startY;
        // For quarter-hour, each half-slot represents 0.25h
        const pixelsPerIncrement = useQuarter ? resizeState.slotHeight / 2 : resizeState.slotHeight;
        const incrementsDelta = Math.round(deltaY / pixelsPerIncrement);
        const durationDelta = incrementsDelta * increment;

        let newDuration = resizeState.originalDuration + durationDelta;
        newDuration = Math.max(resizeState.minDuration, Math.min(resizeState.maxDuration, newDuration));
        // Snap to increment
        newDuration = Math.round(newDuration / increment) * increment;
        newDuration = Math.max(resizeState.minDuration, Math.min(resizeState.maxDuration, newDuration));

        resizeState.currentDuration = newDuration;

        // Update overlay height (not the actual grid element) - match booking render padding/border
        if (resizeState.overlayElement) {
            const padding = 2;
            const newHeight = (resizeState.slotHeight * newDuration * 2) - padding * 2 - 1;
            resizeState.overlayElement.style.height = Math.max(newHeight, 20) + 'px';
        }

        // Update tooltip
        if (resizeState.labelElement) {
            const newEndTime = resizeState.bookingStart + newDuration;
            const rDayEnd = resizeState.res.hours[(resizeState.col.dayIndex * 2) + 1];
            const rCosmeticMin = resizeState.res.cosmeticCloseMinutes || 0;
            resizeState.labelElement.innerText = `${formatTime(resizeState.bookingStart)} - ${formatCosmeticTime(newEndTime, rDayEnd, rCosmeticMin)} (${newDuration}h)`;
        }
    }
    
    async function endResize(e) {
        if (!resizeState.active) return;
        
        document.removeEventListener('mousemove', doResize);
        document.removeEventListener('mouseup', endResize);
        document.body.classList.remove('is-dragging');
        
        // Set flag to prevent accidental clicks, clear after event loop settles
        resizeJustEnded = true;
        setTimeout(() => { resizeJustEnded = false; }, 100);
        
        // Clean up overlay (label is child, removed with it)
        if (resizeState.overlayElement) {
            resizeState.overlayElement.remove();
        }
        
        const newDuration = resizeState.currentDuration;
        const originalDuration = resizeState.originalDuration;
        
        // Only show confirmation if duration actually changed
        if (newDuration !== originalDuration) {
            showResizeConfirmation(
                resizeState.bookingId,
                resizeState.bookingData,
                resizeState.bookingStart,
                originalDuration,
                newDuration
            );
        }
        
        // Reset state
        resizeState = {
            active: false,
            bookingId: null,
            bookingData: null,
            bookingStart: 0,
            col: null,
            res: null,
            activeWeekKey: null,
            startY: 0,
            startSlotIndex: 0,
            slotPositions: [],
            slotHeight: 0,
            originalDuration: 0,
            currentDuration: 0,
            minDuration: 0.5,
            maxDuration: 0,
            originalRect: null,
            overlayElement: null,
            labelElement: null,
            useQuarterHour: false
        };
    }

    function showResizeConfirmation(bookingId, bookingData, bookingStart, oldDuration, newDuration) {
        document.getElementById('resizeBookingId').value = bookingId;
        document.getElementById('resizeNewDuration').value = newDuration;
        document.getElementById('resizePatronName').innerText = bookingData.name;

        const oldEnd = bookingStart + oldDuration;
        const newEnd = bookingStart + newDuration;
        const resizeRes = resources.find(r => r.id === currentResId);
        const parsed = parseSlotId(bookingId, currentResId);
        const resizeDayEnd = resizeRes ? resizeRes.hours[(parsed.dayIndex * 2) + 1] : 0;
        const resizeCosmeticMin = resizeRes ? (resizeRes.cosmeticCloseMinutes || 0) : 0;

        document.getElementById('resizeFromDuration').innerText =
            `${formatTime(bookingStart)} - ${formatCosmeticTime(oldEnd, resizeDayEnd, resizeCosmeticMin)} (${oldDuration} hour${oldDuration === 1 ? '' : 's'})`;
        document.getElementById('resizeToDuration').innerText =
            `${formatTime(bookingStart)} - ${formatCosmeticTime(newEnd, resizeDayEnd, resizeCosmeticMin)} (${newDuration} hour${newDuration === 1 ? '' : 's'})`;
        
        // Store booking data for the execute function
        document.getElementById('resizeModal').dataset.bookingData = JSON.stringify(bookingData);
        
        document.getElementById('resizeModal').style.display = 'flex';
    }

    function cancelResize() {
        closeModal('resizeModal');
    }

    async function executeResize() {
        if (dragState.isSaving) return;
        
        const bookingId = document.getElementById('resizeBookingId').value;
        const newDuration = parseFloat(document.getElementById('resizeNewDuration').value);
        const bookingData = JSON.parse(document.getElementById('resizeModal').dataset.bookingData);
        
        if (!bookingId || !bookingData) {
            showToast("Invalid booking data.", "error");
            closeModal('resizeModal');
            return;
        }
        
        dragState.isSaving = true;
        showLoading(true);
        closeModal('resizeModal');
        
        try {
            const updatedData = { ...bookingData, duration: newDuration };
            await db.collection('appointments').doc(bookingId).set(updatedData);
            showToast(`Duration updated to ${newDuration} hour${newDuration === 1 ? '' : 's'}`, 'success');
        } catch (error) {
            console.error("Resize error:", error);
            showToast("Failed to update duration: " + error.message, "error");
        } finally {
            dragState.isSaving = false;
            showLoading(false);
        }
    }

    async function executeMoveBooking() {
        if (dragState.isSaving) return;
        
        const sourceId = document.getElementById('moveSourceId').value;
        const targetId = document.getElementById('moveTargetId').value;
        
        if (!sourceId || !targetId || !allBookings[sourceId]) {
            showToast("Invalid booking data.", "error");
            closeModal('moveModal');
            return;
        }
        
        dragState.isSaving = true;
        showLoading(true);
        closeModal('moveModal');
        
        try {
            // Copy booking data
            const bookingData = { ...allBookings[sourceId] };
            
            // Use batch write for atomic operation
            const batch = db.batch();
            
            // Delete old document
            const oldRef = db.collection('appointments').doc(sourceId);
            batch.delete(oldRef);
            
            // Create new document with same data
            const newRef = db.collection('appointments').doc(targetId);
            batch.set(newRef, bookingData);
            
            await batch.commit();
            
            // Update stats metadata for the new location
            updateStatsYearMeta(currentResId, targetId);
            
            showToast("Booking moved successfully!", "success");
        } catch (error) {
            console.error("Move error:", error);
            showToast("Failed to move booking: " + error.message, "error");
        } finally {
            dragState.isSaving = false;
            dragState.sourceId = null;
            dragState.sourceData = null;
            showLoading(false);
        }
    }

    // --- RESCHEDULE MODE ---
    // Multi-step rescheduling: user enters reschedule mode from a booking modal,
    // navigates to the target day/week, then clicks an empty slot to place the booking.
    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let rescheduleMode = {
        active: false,
        sourceId: null,
        sourceData: null,
        sourceWeekKey: null,
        sourceDayIdx: null,
        sourceStartTime: null,
        sourceSubIdx: null,
        sourceResourceId: null
    };

    function openRescheduleModal() {
        enterRescheduleMode();
    }

    function enterRescheduleMode() {
        const slotId = document.getElementById('slotId').value;
        const booking = allBookings[slotId];
        if (!booking) {
            showToast("No booking found to reschedule.", "error");
            return;
        }

        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length);
        const parts = suffix.split('_');

        rescheduleMode.active = true;
        rescheduleMode.sourceId = slotId;
        rescheduleMode.sourceData = { ...booking };
        rescheduleMode.sourceWeekKey = parts[0];
        rescheduleMode.sourceDayIdx = parseInt(parts[1]);
        rescheduleMode.sourceStartTime = parseFloat(parts[2]);
        rescheduleMode.sourceSubIdx = parts[3] || '';
        rescheduleMode.sourceResourceId = currentResId;

        document.getElementById('rescheduleBannerText').innerHTML =
            `Moving <strong>${escapeHtml(booking.name)}</strong>'s booking (${booking.duration}h). Use the arrows to navigate to a different day or week if needed, then click any empty slot to place it.`;
        document.getElementById('rescheduleBanner').classList.remove('hidden');

        // Recalculate sidebar scrollbar after banner height change
        const sidebar = document.getElementById('infoSidebar');
        if (sidebar && !sidebar.classList.contains('hidden')) {
            sidebar.style.overflow = 'hidden';
            requestAnimationFrame(() => { sidebar.style.overflow = ''; });
        }

        closeModal('bookingModal');
        loadBookingsForCurrentView();
    }

    function cancelRescheduleMode(navigateToSource = true) {
        // Capture source location before clearing
        const sourceWeekKey = rescheduleMode.sourceWeekKey;
        const sourceDayIdx = rescheduleMode.sourceDayIdx;
        
        rescheduleMode.active = false;
        rescheduleMode.sourceId = null;
        rescheduleMode.sourceData = null;
        rescheduleMode.sourceWeekKey = null;
        rescheduleMode.sourceDayIdx = null;
        rescheduleMode.sourceStartTime = null;
        rescheduleMode.sourceSubIdx = null;
        rescheduleMode.sourceResourceId = null;

        document.getElementById('rescheduleBanner').classList.add('hidden');
        
        if (navigateToSource && sourceWeekKey) {
            // Navigate back to the booking's original week/day
            const [y, m, d] = sourceWeekKey.split('-').map(Number);
            const weekStart = new Date(y, m - 1, d);
            weekStart.setHours(0,0,0,0);
            currentWeekStart = weekStart;
            if (sourceDayIdx !== null && sourceDayIdx !== undefined) {
                const dayDate = new Date(weekStart);
                dayDate.setDate(dayDate.getDate() + sourceDayIdx);
                currentDayDate = dayDate;
            }
            updateUIControls();
        }
        
        loadBookingsForCurrentView();
        
        // Recalculate sidebar scrollbar after banner height change
        const sidebar = document.getElementById('infoSidebar');
        if (sidebar && !sidebar.classList.contains('hidden')) {
            sidebar.style.overflow = 'hidden';
            requestAnimationFrame(() => { sidebar.style.overflow = ''; });
        }
    }

    function handleRescheduleSlotClick(slotId, subIdx) {
        if (!rescheduleMode.active) return false;

        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length);
        const parts = suffix.split('_');
        const targetWeekKey = parts[0];
        const targetDayIdx = parseInt(parts[1]);
        const targetTime = parseFloat(parts[2]);
        const targetSubIdx = (subIdx !== null && subIdx !== undefined) ? String(subIdx) : '';

        if (slotId === rescheduleMode.sourceId) {
            showToast("This is the booking you're trying to move.", "info");
            return true;
        }

        // Check for closure
        const targetDayDate = new Date(targetWeekKey + 'T00:00:00');
        targetDayDate.setDate(targetDayDate.getDate() + targetDayIdx);
        if (getClosureReason(res, targetDayDate)) {
            showToast("Cannot reschedule to a closed day.", "error");
            return true;
        }

        // Check advance booking limit
        const advCheck = checkAdvanceLimit(res, targetWeekKey, targetDayIdx);
        if (!advCheck.allowed) {
            showToast(advCheck.message, "error");
            return true;
        }

        // Calculate max available
        const dayEnd = res.hours[(targetDayIdx * 2) + 1];
        let maxAvail = dayEnd - targetTime;

        Object.keys(allBookings).forEach(key => {
            if (key === rescheduleMode.sourceId) return;
            if (!key.startsWith(res.id + '_' + targetWeekKey + '_' + targetDayIdx + '_')) return;
            const kParts = key.substring(res.id.length + 1).split('_');
            const kSub = kParts[3] || '';
            if (kSub !== targetSubIdx) return;
            const bStart = parseFloat(kParts[2]);
            if (bStart > targetTime && bStart < targetTime + maxAvail) {
                maxAvail = bStart - targetTime;
            }
            const bEnd = bStart + allBookings[key].duration;
            if (targetTime >= bStart && targetTime < bEnd) {
                maxAvail = 0;
            }
        });

        if (maxAvail <= 0) {
            showToast("This slot is not available.", "error");
            return true;
        }

        const originalDuration = rescheduleMode.sourceData.duration;
        const newDuration = Math.min(maxAvail, originalDuration);
        const patronName = rescheduleMode.sourceData.name;

        // Format dates for modal
        const sourceDayDate = new Date(rescheduleMode.sourceWeekKey + 'T00:00:00');
        sourceDayDate.setDate(sourceDayDate.getDate() + rescheduleMode.sourceDayIdx);
        const sourceDateStr = sourceDayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const targetDateStr = targetDayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        // Get room names if applicable
        const sourceRoomName = rescheduleMode.sourceSubIdx !== '' ? getSubRoomName(res, parseInt(rescheduleMode.sourceSubIdx)) : '';
        const targetRoomName = targetSubIdx !== '' ? getSubRoomName(res, parseInt(targetSubIdx)) : '';
        const showRoomChange = sourceRoomName && targetRoomName && sourceRoomName !== targetRoomName;

        // Populate confirmation modal
        document.getElementById('rescheduleTargetWeekKey').value = targetWeekKey;
        document.getElementById('rescheduleTargetDayIdx').value = targetDayIdx;
        document.getElementById('rescheduleTargetTime').value = targetTime;
        document.getElementById('rescheduleTargetSubIdx').value = targetSubIdx;
        document.getElementById('rescheduleNewDuration').value = newDuration;

        document.getElementById('rescheduleConfirmPatron').textContent = patronName;
        const sourceRoomSuffix = sourceRoomName ? ` (${sourceRoomName})` : '';
        const targetRoomSuffix = targetRoomName ? ` (${targetRoomName})` : '';
        const reschCosmeticMin = res.cosmeticCloseMinutes || 0;
        const srcDayEnd = res.hours[(rescheduleMode.sourceDayIdx * 2) + 1];
        const tgtDayEnd = res.hours[(targetDayIdx * 2) + 1];
        document.getElementById('rescheduleConfirmFrom').textContent =
            `${sourceDateStr}, ${formatTime(rescheduleMode.sourceStartTime)} - ${formatCosmeticTime(rescheduleMode.sourceStartTime + originalDuration, srcDayEnd, reschCosmeticMin)}${sourceRoomSuffix}`;
        document.getElementById('rescheduleConfirmTo').textContent =
            `${targetDateStr}, ${formatTime(targetTime)} - ${formatCosmeticTime(targetTime + newDuration, tgtDayEnd, reschCosmeticMin)}${targetRoomSuffix}`;

        const warningEl = document.getElementById('rescheduleConfirmWarning');
        const durationRowEl = document.getElementById('rescheduleConfirmDurationRow');
        if (newDuration < originalDuration) {
            warningEl.innerHTML = `<strong>Note:</strong> Duration will be shortened from ${originalDuration}h to ${newDuration}h to fit this slot.`;
            warningEl.style.display = 'block';
            document.getElementById('rescheduleConfirmDuration').textContent = `${newDuration}h (was ${originalDuration}h)`;
            durationRowEl.style.display = 'flex';
        } else {
            warningEl.style.display = 'none';
            durationRowEl.style.display = 'none';
        }

        document.getElementById('rescheduleConfirmModal').style.display = 'flex';
        return true;
    }

    function confirmReschedule() {
        const targetWeekKey = document.getElementById('rescheduleTargetWeekKey').value;
        const targetDayIdx = parseInt(document.getElementById('rescheduleTargetDayIdx').value);
        const targetTime = parseFloat(document.getElementById('rescheduleTargetTime').value);
        const targetSubIdx = document.getElementById('rescheduleTargetSubIdx').value;
        const newDuration = parseFloat(document.getElementById('rescheduleNewDuration').value);

        closeModal('rescheduleConfirmModal');
        executeReschedule(targetWeekKey, targetDayIdx, targetTime, targetSubIdx, newDuration);
    }

    async function executeReschedule(targetWeekKey, targetDayIdx, targetTime, targetSubIdx, newDuration) {
        const res = resources.find(r => r.id === currentResId);
        if (!res) return;

        const sourceId = rescheduleMode.sourceId;
        let targetId = `${res.id}_${targetWeekKey}_${targetDayIdx}_${targetTime}`;
        if (targetSubIdx) targetId += `_${targetSubIdx}`;

        showLoading(true);

        try {
            const batch = db.batch();
            batch.delete(db.collection('appointments').doc(sourceId));
            batch.set(db.collection('appointments').doc(targetId), { ...rescheduleMode.sourceData, duration: newDuration });
            await batch.commit();

            updateStatsYearMeta(currentResId, targetId);

            const durationMsg = newDuration !== rescheduleMode.sourceData.duration ? ` (duration adjusted to ${newDuration}h)` : '';
            showToast(`Booking rescheduled successfully!${durationMsg}`, "success");
            cancelRescheduleMode(false);
        } catch (error) {
            console.error("Reschedule error:", error);
            showToast("Failed to reschedule: " + error.message, "error");
        } finally {
            showLoading(false);
        }
    }

    // --- MODAL & SAVE ---
    // Booking modal: form population, validation, saveBooking() for single bookings,
    // saveRecurringBooking() for repeating series, and recurring date pattern logic.
    function openBookingModal(slotId, data, subIdx) {
        const modal = document.getElementById('bookingModal');
        const res = resources.find(r => r.id === currentResId);
        
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length); 
        const parts = suffix.split('_');
        
        let start, dayIdx;
        if (data) {
             dayIdx = parseInt(parts[1]);
             start = parseFloat(parts[2]);
             document.getElementById('subRoomIndex').value = parts[3] || ''; 
        } else {
             dayIdx = parseInt(parts[1]);
             start = parseFloat(parts[2]);
             document.getElementById('subRoomIndex').value = (subIdx !== null && subIdx !== undefined) ? subIdx : '';
        }

        const dayEnd = res.hours[(dayIdx * 2) + 1];
        const activeWeekKey = parts[0];
        const currentSubIdx = document.getElementById('subRoomIndex').value;
        let conflictingStarts = [];
        
        Object.keys(allBookings).forEach(k => {
             if (k.startsWith(res.id + "_" + activeWeekKey) && k !== slotId) {
                 const pSuffix = k.substring(prefix.length);
                 const p = pSuffix.split('_');
                 const bDay = parseInt(p[1]);
                 const bStart = parseFloat(p[2]);
                 const bSub = p[3]; 
                 
                 if (bDay === dayIdx) {
                     const subMatch = (bSub == currentSubIdx) || (!bSub && !currentSubIdx);
                     if (subMatch) { if (bStart > start) conflictingStarts.push(bStart); }
                 }
             }
        });
        
        conflictingStarts.sort((a,b)=>a-b);
        const nextStart = conflictingStarts.length > 0 ? conflictingStarts[0] : dayEnd;
        const maxAvailable = nextStart - start;
        const limit = Math.min(maxAvailable, res.maxDuration);

        document.getElementById('slotId').value = slotId;
        
        const anon = data ? isBookingAnonymized(activeWeekKey, dayIdx, res) : false;
        const locked = data ? isBookingLocked(activeWeekKey, dayIdx, res) : false;
        
        document.getElementById('bookName').value = data ? (anon ? 'Past Booking' : data.name) : '';
        document.getElementById('bookNotes').value = data ? (anon ? 'Past notes anonymized for patron privacy' : data.notes) : '';
        
        document.getElementById('bookShowNotes').checked = data ? (data.showNotes || false) : (res.defaultShowNotes || false);

        const showStaff = res.hasStaffField;
        document.getElementById('staffSection').style.display = showStaff ? 'block' : 'none';
        // Populate staff dropdown
        const staffSelect = document.getElementById('bookStaffName');
        const configuredNames = (res.staffNames || []).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        let staffOptions = '<option value="">-- Select --</option>';
        configuredNames.forEach(n => {
            staffOptions += '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>';
        });
        // If editing and the existing staffName isn't in the configured list, add it
        const existingName = data ? (data.staffName || '') : '';
        if (existingName && !configuredNames.some(n => n.toLowerCase() === existingName.toLowerCase())) {
            staffOptions += '<option value="' + escapeHtml(existingName) + '">' + escapeHtml(existingName) + ' (unlisted)</option>';
        }
        staffSelect.innerHTML = staffOptions;
        document.getElementById('staffNameEmptyHint').classList.toggle('hidden', configuredNames.length > 0 || !!existingName);
        if(data) {
             document.getElementById('bookHasStaff').checked = data.hasStaff;
             staffSelect.value = existingName;
             // If value didn't match (case difference), try case-insensitive match
             if (!staffSelect.value && existingName) {
                 const match = configuredNames.find(n => n.toLowerCase() === existingName.toLowerCase());
                 if (match) staffSelect.value = match;
             }
        } else {
             document.getElementById('bookHasStaff').checked = false;
             staffSelect.value = '';
        }
        toggleStaffInput();

        const durSel = document.getElementById('bookDuration');
        durSel.innerHTML = '';
        const increment = res.useQuarterHour ? 0.25 : 0.5;
        const maxIterations = res.maxDuration / increment;
        for(let i=1; i<=maxIterations; i++) {
            const val = i * increment;
            if (val > limit && (!data || data.duration !== val)) continue;
            const opt = document.createElement('option');
            opt.value = val;

            const endVal = start + val;
            const startString = formatTime(start);
            const modalCosmeticMin = res.cosmeticCloseMinutes || 0;
            const endString = formatCosmeticTime(endVal, dayEnd, modalCosmeticMin);

            // Result: "1.5 Hours (2:00pm - 3:30pm)" (end time adjusted by cosmetic close if applicable)
            opt.innerText = `${val} ${val === 1 ? "Hour" : "Hours"} (${startString} - ${endString})`;

            if(data && data.duration == val) opt.selected = true;
            durSel.appendChild(opt);
        }
        if(durSel.options.length === 0) { const opt = document.createElement('option'); opt.innerText = "No time available"; durSel.appendChild(opt); }
        
        // Check permissions and show/hide edit controls
        const canEdit = canEditResource(res);
        document.getElementById('btnSaveBooking').style.display = (canEdit && !locked) ? '' : 'none';
        document.getElementById('btnDeleteBooking').style.display = (canEdit && data && !locked) ? '' : 'none';
        // Show reschedule button only for existing bookings that user can edit (not locked)
        if (canEdit && data && !locked) {
            document.getElementById('btnReschedule').classList.remove('hidden');
        } else {
            document.getElementById('btnReschedule').classList.add('hidden');
        }
        document.getElementById('readOnlyNotice').style.display = canEdit ? 'none' : '';

        // Disable form fields if read-only or locked
        document.getElementById('bookName').disabled = !canEdit || locked;
        document.getElementById('bookDuration').disabled = !canEdit || locked;
        document.getElementById('bookNotes').disabled = !canEdit || locked;
        document.getElementById('bookShowNotes').disabled = !canEdit || locked;
        document.getElementById('bookHasStaff').disabled = !canEdit || locked;
        document.getElementById('bookStaffName').disabled = !canEdit || locked;

        // Show series info for recurring bookings
        const seriesEl = document.getElementById('seriesInfo');
        if (data && data.seriesId) {
            seriesEl.classList.remove('hidden');
            seriesEl.style.display = '';
        } else {
            seriesEl.classList.add('hidden');
            seriesEl.style.display = 'none';
        }
        
        // Show recurring options for new bookings if resource allows it; hide for existing
        const recurSection = document.getElementById('recurringSection');
        if (!data && canEdit && res.allowRecurring) {
            recurSection.style.display = '';
            document.getElementById('bookRecurring').checked = false;
            document.getElementById('recurringOptions').classList.add('hidden');
            document.getElementById('recurPattern').value = '7';
            document.getElementById('customDaysGroup').classList.add('hidden');
            document.getElementById('manualDatesGroup').classList.add('hidden');
            document.getElementById('recurEndControls').style.display = '';
            document.getElementById('recurEndType').value = 'count';
            document.getElementById('recurCount').value = '4';
            document.getElementById('recurCountGroup').classList.remove('hidden');
            document.getElementById('recurDateGroup').classList.add('hidden');
            manualSeriesDates = [];
            renderManualDates();

            // Set dynamic labels for monthly weekday options
            const slotDate = new Date(parts[0] + 'T00:00:00');
            slotDate.setDate(slotDate.getDate() + dayIdx);
            const weekdayName = slotDate.toLocaleDateString('en-US', { weekday: 'long' });
            const dayOfMonth = slotDate.getDate();
            const ordinal = Math.ceil(dayOfMonth / 7);
            const ordinalNames = ['', '1st', '2nd', '3rd', '4th', '5th'];
            const ordinalStr = ordinalNames[ordinal] || ordinal + 'th';
            const opt30 = document.querySelector('#recurPattern option[value="30"]');
            if (opt30) opt30.textContent = `Monthly (same date, ${dayOfMonth})`;
            const optMW = document.querySelector('#recurPattern option[value="monthly-weekday"]');
            if (optMW) optMW.textContent = `Monthly (${ordinalStr} ${weekdayName})`;
        } else {
            recurSection.style.display = 'none';
        }

        modal.style.display = 'flex';
    }

    async function saveBooking() {
        const slotId = document.getElementById('slotId').value;
        const name = document.getElementById('bookName').value;
        const duration = parseFloat(document.getElementById('bookDuration').value);
        
        if(!name.trim()) return showToast("Please enter a name.", "error");
        if(isNaN(duration)) return showToast("Invalid duration.", "error");

        const hasStaff = document.getElementById('bookHasStaff').checked;
        const staffName = document.getElementById('bookStaffName').value;
        if (document.getElementById('staffSection').style.display !== 'none' && hasStaff && !staffName.trim()) {
            return showToast("Staff Name is required.", "error");
        }

        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length); 
        const parts = suffix.split('_');
        const start = parseFloat(parts[2]);
        const dayIdx = parseInt(parts[1]);

        const subIdx = parts[3] ? parseInt(parts[3]) : null;
        const weekKey = parts[0];

        if (isBookingLocked(weekKey, dayIdx, res)) {
            return showToast("Cannot edit a past booking.", "error");
        }

        // Safety net: check advance booking limit (new bookings only)
        const isNewBooking = !allBookings[slotId];
        if (isNewBooking) {
            const advCheck = checkAdvanceLimit(res, weekKey, dayIdx);
            if (!advCheck.allowed) return showToast(advCheck.message, "error");
        }
        const dayEnd = res.hours[(dayIdx * 2) + 1];
        
        if (start + duration > dayEnd) return showToast("Exceeds closing time.", "error");

        const end = start + duration;
        let conflictFound = false;

        Object.keys(allBookings).forEach(key => {
            if (key === slotId) return;

            const kSuffix = key.substring(prefix.length);
            const kParts = kSuffix.split('_');
            
            if (!key.startsWith(prefix)) return; 

            const kDay = parseInt(kParts[1]);
            const kSub = kParts[3] ? parseInt(kParts[3]) : null;

            if (kDay !== dayIdx) return;
            if (kSub != subIdx) return; 

            const bStart = parseFloat(kParts[2]);
            const bDuration = allBookings[key].duration;
            const bEnd = bStart + bDuration;

            if (start < bEnd && end > bStart) {
                conflictFound = true;
            }
        });

        if (conflictFound) {
            return showToast("Conflict: Time overlaps with another booking.", "error");
        }
        
        const showNotes = document.getElementById('bookShowNotes').checked;

        const data = { 
            name: name, 
            notes: document.getElementById('bookNotes').value, 
            duration: duration, 
            hasStaff: hasStaff, 
            staffName: staffName,
            showNotes: showNotes 
        };

        // Check if this is a recurring booking creation
        const isRecurring = document.getElementById('recurringSection').style.display !== 'none'
            && document.getElementById('bookRecurring').checked;

        if (isRecurring && isNewBooking) {
            await saveRecurringBooking(data, slotId, res, start, dayIdx, weekKey, subIdx);
            return;
        }

        showLoading(true);
        try { 
            await db.collection('appointments').doc(slotId).set(data);
            updateStatsYearMeta(res.id, slotId); // Update stats metadata
            delete statsBookingsCache[`${res.id}_${new Date().getFullYear()}`];
            closeModal('bookingModal'); 
        } 
        catch(e) { showToast("Error: " + e.message, "error"); }
        showLoading(false);
    }

    async function saveRecurringBooking(bookingData, baseSlotId, res, startTime, baseDayIdx, baseWeekKey, subIdx) {
        const pattern = document.getElementById('recurPattern').value;
        const endType = document.getElementById('recurEndType').value;
        
        // Calculate base date
        const [wy, wm, wd] = baseWeekKey.split('-').map(Number);
        const baseDate = new Date(wy, wm - 1, wd);
        baseDate.setDate(baseDate.getDate() + baseDayIdx);
        
        // Generate occurrence dates based on pattern
        let dates = [new Date(baseDate)];
        
        if (pattern === 'manual') {
            // Manual mode: base date + manually picked dates
            manualSeriesDates.forEach(ds => {
                const d = new Date(ds + 'T00:00:00');
                if (d.getTime() !== baseDate.getTime()) dates.push(d);
            });
            if (dates.length < 2) return showToast('Add at least one additional date for a series.', 'error');
        } else {
            // Pattern-based: generate dates using end condition
            const maxOccurrences = 52;
            let targetCount, endDate;
            
            if (endType === 'count') {
                targetCount = Math.min(parseInt(document.getElementById('recurCount').value) || 4, maxOccurrences);
            } else {
                const endDateVal = document.getElementById('recurEndDate').value;
                if (!endDateVal) return showToast('Please select an end date.', 'error');
                endDate = new Date(endDateVal + 'T00:00:00');
                if (endDate <= baseDate) return showToast('End date must be after the first booking date.', 'error');
                targetCount = maxOccurrences; // will be capped by endDate
            }
            
            if (pattern === 'monthly-date') {
                // Same date each month (e.g., the 15th)
                const targetDay = baseDate.getDate();
                let monthOffset = 1;
                while (dates.length < targetCount) {
                    // Always compute from baseDate to avoid drift
                    const year = baseDate.getFullYear();
                    const month = baseDate.getMonth() + monthOffset;
                    // Try target day; if month is too short, use last day of month
                    const daysInMonth = new Date(year, month + 1, 0).getDate();
                    const useDay = Math.min(targetDay, daysInMonth);
                    const next = new Date(year, month, useDay);
                    monthOffset++;
                    if (endDate && next > endDate) break;
                    if (monthOffset > 60) break; // safety
                    dates.push(next);
                }
            } else if (pattern === 'monthly-weekday') {
                // Nth weekday of month (e.g., 3rd Wednesday)
                const targetWeekday = baseDate.getDay();
                const targetOrdinal = Math.ceil(baseDate.getDate() / 7);
                let monthOffset = 1;
                while (dates.length < targetCount) {
                    const year = baseDate.getFullYear();
                    const month = baseDate.getMonth() + monthOffset;
                    const next = getNthWeekdayOfMonth(
                        new Date(year, month, 1).getFullYear(),
                        new Date(year, month, 1).getMonth(),
                        targetWeekday, targetOrdinal
                    );
                    monthOffset++;
                    if (monthOffset > 60) break;
                    if (!next) continue; // 5th occurrence doesn't exist this month
                    if (endDate && next > endDate) break;
                    dates.push(next);
                }
            } else if (pattern === 'monthly-last-weekday') {
                // Last weekday of month (e.g., last Tuesday)
                const targetWeekday = baseDate.getDay();
                let monthOffset = 1;
                while (dates.length < targetCount) {
                    const year = baseDate.getFullYear();
                    const month = baseDate.getMonth() + monthOffset;
                    const refDate = new Date(year, month, 1);
                    const next = getLastWeekdayOfMonth(refDate.getFullYear(), refDate.getMonth(), targetWeekday);
                    monthOffset++;
                    if (monthOffset > 60) break;
                    if (endDate && next > endDate) break;
                    dates.push(next);
                }
            } else {
                // Day-interval patterns (weekly=7, biweekly=14, 4-weekly=28, custom)
                let intervalDays;
                if (pattern === 'custom-days') {
                    intervalDays = parseInt(document.getElementById('recurCustomDays').value) || 10;
                    if (intervalDays < 2) intervalDays = 2;
                } else {
                    intervalDays = parseInt(pattern);
                }
                for (let i = 1; dates.length < targetCount; i++) {
                    const next = new Date(baseDate);
                    next.setDate(next.getDate() + (intervalDays * i));
                    if (endDate && next > endDate) break;
                    if (i > 365) break; // safety
                    dates.push(next);
                }
            }
            
            if (dates.length < 2) return showToast('A recurring series needs at least 2 occurrences.', 'error');
        }
        
        // Collect unique week keys to query for conflicts
        const weekKeysNeeded = new Set();
        dates.forEach(d => weekKeysNeeded.add(getWeekKey(d)));
        
        showLoading(true);
        
        // Query all needed weeks' bookings in parallel, reusing in-memory cache for current week
        const weekBookings = {};
        const currentWk = getWeekKey(currentWeekStart);
        // Pre-seed from the active listener's cached data to avoid re-fetching current week
        if (weekKeysNeeded.has(currentWk)) {
            Object.keys(allBookings).forEach(id => { weekBookings[id] = allBookings[id]; });
        }
        try {
            const queries = [...weekKeysNeeded]
                .filter(wk => wk !== currentWk)
                .map(wk => {
                    const qPrefix = `${res.id}_${wk}`;
                    return db.collection('appointments')
                        .where(firebase.firestore.FieldPath.documentId(), '>=', qPrefix)
                        .where(firebase.firestore.FieldPath.documentId(), '<', qPrefix + '\uf8ff')
                        .get()
                        .then(snapshot => {
                            snapshot.forEach(doc => { weekBookings[doc.id] = doc.data(); });
                        });
                });
            await Promise.all(queries);
        } catch (e) {
            showLoading(false);
            return showToast('Error checking conflicts: ' + e.message, 'error');
        }
        
        showLoading(false);
        
        // Check each date for closures, operating hours, and conflicts
        const skipped = [];
        const toCreate = [];
        const seriesId = 'ser-' + Date.now();
        const prefix = res.id + '_';
        
        for (const date of dates) {
            const weekKey = getWeekKey(date);
            const dayIdx = date.getDay();
            const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            
            // Check closure
            if (getClosureReason(res, date)) {
                skipped.push(dateStr + ' (closed)');
                continue;
            }
            
            // Check if day is open
            const dayStart = res.hours[dayIdx * 2];
            const dayEnd = res.hours[dayIdx * 2 + 1];
            if (dayStart === dayEnd) {
                skipped.push(dateStr + ' (not open)');
                continue;
            }
            
            // Check if booking fits within operating hours
            if (startTime + bookingData.duration > dayEnd) {
                skipped.push(dateStr + ' (exceeds closing time)');
                continue;
            }
            
            // Build slot ID
            let slotId = `${res.id}_${weekKey}_${dayIdx}_${startTime}`;
            if (subIdx) slotId += `_${subIdx}`;
            
            // Check for time conflicts
            const end = startTime + bookingData.duration;
            let hasConflict = false;
            Object.keys(weekBookings).forEach(key => {
                if (key === slotId) return;
                const kSuffix = key.substring(prefix.length);
                const kParts = kSuffix.split('_');
                const kDay = parseInt(kParts[1]);
                const kSub = kParts[3] || null;
                const checkSub = subIdx ? String(subIdx) : null;
                if (kDay !== dayIdx) return;
                if (kSub != checkSub) return;
                const bStart = parseFloat(kParts[2]);
                const bEnd = bStart + weekBookings[key].duration;
                if (startTime < bEnd && end > bStart) hasConflict = true;
            });
            
            if (hasConflict) {
                skipped.push(dateStr + ' (time conflict)');
                continue;
            }
            
            toCreate.push({ slotId, date });
        }
        
        if (toCreate.length === 0) {
            return showToast('No valid dates found for this series. All dates had conflicts or closures.', 'error');
        }
        
        // Show summary and confirm
        let msg = `Creating ${toCreate.length} booking(s) for "${bookingData.name}."`;
        if (skipped.length > 0) {
            const displaySkipped = skipped.length <= 8 
                ? skipped.join('\n') 
                : skipped.slice(0, 8).join('\n') + '\n...and ' + (skipped.length - 8) + ' more.';
            msg += `\n\nSkipping ${skipped.length} date(s):\n${displaySkipped}`;
        }
        msg += '\n\nContinue?';
        
        if (!confirm(msg)) return;
        
        // Batch create all bookings
        showLoading(true);
        try {
            const batch = db.batch();
            toCreate.forEach(({ slotId }) => {
                const ref = db.collection('appointments').doc(slotId);
                batch.set(ref, { ...bookingData, seriesId });
            });
            await batch.commit();
            
            if (toCreate.length > 0) updateStatsYearMeta(res.id, toCreate[0].slotId);
            closeModal('bookingModal');
            showToast(`${toCreate.length} recurring booking(s) created.`, 'success');
        } catch (e) {
            showToast('Error creating series: ' + e.message, 'error');
        }
        showLoading(false);
    }
    
    // NOTE: getNthWeekdayOfMonth, getLastWeekdayOfMonth are now defined in utils.js

    // --- ADMIN PANEL ---
    // Admin settings UI: resource management (create/delete/duplicate), operating
    // hours, sub-room configuration, booking rules, color palettes, and saveAllSettings().

    function openAdminPanel() {
        document.getElementById('adminPassInput').value = '';
        document.getElementById('adminPassModal').style.display = 'flex';
        setTimeout(() => document.getElementById('adminPassInput').focus(), 100);
    }

    function submitAdminPass() {
        const pass = document.getElementById('adminPassInput').value;
        closeModal('adminPassModal');
        if (pass !== ADMIN_PASS) return pass ? showToast("Incorrect Password.", "error") : null;
        document.getElementById('settingsOverlay').style.display = 'flex'; 
        document.querySelector('.settings-body').scrollTop = 0;
        document.getElementById('settingResSelect').value = currentResId; 
        loadSettingsForEditor(); 
    }
    
    function updatePalettePreview() {
        const val = document.getElementById('editColorPalette').value;
        const p = COLOR_PALETTES[val] || COLOR_PALETTES.default;
        document.getElementById('palettePreview').innerHTML = 
            `<span style="width:28px; height:28px; border-radius:4px; background:${p[0]};"></span>` +
            `<span style="width:28px; height:28px; border-radius:4px; background:${p[1]};"></span>` +
            `<span style="width:28px; height:28px; border-radius:4px; background:${p[2]};" title="Staff stripe"></span>`;
    }

    function loadSettingsForEditor() {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if(!r) return;
        document.getElementById('editResName').value = r.name;
        document.getElementById('editMaxDuration').value = r.maxDuration;
        document.getElementById('editResOrientation').checked = r.hasStaffField || false;
        cancelStaffNameEdit();
        toggleStaffNamesConfig();
        document.getElementById('editViewMode').value = r.viewMode || 'week';
        renderSubRoomCards(r);
        document.getElementById('editDefaultShowNotes').checked = r.defaultShowNotes || false;
        document.getElementById('editAdminOnly').checked = r.adminOnly || false;
        document.getElementById('editAnonymityBuffer').value = r.anonymityBufferMonths || 0;
        document.getElementById('editAllowRecurring').checked = r.allowRecurring || false;
        document.getElementById('editUseQuarterHour').checked = r.useQuarterHour || false;

        // Load Sidebar Settings
        document.getElementById('editEnableSidebar').checked = r.enableSidebar || false;
        document.getElementById('editSidebarText').value = r.sidebarText || '';
        toggleSidebarConfig();

        // Load Advance Booking Limit Settings
        document.getElementById('editAdvanceLimitEnabled').checked = r.advanceLimitEnabled || false;
        document.getElementById('editAdvanceLimitDays').value = r.advanceLimitDays !== undefined ? r.advanceLimitDays : 1;
        document.getElementById('editAdvanceLimitAdminBypass').checked = r.advanceLimitAdminBypass || false;
        toggleAdvanceLimitConfig();

        // Load Cosmetic Close Minutes
        document.getElementById('editCosmeticCloseMinutes').value = r.cosmeticCloseMinutes || 0;

        // Load Color Palette
        const palette = r.colorPalette || 'default';
        document.getElementById('editColorPalette').value = palette;
        updatePalettePreview();

        toggleSubRoomInput();
        const container = document.getElementById('daysConfigContainer');
        container.innerHTML = '';
        const stepVal = r.useQuarterHour ? '0.25' : '0.5';
        DAYS.forEach((d, i) => {
            const start = r.hours[i*2];
            const end = r.hours[(i*2)+1];
            const isClosed = start === end;
            container.innerHTML += `<div class="day-box ${isClosed ? 'day-closed' : ''}">
                <strong>${d}</strong>
                <div class="day-hours-inputs" ${isClosed ? 'style="opacity:0.3; pointer-events:none;"' : ''} id="dayInputs_${i}">
                    <input type="number" id="s_${i}" value="${start}" min="0" max="24" step="${stepVal}">
                    <input type="number" id="e_${i}" value="${end}" min="0" max="24" step="${stepVal}">
                </div>
                <label class="day-closed-label">
                    <input type="checkbox" id="closed_${i}" ${isClosed ? 'checked' : ''} onchange="toggleDayClosed(${i})" style="width:auto;">
                    <span>Closed</span>
                </label>
            </div>`;
        });
        
        // Load Closure Dates
        cancelClosureEdit();
        renderClosureList(r);
    }
    
    function toggleSettingsSection(headerEl) {
        const isCollapsing = !headerEl.classList.contains("collapsed");
        headerEl.classList.toggle("collapsed");
        const body = headerEl.nextElementSibling;
        body.classList.toggle("collapsed");
        if (!isCollapsing) {
            setTimeout(() => headerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
        }
    }

    function toggleSubRoomInput() { 
        const mode = document.getElementById('editViewMode').value; 
        const container = document.getElementById('subRoomConfig'); 
        if (mode === 'day') { container.classList.remove('hidden'); } 
        else { container.classList.add('hidden'); } 
    }

    function toggleDayClosed(dayIdx) {
        const cb = document.getElementById('closed_' + dayIdx);
        const inputs = document.getElementById('dayInputs_' + dayIdx);
        const dayBox = cb.closest('.day-box');
        if (cb.checked) {
            document.getElementById('s_' + dayIdx).value = 0;
            document.getElementById('e_' + dayIdx).value = 0;
            inputs.style.opacity = '0.3';
            inputs.style.pointerEvents = 'none';
            dayBox.classList.add('day-closed');
        } else {
            // Restore sensible defaults
            document.getElementById('s_' + dayIdx).value = 9;
            document.getElementById('e_' + dayIdx).value = 17;
            inputs.style.opacity = '';
            inputs.style.pointerEvents = '';
            dayBox.classList.remove('day-closed');
        }
    }

    // Temporary working copy of sub-rooms for settings editing
    let editingSubRooms = [];

    function renderSubRoomCards(res) {
        editingSubRooms = Array.isArray(res.subRooms) 
            ? res.subRooms.map(sr => ({ ...sr })) 
            : [];
        drawSubRoomCards();
    }

    function drawSubRoomCards() {
        const container = document.getElementById('subRoomCardList');
        if (!container) return;
        if (editingSubRooms.length === 0) {
            container.innerHTML = '<div style="font-size:0.85em; color:#999; padding: 8px;">No sub-rooms yet. Click "Add Sub-Room" to create one.</div>';
            return;
        }
        // Separate active and inactive
        const sorted = editingSubRooms
            .map((sr, idx) => ({ ...sr, _idx: idx }))
            .sort((a, b) => (a.displayOrder ?? a._idx) - (b.displayOrder ?? b._idx));
        
        const active = sorted.filter(sr => sr.active !== false);
        const inactive = sorted.filter(sr => sr.active === false);

        // Render active cards
        let html = active.map(sr => {
            return `<div class="subroom-card" data-idx="${sr._idx}" draggable="true">
                <div style="display:flex; align-items:center; gap:8px; flex:1;">
                    <span class="subroom-drag-handle" title="Drag to reorder">☰</span>
                    <input type="text" class="subroom-name-input" value="${escapeHtml(sr.name)}" 
                        onchange="updateSubRoomName(${sr._idx}, this.value)" 
                        placeholder="Room name">
                </div>
                <div style="display:flex; align-items:center; gap:4px;">
                    <button type="button" onclick="deactivateSubRoom(${sr._idx})" class="btn-danger" style="padding:4px 8px; font-size:0.8em;">Deactivate</button>
                </div>
            </div>`;
        }).join('');

        // Render collapsed inactive section
        if (inactive.length > 0) {
            html += `<div class="subroom-inactive-section">
                <div class="subroom-inactive-toggle" onclick="toggleInactiveSubRooms()">
                    <span id="inactiveSubRoomArrow" class="section-arrow" style="font-size:0.7em;">&#9654;</span>
                    <span style="font-size:0.85em; color:#888;">${inactive.length} inactive room${inactive.length > 1 ? 's' : ''}</span>
                </div>
                <div id="inactiveSubRoomList" class="hidden" style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
                    ${inactive.map(sr => `<div class="subroom-card subroom-inactive" data-idx="${sr._idx}">
                        <div style="display:flex; align-items:center; gap:8px; flex:1;">
                            <span style="color:#ccc; font-size:1.1em;">☰</span>
                            <input type="text" class="subroom-name-input" value="${escapeHtml(sr.name)}" disabled>
                        </div>
                        <div style="display:flex; align-items:center; gap:4px;">
                            <span class="subroom-badge-inactive">Inactive</span>
                            <button type="button" onclick="reactivateSubRoom(${sr._idx})" class="btn-success" style="padding:4px 8px; font-size:0.8em;">Reactivate</button>
                        </div>
                    </div>`).join('')}
                </div>
            </div>`;
        }

        container.innerHTML = html;

        // Attach drag event listeners to active cards (dragstart/dragend only)
        const cards = container.querySelectorAll('.subroom-card:not(.subroom-inactive)');
        cards.forEach(card => {
            card.addEventListener('dragstart', onSubRoomDragStart);
            card.addEventListener('dragend', onSubRoomDragEnd);
        });
        
        // Container-level drag handling for reliable drop targeting
        container.addEventListener('dragover', onSubRoomContainerDragOver);
        container.addEventListener('drop', onSubRoomContainerDrop);
        container.addEventListener('dragleave', onSubRoomContainerDragLeave);
    }

    function toggleInactiveSubRooms() {
        const list = document.getElementById('inactiveSubRoomList');
        const arrow = document.getElementById('inactiveSubRoomArrow');
        if (!list) return;
        const hidden = list.classList.toggle('hidden');
        arrow.innerHTML = hidden ? '&#9654;' : '&#9660;';
    }

    let subRoomDragIdx = null;

    function onSubRoomDragStart(e) {
        subRoomDragIdx = this.dataset.idx;
        this.classList.add('subroom-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Needed for Firefox
        e.dataTransfer.setData('text/plain', this.dataset.idx);
    }

    function onSubRoomContainerDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (subRoomDragIdx === null) return;
        
        const container = document.getElementById('subRoomCardList');
        // Remove any existing indicator
        const existing = container.querySelector('.subroom-drop-indicator');
        if (existing) existing.remove();
        
        // Find which active card we're over and whether above or below midpoint
        const activeCards = [...container.querySelectorAll('.subroom-card:not(.subroom-inactive):not(.subroom-dragging)')];
        if (activeCards.length === 0) return;
        
        let insertBefore = null;
        for (const card of activeCards) {
            const rect = card.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                insertBefore = card;
                break;
            }
        }
        
        // Create drop indicator line
        const indicator = document.createElement('div');
        indicator.className = 'subroom-drop-indicator';
        if (insertBefore) {
            container.insertBefore(indicator, insertBefore);
        } else {
            // After the last active card
            const lastActive = activeCards[activeCards.length - 1];
            if (lastActive.nextSibling) {
                container.insertBefore(indicator, lastActive.nextSibling);
            } else {
                container.appendChild(indicator);
            }
        }
    }
    
    function onSubRoomContainerDragLeave(e) {
        const container = document.getElementById('subRoomCardList');
        // Only remove indicator if we actually left the container
        if (!container.contains(e.relatedTarget)) {
            const indicator = container.querySelector('.subroom-drop-indicator');
            if (indicator) indicator.remove();
        }
    }

    function onSubRoomContainerDrop(e) {
        e.preventDefault();
        const container = document.getElementById('subRoomCardList');
        const indicator = container.querySelector('.subroom-drop-indicator');
        if (indicator) indicator.remove();
        
        if (subRoomDragIdx === null) return;
        
        // Determine drop position from active cards' visual order
        const activeCards = [...container.querySelectorAll('.subroom-card:not(.subroom-inactive):not(.subroom-dragging)')];
        
        let dropVisualPos = activeCards.length; // default: end
        for (let i = 0; i < activeCards.length; i++) {
            const rect = activeCards[i].getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                dropVisualPos = i;
                break;
            }
        }
        
        // Build current visual order of active items (excluding dragged)
        const dragArrIdx = parseInt(subRoomDragIdx);
        const activeOrder = activeCards.map(c => parseInt(c.dataset.idx));
        
        // Insert dragged item at the drop position
        activeOrder.splice(dropVisualPos, 0, dragArrIdx);
        
        // Include all inactive items at the end (preserve their relative order)
        const inactiveIdxs = editingSubRooms
            .map((sr, idx) => ({ sr, idx }))
            .filter(x => x.sr.active === false)
            .map(x => x.idx);
        
        const fullOrder = [...activeOrder, ...inactiveIdxs];
        
        // Reassign displayOrder
        fullOrder.forEach((arrIdx, newOrder) => {
            editingSubRooms[arrIdx].displayOrder = newOrder;
        });
        
        subRoomDragIdx = null;
        drawSubRoomCards();
    }

    function onSubRoomDragEnd() {
        subRoomDragIdx = null;
        const container = document.getElementById('subRoomCardList');
        if (container) {
            const indicator = container.querySelector('.subroom-drop-indicator');
            if (indicator) indicator.remove();
        }
        document.querySelectorAll('.subroom-dragging').forEach(el => {
            el.classList.remove('subroom-dragging');
        });
    }

    function addSubRoom() {
        const nextOrder = editingSubRooms.length > 0 
            ? Math.max(...editingSubRooms.map(sr => sr.displayOrder ?? 0)) + 1 
            : 0;
        editingSubRooms.push({
            id: 'sr-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            name: 'Room ' + (editingSubRooms.length + 1),
            active: true,
            displayOrder: nextOrder
        });
        drawSubRoomCards();
        // Focus the new input
        setTimeout(() => {
            const inputs = document.querySelectorAll('.subroom-name-input');
            if (inputs.length > 0) inputs[inputs.length - 1].focus();
        }, 50);
    }

    function updateSubRoomName(idx, newName) {
        if (editingSubRooms[idx]) editingSubRooms[idx].name = newName.trim() || 'Unnamed';
    }

    function deactivateSubRoom(idx) {
        if (!editingSubRooms[idx]) return;
        if (!confirm(`Deactivate "${editingSubRooms[idx].name}"?\n\nExisting bookings will be preserved but this column will no longer appear on the grid. You can reactivate it later.`)) return;
        editingSubRooms[idx].active = false;
        drawSubRoomCards();
    }

    function reactivateSubRoom(idx) {
        if (!editingSubRooms[idx]) return;
        editingSubRooms[idx].active = true;
        drawSubRoomCards();
    }

    function readSubRoomCards(target) {
        // Return the working copy as the new subRooms value
        return editingSubRooms.map(sr => ({
            id: sr.id,
            name: sr.name,
            active: sr.active !== false,
            displayOrder: sr.displayOrder ?? 0
        }));
    }

    function toggleSidebarConfig() {
        const isEnabled = document.getElementById('editEnableSidebar').checked;
        const container = document.getElementById('sidebarTextConfig');
        if (isEnabled) container.classList.remove('hidden');
        else container.classList.add('hidden');
    }

    function toggleAdvanceLimitConfig() {
        const isEnabled = document.getElementById('editAdvanceLimitEnabled').checked;
        const container = document.getElementById('advanceLimitConfig');
        if (isEnabled) container.classList.remove('hidden');
        else container.classList.add('hidden');
    }

    // --- CLOSURE DATE MANAGEMENT ---
    // Adding/removing closure dates (holidays), year-based storage, rendering the
    // closure list in admin panel, and applying closures across multiple resources.

    let editingClosureKey = null; // Set when editing an existing closure

    function toggleClosureEndDate(show) {
        document.getElementById('closureEndDateSection').style.display = show ? '' : 'none';
        document.getElementById('closureAddEndDateLink').style.display = show ? 'none' : '';
        if (!show) document.getElementById('newClosureEndDate').value = '';
    }

    function cancelClosureEdit() {
        editingClosureKey = null;
        document.getElementById('newClosureDate').value = '';
        document.getElementById('newClosureEndDate').value = '';
        document.getElementById('newClosureReason').value = '';
        toggleClosureEndDate(false);
        document.getElementById('closureAddBtn').textContent = 'Add';
        document.getElementById('closureCancelEditLink').style.display = 'none';
    }

    function editClosureDate(key) {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r || !r.closuresByYear) return;

        const parts = key.split('|');
        const startDate = parts[0];
        const endDate = parts[1] || null;
        const year = startDate.substring(0, 4);
        if (!r.closuresByYear[year]) return;

        const closure = r.closuresByYear[year].find(c => {
            if (endDate) return c.date === startDate && c.endDate === endDate;
            return c.date === startDate && !c.endDate;
        });
        if (!closure) return;

        editingClosureKey = key;
        document.getElementById('newClosureDate').value = closure.date;
        if (closure.endDate && closure.endDate !== closure.date) {
            toggleClosureEndDate(true);
            document.getElementById('newClosureEndDate').value = closure.endDate;
        } else {
            toggleClosureEndDate(false);
        }
        document.getElementById('newClosureReason').value = closure.reason || '';
        document.getElementById('closureAddBtn').textContent = 'Update';
        document.getElementById('closureCancelEditLink').style.display = '';
    }
    function renderClosureList(res) {
        // If called without argument, get current resource
        if (!res || typeof res !== 'object') {
            const editId = document.getElementById('settingResSelect').value;
            res = resources.find(x => x.id === editId);
            if (!res) return;
        }
        
        // Populate year selector
        const yearSelect = document.getElementById('closureYearSelect');
        const currentSelectedYear = yearSelect.value;
        const currentYear = new Date().getFullYear();
        const years = new Set();
        years.add(String(currentYear));
        if (res.closuresByYear) {
            Object.keys(res.closuresByYear).forEach(y => years.add(y));
        }
        const sortedYears = [...years].sort();
        yearSelect.innerHTML = sortedYears.map(y => 
            `<option value="${y}"${y === String(currentYear) ? ' selected' : ''}>${y}</option>`
        ).join('');
        // Restore previous selection if it exists
        if (currentSelectedYear && sortedYears.includes(currentSelectedYear)) {
            yearSelect.value = currentSelectedYear;
        }
        
        const selectedYear = yearSelect.value;
        const closures = getClosuresForYear(res, selectedYear);
        const container = document.getElementById('closureList');
        
        if (closures.length === 0) {
            container.innerHTML = `<div class="closure-empty">No closure dates for ${selectedYear}</div>`;
            return;
        }
        
        // Sort by start date
        const sorted = [...closures].sort((a, b) => a.date.localeCompare(b.date));
        
        container.innerHTML = sorted.map((c, idx) => {
            const startDate = new Date(c.date + 'T00:00');
            const startFormatted = startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            
            let dateDisplay;
            if (c.endDate && c.endDate !== c.date) {
                const endDate = new Date(c.endDate + 'T00:00');
                const endFormatted = endDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                dateDisplay = `${startFormatted} → ${endFormatted}`;
            } else {
                dateDisplay = startFormatted;
            }
            
            const removeKey = c.endDate ? `${c.date}|${c.endDate}` : c.date;
            const lastDate = new Date((c.endDate || c.date) + 'T00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const isPast = lastDate < today;

            return `
                <div class="closure-item${isPast ? ' closure-item-past' : ''}">
                    <div class="closure-item-info">
                        <span class="closure-item-date">${dateDisplay}</span>
                        <span class="closure-item-reason">${escapeHtml(c.reason || 'No reason specified')}</span>
                    </div>
                    ${isPast ? '' : `<div class="closure-item-actions">
                        <button onclick="editClosureDate('${removeKey}')">Edit</button>
                        <button class="btn-danger" onclick="removeClosureDate('${removeKey}')">Remove</button>
                    </div>`}
                </div>
            `;
        }).join('');
    }

    async function addClosureDate() {
        const dateInput = document.getElementById('newClosureDate');
        const endDateInput = document.getElementById('newClosureEndDate');
        const reasonInput = document.getElementById('newClosureReason');

        const startDate = dateInput.value;
        // Only read end date if the range section is visible
        const endDateVisible = document.getElementById('closureEndDateSection').style.display !== 'none';
        const endDate = endDateVisible ? endDateInput.value : '';
        const reason = reasonInput.value.trim();

        if (!startDate) {
            showToast("Please select a date.", "error");
            return;
        }

        if (endDate && endDate < startDate) {
            showToast("End date must be on or after start date.", "error");
            return;
        }

        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r) return;

        if (!r.closuresByYear) r.closuresByYear = {};
        const year = startDate.substring(0, 4);
        if (!r.closuresByYear[year]) r.closuresByYear[year] = [];

        const newStart = startDate;
        const newEnd = endDate || startDate;

        // If editing, temporarily remove old entry so overlap check doesn't flag itself
        let removedEntry = null;
        let removedYear = null;
        if (editingClosureKey) {
            const oldParts = editingClosureKey.split('|');
            const oldStart = oldParts[0];
            const oldEnd = oldParts[1] || null;
            removedYear = oldStart.substring(0, 4);
            if (r.closuresByYear[removedYear]) {
                const idx = r.closuresByYear[removedYear].findIndex(c => {
                    if (oldEnd) return c.date === oldStart && c.endDate === oldEnd;
                    return c.date === oldStart && !c.endDate;
                });
                if (idx >= 0) removedEntry = r.closuresByYear[removedYear].splice(idx, 1)[0];
                if (r.closuresByYear[removedYear].length === 0) delete r.closuresByYear[removedYear];
            }
            if (!r.closuresByYear[year]) r.closuresByYear[year] = [];
        }

        // Check for overlapping closures across all years
        const allClosures = getAllClosures(r);
        const hasOverlap = allClosures.some(c => {
            const existingStart = c.date;
            const existingEnd = c.endDate || c.date;
            return newStart <= existingEnd && newEnd >= existingStart;
        });

        if (hasOverlap) {
            // Restore old entry if editing
            if (removedEntry) {
                if (!r.closuresByYear[removedYear]) r.closuresByYear[removedYear] = [];
                r.closuresByYear[removedYear].push(removedEntry);
            }
            showToast("This date range overlaps with an existing closure.", "error");
            return;
        }

        // Check for existing bookings on the affected dates (skip if dates unchanged during edit)
        const isEditing = !!editingClosureKey;
        const oldParts = isEditing ? editingClosureKey.split('|') : [];
        const datesChanged = !isEditing || oldParts[0] !== startDate || (oldParts[1] || '') !== (endDate || '');

        if (datesChanged) {
            const affectedDates = [];
            let scanDate = new Date(newStart + 'T00:00:00');
            const scanEnd = new Date(newEnd + 'T00:00:00');
            while (scanDate <= scanEnd) {
                affectedDates.push(new Date(scanDate));
                scanDate.setDate(scanDate.getDate() + 1);
            }

            let totalConflicts = 0;
            const conflictDates = [];
            try {
                const weekGroups = {};
                affectedDates.forEach(date => {
                    const weekKey = getWeekKey(date);
                    const groupKey = `${editId}_${weekKey}`;
                    if (!weekGroups[groupKey]) weekGroups[groupKey] = [];
                    weekGroups[groupKey].push(date);
                });
                const queries = Object.entries(weekGroups).map(([groupPrefix, dates]) => {
                    const dayIndices = new Set(dates.map(d => d.getDay()));
                    return db.collection('appointments')
                        .where(firebase.firestore.FieldPath.documentId(), '>=', groupPrefix)
                        .where(firebase.firestore.FieldPath.documentId(), '<', groupPrefix + '\uf8ff')
                        .get()
                        .then(snapshot => {
                            snapshot.forEach(doc => {
                                const idParts = doc.id.substring(groupPrefix.length + 1).split('_');
                                const docDayIdx = parseInt(idParts[0]);
                                if (dayIndices.has(docDayIdx)) {
                                    totalConflicts++;
                                    const matchDate = dates.find(d => d.getDay() === docDayIdx);
                                    if (matchDate) {
                                        const dateStr = matchDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                                        if (!conflictDates.includes(dateStr)) conflictDates.push(dateStr);
                                    }
                                }
                            });
                        });
                });
                await Promise.all(queries);
            } catch (e) {
                // If query fails, proceed without warning
            }

            if (totalConflicts > 0) {
                const dateList = conflictDates.length <= 5
                    ? conflictDates.join(', ')
                    : conflictDates.slice(0, 5).join(', ') + ` and ${conflictDates.length - 5} more`;
                const msg = `${totalConflicts} existing booking(s) found on: ${dateList}.\n\nThey will be hidden but not deleted. Remove them manually if needed.\n\nContinue?`;
                if (!confirm(msg)) return;
            }
        }

        const closureEntry = {
            date: startDate,
            reason: reason || 'Closed'
        };

        if (endDate && endDate !== startDate) {
            closureEntry.endDate = endDate;
        }

        r.closuresByYear[year].push(closureEntry);

        // Reset form
        dateInput.value = '';
        endDateInput.value = '';
        reasonInput.value = '';
        toggleClosureEndDate(false);

        const wasEditing = !!editingClosureKey;
        editingClosureKey = null;
        document.getElementById('closureAddBtn').textContent = 'Add';
        document.getElementById('closureCancelEditLink').style.display = 'none';

        // Switch year selector to the year we just added to
        document.getElementById('closureYearSelect').value = year;

        renderClosureList(r);
        showToast(wasEditing ? "Closure date updated. Remember to save changes." : "Closure date added. Remember to save changes.", "success");
    }

    function removeClosureDate(key) {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r || !r.closuresByYear) return;
        
        const parts = key.split('|');
        const startDate = parts[0];
        const endDate = parts[1] || null;
        const year = startDate.substring(0, 4);
        
        if (!r.closuresByYear[year]) return;
        
        r.closuresByYear[year] = r.closuresByYear[year].filter(c => {
            if (endDate) {
                return !(c.date === startDate && c.endDate === endDate);
            } else {
                return !(c.date === startDate && !c.endDate);
            }
        });
        
        // Clean up empty year
        if (r.closuresByYear[year].length === 0) delete r.closuresByYear[year];
        
        renderClosureList(r);
        showToast("Closure date removed. Remember to save changes.", "success");
    }

    function openApplyClosuresModal() {
        const editId = document.getElementById('settingResSelect').value;
        const sourceRes = resources.find(x => x.id === editId);
        if (!sourceRes) return;

        const selectedYear = document.getElementById('closureYearSelect').value;
        const closures = getClosuresForYear(sourceRes, selectedYear);
        if (closures.length === 0) {
            showToast(`No closure dates for ${selectedYear} to apply.`, "error");
            return;
        }

        const otherResources = resources.filter(r => r.id !== editId);
        if (otherResources.length === 0) {
            showToast("No other resources to apply to.", "error");
            return;
        }

        document.getElementById('applyClosuresDesc').textContent =
            `Apply closures for ${selectedYear} from "${sourceRes.name}":`;

        // Closure selection checkboxes
        const sorted = [...closures].sort((a, b) => a.date.localeCompare(b.date));
        const dateContainer = document.getElementById('applyClosuresDateCheckboxes');
        dateContainer.innerHTML = sorted.map((c, idx) => {
            const startDate = new Date(c.date + 'T00:00');
            const startFmt = startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            let dateDisplay;
            if (c.endDate && c.endDate !== c.date) {
                const endDate = new Date(c.endDate + 'T00:00');
                const endFmt = endDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                dateDisplay = startFmt + ' \u2192 ' + endFmt;
            } else {
                dateDisplay = startFmt;
            }
            const key = c.endDate ? c.date + '|' + c.endDate : c.date;
            return `<label style="display:flex; align-items:center; gap:8px; padding:4px 8px; cursor:pointer; font-size:0.88em;">
                <input type="checkbox" name="applyClosureDate" value="${key}" style="width:auto;">
                <span><strong>${dateDisplay}</strong> <span style="color:#666;">${escapeHtml(c.reason || '')}</span></span>
            </label>`;
        }).join('');

        // Target resource checkboxes
        const container = document.getElementById('applyClosuresCheckboxes');
        container.innerHTML = otherResources.map(r => {
            const existing = getClosuresForYear(r, selectedYear).length;
            const note = existing > 0 ? ` (${existing} existing)` : '';
            return `<label style="display:flex; align-items:center; gap:8px; padding:4px 8px; cursor:pointer; font-size:0.88em;">
                <input type="checkbox" name="applyClosureTarget" value="${r.id}" checked style="width:auto;">
                <span>${escapeHtml(r.name)}${note}</span>
            </label>`;
        }).join('');

        document.getElementById('applyClosuresModal').style.display = 'flex';
    }
    
    async function confirmApplyClosures() {
        const editId = document.getElementById('settingResSelect').value;
        const sourceRes = resources.find(x => x.id === editId);
        const selectedYear = document.getElementById('closureYearSelect').value;
        const allClosures = getClosuresForYear(sourceRes, selectedYear);

        // Get selected closure keys
        const dateCheckboxes = document.querySelectorAll('input[name="applyClosureDate"]:checked');
        const selectedKeys = new Set([...dateCheckboxes].map(cb => cb.value));

        if (selectedKeys.size === 0) {
            showToast("No closure dates selected.", "error");
            return;
        }

        // Filter to only selected closures
        const closures = allClosures.filter(c => {
            const key = c.endDate ? c.date + '|' + c.endDate : c.date;
            return selectedKeys.has(key);
        });

        const targetCheckboxes = document.querySelectorAll('input[name="applyClosureTarget"]:checked');
        const targetIds = [...targetCheckboxes].map(cb => cb.value);

        if (targetIds.length === 0) {
            showToast("No resources selected.", "error");
            return;
        }

        let applied = 0;
        resources.forEach(r => {
            if (!targetIds.includes(r.id)) return;
            if (!r.closuresByYear) r.closuresByYear = {};
            if (!r.closuresByYear[selectedYear]) r.closuresByYear[selectedYear] = [];

            closures.forEach(c => {
                if (!r.closuresByYear[selectedYear].some(existing => existing.date === c.date)) {
                    r.closuresByYear[selectedYear].push({ ...c });
                }
            });
            applied++;
        });

        closeModal('applyClosuresModal');
        showLoading(true);
        try {
            await db.collection('system').doc('resources').set({ list: resources });
            showToast(`${closures.length} closure(s) applied to ${applied} resource(s).`, "success");
        } catch (e) {
            showToast("Error: " + e.message, "error");
        }
        showLoading(false);
    }

    // --- STAFF NAME LIST MANAGEMENT ---
    let editingStaffNameIdx = null;

    function toggleStaffNamesConfig() {
        const show = document.getElementById('editResOrientation').checked;
        document.getElementById('staffNamesConfig').classList.toggle('hidden', !show);
        if (show) renderStaffNameList();
    }

    function renderStaffNameList() {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r) return;
        const names = r.staffNames || [];
        const container = document.getElementById('staffNameList');
        if (names.length === 0) {
            container.innerHTML = '<div class="closure-empty">No staff names configured</div>';
            return;
        }
        const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        container.innerHTML = sorted.map(name => {
            return `<div class="closure-item">
                <div class="closure-item-info"><span class="closure-item-date">${escapeHtml(name)}</span></div>
                <div class="closure-item-actions">
                    <button onclick="editStaffName('${escapeHtml(name).replace(/'/g, "\\'")}')">Edit</button>
                    <button class="btn-danger" onclick="removeStaffName('${escapeHtml(name).replace(/'/g, "\\'")}')">Remove</button>
                </div>
            </div>`;
        }).join('');
    }

    function addStaffName() {
        const input = document.getElementById('newStaffName');
        const name = input.value.trim();
        if (!name) { showToast("Please enter a name.", "error"); return; }

        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r) return;
        if (!r.staffNames) r.staffNames = [];

        // Check for duplicates (case-insensitive)
        const nameLower = name.toLowerCase();
        const existingIdx = r.staffNames.findIndex(n => n.toLowerCase() === nameLower);

        if (editingStaffNameIdx !== null) {
            // Editing: check duplicate isn't a different entry
            if (existingIdx >= 0 && existingIdx !== editingStaffNameIdx) {
                showToast("This name already exists.", "error"); return;
            }
            r.staffNames[editingStaffNameIdx] = name;
            editingStaffNameIdx = null;
            document.getElementById('staffNameAddBtn').textContent = 'Add';
            document.getElementById('staffNameCancelEditLink').style.display = 'none';
            showToast("Staff name updated. Remember to save changes.", "success");
        } else {
            if (existingIdx >= 0) {
                showToast("This name already exists.", "error"); return;
            }
            r.staffNames.push(name);
            showToast("Staff name added. Remember to save changes.", "success");
        }

        input.value = '';
        renderStaffNameList();
    }

    function editStaffName(name) {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r || !r.staffNames) return;
        const idx = r.staffNames.indexOf(name);
        if (idx < 0) return;

        editingStaffNameIdx = idx;
        document.getElementById('newStaffName').value = name;
        document.getElementById('staffNameAddBtn').textContent = 'Update';
        document.getElementById('staffNameCancelEditLink').style.display = '';
    }

    function cancelStaffNameEdit() {
        editingStaffNameIdx = null;
        document.getElementById('newStaffName').value = '';
        document.getElementById('staffNameAddBtn').textContent = 'Add';
        document.getElementById('staffNameCancelEditLink').style.display = 'none';
    }

    function removeStaffName(name) {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if (!r || !r.staffNames) return;
        r.staffNames = r.staffNames.filter(n => n !== name);
        cancelStaffNameEdit();
        renderStaffNameList();
        showToast("Staff name removed. Remember to save changes.", "success");
    }

    function openApplyStaffNamesModal() {
        const editId = document.getElementById('settingResSelect').value;
        const sourceRes = resources.find(x => x.id === editId);
        if (!sourceRes) return;

        const names = sourceRes.staffNames || [];
        if (names.length === 0) {
            showToast("No staff names to apply.", "error"); return;
        }

        const otherResources = resources.filter(r => r.id !== editId && r.hasStaffField);
        if (otherResources.length === 0) {
            showToast("No other resources with staff fields enabled.", "error"); return;
        }

        document.getElementById('applyStaffNamesDesc').textContent =
            `Apply staff names from "${sourceRes.name}":`;

        const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        document.getElementById('applyStaffNameCheckboxes').innerHTML = sorted.map(name => {
            return `<label style="display:flex; align-items:center; gap:8px; padding:4px 8px; cursor:pointer; font-size:0.88em;">
                <input type="checkbox" name="applyStaffName" value="${escapeHtml(name)}" style="width:auto;">
                <span>${escapeHtml(name)}</span>
            </label>`;
        }).join('');

        document.getElementById('applyStaffNameTargetCheckboxes').innerHTML = otherResources.map(r => {
            const existing = (r.staffNames || []).length;
            const note = existing > 0 ? ` (${existing} existing)` : '';
            return `<label style="display:flex; align-items:center; gap:8px; padding:4px 8px; cursor:pointer; font-size:0.88em;">
                <input type="checkbox" name="applyStaffNameTarget" value="${r.id}" checked style="width:auto;">
                <span>${escapeHtml(r.name)}${note}</span>
            </label>`;
        }).join('');

        document.getElementById('applyStaffNamesModal').style.display = 'flex';
    }

    async function confirmApplyStaffNames() {
        const nameCheckboxes = document.querySelectorAll('input[name="applyStaffName"]:checked');
        const selectedNames = [...nameCheckboxes].map(cb => cb.value);

        if (selectedNames.length === 0) {
            showToast("No names selected.", "error"); return;
        }

        const targetCheckboxes = document.querySelectorAll('input[name="applyStaffNameTarget"]:checked');
        const targetIds = [...targetCheckboxes].map(cb => cb.value);

        if (targetIds.length === 0) {
            showToast("No resources selected.", "error"); return;
        }

        let applied = 0;
        resources.forEach(r => {
            if (!targetIds.includes(r.id)) return;
            if (!r.staffNames) r.staffNames = [];
            selectedNames.forEach(name => {
                if (!r.staffNames.some(n => n.toLowerCase() === name.toLowerCase())) {
                    r.staffNames.push(name);
                }
            });
            applied++;
        });

        closeModal('applyStaffNamesModal');
        showLoading(true);
        try {
            await db.collection('system').doc('resources').set({ list: resources });
            showToast(`${selectedNames.length} name(s) applied to ${applied} resource(s).`, "success");
        } catch (e) {
            showToast("Error: " + e.message, "error");
        }
        showLoading(false);
    }

    function openApplyHoursModal() {
        const editId = document.getElementById('settingResSelect').value;
        const sourceRes = resources.find(x => x.id === editId);
        if (!sourceRes) return;
        
        const otherResources = resources.filter(r => r.id !== editId);
        if (otherResources.length === 0) {
            showToast("No other resources to apply to.", "error");
            return;
        }
        
        document.getElementById('applyHoursDesc').textContent = 
            `Apply operating hours from "${sourceRes.name}" to:`;
        
        const container = document.getElementById('applyHoursCheckboxes');
        container.innerHTML = otherResources.map(r => {
            return `<label style="display:flex; align-items:center; gap:8px; padding:6px 4px; cursor:pointer;">
                <input type="checkbox" value="${r.id}" checked style="width:auto;">
                <span>${escapeHtml(r.name)}</span>
            </label>`;
        }).join('');
        
        document.getElementById('applyHoursModal').style.display = 'flex';
    }
    
    async function confirmApplyHours() {
        const editId = document.getElementById('settingResSelect').value;
        
        // Get current hours from the form inputs
        const currentHours = [];
        for (let i = 0; i < 7; i++) {
            currentHours[i * 2] = parseFloat(document.getElementById(`s_${i}`).value) || 0;
            currentHours[(i * 2) + 1] = parseFloat(document.getElementById(`e_${i}`).value) || 0;
        }
        
        const checkboxes = document.querySelectorAll('#applyHoursCheckboxes input[type="checkbox"]:checked');
        const targetIds = [...checkboxes].map(cb => cb.value);
        
        if (targetIds.length === 0) {
            showToast("No resources selected.", "error");
            return;
        }
        
        let applied = 0;
        resources.forEach(r => {
            if (!targetIds.includes(r.id)) return;
            r.hours = [...currentHours];
            applied++;
        });
        
        closeModal('applyHoursModal');
        showLoading(true);
        try {
            await db.collection('system').doc('resources').set({ list: resources });
            showToast(`Operating hours applied to ${applied} resource(s).`, "success");
        } catch (e) {
            showToast("Error: " + e.message, "error");
        }
        showLoading(false);
    }

    // --- NEW RESOURCE WITH IMPORT OPTION ---
    // Creating new resources with the option to clone settings (hours, closures,
    // all config) from an existing resource.
    async function addNewResource() {
        const name = prompt("Name for new resource?");
        if(!name) return;
        
        // If there are existing resources, show import options
        if (resources.length > 0) {
            // Show import modal
            pendingNewResource = {
                id: 'res-' + Date.now(),
                name: name,
                viewMode: 'week',
                hasStaffField: false,
                defaultShowNotes: false,
                enableSidebar: false,
                sidebarText: "",
                maxDuration: 2,
                hours: [...DEFAULT_HOURS],
                closuresByYear: {},
                useQuarterHour: false,
                advanceLimitEnabled: false,
                advanceLimitDays: 1,
                advanceLimitAdminBypass: false,
                allowRecurring: false,
                anonymityBufferMonths: 0
            };
            
            // Populate closure dates dropdown
            const closuresSelect = document.getElementById('importClosuresSource');
            closuresSelect.innerHTML = '<option value="">-- No, start fresh --</option>';
            const resourcesWithClosures = resources.filter(r => r.closuresByYear && Object.keys(r.closuresByYear).length > 0);
            resourcesWithClosures.forEach(r => {
                const count = getAllClosures(r).length;
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.innerText = `${r.name} (${count} closure dates)`;
                closuresSelect.appendChild(opt);
            });
            
            // Populate hours dropdown
            const hoursSelect = document.getElementById('importHoursSource');
            hoursSelect.innerHTML = '<option value="">-- Use default hours --</option>';
            resources.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r.id;
                opt.innerText = r.name;
                hoursSelect.appendChild(opt);
            });
            
            closeModal('settingsOverlay');
            
            // Track the resource being viewed as clone source
            cloneSourceId = document.getElementById('settingResSelect').value;
            const cloneSource = resources.find(r => r.id === cloneSourceId);
            const cloneLabel = document.getElementById('importCloneAllLabel');
            cloneLabel.textContent = cloneSource ? `Clone all settings from "${cloneSource.name}"` : 'Clone all settings from source resource';
            document.getElementById('importCloneAll').checked = false;
            document.getElementById('importIndividualOptions').style.opacity = '1';
            document.getElementById('importIndividualOptions').style.pointerEvents = 'auto';

            document.getElementById('importClosuresModal').style.display = 'flex';
        } else {
            // No existing resources, create directly with defaults
            showLoading(true);
            const newRes = {
                id: 'res-' + Date.now(),
                name: name,
                viewMode: 'week',
                hasStaffField: false,
                defaultShowNotes: false,
                enableSidebar: false,
                sidebarText: "",
                maxDuration: 2,
                hours: [...DEFAULT_HOURS],
                closuresByYear: {},
                useQuarterHour: false,
                advanceLimitEnabled: false,
                advanceLimitDays: 1,
                advanceLimitAdminBypass: false,
                allowRecurring: false,
                anonymityBufferMonths: 0
            };
            try { 
                pendingSelectionId = newRes.id;
                pendingOpenSettings = true;
                await db.collection('system').doc('resources').set({ list: [...resources, newRes] }); 
            } 
            catch (e) { showToast("Error: " + e.message, "error"); }
            showLoading(false);
        }
    }

    function toggleCloneAll() {
        const checked = document.getElementById('importCloneAll').checked;
        const opts = document.getElementById('importIndividualOptions');
        opts.style.opacity = checked ? '0.4' : '1';
        opts.style.pointerEvents = checked ? 'none' : 'auto';
    }

    async function confirmImportSettings() {
        if (!pendingNewResource) return;
        
        const cloneAll = document.getElementById('importCloneAll').checked;
        
        if (cloneAll && cloneSourceId) {
            const source = resources.find(r => r.id === cloneSourceId);
            if (source) {
                pendingNewResource.viewMode = source.viewMode || 'week';
                pendingNewResource.hasStaffField = source.hasStaffField || false;
                pendingNewResource.defaultShowNotes = source.defaultShowNotes || false;
                pendingNewResource.enableSidebar = source.enableSidebar || false;
                pendingNewResource.sidebarText = '';
                pendingNewResource.maxDuration = source.maxDuration || 2;
                pendingNewResource.hours = [...(source.hours || DEFAULT_HOURS)];
                pendingNewResource.closuresByYear = JSON.parse(JSON.stringify(source.closuresByYear || {}));
                pendingNewResource.useQuarterHour = source.useQuarterHour || false;
                pendingNewResource.advanceLimitEnabled = source.advanceLimitEnabled || false;
                pendingNewResource.advanceLimitDays = source.advanceLimitDays || 1;
                pendingNewResource.advanceLimitAdminBypass = source.advanceLimitAdminBypass || false;
                pendingNewResource.subRooms = Array.isArray(source.subRooms) 
                    ? source.subRooms.map(sr => ({ ...sr, id: 'sr-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4) }))
                    : [];
                pendingNewResource.adminOnly = source.adminOnly || false;
                pendingNewResource.allowRecurring = source.allowRecurring || false;
                pendingNewResource.anonymityBufferMonths = source.anonymityBufferMonths || 0;
                pendingNewResource.colorPalette = source.colorPalette || 'default';
            }
        } else {
            const importClosuresFromId = document.getElementById('importClosuresSource').value;
            const importHoursFromId = document.getElementById('importHoursSource').value;
            
            if (importClosuresFromId) {
                const sourceRes = resources.find(r => r.id === importClosuresFromId);
                if (sourceRes && sourceRes.closuresByYear) {
                    pendingNewResource.closuresByYear = JSON.parse(JSON.stringify(sourceRes.closuresByYear));
                }
            }
            
            if (importHoursFromId) {
                const sourceRes = resources.find(r => r.id === importHoursFromId);
                if (sourceRes && sourceRes.hours) {
                    pendingNewResource.hours = [...sourceRes.hours];
                }
            }
        }
        
        showLoading(true);
        closeModal('importClosuresModal');
        
        // Set flags BEFORE Firebase write since onSnapshot fires during await
        pendingSelectionId = pendingNewResource.id;
        pendingOpenSettings = true;
        
        const importedItems = [];
        if (cloneAll && cloneSourceId) {
            const source = resources.find(r => r.id === cloneSourceId);
            importedItems.push(`all settings from "${source ? source.name : 'source'}"`);
        } else {
            const closureCount = getAllClosures(pendingNewResource).length;
            if (closureCount > 0) {
                importedItems.push(`${closureCount} closure date(s)`);
            }
            if (document.getElementById('importHoursSource').value) {
                importedItems.push('operating hours');
            }
        }
        
        try { 
            await db.collection('system').doc('resources').set({ list: [...resources, pendingNewResource] }); 
            if (importedItems.length > 0) {
                showToast(`Resource created with imported ${importedItems.join(' and ')}!`, "success");
            }
        } 
        catch (e) { showToast("Error: " + e.message, "error"); }
        
        pendingNewResource = null;
        cloneSourceId = null;
        showLoading(false);
    }

    function cancelImportSettings() {
        pendingNewResource = null;
        cloneSourceId = null;
        closeModal('importClosuresModal');
        document.getElementById('settingsOverlay').style.display = 'flex';
        document.querySelector('.settings-body').scrollTop = 0;
    }
    
    async function deleteResource() {
        const delId = document.getElementById('settingResSelect').value;
        if (!delId) return;
        const res = resources.find(r => r.id === delId);
        if (!res) return;
        document.getElementById('deleteResourceName').textContent = `You are about to delete "${res.name}".`;
        document.getElementById('deleteResourcePassInput').value = '';
        document.getElementById('deleteResourceModal').style.display = 'flex';
        setTimeout(() => document.getElementById('deleteResourcePassInput').focus(), 100);
    }

    async function confirmDeleteResource() {
        const pass = document.getElementById('deleteResourcePassInput').value;
        if (pass !== ADMIN_PASS) {
            return pass ? showToast("Incorrect password.", "error") : null;
        }
        const delId = document.getElementById('settingResSelect').value;
        if (!delId) return;
        closeModal('deleteResourceModal');
        closeModal('settingsOverlay');
        showLoading(true);
        
        const deleted = resources.find(r => r.id === delId);
        const remaining = resources.filter(r => r.id !== delId);
        
        // Set currentResId BEFORE Firebase write since onSnapshot fires during await
        if (currentResId === delId) {
            currentResId = remaining.length > 0 ? remaining[0].id : null;
        }
        
        try {
            await db.collection('system').doc('resources').set({ list: remaining });
            showToast(`"${deleted ? deleted.name : 'Resource'}" deleted.`, "success");
        } 
        catch (e) { showToast("Error: " + e.message, "error"); }
        showLoading(false);
    }
    
    async function saveAllSettings() {
        const editId = document.getElementById('settingResSelect').value;
        const r = resources.find(x => x.id === editId);
        if(!r) return;
        const updatedList = JSON.parse(JSON.stringify(resources));
        const target = updatedList.find(x => x.id === editId);
        target.name = document.getElementById('editResName').value;
        target.maxDuration = parseFloat(document.getElementById('editMaxDuration').value) || 2;
        target.hasStaffField = document.getElementById('editResOrientation').checked;
        target.staffNames = r.staffNames || [];
        const newViewMode = document.getElementById('editViewMode').value;
        if (newViewMode !== (r.viewMode || 'week')) {
            const modeLabel = newViewMode === 'day' ? 'Day View' : 'Week View';
            if (!confirm(`⚠️ Changing the view mode to "${modeLabel}" will cause existing bookings to stop displaying correctly. They will not be lost, and switching back will restore them.\n\nOnly proceed if this resource has no bookings yet, or if you understand the consequences.\n\nContinue?`)) {
                return;
            }
        }
        target.viewMode = newViewMode;
        target.subRooms = readSubRoomCards(target);
        target.defaultShowNotes = document.getElementById('editDefaultShowNotes').checked;
        target.adminOnly = document.getElementById('editAdminOnly').checked;
        target.anonymityBufferMonths = parseInt(document.getElementById('editAnonymityBuffer').value, 10) || 0;
        target.allowRecurring = document.getElementById('editAllowRecurring').checked;
        target.useQuarterHour = document.getElementById('editUseQuarterHour').checked;

        // Save Sidebar Settings
        target.enableSidebar = document.getElementById('editEnableSidebar').checked;
        target.sidebarText = document.getElementById('editSidebarText').value;

        // Save Advance Booking Limit Settings
        target.advanceLimitEnabled = document.getElementById('editAdvanceLimitEnabled').checked;
        target.advanceLimitDays = parseInt(document.getElementById('editAdvanceLimitDays').value) || 0;
        target.advanceLimitAdminBypass = document.getElementById('editAdvanceLimitAdminBypass').checked;
        
        // Save Cosmetic Close Minutes
        target.cosmeticCloseMinutes = Math.min(15, Math.max(0, parseInt(document.getElementById('editCosmeticCloseMinutes').value) || 0));

        // Save Color Palette
        target.colorPalette = document.getElementById('editColorPalette').value || 'default';

        // Preserve closure dates from the in-memory resource (already updated by add/remove)
        target.closuresByYear = r.closuresByYear || {};

        for(let i=0; i<7; i++) { target.hours[i*2] = parseFloat(document.getElementById(`s_${i}`).value) || 0; target.hours[(i*2)+1] = parseFloat(document.getElementById(`e_${i}`).value) || 0; }
        showLoading(true);
        try { 
            await db.collection('system').doc('resources').set({ list: updatedList }); 
            showToast("Settings Saved!", "success"); 
            closeModal('settingsOverlay');
            
            // Run the lazy janitor in the background to scrub old bookings
            runLazyJanitor(target);
        } 
        catch (e) { showToast("Error: " + e.message, "error"); }
        showLoading(false);
    }

    async function checkAndRunJanitor() {
        try {
            const now = new Date();
            const monthKey = now.getFullYear() + "-" + (now.getMonth() + 1);
            const janitorRef = db.collection('system').doc('janitor');
            
            const shouldRun = await db.runTransaction(async (transaction) => {
                const janitorDoc = await transaction.get(janitorRef);
                let lastRunMonth = "";
                if (janitorDoc.exists) {
                    lastRunMonth = janitorDoc.data().lastRunMonth || "";
                }
                
                // Run automatically if we haven't run for this month yet
                if (lastRunMonth !== monthKey) {
                    transaction.set(janitorRef, { lastRunMonth: monthKey }, { merge: true });
                    return true;
                }
                return false;
            });

            if (shouldRun) {
                resources.forEach(res => runLazyJanitor(res));
            }
        } catch (e) {
            console.error("Janitor check failed:", e);
        }
    }

    async function runLazyJanitor(res) {
        if (!res) return;

        try {
            const today = new Date();
            const buffer = parseInt(res.anonymityBufferMonths || 0, 10);
            
            let cutoffDate = new Date(today);
            if (buffer > 0) {
                cutoffDate = new Date(today.getFullYear(), today.getMonth() - buffer, 1);
            }
            
            const cutoffWeekKey = getWeekKey(cutoffDate);
            const startWeekKey = res.lastScrubbedWeekKey || "";
            
            // If the bookmark is ahead of the cutoff (e.g. buffer was increased),
            // everything up to the bookmark is already scrubbed. We can just wait
            // for the cutoff to catch up to the bookmark in future months.
            if (startWeekKey && startWeekKey > cutoffWeekKey) {
                return;
            }
            
            let scrubCount = 0;
            let lastDoc = null;
            let hasMore = true;

            while (hasMore) {
                let query = db.collection('appointments')
                    .where(firebase.firestore.FieldPath.documentId(), '>=', res.id + '_' + startWeekKey)
                    .where(firebase.firestore.FieldPath.documentId(), '<=', res.id + '_' + cutoffWeekKey + '\uf8ff')
                    .limit(500);

                if (lastDoc) {
                    query = query.startAfter(lastDoc);
                }

                const snapshot = await query.get();
                
                if (snapshot.empty) {
                    hasMore = false;
                    break;
                }

                lastDoc = snapshot.docs[snapshot.docs.length - 1];
                let batch = db.batch();
                let batchCount = 0;

                for (const doc of snapshot.docs) {
                    const data = doc.data();
                    if (data.isScrubbed || (data.name === "Anonymized Patron" && !data.notes)) {
                        continue;
                    }

                    const prefix = res.id + "_";
                    const suffix = doc.id.substring(prefix.length);
                    const parts = suffix.split('_');
                    const weekKey = parts[0];
                    const dayIdx = parseInt(parts[1]);

                    if (isBookingAnonymized(weekKey, dayIdx, res, today)) {
                        batch.update(doc.ref, {
                            name: "Anonymized Patron",
                            notes: "",
                            isScrubbed: true
                        });
                        scrubCount++;
                        batchCount++;
                    }
                }

                if (batchCount > 0) {
                    await batch.commit();
                }

                if (snapshot.docs.length < 500) {
                    hasMore = false;
                }
            }

            if (scrubCount > 0) {
                console.log(`Lazy Janitor scrubbed ${scrubCount} old bookings for resource ${res.name}.`);
            }
            
            // Update the checkpoint so we don't re-read these weeks next month
            if (res.lastScrubbedWeekKey !== cutoffWeekKey) {
                const systemRef = db.collection('system').doc('resources');
                const systemDoc = await systemRef.get();
                if (systemDoc.exists) {
                    const list = systemDoc.data().list;
                    const rIndex = list.findIndex(r => r.id === res.id);
                    if (rIndex !== -1) {
                        list[rIndex].lastScrubbedWeekKey = cutoffWeekKey;
                        await systemRef.update({ list });
                        res.lastScrubbedWeekKey = cutoffWeekKey;
                    }
                }
            }
        } catch (err) {
            console.error("Janitor error:", err);
        }
    }
    
    function handleResourceChange() {
        hideBookingPopover();
        currentResId = document.getElementById('resourceSelect').value;

        if (rescheduleMode.active && rescheduleMode.sourceResourceId !== currentResId) {
            cancelRescheduleMode();
            showToast("Reschedule cancelled - switched resource.", "info");
        }

        const url = new URL(window.location);
        url.searchParams.set('resource', currentResId);
        window.history.pushState({}, '', url);

        updateUIControls();

        loadBookingsForCurrentView();
    }
    // --- BOOKING POPOVER & HIGHLIGHTS ---
    // Hover popover showing booking details, highlight effects, and deleteBooking()
    // with series-aware deletion (single vs. entire series).

    function highlightBooking(id) { document.querySelectorAll(`.booking-float[data-bid="${id}"]`).forEach(s => s.classList.add('booking-hover-effect')); }
    function unhighlightBooking(id) { document.querySelectorAll(`.booking-float[data-bid="${id}"]`).forEach(s => s.classList.remove('booking-hover-effect')); }
    let activePopover = null;
    
    function showBookingPopover(e, booking) {
        hideBookingPopover(); // Clear any existing
        
        const popover = document.createElement('div');
        popover.className = 'booking-popover';
        const anon = booking.anonymized;
        
        const res = resources.find(r => r.id === currentResId);
        const popDayEnd = res ? res.hours[(booking.dayIndex * 2) + 1] : 0;
        const popCosmeticMin = res ? (res.cosmeticCloseMinutes || 0) : 0;

        let html = `<div class="popover-name">${anon ? 'Past Booking' : escapeHtml(booking.data.name)}</div>`;
        html += `<div class="popover-time">${formatTime(booking.start)} - ${formatCosmeticTime(booking.end, popDayEnd, popCosmeticMin)} (${booking.data.duration}h)</div>`;
        
        if (booking.data.hasStaff && booking.data.staffName) {
            html += `<div class="popover-staff">w/ ${escapeHtml(booking.data.staffName)}</div>`;
        }
        
        if (booking.data.seriesId) {
            html += `<div class="popover-series">🔁 Recurring series</div>`;
        }
        
        if (anon) {
            if (booking.data.notes) {
                html += `<div class="popover-notes" style="font-style: italic; opacity: 0.8;">Past notes anonymized for patron privacy</div>`;
            }
        } else if (booking.data.notes) {
            if (booking.data.showNotes) {
                html += `<div class="popover-notes">${escapeHtml(booking.data.notes)}</div>`;
            } else {
                html += `<div class="popover-notes" style="font-style: italic; opacity: 0.8;">📝 Click to view note</div>`;
            }
        }
        
        popover.innerHTML = html;
        document.body.appendChild(popover);
        activePopover = popover;
        
        updatePopoverPosition(e);
    }
    
    function updatePopoverPosition(e) {
        if (!activePopover) return;
        
        const padding = 12;
        const popoverRect = activePopover.getBoundingClientRect();
        
        let left = e.clientX + padding;
        let top = e.clientY + padding;
        
        // Keep within viewport
        if (left + popoverRect.width > window.innerWidth) {
            left = e.clientX - popoverRect.width - padding;
        }
        if (top + popoverRect.height > window.innerHeight) {
            top = e.clientY - popoverRect.height - padding;
        }
        
        activePopover.style.left = left + 'px';
        activePopover.style.top = top + 'px';
    }
    
    function hideBookingPopover() {
        if (activePopover) {
            activePopover.remove();
            activePopover = null;
        }
    }
    
    async function deleteBooking() { 
        const slotId = document.getElementById('slotId').value;
        const booking = allBookings[slotId];
        if(!booking) return closeModal('bookingModal');
        
        const res = resources.find(r => r.id === currentResId);
        const prefix = res.id + "_";
        const suffix = slotId.substring(prefix.length); 
        const parts = suffix.split('_');
        const weekKey = parts[0];
        const dayIdx = parseInt(parts[1]);
        
        if (isBookingLocked(weekKey, dayIdx, res)) {
            return showToast("Cannot delete a past booking.", "error");
        }
        
        if (booking.seriesId) {
            // Series booking - show series delete modal
            pendingSeriesDeleteSlotId = slotId;
            pendingSeriesDeleteSeriesId = booking.seriesId;
            document.getElementById('seriesDeleteModal').style.display = 'flex';
        } else {
            if(confirm("Delete booking?")) { 
                showLoading(true); 
                try {
                    await db.collection('appointments').doc(slotId).delete();
                    closeModal('bookingModal');
                } catch(e) {
                    showToast("Error deleting: " + e.message, "error");
                }
                showLoading(false); 
            }
        }
    }

    let pendingSeriesDeleteSlotId = null;
    let pendingSeriesDeleteSeriesId = null;

    async function confirmSeriesDelete(mode) {
        closeModal('seriesDeleteModal');
        
        if (mode === 'one') {
            showLoading(true);
            try {
                await db.collection('appointments').doc(pendingSeriesDeleteSlotId).delete();
                delete statsBookingsCache[`${currentResId}_${new Date().getFullYear()}`];
                closeModal('bookingModal');
                showToast('Booking deleted.', 'success');
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
            showLoading(false);
        } else if (mode === 'all') {
            if (!confirm('Delete ALL bookings in this series? This cannot be undone.')) return;
            showLoading(true);
            try {
                const snapshot = await db.collection('appointments')
                    .where('seriesId', '==', pendingSeriesDeleteSeriesId)
                    .get();
                const batch = db.batch();
                snapshot.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                delete statsBookingsCache[`${currentResId}_${new Date().getFullYear()}`];
                closeModal('bookingModal');
                showToast(snapshot.size + ' booking(s) in series deleted.', 'success');
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
            showLoading(false);
        }
        
        pendingSeriesDeleteSlotId = null;
        pendingSeriesDeleteSeriesId = null;
    }
    
    // --- UTILITY FUNCTIONS ---
    // Shared helpers: modal management, DOM creation, time formatting,
    // date helpers, advance limit checking, recurring booking toggles.

    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    // Global Escape key handler: closes the topmost visible modal
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        // Order matters: check child/confirmation modals first, then parent modals
        const modalPriority = [
            'seriesDeleteModal',
            'rescheduleConfirmModal',
            'moveModal',
            'resizeModal',
            'deleteResourceModal',
            'applyHoursModal',
            'applyClosuresModal',
            'importClosuresModal',
            'adminPassModal',
            'bookingModal',
            'statsModal',
            'settingsOverlay'
        ];
        for (const id of modalPriority) {
            const el = document.getElementById(id);
            if (el && el.style.display === 'flex') {
                closeModal(id);
                return;
            }
        }
    });
    function createDiv(cls, content) { const d = document.createElement('div'); d.className = cls; d.innerHTML = content; return d; }
    function showLoading(show) { document.getElementById('loading').className = show ? 'loading-overlay' : 'loading-overlay hidden'; }
    function toggleStaffInput() { const isChecked = document.getElementById('bookHasStaff').checked; document.getElementById('staffInputContainer').classList.toggle('hidden', !isChecked); }
    function toggleRecurringOptions() { 
        const isChecked = document.getElementById('bookRecurring').checked; 
        document.getElementById('recurringOptions').classList.toggle('hidden', !isChecked); 
    }
    function toggleRecurEndDate() {
        const val = document.getElementById('recurEndType').value;
        document.getElementById('recurCountGroup').classList.toggle('hidden', val !== 'count');
        document.getElementById('recurDateGroup').classList.toggle('hidden', val !== 'date');
    }
    function onRecurPatternChange() {
        const val = document.getElementById('recurPattern').value;
        const isManual = val === 'manual';
        const isCustomDays = val === 'custom-days';
        document.getElementById('customDaysGroup').classList.toggle('hidden', !isCustomDays);
        document.getElementById('manualDatesGroup').classList.toggle('hidden', !isManual);
        document.getElementById('recurEndControls').style.display = isManual ? 'none' : '';
    }
    
    let manualSeriesDates = [];
    
    function addManualDate() {
        const input = document.getElementById('manualDateInput');
        const val = input.value;
        if (!val) return;
        if (manualSeriesDates.includes(val)) {
            showToast('Date already added.', 'error');
            return;
        }
        manualSeriesDates.push(val);
        manualSeriesDates.sort();
        input.value = '';
        renderManualDates();
    }
    
    function removeManualDate(dateStr) {
        manualSeriesDates = manualSeriesDates.filter(d => d !== dateStr);
        renderManualDates();
    }
    
    function renderManualDates() {
        const container = document.getElementById('manualDatesList');
        if (manualSeriesDates.length === 0) {
            container.innerHTML = '<span style="font-size:0.85em; color:#999;">No additional dates added yet.</span>';
            return;
        }
        container.innerHTML = manualSeriesDates.map(d => {
            const display = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            return `<span class="manual-date-chip">${display} <span class="chip-remove" onclick="removeManualDate('${d}')">&times;</span></span>`;
        }).join('');
    }
    function handleBookingEnter(e) { if (e.key === 'Enter' && !document.getElementById('btnSaveBooking').classList.contains('hidden')) saveBooking(); }
    function checkAdvanceLimit(res, weekKey, dayIdx) {
        if (!res.advanceLimitEnabled) return { allowed: true };
        if (res.advanceLimitAdminBypass && currentUserRole === 'admin') return { allowed: true };
        const targetDate = new Date(weekKey + 'T00:00:00');
        targetDate.setDate(targetDate.getDate() + parseInt(dayIdx));
        targetDate.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (targetDate <= today) return { allowed: true };
        const daysLimit = res.advanceLimitDays || 0;
        if (daysLimit === 0) {
            return { allowed: false, message: "Bookings for this resource can only be made for today." };
        }
        let openDaysCounted = 0;
        let maxDate = new Date(today);
        const scanDate = new Date(today);
        for (let i = 0; i < 365; i++) {
            scanDate.setDate(scanDate.getDate() + 1);
            const dow = scanDate.getDay();
            const dayStart = res.hours[dow * 2];
            const dayEnd = res.hours[(dow * 2) + 1];
            if (dayStart === dayEnd) continue;
            if (getClosureReason(res, scanDate)) continue;
            openDaysCounted++;
            maxDate = new Date(scanDate);
            if (openDaysCounted >= daysLimit) break;
        }
        if (targetDate > maxDate) {
            const cutoff = maxDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
            const message = `Bookings for this resource can only be made through ${cutoff}.`;
            return { allowed: false, message };
        }
        return { allowed: true };
    }

    // NOTE: isBookingAnonymized, getWeekKey, formatDateShort, escapeHtml, formatTime
    // are now defined in utils.js (loaded before this file).

    function getQuarterHourOffset(e, slotElement, res) {
        if (!res.useQuarterHour) return 0;
        const rect = slotElement.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        return (relativeY >= rect.height / 2) ? 0.25 : 0;
    }

    // --- STATS FUNCTIONS ---
    // Statistics modal: heatmap calendar, dashboard charts (utilization, peak hours,
    // duration distribution, day-of-week analysis), summary metrics, and CSV export.
    let statsData = {}; // Cache for loaded stats
    // NOTE: getWeekStart is now defined in utils.js

    // Update stats metadata when a booking is saved
    async function updateStatsYearMeta(resId, slotId) {
        try {
            // Extract year from slotId (format: resId_weekKey_dayIndex_startTime)
            const prefix = resId + '_';
            const suffix = slotId.substring(prefix.length);
            const weekKey = suffix.split('_')[0]; // YYYY-MM-DD
            const year = parseInt(weekKey.split('-')[0]);
            
            if (isNaN(year)) return;
            
            // Get current metadata
            const metaRef = db.collection('system').doc('stats_meta');
            const metaDoc = await metaRef.get();
            
            let meta = metaDoc.exists ? metaDoc.data() : {};
            
            // Add year if not already present for this resource
            if (!meta[resId]) {
                meta[resId] = [];
            }
            
            if (!meta[resId].includes(year)) {
                meta[resId].push(year);
                meta[resId].sort((a, b) => b - a); // Sort descending
                await metaRef.set(meta);
                statsMetaCache = meta; // Update in-memory cache
            }
        } catch (err) {
            console.error('Error updating stats meta:', err);
            // Non-critical, don't block the save
        }
    }
    
    async function openStatsModal() {
        const modal = document.getElementById('statsModal');
        
        // Populate resource dropdown
        const resSel = document.getElementById('statsResourceSelect');
        resSel.innerHTML = '';
        resources.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.innerText = r.name;
            if (r.id === currentResId) opt.selected = true;
            resSel.appendChild(opt);
        });
        
        modal.style.display = 'flex';
        toggleStatsView('grid');
        await populateYearDropdown();
        loadStatsData();
    }
    
    async function populateYearDropdown() {
        const resId = document.getElementById('statsResourceSelect').value;
        const yearSel = document.getElementById('statsYearSelect');

        yearSel.innerHTML = '<option>Loading...</option>';
        
        try {
            // Use in-memory cache if available, otherwise read from Firestore
            let metaData = statsMetaCache;
            if (!metaData) {
                const metaDoc = await db.collection('system').doc('stats_meta').get();
                metaData = metaDoc.exists ? metaDoc.data() : {};
                statsMetaCache = metaData;
            }

            const yearsWithData = new Set();

            if (metaData[resId]) {
                metaData[resId].forEach(y => yearsWithData.add(y));
            }
            
            // Always include current and next year
            const currentYear = new Date().getFullYear();
            yearsWithData.add(currentYear);
            yearsWithData.add(currentYear + 1);
            
            // Sort descending (newest first)
            const sortedYears = Array.from(yearsWithData).sort((a, b) => b - a);
            
            // Always default to the year of the week/day currently being viewed
            const viewingYear = currentWeekStart.getFullYear();

            yearSel.innerHTML = '';
            sortedYears.forEach(y => {
                const opt = document.createElement('option');
                opt.value = y;
                opt.innerText = y;
                if (y === viewingYear) {
                    opt.selected = true;
                }
                yearSel.appendChild(opt);
            });
            
        } catch (err) {
            console.error('Error loading years:', err);
            // Fallback to current + next year
            const currentYear = new Date().getFullYear();
            yearSel.innerHTML = '';
            [currentYear, currentYear + 1].forEach(y => {
                const opt = document.createElement('option');
                opt.value = y;
                opt.innerText = y;
                if (y === currentYear) opt.selected = true;
                yearSel.appendChild(opt);
            });
        }
    }
    
    async function handleStatsResourceChange() {
        await populateYearDropdown();
        loadStatsData();
    }
    
    async function fetchBookingsForYear(resId, year) {
        // Single range query instead of ~53 per-week queries.
        // Slightly wider range catches boundary weeks that span year edges.
        // buildDailyStats() filters by exact year, so over-fetched docs are harmless.
        const lowerBound = `${resId}_${year - 1}-12-25`;
        const upperBound = `${resId}_${year + 1}-01-08`;
        const snapshot = await db.collection('appointments')
            .where('__name__', '>=', lowerBound)
            .where('__name__', '<', upperBound)
            .get();
        const bookings = {};
        snapshot.forEach(doc => { bookings[doc.id] = doc.data(); });
        return bookings;
    }

    function buildDailyStats(resId, year, res, bookings) {
        const dailyStats = {};

        for (let month = 0; month < 12; month++) {
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            for (let day = 1; day <= daysInMonth; day++) {
                const date = new Date(year, month, day);
                const dateStr = formatDateISO(date);
                const dayOfWeek = date.getDay();

                const dayStart = res.hours[dayOfWeek * 2];
                const dayEnd = res.hours[dayOfWeek * 2 + 1];
                const closureReason = getClosureReason(res, date);

                dailyStats[dateStr] = {
                    hours: 0,
                    bookingCount: 0,
                    closed: (dayStart === dayEnd) || closureReason !== null,
                    reason: closureReason || (dayStart === dayEnd ? 'Closed' : ''),
                    dayOfWeek: dayOfWeek
                };
            }
        }

        const prefix = resId + '_';
        Object.keys(bookings).forEach(key => {
            const booking = bookings[key];
            const suffix = key.substring(prefix.length);
            const parts = suffix.split('_');
            const weekKey = parts[0];
            const dayIndex = parseInt(parts[1]);

            const [wy, wm, wd] = weekKey.split('-').map(Number);
            const weekStart = new Date(wy, wm - 1, wd);
            const bookingDate = new Date(weekStart);
            bookingDate.setDate(bookingDate.getDate() + dayIndex);

            if (bookingDate.getFullYear() === year) {
                const dateStr = formatDateISO(bookingDate);
                if (dailyStats[dateStr]) {
                    dailyStats[dateStr].hours += booking.duration || 0;
                    dailyStats[dateStr].bookingCount++;
                }
            }
        });

        return dailyStats;
    }

    function getStatsCacheDocId(resId, year) {
        return `stats_cache_${resId}_${year}`;
    }

    // Strip bookings down to only the fields needed for stats (duration, hasStaff)
    // to keep the cache document small
    function slimBookingsForCache(bookings) {
        const slim = {};
        Object.keys(bookings).forEach(key => {
            const b = bookings[key];
            slim[key] = { duration: b.duration || 0 };
            if (b.hasStaff) { slim[key].hasStaff = true; if (b.staffName) slim[key].staffName = b.staffName; }
        });
        return slim;
    }

    async function loadStatsData(forceRefresh) {
        const resId = document.getElementById('statsResourceSelect').value;
        const year = parseInt(document.getElementById('statsYearSelect').value);
        const res = resources.find(r => r.id === resId);

        if (!res) return;

        showLoading(true);
        const currentYear = new Date().getFullYear();
        const isPastYear = year < currentYear;

        // Show recalculate button only for past years (cached data)
        const recalcBtn = document.getElementById('statsRecalcBtn');
        if (recalcBtn) recalcBtn.style.display = isPastYear ? '' : 'none';

        try {
            let bookings;
            const memoryCacheKey = `${resId}_${year}`;

            // Check in-memory session cache first (avoids all reads on repeated opens)
            if (!forceRefresh && statsBookingsCache[memoryCacheKey]) {
                const cached = statsBookingsCache[memoryCacheKey];
                if (Date.now() - cached.fetchedAt < STATS_CACHE_TTL) {
                    bookings = cached.bookings;
                }
            }

            // For past years, try loading from Firestore cache (1 read instead of ~53)
            if (!bookings && isPastYear && !forceRefresh) {
                const cacheDocId = getStatsCacheDocId(resId, year);
                const cacheDoc = await db.collection('system').doc(cacheDocId).get();
                if (cacheDoc.exists) {
                    bookings = cacheDoc.data().bookings || {};
                    statsBookingsCache[memoryCacheKey] = { bookings, fetchedAt: Date.now() };
                }
            }

            // If no cache hit, fetch from individual appointment documents
            if (!bookings) {
                bookings = await fetchBookingsForYear(resId, year);

                // If we found bookings for this year, ensure stats_meta is updated
                if (Object.keys(bookings).length > 0) {
                    updateStatsYearMeta(resId, Object.keys(bookings)[0]);
                }

                // Store in session memory cache
                statsBookingsCache[memoryCacheKey] = { bookings, fetchedAt: Date.now() };

                // Cache past year data in Firestore for future sessions
                if (isPastYear) {
                    const cacheDocId = getStatsCacheDocId(resId, year);
                    const slim = slimBookingsForCache(bookings);
                    db.collection('system').doc(cacheDocId).set({
                        bookings: slim,
                        resourceId: resId,
                        year: year,
                        cachedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }).catch(err => console.error('Failed to cache stats:', err));
                }
            }

            const dailyStats = buildDailyStats(resId, year, res, bookings);
            renderStatsGrid(dailyStats, year, res, bookings);

        } catch (err) {
            showToast('Error loading stats: ' + err.message, 'error');
        }

        showLoading(false);
    }

    function recalculateStats() {
        loadStatsData(true);
    }


    function toggleStatsView(view) {
        const chartBtn = document.getElementById('statsViewChart');
        const gridBtn = document.getElementById('statsViewGrid');
        const chartContainer = document.getElementById('statsChartContainer');
        const gridContainer = document.getElementById('statsGridContainer');
        
        if (view === 'chart') {
            chartBtn.classList.add('active');
            gridBtn.classList.remove('active');
            chartContainer.style.display = '';
            gridContainer.style.display = 'none';
        } else {
            gridBtn.classList.add('active');
            chartBtn.classList.remove('active');
            gridContainer.style.display = '';
            chartContainer.style.display = 'none';
        }
    }

    function renderStatsChart() {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const container = document.getElementById('statsChart');
        
        if (!statsData || !statsData.summary) {
            container.innerHTML = '<p style="text-align:center;color:#999;">No data available.</p>';
            return;
        }

        const s = statsData.summary;
        const mTotals = statsData.monthlyTotalsYtd || [];
        const mAvail = statsData.monthlyAvailableYtd || [];
        const res = statsData.res;

        let html = '';
        html += '<div style="font-size: 0.8em; color: #555; margin-bottom: 8px;">All charts reflect year-to-date. Future bookings are excluded as they may still change.</div>';

        // === ROW 1: Utilization Ring + Duration Distribution + Sub-Room Pie (conditional) ===
        const hasSubRooms = res.viewMode === 'day' && Array.isArray(res.subRooms) && getActiveSubRooms(res).length > 1;
        html += '<div class="dash-row' + (hasSubRooms ? ' dash-row-thirds' : '') + '">';

        // Utilization Ring
        html += '<div class="dash-panel">';
        html += '<div class="dash-panel-title">Utilization</div>';
        const utilVal = s.utilization !== null ? s.utilization : 0;
        const ringColor = utilVal >= 75 ? '#c62828' : utilVal >= 50 ? '#e65100' : utilVal >= 25 ? '#1976d2' : '#2e7d32';
        html += '<div class="dash-ring-container">';
        html += '  <div class="dash-ring" style="background: conic-gradient(' + ringColor + ' 0% ' + utilVal + '%, #e0e0e0 ' + utilVal + '% 100%);">';
        html += '    <div class="dash-ring-inner">';
        html += '      <span class="dash-ring-pct">' + (s.utilization !== null ? s.utilization + '%' : 'N/A') + '</span>';
        html += '      <span class="dash-ring-sub">' + (statsData.ytdTotal ? parseFloat(statsData.ytdTotal.toFixed(1)) : 0) + 'h of ' + (statsData.ytdAvailable ? parseFloat(statsData.ytdAvailable.toFixed(0)) : '?') + 'h</span>';
        html += '    </div>';
        html += '  </div>';
        html += '  <div class="dash-ring-legend">';
        html += '    <div class="dash-ring-legend-item"><span class="dash-ring-dot" style="background:#2e7d32;"></span> 0-25% Light</div>';
        html += '    <div class="dash-ring-legend-item"><span class="dash-ring-dot" style="background:#1976d2;"></span> 25-50% Moderate</div>';
        html += '    <div class="dash-ring-legend-item"><span class="dash-ring-dot" style="background:#e65100;"></span> 50-75% Heavy</div>';
        html += '    <div class="dash-ring-legend-item"><span class="dash-ring-dot" style="background:#c62828;"></span> 75%+ Near Capacity</div>';
        html += '  </div>';
        html += '</div>';
        html += '</div>';

        // Duration Distribution
        html += '<div class="dash-panel">';
        html += '<div class="dash-panel-title">Booking Duration Breakdown</div>';
        const durBuckets = statsData.durationBuckets || {};
        const durKeys = Object.keys(durBuckets).map(Number).sort((a, b) => a - b);
        if (durKeys.length > 0) {
            const maxDurCount = Math.max(...durKeys.map(d => durBuckets[d.toString()]));
            html += '<div class="dash-hbar-chart">';
            durKeys.forEach(d => {
                const count = durBuckets[d.toString()];
                const pct = s.totalBookings > 0 ? (count / s.totalBookings) * 100 : 0;
                const label = d < 1 ? (d * 60) + 'm' : d + 'h';
                const bookPct = s.totalBookings > 0 ? Math.round((count / s.totalBookings) * 100) : 0;
                const hl = count === maxDurCount ? ' dash-highlight' : '';
                html += '<div class="dash-hbar-row">';
                html += '  <div class="dash-hbar-label' + hl + '">' + label + '</div>';
                html += '  <div class="dash-hbar-track" title="' + count + ' bookings (' + bookPct + '%)"><div class="dash-hbar-fill duration" style="width:' + pct + '%;"></div></div>';
                html += '  <div class="dash-hbar-value' + hl + '">' + count + ' (' + bookPct + '%)</div>';
                html += '</div>';
            });
            html += '</div>';
        } else {
            html += '<div style="text-align:center;color:#999;padding:20px;">No data yet</div>';
        }
        html += '</div>';

        // Sub-Room Pie (conditional)
        if (hasSubRooms) {
            html += '<div class="dash-panel">';
            html += '<div class="dash-panel-title">Room Distribution</div>';
            const srCounts = statsData.subRoomCounts || {};
            const srKeys = Object.keys(srCounts);
            const srTotal = srKeys.reduce((sum, k) => sum + srCounts[k], 0);
            if (srTotal > 0) {
                // Build conic-gradient slices
                const PIE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#edc948', '#76b7b2', '#9c755f'];
                let cumPct = 0;
                let gradientParts = [];
                let legendItems = [];
                srKeys.sort((a, b) => srCounts[b] - srCounts[a]).forEach((k, i) => {
                    const count = srCounts[k];
                    const pct = (count / srTotal) * 100;
                    const color = PIE_COLORS[i % PIE_COLORS.length];
                    const roomName = getSubRoomName(res, parseInt(k));
                    const hl = i === 0 ? ' dash-highlight' : '';
                    gradientParts.push(color + ' ' + cumPct + '% ' + (cumPct + pct) + '%');
                    cumPct += pct;
                    legendItems.push('<div class="dash-pie-legend-item' + hl + '"><span class="dash-ring-dot" style="background:' + color + ';"></span> ' + roomName + ': ' + count + ' (' + Math.round(pct) + '%)</div>');
                });
                html += '<div class="dash-pie-container">';
                html += '  <div class="dash-pie" style="background: conic-gradient(' + gradientParts.join(', ') + ');"></div>';
                html += '  <div class="dash-pie-legend">' + legendItems.join('') + '</div>';
                html += '</div>';
            } else {
                html += '<div style="text-align:center;color:#999;padding:20px;">No data yet</div>';
            }
            html += '</div>';
        }

        html += '</div>'; // end row 1

        // === ROW 2: Weekly Usage + Monthly Bars ===
        html += '<div class="dash-row">';

        // Weekly Usage bar chart (avg hours per day of week, YTD)
        html += '<div class="dash-panel">';
        html += '<div class="dash-panel-title">Weekly Usage</div>';
        const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dowData = statsData.dowSummary || [];
        const dowMap = {};
        dowData.forEach(d => { dowMap[d.day] = d; });
        const DOW_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        // Find peak day utilization for highlighting
        let peakDowUtil = 0;
        for (let i = 0; i < 7; i++) {
            const dayStart = res.hours[i * 2];
            const dayEnd = res.hours[i * 2 + 1];
            if (dayStart !== dayEnd) {
                const entry = dowMap[DOW_FULL[i]];
                if (entry && entry.utilization > peakDowUtil) peakDowUtil = entry.utilization;
            }
        }
        html += '<div class="dash-vbar-chart">';
        for (let i = 0; i < 7; i++) {
            const entry = dowMap[DOW_FULL[i]];
            const avgHrs = entry ? entry.avgHours : 0;
            const totalHrs = entry ? entry.totalHours : 0;
            const availHrs = entry ? entry.availableHours : 0;
            const util = entry ? entry.utilization : 0;
            const openDays = entry ? entry.openDayCount : 0;
            const dayStart = res.hours[i * 2];
            const dayEnd = res.hours[i * 2 + 1];
            const isClosed = dayStart === dayEnd;
            const pct = isClosed ? 0 : util;
            const fillPct = isClosed ? 0 : Math.min(100, pct);
            const hl = !isClosed && util > 0 && util === peakDowUtil ? ' dash-highlight' : '';
            const title = isClosed ? DOW_LABELS[i] + ': Closed'
                : DOW_LABELS[i] + ': avg ' + avgHrs + 'h/day, ' + parseFloat(totalHrs.toFixed(1)) + 'h total / ' + parseFloat(availHrs.toFixed(1)) + 'h avail (' + util + '%) over ' + openDays + ' days';
            html += '<div class="dash-vbar-col">';
            html += '  <div class="dash-vbar-pct' + hl + '">' + (!isClosed && availHrs > 0 ? Math.round(pct) + '%' : '') + '</div>';
            html += '  <div class="dash-vbar-wrap" style="height:' + Math.max(fillPct, 2) + '%;" title="' + title + '">';
            html += '    <div class="dash-vbar-fill" style="height:100%;"></div>';
            html += '  </div>';
            html += '  <div class="dash-vbar-label' + hl + '">' + DOW_LABELS[i] + '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '<div class="dash-vbar-hint">Hover over bars for details</div>';
        html += '</div>';

        // Monthly utilization bar chart
        html += '<div class="dash-panel">';
        html += '<div class="dash-panel-title">Monthly Usage</div>';
        // Find peak month utilization for highlighting
        let peakMonthPct = 0;
        for (let i = 0; i < 12; i++) {
            const avail = mAvail[i] || 0;
            const pct = avail > 0 ? Math.round((mTotals[i] / avail) * 100) : 0;
            if (pct > peakMonthPct) peakMonthPct = pct;
        }
        html += '<div class="dash-vbar-chart">';
        for (let i = 0; i < 12; i++) {
            const booked = mTotals[i] || 0;
            const avail = mAvail[i] || 0;
            const pct = avail > 0 ? Math.round((booked / avail) * 100) : 0;
            const fillPct = avail > 0 ? Math.min(100, (booked / avail) * 100) : 0;
            const hl = pct > 0 && pct === peakMonthPct ? ' dash-highlight' : '';
            const title = MONTHS[i] + ': ' + parseFloat(booked.toFixed(1)) + 'h / ' + parseFloat(avail.toFixed(1)) + 'h (' + pct + '%)';

            html += '<div class="dash-vbar-col">';
            html += '  <div class="dash-vbar-pct' + hl + '">' + (avail > 0 ? pct + '%' : '') + '</div>';
            html += '  <div class="dash-vbar-wrap" style="height:' + Math.max(fillPct, 2) + '%;" title="' + title + '">';
            html += '    <div class="dash-vbar-fill" style="height:100%;"></div>';
            html += '  </div>';
            html += '  <div class="dash-vbar-label' + hl + '">' + MONTHS[i] + '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '<div class="dash-vbar-hint">Hover over bars for details</div>';
        html += '</div>';

        html += '</div>'; // end row 2

        // === STAFF ASSISTANCE (full width, conditional) ===
        if (res.hasStaffField) {
            const msc = statsData.monthlyStaffCounts || {};
            const staffNames = Object.keys(msc).sort();
            const hasStaffData = staffNames.some(n => msc[n].some(c => c > 0));
            if (hasStaffData) {
                const STAFF_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#edc948', '#76b7b2', '#9c755f'];
                // Find max monthly total for scaling
                let maxMonthTotal = 0;
                for (let i = 0; i < 12; i++) {
                    let monthTotal = 0;
                    staffNames.forEach(n => { monthTotal += msc[n][i]; });
                    if (monthTotal > maxMonthTotal) maxMonthTotal = monthTotal;
                }

                html += '<div class="dash-row" style="grid-template-columns: 1fr;">';
                html += '<div class="dash-panel">';
                html += '<div class="dash-panel-title">Staff Assisted Sessions</div>';
                html += '<div class="dash-stacked-chart">';
                for (let i = 0; i < 12; i++) {
                    let monthTotal = 0;
                    staffNames.forEach(n => { monthTotal += msc[n][i]; });
                    const barPct = maxMonthTotal > 0 ? (monthTotal / maxMonthTotal) * 100 : 0;

                    html += '<div class="dash-stacked-col">';
                    const hlMonth = monthTotal > 0 && monthTotal === maxMonthTotal ? ' dash-highlight' : '';
                    html += '  <div class="dash-stacked-count' + hlMonth + '">' + (monthTotal > 0 ? monthTotal : '') + '</div>';
                    html += '  <div class="dash-stacked-bar" style="height:' + Math.max(barPct, monthTotal > 0 ? 2 : 0) + '%;">';
                    if (monthTotal > 0) {
                        // Build segments bottom-up
                        staffNames.forEach((n, si) => {
                            const count = msc[n][i];
                            if (count === 0) return;
                            const segPct = (count / monthTotal) * 100;
                            const color = STAFF_COLORS[si % STAFF_COLORS.length];
                            const isTop = si === staffNames.reduce((last, name, idx) => msc[name][i] > 0 ? idx : last, 0);
                            html += '<div class="dash-stacked-segment' + (isTop ? ' dash-stacked-segment-top' : '') + '" style="height:' + segPct + '%;background:' + color + ';" title="' + n + ': ' + count + '"></div>';
                        });
                    }
                    html += '  </div>';
                    html += '  <div class="dash-stacked-label' + hlMonth + '">' + MONTHS[i] + '</div>';
                    html += '</div>';
                }
                html += '</div>';

                // Legend
                const maxStaffTotal = Math.max(...staffNames.map(n => msc[n].reduce((s, c) => s + c, 0)));
                html += '<div class="dash-stacked-legend">';
                staffNames.forEach((n, si) => {
                    const total = msc[n].reduce((s, c) => s + c, 0);
                    const color = STAFF_COLORS[si % STAFF_COLORS.length];
                    const hl = total === maxStaffTotal ? ' dash-highlight' : '';
                    html += '<div class="dash-ring-legend-item' + hl + '"><span class="dash-ring-dot" style="background:' + color + ';"></span> ' + n + ': ' + total + '</div>';
                });
                html += '</div>';

                html += '</div>'; // end panel
                html += '</div>'; // end row
            }
        }

        // === ROW 3: Weekly Rhythm (full width) ===
        html += '<div class="dash-row" style="grid-template-columns: 1fr;">';

        // Weekly Rhythm Heatmap
        html += '<div class="dash-panel">';
        html += '<div class="dash-panel-title">Weekly Rhythm (Day &times; Hour)</div>';
        const heatmap = statsData.dayHourHeatmap || [];
        // Find all active hours across all days and the max count
        const activeHours = new Set();
        let heatMax = 0;
        for (let d = 0; d < 7; d++) {
            Object.keys(heatmap[d] || {}).forEach(h => {
                activeHours.add(parseInt(h));
                if (heatmap[d][h] > heatMax) heatMax = heatmap[d][h];
            });
        }
        const sortedHours = Array.from(activeHours).sort((a, b) => a - b);
        if (sortedHours.length > 0 && heatMax > 0) {
            // Fill in any gaps between min and max hour
            const minH = sortedHours[0];
            const maxH = sortedHours[sortedHours.length - 1];
            const allHeatHours = [];
            for (let h = minH; h <= maxH; h++) allHeatHours.push(h);

            const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            // Pre-compute hour totals for highlighting
            const hourTotals = {};
            let maxHourTotal = 0;
            allHeatHours.forEach(h => {
                let total = 0;
                for (let d = 0; d < 7; d++) total += (heatmap[d] || {})[h] || 0;
                hourTotals[h] = total;
                if (total > maxHourTotal) maxHourTotal = total;
            });
            html += '<div class="dash-heatmap" style="grid-template-columns: 36px repeat(' + allHeatHours.length + ', 1fr);">';
            // Header row
            html += '<div class="dash-hm-corner"></div>';
            allHeatHours.forEach(h => {
                const hl = hourTotals[h] > 0 && hourTotals[h] === maxHourTotal ? ' dash-highlight' : '';
                html += '<div class="dash-hm-hdr' + hl + '">' + formatTime(h) + '</div>';
            });
            // Data rows
            for (let d = 0; d < 7; d++) {
                const dayData = heatmap[d] || {};
                // Skip days with no operating hours
                const dayStart = res.hours[d * 2];
                const dayEnd = res.hours[d * 2 + 1];
                if (dayStart === dayEnd) {
                    html += '<div class="dash-hm-day">' + DAY_ABBR[d] + '</div>';
                    allHeatHours.forEach(() => {
                        html += '<div class="dash-hm-cell dash-hm-closed" title="Closed"></div>';
                    });
                    continue;
                }
                html += '<div class="dash-hm-day">' + DAY_ABBR[d] + '</div>';
                allHeatHours.forEach(h => {
                    const count = dayData[h] || 0;
                    const intensity = count > 0 ? Math.min(8, Math.ceil((count / heatMax) * 8)) : 0;
                    const title = DAY_ABBR[d] + ' ' + formatTime(h) + ': ' + count + ' booking' + (count !== 1 ? 's' : '');
                    html += '<div class="dash-hm-cell dash-hm-lvl-' + intensity + '" title="' + title + '">' + (count > 0 ? count : '') + '</div>';
                });
            }
            // Totals row
            html += '<div class="dash-hm-day" style="font-weight:600;">Total</div>';
            allHeatHours.forEach(h => {
                const total = hourTotals[h];
                const hl = total > 0 && total === maxHourTotal ? ' dash-highlight' : '';
                html += '<div class="dash-hm-cell' + hl + '" style="background:transparent;border:none;color:#666;" title="Total at ' + formatTime(h) + ': ' + total + '">' + (total > 0 ? total : '') + '</div>';
            });
            html += '</div>';
            // Heatmap scale legend
            html += '<div class="dash-hm-scale">';
            html += '<span>Less</span>';
            for (let i = 0; i <= 8; i++) {
                html += '<span class="dash-hm-cell dash-hm-lvl-' + i + '" style="width:14px;height:14px;display:inline-block;border-radius:2px;"></span>';
            }
            html += '<span>More</span>';
            html += '</div>';
            html += '<div class="dash-vbar-hint">Bookings starting in the same hour are grouped together</div>';
        } else {
            html += '<div style="text-align:center;color:#999;padding:20px;">No data yet</div>';
        }
        html += '</div>';

        html += '</div>'; // end row 3

        container.innerHTML = html;
    }

    function renderStatsGrid(dailyStats, year, res, bookings) {
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const thead = document.getElementById('statsGridHead');
        const tbody = document.getElementById('statsGridBody');
        const tfoot = document.getElementById('statsGridFoot');
        
        // Determine sub-room count for utilization
        const activeSubRooms = getActiveSubRooms(res);
        const roomMultiplier = activeSubRooms.length > 0 ? activeSubRooms.length : 1;
        
        // Find max hours for heat map scaling
        let maxHours = 0;
        Object.values(dailyStats).forEach(d => {
            if (d.hours > maxHours) maxHours = d.hours;
        });
        if (maxHours === 0) maxHours = 1;
        
        // Build header
        thead.innerHTML = '<tr><th>Day</th>' + MONTHS.map(m => `<th>${m}</th>`).join('') + '</tr>';
        
        // Helper to format date with ordinal suffix
        function formatDateWithOrdinal(month, day, year) {
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                               'July', 'August', 'September', 'October', 'November', 'December'];
            const suffix = (day === 1 || day === 21 || day === 31) ? 'st' : 
                          (day === 2 || day === 22) ? 'nd' : 
                          (day === 3 || day === 23) ? 'rd' : 'th';
            return `${monthNames[month]} ${day}${suffix}, ${year}`;
        }
        
        // Build rows (days 1-31)
        let html = '';
        const monthlyTotals = new Array(12).fill(0);
        const monthlyBookingCounts = new Array(12).fill(0);
        const monthlyAvailable = new Array(12).fill(0);
        let grandTotal = 0;
        let grandBookingCount = 0;
        let totalAvailable = 0;
        let totalDaysBookable = 0;
        
        // YTD tracking
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let ytdTotal = 0;
        let ytdAvailable = 0;
        let ytdDaysBookable = 0;
        const monthlyTotalsYtd = new Array(12).fill(0);
        const monthlyAvailableYtd = new Array(12).fill(0);
        
        // New stat trackers
        let totalBookingCount = 0;
        let totalDurationSum = 0;
        const dayOfWeekHours = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat total hours
        const dayOfWeekCount = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat open day count (YTD)
        const dayOfWeekAvailable = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat total available hours (YTD)
        const hourSlotCounts = {}; // { '9': 5, '10': 8, ... } booking start times
        let staffAssistedCount = 0;
        const durationBuckets = {}; // { '0.5': 3, '1': 8, ... }
        const dayHourHeatmap = Array.from({length: 7}, () => ({})); // [day][hour] = count
        const subRoomCounts = {}; // { '0': 12, '1': 8, ... }
        const monthlyStaffCounts = {}; // { 'John Smith': [0,0,3,...] } per-month counts

        // Analyze individual bookings for count, duration, peak hour, staff
        const resPrefix = res.id + '_';
        Object.keys(bookings).forEach(key => {
            const booking = bookings[key];
            const suffix = key.substring(resPrefix.length);
            const parts = suffix.split('_');
            const weekKey = parts[0];
            const dayIndex = parseInt(parts[1]);
            const startTime = parseFloat(parts[2]);
            const subIdx = parts[3] || null;
            
            const [wy, wm, wd] = weekKey.split('-').map(Number);
            const bookingDate = new Date(wy, wm - 1, wd);
            bookingDate.setDate(bookingDate.getDate() + dayIndex);
            
            if (bookingDate.getFullYear() !== year) return;
            // Only count YTD bookings for these stats
            if (bookingDate > today) return;
            
            totalBookingCount++;
            const dur = booking.duration || 0;
            totalDurationSum += dur;
            
            // Track start hour for peak hour
            const hourKey = Math.floor(startTime);
            hourSlotCounts[hourKey] = (hourSlotCounts[hourKey] || 0) + 1;
            
            // Track staff assistance
            if (booking.hasStaff) {
                staffAssistedCount++;
                const staffKey = normalizeStaffName(booking.staffName);
                if (!monthlyStaffCounts[staffKey]) monthlyStaffCounts[staffKey] = new Array(12).fill(0);
                monthlyStaffCounts[staffKey][bookingDate.getMonth()]++;
            }
            
            // Duration distribution
            const durKey = dur.toString();
            durationBuckets[durKey] = (durationBuckets[durKey] || 0) + 1;
            
            // Day-hour heatmap
            const bookDow = bookingDate.getDay();
            dayHourHeatmap[bookDow][hourKey] = (dayHourHeatmap[bookDow][hourKey] || 0) + 1;
            
            // Sub-room distribution
            if (subIdx !== null) {
                subRoomCounts[subIdx] = (subRoomCounts[subIdx] || 0) + 1;
            }
        });
        
        for (let day = 1; day <= 31; day++) {
            let rowHtml = `<tr>`;
            rowHtml += `<td>${day}</td>`;
            
            for (let month = 0; month < 12; month++) {
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                
                if (day > daysInMonth) {
                    rowHtml += `<td class="stats-closed"></td>`;
                } else {
                    const date = new Date(year, month, day);
                    const dateStr = formatDateISO(date);
                    const stat = dailyStats[dateStr];
                    const dayOfWeekNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    const dateTooltip = dayOfWeekNames[date.getDay()] + ', ' + formatDateWithOrdinal(month, day, year);
                    const hours = stat.hours;
                    
                    // Always count hours and bookings in totals (fix: closed days with bookings still count)
                    monthlyTotals[month] += hours;
                    monthlyBookingCounts[month] += stat.bookingCount;
                    grandTotal += hours;
                    grandBookingCount += stat.bookingCount;
                    
                    if (stat.closed) {
                        const shortReason = stat.reason.length > 8 ? stat.reason.substring(0, 7) + '\u2026' : stat.reason;
                        const closedTooltip = hours > 0 
                            ? `${dateTooltip} - ${stat.reason} (${parseFloat(hours.toFixed(2))}h booked)`
                            : `${dateTooltip} - ${stat.reason}`;
                        rowHtml += `<td class="stats-closed" title="${closedTooltip}">${shortReason || 'C'}</td>`;
                    } else {
                        // Calculate available hours for this open day
                        totalDaysBookable++;
                        const dayOfWeek = date.getDay();
                        const dayStart = res.hours[dayOfWeek * 2];
                        const dayEnd = res.hours[dayOfWeek * 2 + 1];
                        const dayAvailable = (dayEnd - dayStart) * roomMultiplier;
                        monthlyAvailable[month] += dayAvailable;
                        totalAvailable += dayAvailable;
                        
                        // YTD tracking (only past/today)
                        if (date <= today) {
                            ytdAvailable += dayAvailable;
                            ytdTotal += hours;
                            ytdDaysBookable++;
                            dayOfWeekHours[dayOfWeek] += hours;
                            dayOfWeekCount[dayOfWeek]++;
                            dayOfWeekAvailable[dayOfWeek] += dayAvailable;
                            monthlyTotalsYtd[month] += hours;
                            monthlyAvailableYtd[month] += dayAvailable;
                        }
                        
                        // Calculate heat map level (0-8)
                        const heatLevel = hours === 0 ? 0 : Math.min(8, Math.ceil((hours / maxHours) * 8));
                        const displayHours = hours > 0 ? parseFloat(hours.toFixed(2)) : '';
                        const dayUtil = dayAvailable > 0 ? ((hours / dayAvailable) * 100).toFixed(1) : '0.0';
                        const bc = stat.bookingCount;
                        const hoursText = hours > 0 ? `${displayHours} hour${hours === 1 ? '' : 's'}, ${bc} booking${bc === 1 ? '' : 's'} (${dayUtil}% utilization)` : 'No bookings';
                        rowHtml += `<td class="stats-heat-${heatLevel}" title="${dateTooltip} - ${hoursText}">${displayHours}</td>`;
                    }
                }
            }
            
            rowHtml += `</tr>`;
            html += rowHtml;
        }
        
        tbody.innerHTML = html;
        
        // Build footer (monthly totals with month names, hours, and booking counts)
        let footHtml = '<tr><td>Total</td>';
        monthlyTotals.forEach((t, i) => {
            const displayTotal = t > 0 ? parseFloat(t.toFixed(2)) + 'h' : '-';
            const bc = monthlyBookingCounts[i];
            const countLabel = bc > 0 ? `<div style="font-size:0.85em;color:#555;font-weight:normal;">${bc} booking${bc === 1 ? '' : 's'}</div>` : '';
            footHtml += `<td><div style="color:#1565c0;font-weight:bold;">${MONTHS[i]}</div>${displayTotal}${countLabel}</td>`;
        });
        footHtml += '</tr>';
        tfoot.innerHTML = footHtml;

        // Update summary
        document.getElementById('statsTotalHours').innerText = parseFloat(ytdTotal.toFixed(2)) + ' hours';
        
        // Booking count
        document.getElementById('statsBookingCount').innerText = totalBookingCount;
        
        // Utilization (YTD)
        const utilPct = ytdAvailable > 0 ? ((ytdTotal / ytdAvailable) * 100).toFixed(1) : 0;
        document.getElementById('statsUtilization').innerText = ytdAvailable > 0 ? utilPct + '%' : 'N/A';
        
        // Find busiest month (by utilization YTD)
        let busiestMonthIdx = -1, busiestMonthUtil = -1;
        for (let i = 0; i < 12; i++) {
            if (monthlyAvailableYtd[i] === 0) continue;
            const util = (monthlyTotalsYtd[i] / monthlyAvailableYtd[i]) * 100;
            if (util > busiestMonthUtil) { busiestMonthUtil = util; busiestMonthIdx = i; }
        }
        document.getElementById('statsBusiestMonth').innerText = busiestMonthIdx >= 0
            ? `${MONTHS[busiestMonthIdx]} (${parseFloat(monthlyTotalsYtd[busiestMonthIdx].toFixed(2))}h, ${busiestMonthUtil.toFixed(1)}%)` : '-';
        
        // Average hours per open day (YTD)
        const avgHours = ytdDaysBookable > 0 ? (ytdTotal / ytdDaysBookable).toFixed(1) : 0;
        document.getElementById('statsAvgHours').innerText = avgHours;
        
        // Average duration per booking
        const avgDuration = totalBookingCount > 0 ? (totalDurationSum / totalBookingCount).toFixed(1) + 'h' : '-';
        document.getElementById('statsAvgDuration').innerText = avgDuration;
        
        // Busiest and quietest day of week (normalized avg hours per occurrence)
        const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
        let busiestDayIdx = -1, busiestDayUtil = -1;
        let quietestDayIdx = -1, quietestDayUtil = Infinity;
        const dayAvgs = [];
        for (let i = 0; i < 7; i++) {
            if (dayOfWeekCount[i] === 0) { dayAvgs.push(null); continue; }
            const avgHrs = dayOfWeekHours[i] / dayOfWeekCount[i];
            const util = dayOfWeekAvailable[i] > 0 ? (dayOfWeekHours[i] / dayOfWeekAvailable[i]) * 100 : 0;
            dayAvgs.push({ avgHrs, util });
            if (util > busiestDayUtil) { busiestDayUtil = util; busiestDayIdx = i; }
            if (util < quietestDayUtil) { quietestDayUtil = util; quietestDayIdx = i; }
        }
        document.getElementById('statsBusiestDay').innerText = busiestDayIdx >= 0
            ? `${DAY_NAMES[busiestDayIdx]} (avg ${dayAvgs[busiestDayIdx].avgHrs.toFixed(1)}h, ${dayAvgs[busiestDayIdx].util.toFixed(1)}%)` : '-';
        document.getElementById('statsQuietestDay').innerText = quietestDayIdx >= 0
            ? `${DAY_NAMES[quietestDayIdx]} (avg ${dayAvgs[quietestDayIdx].avgHrs.toFixed(1)}h, ${dayAvgs[quietestDayIdx].util.toFixed(1)}%)` : '-';
        
        // Peak hour
        let peakHour = -1, peakCount = 0;
        Object.keys(hourSlotCounts).forEach(h => {
            if (hourSlotCounts[h] > peakCount) { peakCount = hourSlotCounts[h]; peakHour = parseInt(h); }
        });
        document.getElementById('statsPeakHour').innerText = peakHour >= 0
            ? `${formatTime(peakHour)} (${peakCount} bookings)` : '-';
        
        // Staff assisted (conditional)
        if (res.hasStaffField) {
            document.getElementById('statsStaffSection').style.display = '';
            const staffPct = totalBookingCount > 0 ? ((staffAssistedCount / totalBookingCount) * 100).toFixed(0) : 0;
            document.getElementById('statsStaffAssisted').innerText = totalBookingCount > 0
                ? `${staffAssistedCount} (${staffPct}%)` : '-';
        } else {
            document.getElementById('statsStaffSection').style.display = 'none';
        }
        
        // Store raw data for CSV export
        const DAY_NAMES_EXPORT = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        
        // Build monthly summary (YTD)
        const monthlySummary = [];
        for (let i = 0; i < 12; i++) {
            if (monthlyAvailableYtd[i] === 0 && monthlyTotalsYtd[i] === 0) continue;
            monthlySummary.push({
                month: MONTHS[i],
                bookedHours: parseFloat(monthlyTotalsYtd[i].toFixed(2)),
                availableHours: parseFloat(monthlyAvailableYtd[i].toFixed(2)),
                utilization: monthlyAvailableYtd[i] > 0 ? parseFloat(((monthlyTotalsYtd[i] / monthlyAvailableYtd[i]) * 100).toFixed(1)) : 0
            });
        }
        
        // Build day-of-week summary
        const dowSummary = [];
        for (let i = 0; i < 7; i++) {
            if (dayOfWeekCount[i] === 0) continue;
            dowSummary.push({
                day: DAY_NAMES_EXPORT[i],
                avgHours: parseFloat((dayOfWeekHours[i] / dayOfWeekCount[i]).toFixed(1)),
                totalHours: parseFloat(dayOfWeekHours[i].toFixed(2)),
                availableHours: parseFloat(dayOfWeekAvailable[i].toFixed(2)),
                utilization: dayOfWeekAvailable[i] > 0 ? parseFloat(((dayOfWeekHours[i] / dayOfWeekAvailable[i]) * 100).toFixed(1)) : 0,
                openDayCount: dayOfWeekCount[i]
            });
        }
        
        // Build hourly distribution
        const hourlyDist = [];
        const allHours = Object.keys(hourSlotCounts).map(Number).sort((a, b) => a - b);
        allHours.forEach(h => {
            hourlyDist.push({ hour: formatTime(h), bookings: hourSlotCounts[h] });
        });
        
        statsData = {
            dailyStats, year, res, monthlyTotals, monthlyAvailable, monthlyTotalsYtd, monthlyAvailableYtd, grandTotal, totalAvailable, ytdAvailable, ytdTotal,
            summary: {
                totalHours: parseFloat(grandTotal.toFixed(2)),
                totalBookings: totalBookingCount,
                utilization: ytdAvailable > 0 ? parseFloat(((ytdTotal / ytdAvailable) * 100).toFixed(1)) : null,
                avgHoursPerDay: ytdDaysBookable > 0 ? parseFloat((ytdTotal / ytdDaysBookable).toFixed(1)) : 0,
                avgDuration: totalBookingCount > 0 ? parseFloat((totalDurationSum / totalBookingCount).toFixed(1)) : null,
                peakHour: peakHour >= 0 ? formatTime(peakHour) : null,
                peakHourBookings: peakHour >= 0 ? peakCount : null,
                staffAssistedCount: res.hasStaffField ? staffAssistedCount : null,
                staffAssistedPct: res.hasStaffField && totalBookingCount > 0 ? parseFloat(((staffAssistedCount / totalBookingCount) * 100).toFixed(1)) : null
            },
            monthlySummary,
            dowSummary,
            hourlyDist,
            durationBuckets,
            dayHourHeatmap,
            subRoomCounts,
            monthlyStaffCounts
        };

        // Render dashboard (must come after statsData is populated)
        renderStatsChart();
    }

    
    function exportStatsCSV() {
        if (!statsData.dailyStats) {
            showToast('No data to export', 'error');
            return;
        }
        
        const { dailyStats, year, res, monthlyTotals, grandTotal, summary, monthlySummary, dowSummary, hourlyDist } = statsData;
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        let csv = `${res.name} - Usage Statistics ${year}\n\n`;
        
        // Section 1: Overview
        csv += 'OVERVIEW (YTD)\n';
        csv += 'Metric,Value\n';
        csv += `Total Hours,${summary.totalHours}\n`;
        csv += `Total Bookings,${summary.totalBookings}\n`;
        csv += `Utilization %,${summary.utilization !== null ? summary.utilization : ''}\n`;
        csv += `Avg Hours per Open Day,${summary.avgHoursPerDay}\n`;
        csv += `Avg Booking Duration (hours),${summary.avgDuration !== null ? summary.avgDuration : ''}\n`;
        csv += `Peak Hour,${summary.peakHour || ''}\n`;
        csv += `Bookings at Peak Hour,${summary.peakHourBookings || ''}\n`;
        if (summary.staffAssistedCount !== null) {
            csv += `Staff Assisted Count,${summary.staffAssistedCount}\n`;
            csv += `Staff Assisted %,${summary.staffAssistedPct !== null ? summary.staffAssistedPct : ''}\n`;
        }
        
        // Section 2: Monthly Summary
        csv += '\nMONTHLY SUMMARY (YTD)\n';
        csv += 'Month,Booked Hours,Available Hours,Utilization %\n';
        monthlySummary.forEach(m => {
            csv += `${m.month},${m.bookedHours},${m.availableHours},${m.utilization}\n`;
        });
        
        // Section 3: Day-of-Week Summary
        csv += '\nDAY-OF-WEEK SUMMARY (YTD)\n';
        csv += 'Day,Avg Hours,Total Hours,Available Hours,Utilization %,Open Days\n';
        dowSummary.forEach(d => {
            csv += `${d.day},${d.avgHours},${d.totalHours},${d.availableHours},${d.utilization},${d.openDayCount}\n`;
        });
        
        // Section 4: Hourly Distribution
        csv += '\nHOURLY DISTRIBUTION (YTD)\n';
        csv += 'Hour,Bookings\n';
        hourlyDist.forEach(h => {
            csv += `${h.hour},${h.bookings}\n`;
        });
        
        // Section 5: Staff Assistance by Month (conditional)
        const msc = statsData.monthlyStaffCounts || {};
        const staffCsvNames = Object.keys(msc).sort();
        if (staffCsvNames.length > 0) {
            csv += '\nSTAFF ASSISTANCE BY MONTH (YTD)\n';
            csv += 'Staff Name,' + MONTHS.join(',') + ',Total\n';
            staffCsvNames.forEach(name => {
                const counts = msc[name];
                const total = counts.reduce((s, c) => s + c, 0);
                csv += name + ',' + counts.join(',') + ',' + total + '\n';
            });
        }

        // Section 6: Daily Breakdown
        csv += '\nDAILY BREAKDOWN\n';
        csv += 'Day,' + MONTHS.join(',') + ',Total\n';
        
        for (let day = 1; day <= 31; day++) {
            let row = [day];
            let rowTotal = 0;
            
            for (let month = 0; month < 12; month++) {
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                
                if (day > daysInMonth) {
                    row.push('');
                } else {
                    const date = new Date(year, month, day);
                    const dateStr = formatDateISO(date);
                    const stat = dailyStats[dateStr];
                    
                    if (stat.closed) {
                        row.push(stat.reason || 'Closed');
                    } else {
                        row.push(stat.hours || '');
                        rowTotal += stat.hours || 0;
                    }
                }
            }
            
            row.push(rowTotal > 0 ? rowTotal : '');
            csv += row.join(',') + '\n';
        }
        
        csv += 'Total,' + monthlyTotals.join(',') + ',' + grandTotal + '\n';
        
        // Download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${res.name.replace(/\s+/g, '_')}_stats_${year}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // Re-render grid on window resize (debounced)
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (currentResId) {
                renderGrid();
            }
            // Force sidebar scrollbar recalculation
            const sidebar = document.getElementById('infoSidebar');
            if (sidebar && !sidebar.classList.contains('hidden')) {
                sidebar.style.overflow = 'hidden';
                requestAnimationFrame(() => { sidebar.style.overflow = ''; });
            }
        }, 150);
    });

    init();