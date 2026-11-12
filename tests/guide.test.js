import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseGuideText, parseGuideCsv, looksLikeCsv, findPlaceNames, chooseResult, sameName, regionsFrom, findPlace, cachedSearch, planFromLegs, compareLegs,
    placeWaypoints, locateWaypoints, nextWaypoint, METRES_PER_MILE,
} from '../guide.js';
import { buildTrack } from '../geo.js';
import { lineLength } from '../plan.js';
import { buildGpx } from '../gpx.js';
import { searchPlaces } from '../geocoder.js';
import { routeBetween } from '../router.js';
import { useRecordedResponses } from './helpers/recorded.js';

const SHEET = readFileSync(new URL('./fixtures/guide-milestones.txt', import.meta.url), 'utf8');
const M = 1 / 111195; // degrees of latitude per metre
const at = (northM) => ({ lat: 10 + northM * M, lon: -140 });
const MILE = METRES_PER_MILE;

test('guide: the test sheet is invented and has no contact details', () => {
    assert.doesNotMatch(SHEET, /@|\d{3}[-. )]+\d{3}[-. ]\d{4}|contact|email/i);
    assert.match(SHEET, /Every name on this sheet is made up/);
});

test('guide: reads every milestone of the sheet, with restrooms', () => {
    const { milestones, ignored } = parseGuideText(SHEET);
    assert.equal(milestones.length, 13);
    assert.equal(ignored.length, 5); // title lines, section lines and the closing note
    assert.equal(milestones[0].mile, 0);
    assert.equal(milestones.at(-1).mile, 8.77);
    assert.deepEqual(milestones.filter((m) => m.restroom).map((m) => m.mile), [2.95, 6.07, 8.77]);
});

test('guide: other lines are ignored, including non-breaking spaces around the mileage', () => {
    const { milestones, ignored } = parseGuideText([
        'Example Ramblers',
        'Autumn Walk Notes',
        'First Part (roughly 3 miles) ',
        '0.0  Begin at Grove Park. ',
        '',
        '1.5*  Arrive at Oak Marina.',
        '2.5 * Arrive at Elm Trailhead.',
        'Restrooms are marked with a *.',
    ].join('\r\n'));
    assert.deepEqual(milestones.map((m) => [m.mile, m.restroom]), [[0, false], [1.5, true], [2.5, true]]);
    assert.equal(milestones[0].text, 'Begin at Grove Park.');
    assert.equal(ignored.length, 4);
});

test('guide: contact lines never become milestones, whatever they start with', () => {
    const { milestones, ignored } = parseGuideText([
        '0.0 Begin at Grove Park.',
        '302 555-0100 Pat',
        '555-0100 leader Pat at pat@example.com',
        '3 questions? pat@example.com',
        '5 Call Pat (302) 555-0100',
        '1.0 Arrive at Oak Marina.',
    ].join('\n'));
    assert.deepEqual(milestones.map((m) => m.mile), [0, 1]);
    assert.equal(ignored.length, 4);
    assert.doesNotMatch(JSON.stringify(milestones), /Pat|555/);
});

test('guide: a stray line starting with a number does not throw out the real ones', () => {
    const { milestones, ignored } = parseGuideText('2026 Trail guide\n0.0 Begin at Grove Park.\n30 hikers came last year\n1.0 Turn left.\n2.0 Turn right.');
    assert.deepEqual(milestones.map((m) => m.mile), [0, 1, 2]);
    assert.deepEqual(ignored, ['2026 Trail guide', '30 hikers came last year']);
});

const placeAt = (mile) => parseGuideText(SHEET).milestones.find((m) => m.mile === mile).place?.query ?? null;

test('guide: unnamed turns have no place; places are where the line says', () => {
    assert.equal(placeAt(0.84), null);  // Fork right beside the rusty pump house
    assert.equal(placeAt(1.62), null);  // Climb the stone steps…
    assert.equal(placeAt(5.12), null);  // Veer onto the left-hand spur…
    assert.equal(placeAt(0), '812 Tansy Street, West Larkmere, QX');
    assert.equal(placeAt(2.95), 'Ottermere Marina'); // not the cafe passed afterwards
    assert.equal(placeAt(6.07), 'Thistledown Park');
    assert.equal(placeAt(8.77), 'Merrowgate Green, Dunmarrow');
});

