// Initialize Map (Default centered on a sample region, e.g., Apulia / Delaware or user default)
const map = L.map('map').setView([40.5, 18.0], 13); // Example: Salento region coordinates

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// UI Elements
const scanBtn = document.getElementById('scan-btn');
const statusToast = document.getElementById('status-toast');

function showStatus(message, duration = 3000) {
    statusToast.textContent = message;
    statusToast.style.display = 'block';
    setTimeout(() => {
        statusToast.style.display = 'none';
    }, duration);
}

// --- IndexedDB Setup for Offline Vector Caching ---
let db;
const dbRequest = indexedDB.open('TrailCacheDB', 1);

dbRequest.onerror = (event) => {
    console.error("IndexedDB error:", event.target.error);
};

dbRequest.onsuccess = (event) => {
    db = event.target.result;
    loadCachedTrails(); // Load any previously cached trails on startup
};

dbRequest.onupgradeneeded = (event) => {
    db = event.target.result;
    if (!db.objectStoreNames.contains('trails')) {
        db.createObjectStore('trails', { keyPath: 'id', autoIncrement: true });
    }
};

function saveTrailsToIndexedDB(geojson) {
    if (!db) return;
    const transaction = db.transaction(['trails'], 'readwrite');
    const store = transaction.objectStore('trails');
    
    // Store the geojson feature collection payload
    store.add({ timestamp: Date.now(), data: geojson });
    
    transaction.oncomplete = () => {
        showStatus("Trails cached locally for offline use.");
    };
    transaction.onerror = (event) => {
        console.error("Error saving trails:", event.target.error);
    };
}

function loadCachedTrails() {
    if (!db) return;
    const transaction = db.transaction(['trails'], 'readonly');
    const store = transaction.objectStore('trails');
    const request = store.getAll();

    request.onsuccess = () => {
        const results = request.result;
        results.forEach(record => {
            L.geoJSON(record.data, {
                style: { color: '#ff7800', weight: 3, opacity: 0.65 }
            }).addTo(map);
        });
        if (results.length > 0) {
            showStatus(`Loaded ${results.length} cached trail sets.`);
        }
    };
}

// --- Overpass API Integration ---
scanBtn.addEventListener('click', async () => {
    const bounds = map.getBounds();
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    
    showStatus("Scanning viewport for trails...");

    const overpassQuery = `
        [out:json][timeout:25];
        (
          way["highway"="path"](${bbox});
          way["route"="hiking"](${bbox});
        );
        out body;
        >;
        out skel qt;
    `;

    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: overpassQuery
        });

        if (!response.ok) throw new Error("Network response failed");

        const osmData = await response.json();
        const geojson = osmtogeojson(osmData);

        if (geojson.features.length === 0) {
            showStatus("No trails found in this view.");
            return;
        }

        // Render on map
        L.geoJSON(geojson, {
            style: { color: '#e63946', weight: 4, opacity: 0.8 }
        }).addTo(map);

        // Save to local storage for offline use
        saveTrailsToIndexedDB(geojson);
        showStatus(`Successfully loaded ${geojson.features.length} trails!`);

    } catch (error) {
        console.error("Scan failed:", error);
        showStatus("Scan failed. Check network connection.");
    }
});

// Register Service Worker for PWA capabilities
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(() => console.log("Service Worker registered successfully."))
        .catch(err => console.error("Service Worker registration failed:", err));
}