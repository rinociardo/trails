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