test('guide: a place you are heading for, passing or going under is not the milestone', () => {
    assert.equal(placeAt(3.88), null); // "carry on to Brackenfield"
    assert.equal(placeAt(3.4), null);  // "past the Ottermere Marina"
    assert.equal(placeAt(2.3), null);  // "Duck under the Quillby Bridge": the search finds the road on top
    assert.equal(placeAt(8.02), null); // "Wander under the Hobnail Viaduct"
    assert.ok(findPlaceNames('Carry on to Grove Park.')[0].elsewhere);
    assert.ok(!findPlaceNames('Arrive at Grove Park.')[0].elsewhere);
});

test('guide: long things and road codes are not route points by default', () => {
    assert.equal(placeAt(6.55), null); // QX-12 (Mallow Road)
    assert.equal(placeAt(7.18), null); // the Dunmarrow Canal
});

test('guide: one word opening a sentence is not a name, a verb the list lacks included', () => {
    const names = (s) => findPlaceNames(s).map((n) => n.text);
    assert.deepEqual(names('Saunter along the wall.'), []);
    assert.deepEqual(names('Rest here. Hop the stile.'), []);
    assert.deepEqual(names('Lunch at Oakham.'), ['Oakham']);
    assert.deepEqual(names('Grove Park has benches.'), ['Grove Park']);
});

test('guide: states the sheet mentions, for narrowing a search', () => {
    const { milestones } = parseGuideText(SHEET);
    assert.deepEqual(regionsFrom(milestones), ['QX', 'ZQ']); // "(1931), QX-41" is a road, not a state
    assert.deepEqual(regionsFrom([{ text: 'Fork right at the pump house.' }]), []);
});

test('guide: the same place on two lines in a row is one point', () => {
    const { milestones } = parseGuideText('0 Arrive at Grove Park.\n1 Leave the Grove Park.');
    assert.equal(milestones[0].place.query, 'Grove Park');
    assert.equal(milestones[1].place, null);
});

test('guide: names leave out direction words, road codes and state pairs', () => {
    const names = (s) => findPlaceNames(s).map((n) => n.text);
    assert.deepEqual(names('Fork right at the foot of the bank.'), []);
    assert.deepEqual(names('Step over the QX/ZQ boundary.'), []);
    assert.deepEqual(names('At the X, go right.'), []);
    assert.ok(names('Go under the Oak Bridge (1902), QX-41/RT-7').includes('Oak Bridge'));
    assert.equal(findPlaceNames('Step over QX-12 here')[0].kind, 'code');
    assert.equal(findPlaceNames('Begin the Oak Trail')[0].kind, 'long');
});

test('guide: CSV skips the text parsing', () => {
    const csv = '﻿mile,place,note,restroom\r\n0,Grove Park,"Begin, heading east",\n1.5,,Fork right at the pump house,no\n2.5,"Oak Marina",,yes\nmile?,x,y,z\n3.5*,Elm Trailhead,,\n';
    assert.ok(looksLikeCsv(csv));
    const { milestones, ignored } = parseGuideCsv(csv);
    assert.deepEqual(milestones, [
        { mile: 0, restroom: false, text: 'Begin, heading east', place: { query: 'Grove Park', alternatives: [] } },
        { mile: 1.5, restroom: false, text: 'Fork right at the pump house', place: null },
        { mile: 2.5, restroom: true, text: 'Oak Marina', place: { query: 'Oak Marina', alternatives: [] } },
        { mile: 3.5, restroom: true, text: 'Elm Trailhead', place: { query: 'Elm Trailhead', alternatives: [] } },
    ]);
    assert.deepEqual(ignored, ['mile?,x,y,z']);
});

test('guide: CSV columns in any order, or none with a header; contacts ignored', () => {
    const { milestones } = parseGuideCsv('note,restroom,place,mile\nStart,,Grove Park,0\n');
    assert.equal(milestones[0].place.query, 'Grove Park');
    const plain = parseGuideCsv('0,Grove Park,Start,\n1,Pat 302-555-0100,,\n');
    assert.equal(plain.milestones.length, 1);
    assert.equal(plain.ignored.length, 1);
    assert.ok(!looksLikeCsv(SHEET));
});

