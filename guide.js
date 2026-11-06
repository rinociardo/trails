// Trail-guide importer: turns a club's milestone sheet into places to route
// between and waypoints along the route. Pure logic, no browser APIs. The screen
// is guide-import.js.
//
// A milestone: { mile, restroom, text, place } where text is the sheet's words and
// place is { query, alternatives } for something place search can find, or null
// for an unnamed turn ("fork right at the pump house").

import { haversine, buildTrack, locateOnTrack, pointAtDistance } from './geo.js';
import { SEGMENT_STRAIGHT, SEGMENT_TRAIL, lineLength } from './plan.js';

export const METRES_PER_MILE = 1609.344;
export const LEG_TOLERANCE = 0.10; // a leg further than this from the sheet is flagged

// Contact details never become milestones, so they can't reach the place search.
const CONTACT = /[\w.+-]+@[\w-]+\.[\w.-]+|\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/;
export const hasContactDetails = (text) => CONTACT.test(text);
const MAX_MILE = 1000;

// "2.95*  Stop at the marina…": a mileage, an optional * for restrooms, then the words.
const MILESTONE = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(\*?)\s+(\S.*?)\s*$/;

// Keeps the longest run of mileages that never goes down, so one stray line
// starting with a number ("30 hikers…") can't throw out the real ones after it.
// rows: [{ mile, … }]. Returns { kept, dropped } in sheet order.
function inMileOrder(rows) {
    const best = rows.map(() => 1), from = rows.map(() => -1);
    let end = -1;
    rows.forEach((row, i) => {
        for (let j = 0; j < i; j++) {
            if (rows[j].mile <= row.mile && best[j] + 1 > best[i]) {
                best[i] = best[j] + 1;
                from[i] = j;
            }
        }
        if (end < 0 || best[i] >= best[end]) end = i;
    });
    const keep = new Set();
    for (let i = end; i >= 0; i = from[i]) keep.add(i);
    return { kept: rows.filter((_, i) => keep.has(i)), dropped: rows.filter((_, i) => !keep.has(i)) };
}

// The pasted sheet. Returns { milestones, ignored } with ignored the other lines' text.
export function parseGuideText(text) {
    const rows = [], ignored = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = MILESTONE.exec(line);
        const mile = m ? Number(m[1]) : NaN;
        if (!m || CONTACT.test(line) || mile >= MAX_MILE || !/\p{L}/u.test(m[3])) {
            ignored.push(line);
            continue;
        }
        const words = m[3].replace(/\s+/g, ' ');
        rows.push({ mile, restroom: m[2] === '*', text: words, line });
    }
    const { kept, dropped } = inMileOrder(rows);
    return {
        milestones: withoutRepeats(kept.map(({ mile, restroom, text: words }) => ({ mile, restroom, text: words, place: placeFrom(words) }))),
        ignored: [...ignored, ...dropped.map((r) => r.line)],
    };
}

// The same place on two lines in a row is one route point: the later line is a turn.
function withoutRepeats(milestones) {
    let last = null;
    return milestones.map((m) => {
        if (!m.place) return m;
        if (m.place.query === last) return { ...m, place: null };
        last = m.place.query;
        return m;
    });
}

// One CSV line into fields (double quotes around a field, "" for a quote inside).
function csvFields(line) {
    const fields = [];
    let field = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { fields.push(field); field = ''; }
        else field += c;
    }
    fields.push(field);
    return fields.map((f) => f.trim());
}

const CSV_COLUMNS = ['mile', 'place', 'note', 'restroom'];

// Does this text have the CSV's header line (mile, place, note, restroom in any order)?
export function looksLikeCsv(text) {
    const first = String(text).replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim());
    if (!first) return false;
    const header = csvFields(first).map((f) => f.toLowerCase());
    return header.includes('mile') && header.includes('place');
}

