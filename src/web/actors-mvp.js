// Actors browser MVP — desktop-only, no server changes required.
//
// Adds an "Actors" entry to the movies library tab strip (between the Movies
// and Suggestions tabs). Selecting it navigates to a real, URL-driven page
// (state lives in the route as `&jam=actors`), so the app's top-level back
// button, the desktop back/forward shortcuts and page refresh all work. The
// page lists every actor in the current movie library with an always-visible
// name filter, a first-appearance year filter, and sorting controls, split
// into two foldable groups: with and without a profile photo.
//
// Implementation notes:
// - The movies controller switches tabs via internal state only (it never
//   touches the URL). So when the user clicks a real tab, we explicitly close
//   the Actors page and strip `jam=actors` from the URL.
// - The tab launcher uses its own class (.jam-tab), NOT .emby-tab-button, so it
//   is excluded from emby-tabs' positional index lookups and cannot break host
//   tab selection.
// - Year/sort use custom dropdowns (not native <select>) so a choice applies
//   immediately and we don't depend on the desktop's native-select shim.
// - Actors are aggregated client-side from /Items?Fields=People (stock-server
//   safe). First-appearance year and the user's total watch count across an
//   actor's movies are derived in the same pass (no per-actor N+1 requests).
(function() {
    'use strict';

    const STYLE_ID = 'jamStyles';
    const PAGE_ID = 'jamPage';
    const TAB_MARK = 'jam-tab';
    const TAB_ACTIVE = 'jam-tab-active';
    const FILTER_MARK = 'data-jam-filter';
    const ROUTE_FLAG = 'jam=actors';

    const state = {
        actors: [],
        snapshot: null,
        rolesData: {},
        role: 'Actor',
        search: '',
        year: 'all',
        sortBy: 'name',
        sortOrder: 'asc',
        loaded: false,
        needsCheck: false,
        fingerprint: null,
        dismissed: false,
        libWatch: false,
        cacheCheckToken: null,
        loading: false,
        parentId: null,
        collapsed: { withPhoto: false, withoutPhoto: false }
    };

    const SORT_OPTIONS = [
        { value: 'name', label: 'Name' },
        { value: 'year', label: 'First year' },
        { value: 'movies', label: 'Movie count' },
        { value: 'watch', label: 'Watch count' }
    ];

    function api() {
        return window.ApiClient || null;
    }

    function currentUserId() {
        const a = api();
        return a && a.getCurrentUserId ? a.getCurrentUserId() : null;
    }

    function currentServerId() {
        const a = api();
        return a && a.serverId ? a.serverId() : null;
    }

    function isMoviesRoute() {
        const hash = (window.location.hash || '').toLowerCase();
        return hash.indexOf('/movies') !== -1 || hash.indexOf('movies.html') !== -1;
    }

    function isActorsActive() {
        return isMoviesRoute() && (window.location.hash || '').toLowerCase().indexOf('jam=actors') !== -1;
    }

    function isActorsShown() {
        return isActorsActive() && !state.dismissed;
    }

    function getLibraryParentId() {
        const hash = window.location.hash || '';
        const match = hash.match(/[?&]topParentId=([^&]+)/i) || hash.match(/[?&]parentId=([^&]+)/i);
        return match ? decodeURIComponent(match[1]) : null;
    }

    function hasPhoto(actor) {
        return !!(actor && actor.Id && actor.PrimaryImageTag);
    }

    function personImageUrl(actor) {
        const a = api();
        if (!a || !hasPhoto(actor)) {
            return '';
        }
        return a.getUrl('Items/' + actor.Id + '/Images/Primary', {
            maxHeight: 300,
            tag: actor.PrimaryImageTag,
            quality: 90
        });
    }

    function movieYear(movie) {
        if (Number.isFinite(movie.ProductionYear)) {
            return movie.ProductionYear;
        }
        if (movie.PremiereDate) {
            const year = new Date(movie.PremiereDate).getFullYear();
            if (Number.isFinite(year)) {
                return year;
            }
        }
        return null;
    }

    function moviePlayCount(movie) {
        const ud = movie.UserData;
        return ud && Number.isFinite(ud.PlayCount) ? ud.PlayCount : 0;
    }

    async function fetchMoviesWithPeople(parentId, onProgress) {
        const a = api();
        const uid = currentUserId();
        if (!a || !uid) {
            return [];
        }

        const pageSize = 200;
        const parallelPages = 8;
        const fetchPage = (startIndex) => a.getItems(uid, {
                ParentId: parentId || undefined,
                IncludeItemTypes: 'Movie',
                Recursive: true,
                Fields: 'People,ProductionYear,PremiereDate,DateCreated',
                EnableImages: false,
                EnableUserData: true,
                SortBy: 'SortName',
                Limit: pageSize,
                StartIndex: startIndex
            });

        const first = await fetchPage(0);
        const firstItems = (first && first.Items) || [];
        const total = (first && Number.isFinite(first.TotalRecordCount))
            ? first.TotalRecordCount
            : firstItems.length;
        if (!firstItems.length || total <= firstItems.length) {
            if (onProgress) {
                onProgress(firstItems.length, total);
            }
            return firstItems;
        }

        const pages = Math.ceil(total / pageSize);
        const results = new Array(pages);
        results[0] = firstItems;
        let loaded = firstItems.length;
        let nextPage = 1;

        async function worker() {
            while (nextPage < pages) {
                const page = nextPage;
                nextPage += 1;
                const result = await fetchPage(page * pageSize);
                const items = (result && result.Items) || [];
                results[page] = items;
                loaded += items.length;
                if (onProgress) {
                    onProgress(Math.min(loaded, total), total);
                }
            }
        }

        if (onProgress) {
            onProgress(Math.min(loaded, total), total);
        }
        await Promise.all(Array.from({ length: Math.min(parallelPages, pages - 1) }, worker));
        return results.flat();
    }

    function aggregatePeople(movies, roleType) {
        const byKey = new Map();

        for (const movie of movies) {
            const year = movieYear(movie);
            const plays = moviePlayCount(movie);
            const people = movie.People || [];
            const seenInMovie = new Set();

            for (const person of people) {
                if (person.Type !== roleType) {
                    continue;
                }
                const key = person.Id || ('name:' + (person.Name || ''));
                if (seenInMovie.has(key)) {
                    continue;
                }
                seenInMovie.add(key);

                let actor = byKey.get(key);
                if (!actor) {
                    actor = {
                        Id: person.Id || null,
                        Name: person.Name || '',
                        PrimaryImageTag: person.PrimaryImageTag || null,
                        firstYear: null,
                        movieCount: 0,
                        watchCount: 0
                    };
                    byKey.set(key, actor);
                }
                if (!actor.Id && person.Id) {
                    actor.Id = person.Id;
                }
                if (!actor.PrimaryImageTag && person.PrimaryImageTag) {
                    actor.PrimaryImageTag = person.PrimaryImageTag;
                }
                actor.movieCount += 1;
                actor.watchCount += plays;
                if (Number.isFinite(year)) {
                    actor.firstYear = actor.firstYear == null ? year : Math.min(actor.firstYear, year);
                }
            }
        }

        return Array.from(byKey.values());
    }

    // Backward-compatible helper (Actors are the default role).
    function aggregateActors(movies) {
        return aggregatePeople(movies, 'Actor');
    }

    const ROLE_ORDER = ['Actor', 'Director', 'Writer', 'Producer', 'GuestStar', 'Composer'];

    function roleLabel(type) {
        const map = {
            Actor: 'Actors',
            Director: 'Directors',
            Writer: 'Writers',
            Producer: 'Producers',
            GuestStar: 'Guest Stars',
            Composer: 'Composers'
        };
        return map[type] || (type + 's');
    }

    function getRolesFromMovies(movies) {
        const present = new Set();
        for (const movie of movies) {
            for (const person of (movie.People || [])) {
                if (person.Type) {
                    present.add(person.Type);
                }
            }
        }
        const ordered = ROLE_ORDER.filter((t) => present.has(t));
        const extras = Array.from(present).filter((t) => ROLE_ORDER.indexOf(t) === -1).sort();
        return ordered.concat(extras);
    }

    // One-pass aggregation of every role -> { Actor:[...], Director:[...], ... }.
    function aggregateAllRoles(movies) {
        const roles = {};
        for (const movie of movies) {
            const year = movieYear(movie);
            const plays = moviePlayCount(movie);
            const seen = {};
            for (const person of (movie.People || [])) {
                const type = person.Type;
                if (!type) {
                    continue;
                }
                const key = person.Id || ('name:' + (person.Name || ''));
                if (!seen[type]) {
                    seen[type] = new Set();
                }
                if (seen[type].has(key)) {
                    continue;
                }
                seen[type].add(key);

                const bucket = roles[type] || (roles[type] = new Map());
                let a = bucket.get(key);
                if (!a) {
                    a = { Id: person.Id || null, Name: person.Name || '', PrimaryImageTag: person.PrimaryImageTag || null, firstYear: null, movieCount: 0, watchCount: 0 };
                    bucket.set(key, a);
                }
                if (!a.Id && person.Id) {
                    a.Id = person.Id;
                }
                if (!a.PrimaryImageTag && person.PrimaryImageTag) {
                    a.PrimaryImageTag = person.PrimaryImageTag;
                }
                a.movieCount += 1;
                a.watchCount += plays;
                if (Number.isFinite(year)) {
                    a.firstYear = a.firstYear == null ? year : Math.min(a.firstYear, year);
                }
            }
        }
        const out = {};
        for (const type of Object.keys(roles)) {
            out[type] = Array.from(roles[type].values());
        }
        return out;
    }

    function personKey(person) {
        return person.Id || ('name:' + (person.Name || ''));
    }

    // Item ids arrive dashed from websocket payloads but dashless from /Items.
    function normalizeId(value) {
        if (typeof value !== 'string') {
            return '';
        }
        return value.replace(/-/g, '').toLowerCase();
    }

    // ---- movie snapshot ----
    //
    // A compact per-movie index kept alongside the aggregate. It records only
    // what aggregation needs (year, play count, creation date, cast keys) plus a
    // shared person table, so a deleted movie's contribution can be subtracted
    // locally instead of rescanning the library. Person names/images are stored
    // once rather than per movie to keep the payload small.
    function buildSnapshot(movies) {
        const people = {};
        const items = {};

        for (const movie of movies) {
            const cast = [];
            const seen = new Set();
            for (const person of (movie.People || [])) {
                const type = person.Type;
                if (!type) {
                    continue;
                }
                const key = personKey(person);
                const dedupe = type + '\u0000' + key;
                if (seen.has(dedupe)) {
                    continue;
                }
                seen.add(dedupe);
                cast.push([type, key]);

                const known = people[key];
                if (!known) {
                    people[key] = [person.Id || null, person.Name || '', person.PrimaryImageTag || null];
                } else {
                    if (!known[0] && person.Id) {
                        known[0] = person.Id;
                    }
                    if (!known[2] && person.PrimaryImageTag) {
                        known[2] = person.PrimaryImageTag;
                    }
                }
            }
            items[normalizeId(movie.Id)] = [movieYear(movie), moviePlayCount(movie), movie.DateCreated || '', cast];
        }

        return { people, items };
    }

    function isSnapshot(value) {
        return !!(value && value.items && value.people);
    }

    // Rebuilds the same structure aggregateAllRoles() produces, from the index.
    function aggregateFromSnapshot(snapshot) {
        const roles = {};

        for (const id of Object.keys(snapshot.items)) {
            const entry = snapshot.items[id];
            const year = entry[0];
            const plays = entry[1];
            for (const pair of (entry[3] || [])) {
                const type = pair[0];
                const key = pair[1];
                const bucket = roles[type] || (roles[type] = {});
                let actor = bucket[key];
                if (!actor) {
                    const meta = snapshot.people[key] || [null, '', null];
                    actor = bucket[key] = {
                        Id: meta[0],
                        Name: meta[1],
                        PrimaryImageTag: meta[2],
                        firstYear: null,
                        movieCount: 0,
                        watchCount: 0
                    };
                }
                actor.movieCount += 1;
                actor.watchCount += plays;
                if (Number.isFinite(year)) {
                    actor.firstYear = actor.firstYear == null ? year : Math.min(actor.firstYear, year);
                }
            }
        }

        const out = {};
        for (const type of Object.keys(roles)) {
            out[type] = Object.keys(roles[type]).map((key) => roles[type][key]);
        }
        return out;
    }

    function fingerprintFromSnapshot(snapshot) {
        let maxDate = '';
        let count = 0;
        for (const id of Object.keys(snapshot.items)) {
            count += 1;
            const created = snapshot.items[id][2];
            if (created && created > maxDate) {
                maxDate = created;
            }
        }
        return { count, maxDate };
    }

    // Drops deleted movies from the index. Returns how many were actually held.
    function removeFromSnapshot(snapshot, ids) {
        let removed = 0;
        for (const id of ids) {
            if (id && snapshot.items[id]) {
                delete snapshot.items[id];
                removed += 1;
            }
        }
        return removed;
    }

    // Ordered list of roles that currently have entries in state.rolesData.
    function getRoles() {        const data = state.rolesData || {};
        const present = Object.keys(data).filter((r) => (data[r] || []).length > 0);
        const ordered = ROLE_ORDER.filter((t) => present.indexOf(t) !== -1);
        const extras = present.filter((t) => ROLE_ORDER.indexOf(t) === -1).sort();
        return ordered.concat(extras);
    }

    // ---- persistent cache (localStorage, survives app restarts) ----
    function cacheKey(parentId) {
        return 'jamActorsCache:v1:' + (currentServerId() || '') + ':' + (currentUserId() || '') + ':' + (parentId || 'root');
    }

    function loadCache(parentId) {
        try {
            const raw = window.localStorage.getItem(cacheKey(parentId));
            if (!raw) {
                return null;
            }
            const obj = JSON.parse(raw);
            if (obj && obj.roles && obj.fingerprint) {
                return obj;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function saveCache(parentId, roles, fingerprint, snapshot) {
        const key = cacheKey(parentId);
        const savedAt = Date.now();
        try {
            window.localStorage.setItem(key, JSON.stringify({ roles, fingerprint, snapshot, savedAt }));
            return;
        } catch (e) { /* quota — retry without the (larger) snapshot below */ }
        try {
            window.localStorage.setItem(key, JSON.stringify({ roles, fingerprint, savedAt }));
        } catch (e) { /* quota / unavailable — non-fatal */ }
    }

    function sameFingerprint(a, b) {
        return !!(a && b && a.count === b.count && a.maxDate === b.maxDate);
    }

    function fingerprintFromMovies(movies) {
        let maxDate = '';
        for (const m of movies) {
            if (m.DateCreated && m.DateCreated > maxDate) {
                maxDate = m.DateCreated;
            }
        }
        return { count: movies.length, maxDate };
    }

    // Cheap library-state probe: one item to read TotalRecordCount + newest add.
    async function fetchFingerprint(parentId) {
        const a = api();
        const uid = currentUserId();
        if (!a || !uid) {
            return null;
        }
        const r = await a.getItems(uid, {
            ParentId: parentId || undefined,
            IncludeItemTypes: 'Movie',
            Recursive: true,
            Limit: 1,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'DateCreated',
            EnableImages: false,
            EnableUserData: false,
            EnableTotalRecordCount: true
        });
        const items = (r && r.Items) || [];
        return {
            count: (r && Number.isFinite(r.TotalRecordCount)) ? r.TotalRecordCount : items.length,
            maxDate: (items[0] && items[0].DateCreated) || ''
        };
    }

    function isCurrentActorsPage(page, parentId) {
        if (!page) {
            return state.parentId === parentId;
        }
        return document.getElementById(PAGE_ID) === page
            && getLibraryParentId() === parentId
            && isActorsShown();
    }

    // Cheap library-state probe against the fingerprint of the data we already
    // hold. A full rescan only happens when the library actually changed, so
    // playback activity and other notifications never cost a rescan.
    function verifyLoadedData(page, parentId, knownFingerprint) {
        const token = {};
        state.cacheCheckToken = token;
        if (page) {
            setStatus(page, 'Checking for changes\u2026');
        }

        fetchFingerprint(parentId).then((fingerprint) => {
            if (state.cacheCheckToken !== token || !isCurrentActorsPage(page, parentId)) {
                return;
            }
            state.cacheCheckToken = null;
            if (!fingerprint) {
                state.needsCheck = false;
                if (page) {
                    setStatus(page, 'Cached results (library check unavailable).');
                }
                return;
            }
            if (sameFingerprint(fingerprint, knownFingerprint)) {
                state.needsCheck = false;
                if (page) {
                    setStatus(page, '');
                }
                return;
            }
            void loadActors(page, true);
        }).catch((err) => {
            if (state.cacheCheckToken !== token || !isCurrentActorsPage(page, parentId)) {
                return;
            }
            state.cacheCheckToken = null;
            state.needsCheck = false;
            console.debug('[actors-mvp] cache verification failed', err);
            if (page) {
                setStatus(page, 'Cached results (library check unavailable).');
            }
        });
    }

    function getVisibleActors() {
        const text = state.search.trim().toLowerCase();
        return state.actors.filter((actor) => {
            if (text && String(actor.Name || '').toLowerCase().indexOf(text) === -1) {
                return false;
            }
            if (state.year !== 'all' && String(actor.firstYear == null ? '' : actor.firstYear) !== state.year) {
                return false;
            }
            return true;
        });
    }

    function cmpNum(a, b, dir) {
        if (a == null && b == null) {
            return 0;
        }
        if (a == null) {
            return 1; // nulls always last
        }
        if (b == null) {
            return -1;
        }
        if (a < b) {
            return -1 * dir;
        }
        if (a > b) {
            return 1 * dir;
        }
        return 0;
    }

    function sortActors(list) {
        const dir = state.sortOrder === 'asc' ? 1 : -1;
        const by = state.sortBy;
        return list.slice().sort((a, b) => {
            let r = 0;
            if (by === 'name') {
                r = a.Name.localeCompare(b.Name) * dir;
            } else if (by === 'year') {
                r = cmpNum(a.firstYear, b.firstYear, dir);
            } else if (by === 'movies') {
                r = cmpNum(a.movieCount, b.movieCount, dir);
            } else if (by === 'watch') {
                r = cmpNum(a.watchCount, b.watchCount, dir);
            }
            if (r !== 0) {
                return r;
            }
            return a.Name.localeCompare(b.Name);
        });
    }

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        const P = '#' + PAGE_ID;
        style.textContent = [
            P + '{position:fixed;left:0;right:0;bottom:0;top:0;z-index:100;',
            'display:flex;flex-direction:column;color:inherit;font-family:inherit;}',
            P + ' .jam-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;',
            'padding:14px 3.3%;border-bottom:1px solid rgba(127,127,127,.2);}',
            P + ' .jam-title{font-size:1.3em;font-weight:600;margin:0;}',
            P + ' .jam-count{opacity:.6;font-size:.95em;}',
            P + ' .jam-spacer{flex:1;}',
            P + ' .jam-label{opacity:.6;font-size:.9em;}',
            P + ' .jam-search{flex:1;min-width:180px;max-width:340px;padding:9px 13px;',
            'border-radius:6px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.08);color:inherit;font-size:1em;}',
            P + ' .jam-status{padding:10px 3.3%;opacity:.7;}',
            P + ' .jam-body{flex:1;overflow:auto;padding:4px 3.3% 28px;}',
            P + ' .jam-group{margin-top:14px;}',
            P + ' .jam-group-header{display:flex;align-items:center;gap:10px;width:100%;',
            'background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;',
            'padding:8px 4px;font-size:1.05em;font-weight:600;',
            'border-bottom:1px solid rgba(127,127,127,.2);}',
            P + ' .jam-caret{display:inline-block;transition:transform .15s;font-size:.85em;opacity:.8;}',
            P + ' .jam-group.collapsed .jam-caret{transform:rotate(-90deg);}',
            P + ' .jam-group-count{opacity:.55;font-weight:400;font-size:.9em;}',
            P + ' .jam-group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));',
            'gap:18px;align-content:start;padding:16px 0 4px;}',
            P + ' .jam-group.collapsed .jam-group-grid{display:none;}',
            P + ' .jam-card{display:flex;flex-direction:column;gap:8px;cursor:pointer;',
            'background:transparent;border:none;color:inherit;text-align:center;padding:0;}',
            P + ' .jam-thumb{width:100%;aspect-ratio:2/3;border-radius:8px;object-fit:cover;',
            'background:rgba(127,127,127,.15);display:flex;align-items:center;justify-content:center;}',
            P + ' .jam-thumb-ph{font-size:3em;opacity:.35;}',
            P + ' .jam-name{font-weight:600;font-size:.98em;line-height:1.2;}',
            P + ' .jam-meta{opacity:.6;font-size:.85em;}',
            P + ' .jam-card:hover .jam-name{text-decoration:underline;}',
            P + ' .jam-empty{opacity:.6;padding:20px 4px;}',
            // Custom dropdown (year + sort) and order toggle.
            '.jam-dd{position:relative;display:inline-block;}',
            '.jam-dd-btn,.jam-order{padding:9px 13px;border-radius:6px;border:1px solid rgba(127,127,127,.4);',
            'background:rgba(127,127,127,.08);color:inherit;font-size:1em;cursor:pointer;white-space:nowrap;}',
            '.jam-dd-btn:hover,.jam-order:hover{background:rgba(127,127,127,.18);}',
            P + ' .jam-refresh{padding:9px 13px;border-radius:6px;border:1px solid rgba(127,127,127,.4);',
            'background:rgba(127,127,127,.08);color:inherit;font-size:1em;cursor:pointer;white-space:nowrap;}',
            P + ' .jam-refresh:hover{background:rgba(127,127,127,.18);}',
            '.jam-dd-menu{background:#2b2b2b;color:#e0e0e0;border:1px solid #555;border-radius:6px;',
            'padding:4px 0;max-height:50vh;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.5);}',
            '.jam-dd-item{display:block;width:100%;text-align:left;background:transparent;border:none;',
            'color:inherit;padding:7px 16px;font-size:.95em;cursor:pointer;white-space:nowrap;}',
            '.jam-dd-item:hover{background:#3d3d3d;}',
            '.jam-dd-item.sel{font-weight:700;}',
            '.jam-filter-search{width:100%;margin:0 0 .5em 0;padding:.45em .65em;border-radius:4px;',
            'border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.1);color:inherit;font-size:.95em;}',
            // Launcher styled to match the sibling .emby-tab-button tabs without
            // using that class (which emby-tabs indexes positionally).
            '.' + TAB_MARK + '{box-sizing:border-box;background:transparent;box-shadow:none;cursor:pointer;',
            'outline:none;width:auto;font-family:inherit;font-size:inherit;display:inline-block;',
            'vertical-align:middle;flex-shrink:0;margin:0;padding:1.5em 1.5em;position:relative;',
            'height:auto;min-width:initial;line-height:1.25;border:0;border-radius:0;overflow:hidden;',
            'font-weight:600;color:inherit;opacity:.7;}',
            '.' + TAB_MARK + ':hover,.' + TAB_ACTIVE + '{opacity:1 !important;}'
        ].join('');
        document.head.appendChild(style);
    }

    // Lightweight custom dropdown. Returns { el, refresh }.
    function makeDropdown(getItems, getValue, onSelect) {
        const wrap = document.createElement('div');
        wrap.className = 'jam-dd';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'jam-dd-btn';
        wrap.appendChild(btn);

        let menu = null;

        function labelFor(value) {
            const item = getItems().find((i) => String(i.value) === String(value));
            return item ? item.label : '';
        }
        function refresh() {
            btn.textContent = labelFor(getValue()) + ' \u25BE';
        }
        function close() {
            if (menu) {
                menu.remove();
                menu = null;
            }
            document.removeEventListener('mousedown', onDocDown, true);
            window.removeEventListener('resize', close);
        }
        function onDocDown(e) {
            if (menu && !menu.contains(e.target) && e.target !== btn) {
                close();
            }
        }
        function open() {
            close();
            menu = document.createElement('div');
            menu.className = 'jam-dd-menu';
            menu.style.position = 'fixed';
            menu.style.zIndex = '2147483646';
            for (const item of getItems()) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'jam-dd-item' + (String(item.value) === String(getValue()) ? ' sel' : '');
                row.textContent = item.label;
                row.addEventListener('click', () => {
                    close();
                    onSelect(item.value);
                    refresh();
                });
                menu.appendChild(row);
            }
            const r = btn.getBoundingClientRect();
            menu.style.left = r.left + 'px';
            menu.style.top = r.bottom + 'px';
            menu.style.minWidth = r.width + 'px';
            document.body.appendChild(menu);
            document.addEventListener('mousedown', onDocDown, true);
            window.addEventListener('resize', close);
        }
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (menu) {
                close();
            } else {
                open();
            }
        });

        refresh();
        return { el: wrap, refresh };
    }

    function navigateToActors() {
        state.dismissed = false;
        // If jam=actors is already in the URL (e.g. we left via a real tab,
        // which doesn't change the URL), just show the page again without
        // pushing a duplicate history entry.
        if (isActorsActive()) {
            syncFromUrl();
            return;
        }
        const parentId = getLibraryParentId();
        const path = 'movies?' + (parentId ? 'topParentId=' + encodeURIComponent(parentId) + '&' : '') + ROUTE_FLAG;
        if (window.Emby && window.Emby.Page && window.Emby.Page.show) {
            window.Emby.Page.show(path);
        } else {
            window.location.hash = '#/' + path;
        }
    }

    function closeActorsPage() {
        const page = document.getElementById(PAGE_ID);
        if (page) {
            page.remove();
        }
        document.removeEventListener('keydown', onKeyDown);
        for (const tab of document.querySelectorAll('.' + TAB_MARK)) {
            tab.classList.remove(TAB_ACTIVE);
        }
    }

    function goBack() {
        if (window.Emby && window.Emby.Page && window.Emby.Page.back) {
            window.Emby.Page.back();
        } else {
            window.history.back();
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Escape' && document.getElementById(PAGE_ID)) {
            goBack();
        }
    }

    function openPerson(actor) {
        if (!actor || !actor.Id) {
            return;
        }
        const sid = currentServerId();
        window.location.hash = '#/details?id=' + actor.Id + (sid ? '&serverId=' + sid : '');
    }

    function setStatus(page, text) {
        const status = page.querySelector('.jam-status');
        if (status) {
            status.textContent = text || '';
            status.style.display = text ? '' : 'none';
        }
    }

    function getYearItems() {
        const years = Array.from(new Set(
            state.actors.map((a) => a.firstYear).filter((y) => Number.isFinite(y))
        )).sort((a, b) => a - b);
        return [{ value: 'all', label: 'All years' }]
            .concat(years.map((y) => ({ value: String(y), label: String(y) })));
    }

    function buildActorCard(actor) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'jam-card';

        const img = personImageUrl(actor);
        const thumb = document.createElement(img ? 'img' : 'div');
        thumb.className = 'jam-thumb';
        if (img) {
            thumb.src = img;
            thumb.alt = actor.Name;
            thumb.loading = 'lazy';
        } else {
            thumb.innerHTML = '<span class="jam-thumb-ph material-icons" aria-hidden="true">person</span>';
        }
        card.appendChild(thumb);

        const name = document.createElement('span');
        name.className = 'jam-name';
        name.textContent = actor.Name;
        card.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'jam-meta';
        const first = Number.isFinite(actor.firstYear) ? actor.firstYear : '—';
        meta.textContent = first + ' · ' + actor.movieCount + ' movie' + (actor.movieCount === 1 ? '' : 's')
            + ' · ' + actor.watchCount + ' play' + (actor.watchCount === 1 ? '' : 's');
        card.appendChild(meta);

        card.addEventListener('click', () => openPerson(actor));
        return card;
    }

    function renderGroup(page, groupKey, actors) {
        const group = page.querySelector('.jam-group[data-group="' + groupKey + '"]');
        if (!group) {
            return;
        }
        const countEl = group.querySelector('.jam-group-count');
        const grid = group.querySelector('.jam-group-grid');
        countEl.textContent = actors.length;

        group.classList.toggle('collapsed', !!state.collapsed[groupKey]);

        const frag = document.createDocumentFragment();
        for (const actor of actors) {
            frag.appendChild(buildActorCard(actor));
        }
        grid.innerHTML = '';
        if (!actors.length) {
            const empty = document.createElement('div');
            empty.className = 'jam-empty';
            empty.textContent = 'None.';
            grid.appendChild(empty);
        } else {
            grid.appendChild(frag);
        }
    }

    function render(page) {
        const countEl = page.querySelector('.jam-count');
        if (!state.actors.length) {
            countEl.textContent = '';
            renderGroup(page, 'withPhoto', []);
            renderGroup(page, 'withoutPhoto', []);
            return;
        }

        const visible = sortActors(getVisibleActors());
        countEl.textContent = visible.length + ' actor' + (visible.length === 1 ? '' : 's');

        const withPhoto = visible.filter(hasPhoto);
        const withoutPhoto = visible.filter((a) => !hasPhoto(a));
        renderGroup(page, 'withPhoto', withPhoto);
        renderGroup(page, 'withoutPhoto', withoutPhoto);
    }

    function buildGroup(groupKey, label) {
        return [
            '  <div class="jam-group" data-group="' + groupKey + '">',
            '    <button type="button" class="jam-group-header" data-group="' + groupKey + '">',
            '      <span class="jam-caret">\u25BC</span>',
            '      <span>' + label + '</span>',
            '      <span class="jam-group-count">0</span>',
            '    </button>',
            '    <div class="jam-group-grid"></div>',
            '  </div>'
        ].join('');
    }

    function applyBackground(page) {
        let bg = '';
        try {
            const skinBody = document.querySelector('.skinBody') || document.body;
            bg = getComputedStyle(skinBody).backgroundColor;
        } catch (e) { /* ignore */ }
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
            bg = '#101010';
        }
        page.style.background = bg;
    }

    function positionPage(page) {
        const header = document.querySelector('.skinHeader');
        const top = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
        page.style.top = (top > 0 ? top : 0) + 'px';
    }

    function buildPage() {
        ensureStyles();

        const page = document.createElement('div');
        page.id = PAGE_ID;
        page.innerHTML = [
            '<div class="jam-controls">',
            '  <h2 class="jam-title">Actors</h2>',
            '  <span class="jam-count"></span>',
            '  <span class="jam-label">Role</span>',
            '  <span class="jam-role-slot"></span>',
            '  <input type="text" class="jam-search" placeholder="Search by name\u2026" />',
            '  <span class="jam-label">Sort</span>',
            '  <span class="jam-sort-slot"></span>',
            '  <button type="button" class="jam-order" title="Toggle sort order"></button>',
            '  <span class="jam-label">Year</span>',
            '  <span class="jam-year-slot"></span>',
            '  <button type="button" class="jam-refresh" title="Rescan library">\u21bb Refresh</button>',
            '  <span class="jam-spacer"></span>',
            '</div>',
            '<div class="jam-status"></div>',
            '<div class="jam-body">',
            buildGroup('withPhoto', 'With photo'),
            buildGroup('withoutPhoto', 'Without photo'),
            '</div>'
        ].join('');

        applyBackground(page);

        const search = page.querySelector('.jam-search');
        search.addEventListener('input', () => {
            state.search = search.value || '';
            render(page);
        });
        search.value = state.search;

        const sortDd = makeDropdown(
            () => SORT_OPTIONS,
            () => state.sortBy,
            (value) => { state.sortBy = value; render(page); }
        );
        sortDd.el.classList.add('jam-dd-sort');
        page.querySelector('.jam-sort-slot').replaceWith(sortDd.el);

        const orderBtn = page.querySelector('.jam-order');
        function refreshOrder() {
            orderBtn.textContent = state.sortOrder === 'asc' ? '\u2191 Asc' : '\u2193 Desc';
        }
        orderBtn.addEventListener('click', () => {
            state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
            refreshOrder();
            render(page);
        });
        refreshOrder();

        const yearDd = makeDropdown(
            getYearItems,
            () => state.year,
            (value) => { state.year = value; render(page); }
        );
        yearDd.el.classList.add('jam-dd-year');
        page.querySelector('.jam-year-slot').replaceWith(yearDd.el);
        page._jamYearDd = yearDd;

        const roleDd = makeDropdown(
            () => getRoles().map((t) => ({ value: t, label: roleLabel(t) })),
            () => state.role,
            (value) => applyRole(page, value)
        );
        roleDd.el.classList.add('jam-dd-role');
        page.querySelector('.jam-role-slot').replaceWith(roleDd.el);
        page._jamRoleDd = roleDd;
        updateTitle(page);

        for (const header of page.querySelectorAll('.jam-group-header')) {
            header.addEventListener('click', () => {
                const key = header.getAttribute('data-group');
                state.collapsed[key] = !state.collapsed[key];
                render(page);
            });
        }

        document.body.appendChild(page);
        positionPage(page);
        const refreshBtn = page.querySelector('.jam-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => loadActors(page, true));
        }
        setTimeout(() => search.focus(), 0);
        return page;
    }

    function updateTitle(page) {
        const title = page.querySelector('.jam-title');
        if (title) {
            title.textContent = roleLabel(state.role);
        }
    }

    function applyRole(page, role) {
        state.role = role;
        state.actors = (state.rolesData && state.rolesData[role]) || [];
        // The available years depend on the role's people, so refresh + clamp.
        const years = new Set(state.actors.map((a) => a.firstYear).filter((y) => Number.isFinite(y)));
        if (state.year !== 'all' && !years.has(Number(state.year))) {
            state.year = 'all';
        }
        updateTitle(page);
        if (page._jamYearDd) {
            page._jamYearDd.refresh();
        }
        if (page._jamRoleDd) {
            page._jamRoleDd.refresh();
        }
        render(page);
    }

    // Point state.actors at the current role, falling back to the first role
    // that actually has entries.
    function selectRoleData() {
        const data = state.rolesData || {};
        if (!(data[state.role] && data[state.role].length)) {
            const roles = getRoles();
            if (roles.length) {
                state.role = roles[0];
            }
        }
        state.actors = (data[state.role]) || [];
    }

    function applyLoadedData(page) {
        selectRoleData();
        state.loaded = true;
        if (page._jamYearDd) {
            page._jamYearDd.refresh();
        }
        if (page._jamRoleDd) {
            page._jamRoleDd.refresh();
        }
        updateTitle(page);
        render(page);
        setStatus(page, state.actors.length ? '' : ('No ' + roleLabel(state.role).toLowerCase() + ' found in this library.'));
    }

    function markDataLoaded() {
        selectRoleData();
        state.loaded = true;
    }

    async function loadActors(page, force) {
        const parentId = getLibraryParentId();

        if (!parentId || !currentUserId()) {
            return;
        }

        if (force) {
            state.cacheCheckToken = null;
            state.needsCheck = false;
        }

        if (state.loading && state.parentId === parentId) {
            if (page) {
                setStatus(page, 'Loading movies\u2026');
            }
            return;
        }

        // Data already in memory: show it right away. A pending library-change
        // notification only costs a cheap fingerprint probe, never a rescan.
        if (state.loaded && state.parentId === parentId && !force) {
            if (page) {
                applyLoadedData(page);
            }
            if (state.needsCheck) {
                verifyLoadedData(page, parentId, state.fingerprint);
            }
            return;
        }

        state.parentId = parentId;
        state.loading = true;

        try {
            // Persistent cache (survives restarts): use it if a cheap fingerprint
            // check shows the library hasn't changed.
            if (!force) {
                const cached = loadCache(parentId);
                if (cached) {
                    state.rolesData = cached.roles;
                    state.fingerprint = cached.fingerprint;
                    state.snapshot = isSnapshot(cached.snapshot) ? cached.snapshot : null;
                    if (page) {
                        applyLoadedData(page);
                    } else {
                        markDataLoaded();
                    }
                    verifyLoadedData(page, parentId, cached.fingerprint);
                    return;
                }
            }

            // Full scan.
            if (page) {
                setStatus(page, state.loaded ? 'Refreshing\u2026' : 'Loading movies\u2026');
            }
            const movies = await fetchMoviesWithPeople(parentId, (loaded, total) => {
                const p = document.getElementById(PAGE_ID);
                if (p) {
                    setStatus(p, 'Scanning movies\u2026 ' + loaded + '/' + total);
                }
            });
            if (state.parentId !== parentId) {
                return;
            }
            state.snapshot = buildSnapshot(movies);
            state.rolesData = aggregateAllRoles(movies);
            state.fingerprint = fingerprintFromMovies(movies);
            state.needsCheck = false;
            saveCache(parentId, state.rolesData, state.fingerprint, state.snapshot);
            markDataLoaded();

            const p = document.getElementById(PAGE_ID);
            if (p && isCurrentActorsPage(p, parentId)) {
                applyLoadedData(p);
            }
        } catch (err) {
            console.error('[actors-mvp] failed loading actors', err);
            const p = document.getElementById(PAGE_ID);
            if (p) {
                setStatus(p, 'Failed to load actors.');
            }
        } finally {
            state.loading = false;
        }
    }

    function syncFromUrl() {
        const show = isActorsShown();
        let page = document.getElementById(PAGE_ID);

        if (show) {
            if (!page) {
                page = buildPage();
                document.addEventListener('keydown', onKeyDown);
                loadActors(page);
            } else {
                positionPage(page);
            }
        } else if (isMoviesRoute() && getLibraryParentId() && currentUserId()) {
            // Warm the active movie library before the user opens Actors.
            void loadActors(null);
        } else if (page) {
            closeActorsPage();
        }

        for (const tab of document.querySelectorAll('.' + TAB_MARK)) {
            tab.classList.toggle(TAB_ACTIVE, show);
        }
    }

    function makeActorsTab() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = TAB_MARK + (isActorsActive() ? ' ' + TAB_ACTIVE : '');
        btn.innerHTML = '<div class="emby-button-foreground">Actors</div>';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            navigateToActors();
        });
        return btn;
    }

    function ensureActorsTab() {
        if (!isMoviesRoute()) {
            return;
        }
        const slider = document.querySelector('.skinHeader .headerTabs .emby-tabs-slider')
            || document.querySelector('.tabs-viewmenubar .emby-tabs-slider');
        if (!slider) {
            return;
        }
        if (slider.querySelector('.' + TAB_MARK)) {
            return;
        }
        const moviesTab = slider.querySelector('.emby-tab-button[data-index="0"]')
            || slider.querySelector('.emby-tab-button');
        if (!moviesTab) {
            return;
        }
        // Inject styles now so the tab matches the other (inactive) tabs the
        // moment it appears — not only after the page is first opened.
        ensureStyles();
        slider.insertBefore(makeActorsTab(), moviesTab.nextSibling);
    }

    // The movies controller swaps tabs via internal state without touching the
    // URL, so leaving Actors via a real tab is handled with an in-memory
    // "dismissed" flag (avoids manipulating the URL, which desynced the host
    // router). jam=actors stays in the URL but the page is hidden.
    function onDocClickCapture(e) {
        const target = e.target;
        if (!target || !target.closest) {
            return;
        }
        const realTab = target.closest('.emby-tab-button');
        if (realTab && !realTab.classList.contains(TAB_MARK) && isActorsShown()) {
            state.dismissed = true;
            closeActorsPage();
        }
    }

    function changedIds(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .map((entry) => normalizeId(typeof entry === 'string' ? entry : (entry && (entry.Id || entry.ItemId))))
            .filter(Boolean);
    }

    // Subtracts deleted movies from the cached index and rebuilds the aggregate
    // locally. Returns true when something was actually removed.
    function applyRemovals(ids, page) {
        if (!isSnapshot(state.snapshot) || !removeFromSnapshot(state.snapshot, ids)) {
            return false;
        }
        state.rolesData = aggregateFromSnapshot(state.snapshot);
        state.fingerprint = fingerprintFromSnapshot(state.snapshot);
        saveCache(state.parentId, state.rolesData, state.fingerprint, state.snapshot);
        if (page) {
            applyLoadedData(page);
        } else {
            markDataLoaded();
        }
        return true;
    }

    // Library-change notifications mark the data for verification. Deletions are
    // resolved from the cached index without touching the network; anything else
    // falls through to the cheap fingerprint probe, which decides whether a full
    // rescan is warranted. Routine chatter (playback activity) costs nothing.
    function onApiMessage(e, msg) {
        const data = msg || e;
        if (!data || data.MessageType !== 'LibraryChanged') {
            return;
        }
        state.needsCheck = true;

        // Keyed to the library the data belongs to, not the current route: a
        // movie is usually deleted from its details page, which has no library
        // id in the URL.
        const parentId = state.parentId;
        if (!state.loaded || !parentId || state.loading) {
            return;
        }

        const page = document.getElementById(PAGE_ID);
        const target = page && isActorsShown() ? page : null;
        const payload = data.Data || {};
        const removed = changedIds(payload.ItemsRemoved);
        const otherChanges = changedIds(payload.ItemsAdded).length
            + changedIds(payload.ItemsUpdated).length;

        if (removed.length && !otherChanges) {
            if (applyRemovals(removed, target)) {
                // The snapshot and its fingerprint now reflect the deletion
                // exactly, so no server probe or full scan is needed.
                state.needsCheck = false;
                return;
            }
        }
        // Additions, updates, and deletions absent from an older index still
        // need confirmation. A disagreement falls back to a full rescan.
        verifyLoadedData(target, parentId, state.fingerprint);
    }

    function setupLibraryWatch() {
        if (state.libWatch || !window.Events || !window.ApiClient) {
            return;
        }
        try {
            window.Events.on(window.ApiClient, 'message', onApiMessage);
            if (window.ApiClient.ensureWebSocket) {
                window.ApiClient.ensureWebSocket();
            }
            state.libWatch = true;
        } catch (err) {
            console.debug('[actors-mvp] library watch setup failed', err);
        }
    }

    // Real URL changes are authoritative: clear the in-memory dismissed flag.
    function onUrlChange() {
        state.dismissed = false;
        scheduleScan();
    }

    function enhanceFilterDialogs() {
        const groups = document.querySelectorAll('.filterDialog .filterOptions');
        for (const opts of groups) {
            if (opts.getAttribute(FILTER_MARK) === '1') {
                continue;
            }
            const list = opts.querySelector('.checkboxList');
            if (!list) {
                continue;
            }
            const labels = list.querySelectorAll('label');
            if (labels.length < 6) {
                opts.setAttribute(FILTER_MARK, '1');
                continue;
            }

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'jam-filter-search';
            input.placeholder = 'Filter options\u2026';
            opts.insertBefore(input, list);
            input.addEventListener('input', () => {
                const query = input.value.trim().toLowerCase();
                for (const label of list.querySelectorAll('label')) {
                    const text = (label.textContent || '').toLowerCase();
                    label.style.display = (!query || text.indexOf(query) !== -1) ? '' : 'none';
                }
            });
            opts.setAttribute(FILTER_MARK, '1');
        }
    }

    let scheduled = false;
    function scheduleScan() {
        if (scheduled) {
            return;
        }
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try {
                setupLibraryWatch();
                ensureActorsTab();
                enhanceFilterDialogs();
                syncFromUrl();
            } catch (err) {
                console.debug('[actors-mvp] scan error', err);
            }
        });
    }

    function init() {
        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
        document.addEventListener('click', onDocClickCapture, true);
        window.addEventListener('hashchange', onUrlChange);
        window.addEventListener('popstate', onUrlChange);
        window.addEventListener('resize', () => {
            const page = document.getElementById(PAGE_ID);
            if (page) {
                positionPage(page);
            }
        });
        setupLibraryWatch();
        scheduleScan();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Exposed for headless unit testing of pure logic (no-op in the app).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fetchMoviesWithPeople, aggregateActors, aggregatePeople, aggregateAllRoles, getRolesFromMovies, roleLabel, getVisibleActors, sortActors, hasPhoto, movieYear, moviePlayCount, fingerprintFromMovies, sameFingerprint, buildSnapshot, aggregateFromSnapshot, fingerprintFromSnapshot, removeFromSnapshot, normalizeId, state };
    }
})();
