// Elevation profile: distance (km or mi) across, elevation (m or ft) up, with a marker at
// the current position and a finger-drag crosshair to read any point.
// The profile is drawn once per track; moving the marker only shifts two
// small elements, so live updates cost almost nothing.

import { profileAt } from './elevation.js';
import { makeUnits } from './units.js';

const PAD = { left: 34, right: 6, top: 6, bottom: 16 };

function niceStep(range, targetTicks) {
    const raw = range / targetTicks;
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) {
        if (m * mag >= raw) return m * mag;
    }
    return 10 * mag;
}

// getUnits(): the current units (see units.js); metric if not given.
export function createProfileChart(root, { getUnits = () => makeUnits('metric') } = {}) {
    const canvas = root.querySelector('canvas');
    const line = root.querySelector('.profile-line');
    const dot = root.querySelector('.profile-dot');
    const cursor = root.querySelector('.profile-cursor');
    const tip = root.querySelector('.profile-tip');
    const empty = root.querySelector('.profile-empty');

    let track = null, profile = null;
    const defaultEmpty = empty.textContent;
    let emptyText = null; // shown instead of the profile, even with nothing to draw
    let markerAlong = null;
    let scale = null; // { x(d), y(e), plotH }

    function draw() {
        const w = root.clientWidth, h = root.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        empty.hidden = Boolean(profile) || !(track || emptyText);
        canvas.hidden = !profile;
        if (!track || !profile || w === 0) {
            scale = null;
            placeMarker();
            return;
        }

        const css = getComputedStyle(document.documentElement);
        const color = (name) => css.getPropertyValue(name).trim();

        // Axes in the chosen units: lo/hi and the ticks are in m or ft.
        const units = getUnits();
        const { lengthM, distanceM, distanceUnit } = units;
        const eleLabel = (e) => `${Math.round(e).toLocaleString('en-US')} ${units.lengthUnit}`;
        // Keep at least 50 m of vertical range so flat tracks don't look dramatic.
        let lo = profile.minEle / lengthM, hi = profile.maxEle / lengthM;
        const minRange = 50 / lengthM;
        if (hi - lo < minRange) {
            const mid = (hi + lo) / 2;
            lo = mid - minRange / 2;
            hi = mid + minRange / 2;
        }
        const yStep = niceStep(hi - lo, 2);
        lo = Math.floor(lo / yStep) * yStep;
        hi = Math.ceil(hi / yStep) * yStep;

        // Room for the widest elevation label ("1300 m" was cut to "300 m" at a fixed 34 px).
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        PAD.left = Math.max(34, Math.ceil(Math.max(...[lo, hi].map((e) => ctx.measureText(eleLabel(e)).width))) + 8);
        const plotW = w - PAD.left - PAD.right, plotH = h - PAD.top - PAD.bottom;
        const x = (d) => PAD.left + (d / track.total) * plotW;
        const y = (e) => PAD.top + (1 - (e / lengthM - lo) / (hi - lo)) * plotH; // e in metres
        scale = { x, y, plotH };

        // Recessive grid and labels.
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = color('--panel-muted');
        ctx.strokeStyle = color('--profile-grid');
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let e = lo; e <= hi + 1e-6; e += yStep) {
            ctx.beginPath();
            const yy = y(e * lengthM);
            ctx.moveTo(PAD.left, Math.round(yy) + 0.5);
            ctx.lineTo(w - PAD.right, Math.round(yy) + 0.5);
            ctx.stroke();
            ctx.fillText(eleLabel(e), PAD.left - 4, yy);
        }
        const km = track.total / distanceM; // in km or mi
        const xStep = niceStep(km, 4);
        // Enough decimals that short tracks don't repeat a label (0.05, 0.1, 0.15…).
        const decimals = Math.min(3, Math.max(1, -Math.floor(Math.log10(xStep) + 1e-9) + (Number.isInteger(xStep * 10 ** -Math.floor(Math.log10(xStep))) ? 0 : 1)));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let k = 0; k <= km + 1e-6; k += xStep) {
            const label = `${+k.toFixed(decimals)}${k === 0 ? '' : ` ${distanceUnit}`}`;
            ctx.fillText(label, Math.min(Math.max(x(k * distanceM), PAD.left + 6), w - PAD.right - 14), h - PAD.bottom + 3);
        }

        // Area and 2px line.
        const { cum } = track, { eles } = profile;
        ctx.beginPath();
        ctx.moveTo(x(0), y(eles[0]));
        for (let i = 1; i < eles.length; i++) ctx.lineTo(x(cum[i]), y(eles[i]));
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = color('--profile-line');
        ctx.stroke();
        ctx.lineTo(x(track.total), PAD.top + plotH);
        ctx.lineTo(x(0), PAD.top + plotH);
        ctx.closePath();
        ctx.fillStyle = color('--profile-fill');
        ctx.fill();

        placeMarker();
    }

    function placeMarker() {
        const show = Boolean(scale) && markerAlong != null;
        line.hidden = dot.hidden = !show;
        if (!show) return;
        const at = profileAt(track, profile, markerAlong);
        const px = scale.x(markerAlong);
        line.style.left = `${px - 1}px`;
        line.style.top = `${PAD.top}px`;
        line.style.height = `${scale.plotH}px`;
        dot.style.left = `${px}px`;
        dot.style.top = `${scale.y(at.ele)}px`;
    }

    // Drag a finger along the profile to read distance and elevation.
    function showCursor(event) {
        if (!scale) return;
        const rect = root.getBoundingClientRect();
        const plotW = rect.width - PAD.left - PAD.right;
        const f = Math.max(0, Math.min(1, (event.clientX - rect.left - PAD.left) / plotW));
        const along = f * track.total;
        const at = profileAt(track, profile, along);
        const px = scale.x(along);
        cursor.hidden = tip.hidden = false;
        cursor.style.left = `${px}px`;
        cursor.style.top = `${PAD.top}px`;
        cursor.style.height = `${scale.plotH}px`;
        const units = getUnits();
        tip.textContent = `${(along / units.distanceM).toFixed(2)} ${units.distanceUnit} · ${units.length(at.ele)}`;
        const tipW = tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(rect.width - tipW, px - tipW / 2))}px`;
    }

    function hideCursor() {
        cursor.hidden = tip.hidden = true;
    }

    root.addEventListener('pointerdown', (e) => {
        root.setPointerCapture(e.pointerId);
        showCursor(e);
    });
    root.addEventListener('pointermove', (e) => {
        if (e.buttons || e.pointerType === 'mouse') showCursor(e);
    });
    root.addEventListener('pointerup', hideCursor);
    root.addEventListener('pointercancel', hideCursor);
    root.addEventListener('pointerleave', hideCursor);

    new ResizeObserver(draw).observe(root);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

    return {
        // profile may be null (track without elevations); options.empty: the message
        // shown then (default "No elevation data in this track").
        setData(newTrack, newProfile, { empty: message = null } = {}) {
            track = newTrack;
            profile = newProfile;
            emptyText = message;
            empty.textContent = message ?? defaultEmpty;
            markerAlong = null;
            hideCursor();
            draw();
        },
        // Units changed.
        redraw: draw,
        setPosition(along) {
            markerAlong = along;
            placeMarker();
        },
    };
}