test('guide: a search result too far for the sheet is not chosen', () => {
    const near = at(1000), far = at(500_000);
    assert.deepEqual(chooseResult([far, near], at(0), MILE), { index: 1, plausible: true });
    assert.deepEqual(chooseResult([far], at(0), MILE), { index: 0, plausible: false });
    assert.deepEqual(chooseResult([], at(0), MILE), { index: -1, plausible: false });
    assert.deepEqual(chooseResult([far], null, 0), { index: 0, plausible: true });
});

test('guide: a result near the route must also have the right name', () => {
    assert.ok(!sameName('South Oakham', 'South Street, Dunmarrow, QX, Nowhere'));
    assert.ok(!sameName('Elm Point', 'Elm Avenue, Dunmarrow, QX, Nowhere'));
    assert.ok(!sameName('Grove Park, Oakham', 'Oakham, QX, Nowhere'));
    assert.ok(sameName('Oak Marina', 'Oak Marina, Dunmarrow, QX, Nowhere'));
    assert.ok(sameName('Willow Cemetery', 'Willow Church Cemetery, Oakham, QX, Nowhere'));
    assert.ok(sameName('St. Olaves Trailhead', 'St. Olaves, QX, Nowhere'));
    assert.ok(sameName('St. Olaves', 'Saint Olaves, QX, Nowhere'));
    assert.ok(sameName('812 Tansy Street, West Larkmere, QX', 'Tansy Street, Larkmere, QX, Nowhere'));
    const street = { ...at(100), label: 'South Street, Dunmarrow' }, right = { ...at(900), label: 'South Oakham Park' };
    assert.deepEqual(chooseResult([street, right], at(0), MILE, 'South Oakham'), { index: 1, plausible: true });
    assert.deepEqual(chooseResult([street], at(0), MILE, 'South Oakham'), { index: 0, plausible: false });
    assert.deepEqual(chooseResult([street], null, 0, 'South Oakham'), { index: 0, plausible: false });
});

test('guide: places off the path add no spur to the line', () => {
    const anchors = [{ lat: 10, lon: -140 }, { lat: 10.01, lon: -140 }];
    const path = [{ lat: 10, lon: -140.001 }, { lat: 10.01, lon: -140.001 }];
    const plan = planFromLegs(anchors, [path]);
    assert.deepEqual(plan.vertices, path);
    assert.deepEqual(plan.routes[0], path);
    assert.equal(plan.segments[0], 'trail');
});

test('guide: a leg with no route stays straight; neighbours share their meeting point', () => {
    const a = at(0), b = at(1000), c = at(2000), d = at(3000);
    const plan = planFromLegs([a, b, c, d], [[at(10), at(990)], null, [at(2010), at(2990)]]);
    assert.deepEqual(plan.segments, ['trail', 'straight', 'trail']);
    assert.equal(plan.routes[1], null);
    assert.deepEqual(plan.vertices[1], at(990));
    assert.deepEqual(plan.vertices[2], at(2010));
    assert.deepEqual(plan.routes[2][0], plan.vertices[2]);
});

test('guide: legs more than 10% off the sheet are flagged, in both directions', () => {
    const line = (m) => [at(0), at(m)];
    const legs = compareLegs([0, 1, 2, 3, 4, 4], [line(MILE * 1.05), line(MILE * 1.15), line(MILE * 0.8), line(MILE * 0.91), line(100)]);
    assert.deepEqual(legs.map((l) => l.flagged), [false, true, true, false, true]);
    assert.ok(Math.abs(legs[1].diffRatio - 0.15) < 0.001);
    assert.equal(legs[4].diffRatio, null); // the sheet gives no distance to compare
});