// CSV with columns mile, place, note, restroom (the place is used as written, so
// there is no guessing). Without a header line, the columns are taken in that order.
export function parseGuideCsv(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const hasHeader = looksLikeCsv(text);
    const header = hasHeader ? csvFields(lines[0]).map((f) => f.toLowerCase()) : CSV_COLUMNS;
    const column = (fields, name) => {
        const i = header.indexOf(name);
        return i >= 0 ? fields[i] ?? '' : '';
    };
    const rows = [], ignored = [];
    for (const line of hasHeader ? lines.slice(1) : lines) {
        const fields = csvFields(line);
        const rawMile = column(fields, 'mile');
        const mile = /^\d*\.?\d+\*?$/.test(rawMile) ? parseFloat(rawMile) : NaN;
        const place = column(fields, 'place');
        const note = column(fields, 'note');
        if (!Number.isFinite(mile) || mile >= MAX_MILE || CONTACT.test(line) || !(place || note)) {
            ignored.push(line);
            continue;
        }
        const restroom = rawMile.endsWith('*') || /^(y|yes|true|1|x|\*)$/i.test(column(fields, 'restroom'));
        rows.push({ mile, restroom, text: note || place, place: place ? { query: place, alternatives: [] } : null, line });
    }
    const { kept, dropped } = inMileOrder(rows);
    return {
        milestones: withoutRepeats(kept.map(({ line, ...row }) => row)),
        ignored: [...ignored, ...dropped.map((r) => r.line)],
    };
}

// ---------- Place names in a milestone's words ----------

// Direction words, capitalized only because they start a sentence.
const NOT_A_NAME = new Set(['Begin', 'Start', 'Turn', 'Take', 'Go', 'Cross', 'Pass', 'Arrive', 'At', 'Bear', 'Reach', 'Head',
    'Continue', 'Follow', 'Keep', 'Stay', 'End', 'Left', 'Right', 'Straight', 'Confirm', 'On', 'In', 'Then', 'A', 'An', 'The',
    'After', 'Under', 'From', 'To', 'Over', 'Past', 'Walk', 'Hike', 'Climb', 'Descend', 'Enter', 'Exit', 'Leave', 'Note',
    'This', 'That', 'There', 'Here', 'Look', 'Watch', 'Use', 'Restrooms', 'Restroom', 'North', 'South', 'East', 'West']);
