// Units for everything shown to the user: metric (km, m) or imperial (mi, ft).
// Values are always kept in metres inside the app (and in GPX files, whose
// standard is metres); only what is displayed or typed is converted.

export const FOOT_M = 0.3048;
export const MILE_M = 1609.344;

// Countries where people think in miles and feet.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

// "en-US" -> imperial; anything else (or unknown) -> metric.
export function defaultUnitSystem(locale = '') {
    const region = String(locale).split(/[-_]/)[1]?.toUpperCase();
    return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
}

const finite = (v) => v != null && Number.isFinite(v);

export function makeUnits(system = 'metric') {
    const imperial = system === 'imperial';
    // Short lengths (elevations, accuracies, offsets): m or ft.
    const lengthUnit = imperial ? 'ft' : 'm';
    const lengthM = imperial ? FOOT_M : 1;
    // Long distances: km or mi.
    const distanceUnit = imperial ? 'mi' : 'km';
    const distanceM = imperial ? MILE_M : 1000;

    return {
        system: imperial ? 'imperial' : 'metric',
        lengthUnit,
        lengthM,
        distanceUnit,
        distanceM,

        // 850 m / 1.25 km / 12.4 km; 900 ft / 0.25 mi / 12.4 mi.
        // Below 1,000 ft (or 1 km) a whole number of the short unit.
        distance(m) {
            if (!finite(m)) return '–';
            const short = imperial ? 1000 * FOOT_M : 1000;
            if (Math.abs(m) < short) return `${Math.round(m / lengthM)} ${lengthUnit}`;
            const d = m / distanceM;
            return `${d.toFixed(Math.abs(d) < 10 ? 2 : 1)} ${distanceUnit}`;
        },
        // Elevations, climbs, accuracies: "812 m" / "2,664 ft".
        length(m, decimals = 0) {
            if (!finite(m)) return '–';
            const v = m / lengthM;
            return `${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${lengthUnit}`;
        },
        // Metres per second -> "4.2 km/h" / "2.6 mph".
        speed(mps) {
            if (!finite(mps)) return '–';
            return imperial ? `${(mps * 3600 / MILE_M).toFixed(1)} mph` : `${(mps * 3.6).toFixed(1)} km/h`;
        },
        // A settings field: metres <-> the number typed in the current unit.
        toInput(m, step = 1) {
            return Math.round(m / lengthM / step) * step;
        },
        fromInput(value) {
            return value * lengthM;
        },
    };
}