test('guide: turns are placed by mileage, scaled to their leg', () => {
    const milestones = [
        { mile: 1, text: 'before the first place', restroom: false, place: null },
        { mile: 2, text: 'A', restroom: false, place: { query: 'A' } },
        { mile: 3, text: 'turn', restroom: false, place: null },
        { mile: 4, text: 'B', restroom: true, place: { query: 'B' } },
        { mile: 5, text: 'after the last place', restroom: false, place: null },
    ];
    // The leg of 2 sheet miles routed 10% long: the turn halfway stays halfway.
    const length = 2.2 * MILE;
    const lines = [[at(0), at(length)]];
    const w = placeWaypoints(milestones, [1, 3], lines);
    assert.equal(w.length, 5);
    assert.deepEqual(w[0], { ...at(0), mile: 1, name: '', note: 'before the first place', restroom: false }); // kept on the line
    assert.equal(w[1].name, 'A');
    assert.ok(Math.abs((w[2].lat - 10) / M - length / 2) < 1, 'halfway');
    assert.equal(w[3].restroom, true);
    assert.ok(Math.abs((w[3].lat - 10) / M - length) < 0.01);
    assert.ok(Math.abs((w[4].lat - 10) / M - length) < 0.01); // kept on the line
});

test('guide: next waypoint and distance along the hike', () => {
    const track = buildTrack([at(0), at(1000), at(2000)]);
    const w = locateWaypoints(track, [{ ...at(1500), note: 'b' }, { ...at(500), note: 'a' }, { ...at(0), note: 'start' }]);
    assert.deepEqual(w.map((x) => x.note), ['start', 'a', 'b']);
    assert.ok(Math.abs(w[1].along - 500) < 1);

    const first = nextWaypoint(w, 0);
    assert.equal(first.waypoint.note, 'a');
    assert.ok(Math.abs(first.distance - 500) < 1);
    assert.equal(nextWaypoint(w, 490).waypoint.note, 'b'); // reached, within GPS error
    assert.equal(nextWaypoint(w, 1600), null);
    assert.equal(nextWaypoint([], 0), null);
    assert.equal(nextWaypoint(undefined, 0), null);
});

test('guide: waypoints follow a reversed track', () => {
    const points = [at(0), at(1000), at(2000)];
    const w = locateWaypoints(buildTrack(points), [{ ...at(500), note: 'a' }, { ...at(1500), note: 'b' }]);
    const back = locateWaypoints(buildTrack(points.slice().reverse()), w);
    assert.deepEqual(back.map((x) => x.note), ['b', 'a']);
    assert.ok(Math.abs(back[0].along - 500) < 1);
});

test('guide: GPX export has the waypoints before the track, escaped, with restrooms', () => {
    const text = buildGpx({
        name: 'T', segments: [[at(0), at(100)]], time: 0,
        waypoints: [
            { lat: 10, lon: -140, mile: 2.75, name: '', note: 'Bear left at the "Y" & go', restroom: false },
            { lat: 10.1, lon: -140, mile: 2.95, name: 'Oak Marina', note: 'Arrive', restroom: true },
        ],
    });
    assert.ok(text.indexOf('<wpt') < text.indexOf('<trk>'));
    assert.match(text, /<name>Mile 2\.75<\/name><cmt>Sheet mile 2\.75<\/cmt><desc>Bear left at the &quot;Y&quot; &amp; go<\/desc><sym>Waypoint<\/sym>/);
    assert.match(text, /<name>Oak Marina<\/name>.*<sym>Restroom<\/sym>/);
    assert.equal(lineLength([at(0), at(100)]) > 99, true);
    assert.doesNotMatch(buildGpx({ name: 'T', segments: [[at(0), at(100)]] }), /<wpt/);
});

// ---------- The whole path, on recorded answers: no network, no quota ----------

test('guide: with nothing stubbed, the network is off for every test', async () => {
    await assert.rejects(fetch('https://api.openrouteservice.org/geocode/search?text=x'), /network is off/);
    assert.deepEqual(await searchPlaces('Ottermere Marina'), { ok: false, reason: 'unavailable', detail: 'relay not reachable' });
});

test('guide: recorded answers are the default, and tests cannot reach the network', async () => {
    const network = useRecordedResponses();
    try {
        await assert.rejects(fetch('https://example.org/'), /network is off/);
        const none = await searchPlaces('Nowhere In The Recording');
        assert.deepEqual(none, { ok: true, places: [] });
        assert.equal(network.calls.length, 1);
        assert.ok(network.calls[0].includes('/geocode'));
    } finally {
        network.restore();
    }
});