// A name can carry these, but never start with them alone ("South Oakham" is fine; "South" isn't).
const NAME_START_OK = new Set(['North', 'South', 'East', 'West']);
const ABBREVIATIONS = /^(St|Mt|Ft|Dr|Rd|Ave|Pt|Jr|Sr)\.$/;
const STREET = 'Street|St\\.?|Road|Rd\\.?|Avenue|Ave\\.?|Place|Pl\\.?|Lane|Ln\\.?|Drive|Dr\\.?|Boulevard|Blvd\\.?|Highway|Hwy\\.?|Way|Court|Ct\\.?';
// "812 Tansy Street, West Larkmere, QX"
const ADDRESS = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z][\\w’'.-]*\\s+){1,5}?(?:${STREET})(?:,\\s*(?:[A-Z][\\w’'.-]*\\s*)+)?(?:,\\s*[A-Z]{2}\\b)?`, 'g');
// Somewhere you can stand: searched by default.
const SPOT = /\b(Trailhead|Marina|Park|Cemetery|Point|Restaurant|Store|Bridge|Church|School|Museum|Library|Center|Centre|Station|Lodge|Hut|Inn|Farm|Mill|Lake|Pond|Falls|Peak|Summit|Overlook|Campground|Parking)\b$/;
// Long things: a search gives some point along them, which makes a poor route point.
const LONG = /\b(Trail|Path|Canal|River|Creek|Brook|Road|Rd|Street|Streets|St|Avenue|Ave|Highway|Hwy|Route|Drive|Lane|Boulevard)\.?$/;
// A name after one of these is somewhere else ("carry on to Oakham", "past the
// marina") or a poor route point ("under the bridge": a search finds the road on top of
// it, and the router can't get there from the trail below).
const ELSEWHERE = new Set(['to', 'toward', 'towards', 'past', 'until', 'before', 'from', 'beyond', 'via', 'under']);
const ROAD_CODE = /^[A-Z]{1,3}-\d+[A-Z]?(\/[A-Z]{1,3}-\d+[A-Z]?)*$/;

const SCORE = { address: 4, spot: 3, name: 2, long: 1, code: 0 };
const PLACE_MIN_SCORE = SCORE.name; // below this a line is a waypoint unless changed by hand

function kindOf(name) {
    if (ROAD_CODE.test(name)) return 'code';
    if (LONG.test(name)) return 'long';
    if (SPOT.test(name)) return 'spot';
    return 'name';
}

// Candidate place names, best first: [{ text, kind, elsewhere }]. An address or a
// name in the line's first sentence comes before others (the milestone is where the
// first sentence says; later ones are often just things passed afterwards). elsewhere:
// the words say it isn't here, so it can be chosen by hand but isn't used by default.
export function findPlaceNames(text) {
    const found = [];
    const firstSentenceEnd = (() => {
        const m = /(?<!\b(?:St|Mt|Ft|Dr|Rd|Ave|Pt))[.!?]\s/.exec(text);
        return m ? m.index : text.length;
    })();

    // Addresses first, blanked out so their words aren't read again.
    const rest = text.replace(ADDRESS, (match, offset) => {
        found.push({ text: match.replace(/[.,]$/, ''), kind: 'address', at: offset });
        return ' '.repeat(match.length);
    });

    let words = [];
    let lastLower = ''; // the last lowercase word before the current name, skipping "the"
    let elsewhere = false;
    const flush = () => {
        while (words.length && (/^(of|and|the)$/.test(words[0].word) ||
            (NOT_A_NAME.has(words[0].word) && !(NAME_START_OK.has(words[0].word) && words.length > 1)))) words.shift();
        while (words.length && /^(of|and|the)$/.test(words[words.length - 1].word)) words.pop();
        if (words.length) {
            const name = words.map((w) => w.word).join(' ');
            // One word opening a sentence is a verb far more often than a place ("Duck under…").
            const opensSentence = /(^|[.!?])\s*$/.test(rest.slice(0, words[0].at));
            const bad = (words.length === 1 && opensSentence) || name.length < 2 || /^[A-Z]{1,2}$/.test(name) || (name.includes('/') && !ROAD_CODE.test(name));
            if (!bad) found.push({ text: name, kind: kindOf(name), at: words[0].at, comma: words[words.length - 1].comma, elsewhere });
        }
        words = [];
    };
    for (const m of rest.matchAll(/\S+/g)) {
        const raw = m[0];
        const opened = raw.startsWith('(');
        if (opened) flush();
        const stripped = raw.replace(/^[("“‘]+/, '').replace(/[)"”’,;:!?]+$/, '');
        const abbreviation = ABBREVIATIONS.test(stripped);
        const word = abbreviation ? stripped : stripped.replace(/\.$/, '').replace(/[’']s$/, '');
        const breaks = stripped !== word || /[),;:!?]$/.test(raw);
        const capital = /^[A-Z]/.test(word) && /[\p{L}\d]/u.test(word);
        const joiner = words.length > 0 && /^(of|and|the)$/.test(word);
        if (!capital && !joiner && word !== 'the') lastLower = word.toLowerCase();
        if (capital || joiner) {
            if (!words.length) elsewhere = ELSEWHERE.has(lastLower);
            words.push({ word, at: m.index, comma: raw.endsWith(',') });
            if (breaks && !abbreviation) flush();
        } else {
            flush();
        }
    }
    flush();

    return found
        .sort((a, b) => (Number(Boolean(a.elsewhere)) - Number(Boolean(b.elsewhere))) ||
            (Number(b.at < firstSentenceEnd) - Number(a.at < firstSentenceEnd)) ||
            (SCORE[b.kind] - SCORE[a.kind]) || (a.at - b.at))
        .map(({ text: name, kind, at, comma, elsewhere: away }) => {
            // "Merrowgate Green, Dunmarrow": the town right after helps the search.
            const town = comma && found.find((o) => o.kind === 'name' && o.at > at && o.at <= at + name.length + 3);
            return { text: town ? `${name}, ${town.text}` : name, kind, elsewhere: Boolean(away) };
        });
}

// What to search for on this line, or null for an unnamed turn.
function placeFrom(words) {
    const names = findPlaceNames(words);
    if (!names.length || names[0].elsewhere || SCORE[names[0].kind] < PLACE_MIN_SCORE) return null;
    return { query: names[0].text, alternatives: names.slice(1).map((n) => n.text) };
}

// ---------- Choosing a search result ----------

// State or province codes the sheet itself mentions ("…, MD"), to narrow a worldwide
// search when a name alone finds nothing near the route.
export function regionsFrom(milestones) {
    const found = new Set();
    for (const m of milestones) {
        for (const match of m.text.matchAll(/,\s*([A-Z]{2})\b(?!-)/g)) found.add(match[1]);
    }
    return [...found];
}

// Words a result may leave out: a trailhead is often listed under its town or park.
const OPTIONAL_WORDS = new Set(['trailhead', 'parking', 'area', 'lot']);
const wordsOf = (text) => String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/\bst\b\.?/g, 'saint').replace(/['’]s\b/g, 's').match(/[\p{L}\d]+/gu) ?? [];

// Is this result really called what we searched for? Near isn't enough: "Oak
// Park" must not settle for Oak Street. Only the name counts, not the town after a
// comma; an address is taken as found (its number and town are often written differently).
export function sameName(query, label) {
    if (/^\d/.test(query)) return true;
    const found = new Set(wordsOf(label));
    return wordsOf(query.split(',')[0]).every((word) => OPTIONAL_WORDS.has(word) || found.has(word));
}

// Index of the first result that could be right: called what was searched for
// (when query is given), and not further from the previous place than the sheet's
// distance allows. Returns { index, plausible }; index 0 with plausible false: none is.
export function chooseResult(results, previous, sheetM, query = null) {
    if (!results.length) return { index: -1, plausible: false };
    const limit = sheetM * 1.25 + 1500; // the sheet's miles are along the trail, so at least the straight line
    const index = results.findIndex((r) => (!query || sameName(query, r.label ?? '')) &&
        (!previous || haversine(previous, r) <= limit));
    return index >= 0 ? { index, plausible: true } : { index: 0, plausible: false };
}

// Wraps a search so each text is only asked once (the quota is shared). Failures
// aren't kept, so a later try can still work.
export function cachedSearch(search) {
    const answers = new Map();
    return async (text, near) => {
        if (answers.has(text)) return answers.get(text);
        const answer = await search(text, near);
        if (answer.ok) answers.set(text, answer);
        return answer;
    };
}

// Looks for a place: the name alone, then with each state the sheet mentions, until a
// result fits chooseResult. search(text, near) answers like searchPlaces().
// Resolves { ok: true, results, index } (index -1: nothing fits) or the failed answer.
export async function findPlace(query, { near = null, focus = null, sheetM = 0, regions = [], search }) {
    const results = [];
    for (const text of [query, ...regions.map((code) => `${query}, ${code}`)]) {
        const answer = await search(text, near ?? focus);
        if (!answer.ok) return answer;
        for (const p of answer.places) {
            if (!results.some((r) => r.lat === p.lat && r.lon === p.lon)) results.push(p);
        }
        const { index, plausible } = chooseResult(results, near, sheetM, query);
        if (plausible) return { ok: true, results, index };
    }
    return { ok: true, results, index: -1 };
}

// ---------- From places to a plan ----------

// anchors: the confirmed places, [{ lat, lon }], in order. paths[i]: the router's
// path from anchor i to i+1, or null (a straight line). A point is moved to where
// its route meets the trails, so a place off the path (an address, a car park)
// adds no out-and-back spur to the line or its length.
// Returns { vertices, segments, routes }, as PlanEditor takes them.
export function planFromLegs(anchors, paths) {
    const vertices = anchors.map((a, i) => {
        const start = paths[i]?.[0];
        const end = paths[i - 1]?.[paths[i - 1].length - 1];
        const { lat, lon } = end ?? start ?? a;
        return { lat, lon };
    });
    const segments = paths.map((p) => (p ? SEGMENT_TRAIL : SEGMENT_STRAIGHT));
    const routes = paths.map((p, i) => {
        if (!p) return null;
        return [vertices[i], ...p, vertices[i + 1]]
            .filter((q, k, all) => k === 0 || q.lat !== all[k - 1].lat || q.lon !== all[k - 1].lon)
            .map(({ lat, lon }) => ({ lat, lon }));
    });
    return { vertices, segments, routes };
}

// One row per leg: { from, to, sheetM, routeM, diffRatio, flagged } (from and to:
// sheet miles). diffRatio is null when the sheet gives no distance to compare with.
export function compareLegs(anchorMiles, lines, tolerance = LEG_TOLERANCE) {
    return lines.map((line, i) => {
        const sheetM = (anchorMiles[i + 1] - anchorMiles[i]) * METRES_PER_MILE;
        const routeM = lineLength(line);
        const diffRatio = sheetM > 0 ? (routeM - sheetM) / sheetM : null;
        const off = diffRatio == null || Math.abs(diffRatio) > tolerance;
        return { from: anchorMiles[i], to: anchorMiles[i + 1], sheetM, routeM, diffRatio, flagged: off };
    });
}

// Every milestone as a waypoint on the finished route. A place sits at its route
// point. A turn sits by its mileage, scaled to the routed length of its leg, so a
// leg that came out 3% long doesn't push its turns 3% further along than the places
// around them. Beyond the first or last place: the sheet's distance from it, kept on the line.
// milestones: all of them, in order. anchorIndexes: positions in milestones of the
// confirmed places (one per vertex of the plan), with lines[i] from vertex i to i+1.
export function placeWaypoints(milestones, anchorIndexes, lines) {
    const line = lines.flatMap((l, i) => (i === 0 ? l : l.slice(1)));
    const track = buildTrack(line);
    const alongs = [0];
    for (const l of lines) alongs.push(alongs[alongs.length - 1] + lineLength(l));
    const miles = anchorIndexes.map((m) => milestones[m].mile);

    const alongOf = (mile) => {
        if (mile <= miles[0]) return alongs[0] - (miles[0] - mile) * METRES_PER_MILE;
        for (let i = 0; i < lines.length; i++) {
            if (mile <= miles[i + 1]) {
                const span = miles[i + 1] - miles[i];
                return alongs[i] + (span > 0 ? (mile - miles[i]) / span : 0) * (alongs[i + 1] - alongs[i]);
            }
        }
        return alongs[lines.length] + (mile - miles[lines.length]) * METRES_PER_MILE;
    };

    return milestones.map((m, index) => {
        const a = anchorIndexes.indexOf(index);
        const { lat, lon } = pointAtDistance(track, a >= 0 ? alongs[a] : alongOf(m.mile));
        return { lat, lon, mile: m.mile, name: a >= 0 ? m.place.query : '', note: m.text, restroom: m.restroom };
    });
}

// ---------- During the hike ----------

// Where each waypoint is along this track, in order along it: adds `along`.
// Always worked out from lat/lon, so it holds after Reverse, a GPX import or an edit.
export function locateWaypoints(track, waypoints) {
    if (!waypoints?.length) return [];
    let prev = 0;
    const located = waypoints.map((w) => {
        const { along } = locateOnTrack(track, w, prev);
        return { w, along };
    }).sort((a, b) => a.along - b.along);
    prev = 0;
    return located.map(({ w }) => {
        const { along } = locateOnTrack(track, w, prev);
        prev = along;
        return { ...w, along };
    });
}

export const WAYPOINT_PASSED_M = 15; // GPS can't tell closer than this: it counts as reached

// The next waypoint ahead of `along`, with the distance to it, or null after the last.
export function nextWaypoint(waypoints, along) {
    const next = waypoints?.find((w) => w.along > along + WAYPOINT_PASSED_M);
    return next ? { waypoint: next, distance: next.along - along } : null;
}
