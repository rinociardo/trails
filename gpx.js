// Minimal GPX reader: returns { name, points: [{lat, lon, ele}] }.
// Uses track points (<trkpt>) and falls back to route points (<rtept>);
// multiple segments/tracks are joined in file order.

export function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
        throw new Error('This file is not valid GPX/XML.');
    }
    const byTag = (tag) => Array.from(doc.getElementsByTagNameNS('*', tag));

    let nodes = byTag('trkpt');
    if (nodes.length === 0) nodes = byTag('rtept');
    if (nodes.length === 0) {
        throw new Error('No track or route points found in this GPX file.');
    }

    const points = [];
    for (const node of nodes) {
        const lat = parseFloat(node.getAttribute('lat'));
        const lon = parseFloat(node.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const prev = points[points.length - 1];
        if (prev && prev.lat === lat && prev.lon === lon) continue;
        const eleNode = node.getElementsByTagNameNS('*', 'ele')[0];
        const ele = eleNode ? parseFloat(eleNode.textContent) : null;
        points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
    }
    if (points.length < 2) {
        throw new Error('The GPX track needs at least two points.');
    }

    const nameNode = byTag('trk')[0]?.getElementsByTagNameNS('*', 'name')[0] ||
        byTag('rte')[0]?.getElementsByTagNameNS('*', 'name')[0] ||
        byTag('metadata')[0]?.getElementsByTagNameNS('*', 'name')[0];
    return { name: nameNode ? nameNode.textContent.trim() : '', points };
}

// ---------- Export ----------

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// GPX 1.1 text for one track. segments: arrays of { lat, lon, ele?, time? }
// (time in ms); each segment becomes a <trkseg> (a recorded hike has one per
// Start/Stop). Elevations and times are written when present.
export function buildGpx({ name = '', segments, time = Date.now() }) {
    const point = (p) => {
        let inner = '';
        if (Number.isFinite(p.ele)) inner += `<ele>${p.ele.toFixed(1)}</ele>`;
        if (Number.isFinite(p.time)) inner += `<time>${new Date(p.time).toISOString()}</time>`;
        return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${inner}</trkpt>`;
    };
    const nameTag = name ? `<name>${escapeXml(name)}</name>` : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Trails (https://rinociardo.github.io/trails/)"',
        '     xmlns="http://www.topografix.com/GPX/1/1"',
        '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
        `  <metadata>${nameTag}<time>${new Date(time).toISOString()}</time></metadata>`,
        `  <trk>${nameTag}`,
        ...segments.filter((seg) => seg.length).flatMap((seg) => ['    <trkseg>', ...seg.map(point), '    </trkseg>']),
        '  </trk>',
        '</gpx>',
        '',
    ].join('\n');
}

// "Sample loop", 2026-10-27 -> "Sample-loop_2026-10-27.gpx" (local date).
// Keeps letters of any language; anything else that could upset a file system becomes "-".
export function gpxFileName(name, time = Date.now()) {
    const d = new Date(time);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const base = String(name || '').normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/g, '').slice(0, 60) || 'track';
    return `${base}_${date}.gpx`;
}