test('guide: each search text is asked once; a failure is not remembered', async () => {
    const network = useRecordedResponses();
    try {
        const search = cachedSearch(searchPlaces);
        const a = await search('Ottermere Marina');
        const b = await search('Ottermere Marina');
        assert.ok(a.ok);
        assert.equal(a, b);
        assert.equal(network.calls.length, 1);
    } finally {
        network.restore();
    }
    let tries = 0;
    const flaky = cachedSearch(async () => (++tries === 1 ? { ok: false, reason: 'limit' } : { ok: true, places: [] }));
    assert.equal((await flaky('x')).ok, false);
    assert.equal((await flaky('x')).ok, true);
    assert.equal(tries, 2);
});

test('guide: finding places skips a far namesake and a near wrong name; a limit stops the search', async () => {
    const network = useRecordedResponses();
    try {
        const search = cachedSearch(searchPlaces);
        const start = { lat: 10, lon: -140 };
        const marina = await findPlace('Ottermere Marina', { near: start, sheetM: 2.95 * MILE, regions: ['QX', 'ZQ'], search });
        assert.equal(marina.results[marina.index].label, 'Ottermere Marina, Dunmarrow, QX, Nowhere');
        assert.equal(network.calls.length, 1); // found without a retry

        const park = await findPlace('Thistledown Park', { near: marina.results[marina.index], sheetM: 3.12 * MILE, regions: ['QX', 'ZQ'], search });
        assert.equal(park.results[park.index].label, 'Thistledown Park, Dunmarrow, QX, Nowhere');
        assert.equal(network.calls.length, 3); // the name, then the name with the state

        const missing = await findPlace('Nowhere In The Recording', { near: start, sheetM: MILE, regions: ['QX', 'ZQ'], search });
        assert.deepEqual([missing.ok, missing.index], [true, -1]);
        assert.equal(network.calls.length, 6); // the name and both states, then it gives up
    } finally {
        network.restore();
    }
    const limited = await findPlace('x', { regions: ['QX'], search: async () => ({ ok: false, reason: 'limit' }) });
    assert.deepEqual(limited, { ok: false, reason: 'limit' });
});

test('guide: the invented sheet, from text to GPX, on recorded answers', async () => {
    const network = useRecordedResponses();
    try {
        const { milestones } = parseGuideText(SHEET);
        const regions = regionsFrom(milestones);
        const search = cachedSearch(searchPlaces);
        const anchors = [], anchorIndexes = [];
        for (const [i, m] of milestones.entries()) {
            if (!m.place) continue;
            const near = anchors.at(-1) ?? null;
            const sheetM = near ? (m.mile - near.mile) * MILE : 0;
            const found = await findPlace(m.place.query, { near, sheetM, regions, search });
            assert.ok(found.index >= 0, `no place for ${m.place.query}`);
            anchors.push({ ...found.results[found.index], mile: m.mile });
            anchorIndexes.push(i);
        }
        assert.deepEqual(anchors.map((a) => a.mile), [0, 2.95, 6.07, 8.77]);

        const paths = [];
        for (let i = 0; i + 1 < anchors.length; i++) {
            const r = await routeBetween(anchors[i], anchors[i + 1]);
            assert.ok(r.ok, r.detail);
            paths.push(r.path);
        }
        const plan = planFromLegs(anchors, paths);
        const legs = compareLegs(anchors.map((a) => a.mile), plan.routes);
        assert.deepEqual(legs.map((l) => l.flagged), [false, false, true]); // the long way round
        assert.ok(legs[2].diffRatio > 0.2 && legs[2].diffRatio < 0.3);

        const waypoints = placeWaypoints(milestones, anchorIndexes, plan.routes);
        assert.equal(waypoints.length, 13);
        const track = buildTrack(plan.routes.flatMap((l, i) => (i === 0 ? l : l.slice(1))));
        const located = locateWaypoints(track, waypoints);
        assert.deepEqual(located.map((w) => w.mile), milestones.map((m) => m.mile)); // still in sheet order

        const gpx = buildGpx({ name: 'Fernhollow', segments: [track.points], waypoints: located, time: 0 });
        assert.equal(gpx.match(/<wpt/g).length, 13);
        assert.equal(gpx.match(/<sym>Restroom/g).length, 3);
    } finally {
        network.restore();
    }
});
