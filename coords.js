// Coordinates typed in the search box, read on the phone (no request):
//   "39.5274, -75.8113"   "39.5274 -75.8113"   "39,5274 18,0312"   "39,5274; 18,0312"
//   "39.5274 N, 75.8113 W"   "N39.5274 W75.8113"   "39°31'38.6\"N 75°48'40.7\"W"
//   "39°31.643'N 75°48.678'W" (degrees and decimal minutes)
// Letters may put longitude first ("75.81 W 39.52 N"). Without letters: latitude first.
// Pure logic.

const NUMBER = String.raw`[-+]?\d+(?:[.,]\d+)?`;
const toNumber = (s) => Number(String(s).replace(',', '.'));

function normalise(text) {
    return String(text)
        .replace(/[″“”]/g, '"')
        .replace(/[′’‘´`]/g, "'")
        .replace(/''/g, '"')
        .replace(/º/g, '°')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

const inRange = ({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

// Two plain numbers: a space, a comma or a semicolon between them. A comma inside
// a number is a decimal comma ("39,5274 18,0312"), so a comma-separated pair needs
// points ("39.5274, -75.8113") or a space after the comma.
function plainPair(t) {
    let m = t.match(new RegExp(String.raw`^(${NUMBER})\s*;\s*(${NUMBER})$`));
    if (!m) m = t.match(new RegExp(String.raw`^([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)$`));
    if (!m) m = t.match(new RegExp(String.raw`^(${NUMBER})\s+(${NUMBER})$`));
    if (!m) m = t.match(new RegExp(String.raw`^(${NUMBER}),\s+(${NUMBER})$`));
    return m ? { lat: toNumber(m[1]), lon: toNumber(m[2]) } : null;
}

// One coordinate: optional letter, degrees, optional minutes and seconds (with
// ° ' " or just spaces between), optional letter.
const ONE = new RegExp(
    String.raw`([NSEW])?\s*(${NUMBER})\s*(?:°|D(?![A-Z]))?\s*` +
    String.raw`(?:(\d+(?:[.,]\d+)?)\s*'?\s*` +
    String.raw`(?:(\d+(?:[.,]\d+)?)\s*"?\s*)?)?` +
    String.raw`([NSEW])?`, 'g');

function parts(t) {
    const found = [];
    ONE.lastIndex = 0;
    let m;
    while ((m = ONE.exec(t)) && found.length < 3) {
        if (m[0].trim() === '') { ONE.lastIndex++; continue; }
        // "N39.5 W75.8": the W after the first number belongs to the second one.
        if (m[1] && m[5]) {
            ONE.lastIndex = m.index + m[0].length - 1;
            m = [...m];
            m[5] = undefined;
        }
        found.push(m);
        // Skip a separator (comma, semicolon, slash) between the two.
        const rest = t.slice(ONE.lastIndex);
        const sep = rest.match(/^\s*[,;/]?\s*/);
        ONE.lastIndex += sep ? sep[0].length : 0;
    }
    return found;
}

function value(m) {
    const [, before, deg, min, sec, after] = m;
    if (before && after) return null;
    const letter = before || after || null;
    const d = toNumber(deg), mi = min != null ? toNumber(min) : 0, s = sec != null ? toNumber(sec) : 0;
    if (mi >= 60 || s >= 60) return null;
    if ((min != null || sec != null) && !Number.isInteger(d)) return null;
    let v = Math.abs(d) + mi / 60 + s / 3600;
    if (d < 0 || deg.startsWith('-') || letter === 'S' || letter === 'W') v = -v;
    if ((d < 0 || deg.startsWith('-')) && (letter === 'S' || letter === 'W')) return null; // "-39 S" is a contradiction
    return { v, letter };
}

// Returns { lat, lon } (rounded to 7 decimals), or null if the text isn't coordinates.
export function parseCoordinates(text) {
    const t = normalise(text);
    if (!t || !/\d/.test(t) || /[A-DF-MO-RT-VX-Z]/.test(t.replace(/D(?![A-Z])/g, ''))) return null;
    let point = /[NSEW°'"]/.test(t) ? null : plainPair(t);
    if (!point) {
        const found = parts(t);
        if (found.length !== 2) return null;
        const a = value(found[0]), b = value(found[1]);
        if (!a || !b) return null;
        const isLat = (x) => x.letter === 'N' || x.letter === 'S';
        const isLon = (x) => x.letter === 'E' || x.letter === 'W';
        if ((isLat(a) && isLat(b)) || (isLon(a) && isLon(b))) return null;
        point = isLon(a) || isLat(b) ? { lat: b.v, lon: a.v } : { lat: a.v, lon: b.v };
    }
    if (!inRange(point)) return null;
    const round = (v) => Math.round(v * 1e7) / 1e7;
    return { lat: round(point.lat), lon: round(point.lon) };
}

// "39.52740, -75.81130" and "39°31'38.6"N 75°48'40.7"W", for showing and copying.
export function formatCoordinates({ lat, lon }) {
    const dms = (v, pos, neg) => {
        const a = Math.abs(v);
        let d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 600) / 10;
        if (s >= 60) { s = 0; m += 1; }
        if (m >= 60) { m = 0; d += 1; }
        return `${d}°${m}'${s.toFixed(1)}"${v < 0 ? neg : pos}`;
    };
    return { decimal: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, dms: `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}` };
}
