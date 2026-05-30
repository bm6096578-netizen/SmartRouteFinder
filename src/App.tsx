import { useState, useRef, useCallback, useEffect } from "react";
import {
  MapContainer, TileLayer, Marker, Popup,
  useMap, useMapEvents, Polyline,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const BENGALURU: [number, number] = [12.9716, 77.5946];

const D = {
  bg:        "#0a0a0c",
  surface:   "#131315",
  surfaceHi: "#1c1c1e",
  surfaceTop:"#27272a",
  border:    "rgba(255,255,255,0.08)",
  borderHov: "rgba(37,99,235,0.3)",
  text:      "#e4e2e4",
  textMuted: "#a1a1aa",
  textDim:   "#52525b",
  primary:   "#2563eb",
  primaryBg: "rgba(37,99,235,0.12)",
  error:     "#ef4444",
  glass:     "rgba(10,10,12,0.88)",
};

const glass: React.CSSProperties = {
  background: D.glass,
  backdropFilter: "blur(16px)",
  border: `1px solid ${D.border}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// OSRM
// ─────────────────────────────────────────────────────────────────────────────
interface OsrmRoute {
  coords: [number, number][];
  distKm: number;
  durationMin: number;
  steps: { text: string; distM: number; coords: [number, number] }[];
}

async function fetchRouteSegment(from: [number, number], to: [number, number], profile: string): Promise<OsrmRoute | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "Ok" || !d.routes.length) return null;
    const rt = d.routes[0];
    return {
      coords: rt.geometry.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number]),
      distKm: rt.distance / 1000,
      durationMin: Math.round(rt.duration / 60),
      steps: rt.legs[0].steps.map((s: any) => ({
        text: buildStepText(s),
        distM: Math.round(s.distance),
        coords: s.maneuver?.location ? [s.maneuver.location[1], s.maneuver.location[0]] as [number, number] : from,
      })),
    };
  } catch { return null; }
}

async function fetchRoutes(from: [number, number], to: [number, number], profile: string, stop?: [number, number] | null): Promise<OsrmRoute[]> {
  try {
    if (stop) {
      // Route through stop: fetch two segments and merge
      const [seg1, seg2] = await Promise.all([
        fetchRouteSegment(from, stop, profile),
        fetchRouteSegment(stop, to, profile),
      ]);
      if (!seg1 || !seg2) return [];
      const merged: OsrmRoute = {
        coords: [...seg1.coords, ...seg2.coords],
        distKm: seg1.distKm + seg2.distKm,
        durationMin: seg1.durationMin + seg2.durationMin,
        steps: [...seg1.steps, ...seg2.steps],
      };
      return [merged];
    }

    // Normal route with alternatives
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.code !== "Ok") return [];
    return d.routes.map((rt: any) => ({
      coords: rt.geometry.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number]),
      distKm: rt.distance / 1000,
      durationMin: Math.round(rt.duration / 60),
      steps: rt.legs[0].steps.map((s: any) => ({
        text: buildStepText(s),
        distM: Math.round(s.distance),
        coords: s.maneuver?.location ? [s.maneuver.location[1], s.maneuver.location[0]] as [number, number] : from,
      })),
    }));
  } catch { return []; }
}

function buildStepText(s: any): string {
  const type = s.maneuver?.type || "";
  const mod  = s.maneuver?.modifier || "";
  const name = s.name || "";
  if (type === "arrive")     return "Arrive at destination";
  if (type === "depart")     return `Head ${mod} on ${name}`.trim();
  if (type === "turn")       return `Turn ${mod}${name ? " onto " + name : ""}`.trim();
  if (type === "continue")   return `Continue on ${name}`.trim();
  if (type === "roundabout") return `Enter roundabout, take exit onto ${name}`.trim();
  if (type === "merge")      return `Merge ${mod} onto ${name}`.trim();
  if (type === "fork")       return `Keep ${mod} onto ${name}`.trim();
  return `${type} ${mod} ${name}`.trim() || "Continue";
}

// ─────────────────────────────────────────────────────────────────────────────
// NOMINATIM
// ─────────────────────────────────────────────────────────────────────────────
interface Loc { coords: [number, number]; label: string; }

async function geocode(q: string): Promise<Loc | null> {
  try {
    // Try with Bengaluru first, then without city restriction for flexibility
    const queries = [
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + " Bengaluru")}&format=json&limit=1&countrycodes=in`,
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=in&viewbox=77.4,12.8,77.8,13.2&bounded=1`,
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=in`,
    ];
    for (const url of queries) {
      const r = await fetch(url, { headers: { "Accept-Language": "en" } });
      const d = await r.json();
      if (d.length) return { coords: [parseFloat(d[0].lat), parseFloat(d[0].lon)], label: shortLabel(d[0].display_name) };
    }
    return null;
  } catch { return null; }
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { "Accept-Language": "en" } }
    );
    const d = await r.json();
    const a = d.address ?? {};
    return [a.road || a.pedestrian, a.suburb || a.neighbourhood, a.city_district].filter(Boolean).join(", ")
      || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch { return `${lat.toFixed(5)}, ${lng.toFixed(5)}`; }
}

async function fetchSuggestions(q: string): Promise<Loc[]> {
  if (q.length < 2) return [];
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + " Bengaluru")}&format=json&limit=8&countrycodes=in`,
      { headers: { "Accept-Language": "en" } }
    );
    const d = await r.json();
    return d.map((x: any) => ({
      coords: [parseFloat(x.lat), parseFloat(x.lon)] as [number, number],
      label: shortLabel(x.display_name),
    }));
  } catch { return []; }
}

function shortLabel(s: string) { return s.split(",").slice(0, 3).join(", ").trim(); }

// ─────────────────────────────────────────────────────────────────────────────
// OVERPASS
// ─────────────────────────────────────────────────────────────────────────────
interface NearbyPlace { id: number; coords: [number, number]; name: string; type: string; address: string; category?: string; }

const OQ: Record<string, string> = {
  food:       `node["amenity"~"restaurant|cafe|fast_food|food_court"]`,
  hospital:   `node["amenity"~"hospital|clinic|pharmacy|doctors"]`,
  atm:        `node["amenity"="atm"]`,
  hotel:      `node["tourism"~"hotel|guest_house|hostel|motel"]`,
  police:     `node["amenity"="police"]`,
  fuel:       `node["amenity"="fuel"]`,
  college:    `node["amenity"~"university|college|school"]`,
  busstop:    `node["highway"="bus_stop"]`,
  cafe:       `node["amenity"~"cafe|coffee_shop"]`,
  temple:     `node["amenity"~"place_of_worship"]["religion"~"hindu|jain|sikh"]`,
  mall:       `node["shop"~"mall|supermarket|department_store"]`,
  metro:      `node["railway"~"station|subway_entrance"]["station"~"subway|metro"]`,
  pharmacy:   `node["amenity"~"pharmacy|chemist"]`,
  park:       `node["leisure"~"park|garden"]`,
  bank:       `node["amenity"="bank"]`,
};

async function overpassFetch(query: string): Promise<any[]> {
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", body: query,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.elements || [];
  } catch { return []; }
}

async function fetchNearby(lat: number, lng: number, cat: string, radius = 1500): Promise<NearbyPlace[]> {
  const q = OQ[cat] || `node["amenity"="${cat}"]`;
  const els = await overpassFetch(`[out:json][timeout:15];${q}(around:${radius},${lat},${lng});out body 20;`);
  return els.filter((e: any) => e.lat && e.lon).map((e: any) => ({
    id: e.id, coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || CAT_LABELS[cat] || cat,
    type: cat,
    address: [e.tags?.["addr:street"], e.tags?.["addr:housenumber"]].filter(Boolean).join(" ") || "",
    category: e.tags?.amenity || e.tags?.tourism || e.tags?.shop || e.tags?.leisure || cat,
  }));
}

async function fetchNearbyText(lat: number, lng: number, text: string, radius = 3000): Promise<NearbyPlace[]> {
  try {
    // Try Overpass first with flexible tag matching
    const ltext = text.toLowerCase();
    let overpassQ = "";
    if (ltext.includes("cafe") || ltext.includes("coffee")) overpassQ = OQ["cafe"];
    else if (ltext.includes("temple") || ltext.includes("mandir")) overpassQ = OQ["temple"];
    else if (ltext.includes("mall")) overpassQ = OQ["mall"];
    else if (ltext.includes("metro")) overpassQ = OQ["metro"];
    else if (ltext.includes("pharmacy") || ltext.includes("medical")) overpassQ = OQ["pharmacy"];
    else if (ltext.includes("park") || ltext.includes("garden")) overpassQ = OQ["park"];
    else if (ltext.includes("bank")) overpassQ = OQ["bank"];
    else if (ltext.includes("hotel")) overpassQ = OQ["hotel"];
    else if (ltext.includes("restaurant") || ltext.includes("food")) overpassQ = OQ["food"];
    else if (ltext.includes("atm")) overpassQ = OQ["atm"];
    else if (ltext.includes("school") || ltext.includes("college") || ltext.includes("university")) overpassQ = OQ["college"];
    else if (ltext.includes("fuel") || ltext.includes("petrol") || ltext.includes("gas")) overpassQ = OQ["fuel"];

    let results: NearbyPlace[] = [];
    if (overpassQ) {
      const els = await overpassFetch(`[out:json][timeout:15];${overpassQ}(around:${radius},${lat},${lng});out body 20;`);
      results = els.filter((e: any) => e.lat && e.lon).map((e: any, i: number) => ({
        id: e.id || i, coords: [e.lat, e.lon] as [number, number],
        name: e.tags?.name || e.tags?.["name:en"] || text,
        type: "search", address: e.tags?.["addr:street"] || "",
        category: e.tags?.amenity || e.tags?.tourism || e.tags?.shop || text,
      }));
    }

    // Supplement with Nominatim
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text + " Bengaluru")}&format=json&limit=15&countrycodes=in`,
      { headers: { "Accept-Language": "en" } }
    );
    const d = await r.json();
    const nomResults = d.filter((x: any) => {
      const dlat = parseFloat(x.lat) - lat, dlng = parseFloat(x.lon) - lng;
      return Math.sqrt(dlat * dlat + dlng * dlng) * 111000 < radius * 2;
    }).map((x: any, i: number) => ({
      id: 900000 + i, coords: [parseFloat(x.lat), parseFloat(x.lon)] as [number, number],
      name: shortLabel(x.display_name), type: "search", address: "",
      category: x.type || text,
    }));

    const combined = [...results, ...nomResults];
    const seen = new Set<string>();
    return combined.filter(p => {
      const key = `${p.coords[0].toFixed(4)},${p.coords[1].toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);
  } catch { return []; }
}

async function fetchOnTheWay(routeCoords: [number, number][], catOrText: string): Promise<NearbyPlace[]> {
  const step = Math.max(1, Math.floor(routeCoords.length / 8));
  const samples = routeCoords.filter((_, i) => i % step === 0).slice(0, 8);
  const q = OQ[catOrText] || `node["name"~"${catOrText}",i]`;
  const parts = samples.map(c => `${q}(around:500,${c[0]},${c[1]});`).join("");
  const els = await overpassFetch(`[out:json][timeout:20];(${parts});out body 20;`);
  const seen = new Set<number>();
  return els.filter((e: any) => e.lat && e.lon && !seen.has(e.id) && seen.add(e.id)).slice(0, 15).map((e: any) => ({
    id: e.id, coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || CAT_LABELS[catOrText] || catOrText,
    type: catOrText, address: e.tags?.["addr:street"] || "",
    category: e.tags?.amenity || e.tags?.tourism || catOrText,
  }));
}

async function fetchBusStops(lat: number, lng: number): Promise<NearbyPlace[]> {
  const els = await overpassFetch(`[out:json][timeout:10];node["highway"="bus_stop"](around:800,${lat},${lng});out body 8;`);
  return els.filter((e: any) => e.lat && e.lon).map((e: any) => ({
    id: e.id, coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || "Bus Stop",
    type: "busstop", address: e.tags?.ref || "",
    category: "bus_stop",
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// BMTC
// ─────────────────────────────────────────────────────────────────────────────
const BMTC = [
  { number: "500C", from: "Kempegowda BS", to: "Whitefield",      via: ["Majestic","Indiranagar","Marathahalli"] },
  { number: "201R", from: "Kempegowda BS", to: "Electronic City", via: ["Jayanagar","BTM Layout","Silk Board"] },
  { number: "335E", from: "Kempegowda BS", to: "Hebbal",          via: ["Mekhri Circle","Nagawara"] },
  { number: "G1",   from: "Kempegowda BS", to: "Bellandur",       via: ["Koramangala","HSR Layout"] },
  { number: "401",  from: "Shivajinagar",  to: "Banashankari",    via: ["Majestic","Jayanagar"] },
  { number: "500A", from: "Majestic",      to: "Marathahalli",    via: ["Indiranagar","Domlur"] },
  { number: "356F", from: "Majestic",      to: "Yelahanka",       via: ["Hebbal","Kogilu"] },
  { number: "333",  from: "Majestic",      to: "Electronic City", via: ["Lalbagh","Jayanagar","BTM","Silk Board"] },
  { number: "600",  from: "Kempegowda BS", to: "Mysuru Road",     via: ["Rajajinagar","Vijayanagar"] },
  { number: "150",  from: "Shivajinagar",  to: "Koramangala",     via: ["Richmond Circle"] },
  { number: "G5",   from: "Shivajinagar",  to: "Manyata Tech",    via: ["Hebbal"] },
  { number: "400",  from: "Kempegowda BS", to: "Domlur",          via: ["MG Road","Trinity"] },
  { number: "201",  from: "Jayanagar",     to: "Whitefield",      via: ["Koramangala","Indiranagar","Marathahalli"] },
  { number: "C9",   from: "Shivajinagar",  to: "Kengeri",         via: ["Majestic","Vijayanagar"] },
  { number: "V1",   from: "Kempegowda BS", to: "Vidhan Soudha",   via: ["Cubbon Park"] },
];

function findBusRoutes(a: string, b: string) {
  const fromWords = a.toLowerCase().split(/[\s,]+/).filter(w => w.length > 4);
  const toWords   = b.toLowerCase().split(/[\s,]+/).filter(w => w.length > 4);
  return BMTC.filter(rt => {
    const fromText = rt.from.toLowerCase() + " " + rt.via.join(" ").toLowerCase();
    const toText   = rt.to.toLowerCase()   + " " + rt.via.join(" ").toLowerCase();
    const fromMatch = fromWords.some(w => fromText.includes(w));
    const toMatch   = toWords.some(w => toText.includes(w));
    return fromMatch || toMatch;
  }).slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
type Mode = "car" | "bike" | "walk" | "bus";
type SavedType = "home" | "work" | "custom";
interface SavedPlace { label: string; coords: [number, number]; type: SavedType; name?: string; }
type Panel = "search" | "result" | "nearby" | "saved" | "recents";

const MODES: { id: Mode; icon: string; label: string; color: string; osrm: string }[] = [
  { id: "car",  icon: "🚗", label: "Car",   color: "#2563eb", osrm: "driving" },
  { id: "bike", icon: "🏍", label: "Bike",  color: "#10b981", osrm: "driving" },
  { id: "walk", icon: "🚶", label: "Walk",  color: "#f59e0b", osrm: "foot"    },
  { id: "bus",  icon: "🚌", label: "Bus",   color: "#8b5cf6", osrm: "driving" },
];

const CATS = [
  { id: "food",     icon: "🍽", label: "Dining"   },
  { id: "hospital", icon: "🏥", label: "Hospital" },
  { id: "atm",      icon: "🏧", label: "ATM"      },
  { id: "hotel",    icon: "🏨", label: "Hotel"    },
  { id: "police",   icon: "👮", label: "Police"   },
  { id: "fuel",     icon: "⛽", label: "Fuel"     },
  { id: "college",  icon: "🎓", label: "College"  },
  { id: "cafe",     icon: "☕", label: "Cafe"     },
  { id: "temple",   icon: "🛕", label: "Temple"   },
  { id: "mall",     icon: "🏬", label: "Mall"     },
  { id: "metro",    icon: "🚇", label: "Metro"    },
  { id: "pharmacy", icon: "💊", label: "Pharmacy" },
];

const CAT_LABELS: Record<string, string> = {
  food:"Restaurant", hospital:"Hospital", atm:"ATM", hotel:"Hotel",
  police:"Police", fuel:"Fuel Station", busstop:"Bus Stop", college:"College",
  cafe:"Cafe", temple:"Temple", mall:"Mall", metro:"Metro Station",
  pharmacy:"Pharmacy", park:"Park", bank:"Bank", search:"Place",
};
const CAT_COLORS: Record<string, string> = {
  food:"#ef4444", hospital:"#3b82f6", atm:"#10b981", hotel:"#f59e0b",
  police:"#1e40af", fuel:"#ea580c", busstop:"#8b5cf6", college:"#0891b2",
  cafe:"#92400e", temple:"#d97706", mall:"#7c3aed", metro:"#0284c7",
  pharmacy:"#16a34a", park:"#15803d", bank:"#1d4ed8", search:"#64748b",
};
const CAT_ICONS: Record<string, string> = {
  food:"🍽", hospital:"🏥", atm:"🏧", hotel:"🏨",
  police:"👮", fuel:"⛽", busstop:"🚌", college:"🎓",
  cafe:"☕", temple:"🛕", mall:"🏬", metro:"🚇",
  pharmacy:"💊", park:"🌳", bank:"🏦", search:"📍",
};

// ─────────────────────────────────────────────────────────────────────────────
// PIN ICONS
// ─────────────────────────────────────────────────────────────────────────────
function makePin(fill: string, letter: string) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:28px;height:40px;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6))">
      <svg viewBox="0 0 28 40" width="28" height="40" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 0C6.268 0 0 6.268 0 14c0 10 14 26 14 26S28 24 28 14C28 6.268 21.732 0 14 0z" fill="${fill}"/>
        <circle cx="14" cy="14" r="6" fill="white" opacity="0.95"/>
      </svg>
      <span style="position:absolute;top:9px;left:0;width:28px;text-align:center;font-size:9px;font-weight:900;color:${fill};font-family:sans-serif">${letter}</span>
    </div>`,
    iconSize: [28, 40], iconAnchor: [14, 40], popupAnchor: [0, -42],
  });
}

function makeNearbyPin(color: string, emoji: string) {
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};border:2px solid rgba(255,255,255,0.8);border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.5)">${emoji}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function makeWaypointDot(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};border:2px solid rgba(255,255,255,0.7);border-radius:50%;width:10px;height:10px;box-shadow:0 1px 4px rgba(0,0,0,0.5)"></div>`,
    iconSize: [10, 10], iconAnchor: [5, 5],
  });
}

const PIN_A = makePin("#10b981", "A");
const PIN_B = makePin("#ef4444", "B");
const PIN_S = makePin("#f97316", "S");

// ─────────────────────────────────────────────────────────────────────────────
// MAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function ClickHandler({ active, onPick }: { active: boolean; onPick: (ll: L.LatLng) => void }) {
  const map = useMap();
  useEffect(() => { map.getContainer().style.cursor = active ? "crosshair" : ""; }, [active, map]);
  useMapEvents({ click(e) { if (active) onPick(e.latlng); } });
  return null;
}

function FlyTo({ from, to, stop }: { from: Loc | null; to: Loc | null; stop?: Loc | null }) {
  const map = useMap();
  useEffect(() => {
    const pts = [from, to, stop].filter(Boolean).map(l => l!.coords);
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 15 });
    else if (pts.length === 1) map.flyTo(pts[0], 15, { duration: 1 });
  // eslint-disable-next-line
  }, [from?.coords.toString(), to?.coords.toString(), stop?.coords?.toString()]);
  return null;
}

function LiveDot({ pos }: { pos: [number, number] | null }) {
  const map = useMap();
  const layers = useRef<L.Layer[]>([]);
  useEffect(() => {
    layers.current.forEach(l => { try { map.removeLayer(l); } catch {} });
    layers.current = [];
    if (!pos) return;
    const pulse = L.circleMarker(pos, { radius: 18, fillColor: "#2563eb", fillOpacity: 0.15, color: "#2563eb", weight: 1, opacity: 0.4 }).addTo(map);
    const dot   = L.circleMarker(pos, { radius: 8,  fillColor: "#2563eb", fillOpacity: 1,    color: "#fff",    weight: 2.5 }).addTo(map);
    layers.current = [pulse, dot];
    return () => { layers.current.forEach(l => { try { map.removeLayer(l); } catch {} }); };
  // eslint-disable-next-line
  }, [pos?.toString()]);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO INPUT
// ─────────────────────────────────────────────────────────────────────────────
function AutoInput({ value, placeholder, dot, onChange, onSelect, savedPlaces, recents, dark = true }: {
  value: string; placeholder: string; dot: string;
  onChange: (v: string) => void; onSelect: (l: Loc) => void;
  savedPlaces?: SavedPlace[]; recents?: Loc[]; dark?: boolean;
}) {
  const [list, setList]   = useState<Loc[]>([]);
  const [open, setOpen]   = useState(false);
  const [focus, setFocus] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function change(v: string) {
    onChange(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setList([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const s = await fetchSuggestions(v);
      setList(s); setOpen(s.length > 0);
    }, 300);
  }

  const showQuick = focus && !value && ((savedPlaces?.length ?? 0) > 0 || (recents?.length ?? 0) > 0);
  const dropBg = dark ? "#1c1c1e" : "#fff";
  const dropText = dark ? "#e4e2e4" : "#1e293b";
  const dropBorder = dark ? "rgba(255,255,255,0.08)" : "#e2e8f0";
  const dropHover = dark ? "rgba(255,255,255,0.05)" : "#f8fafc";

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <input value={value} onChange={e => change(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => { setOpen(false); setFocus(false); }, 200)}
          placeholder={placeholder}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: dark ? D.text : "#1e293b", fontSize: 13, fontFamily: "inherit", minWidth: 0 }}
        />
        {value && (
          <button onMouseDown={() => { onChange(""); setList([]); setOpen(false); }}
            style={{ background: "none", border: "none", color: D.textDim, cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0 }}>×</button>
        )}
      </div>

      {showQuick && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: -14, right: -14, zIndex: 99999, background: dropBg, borderRadius: 12, border: `1px solid ${dropBorder}`, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", overflow: "hidden" }}>
          {savedPlaces && savedPlaces.length > 0 && (
            <>
              <div style={{ padding: "7px 12px 3px", fontSize: 9, fontWeight: 800, color: D.textDim, letterSpacing: "0.1em" }}>SAVED</div>
              {savedPlaces.map((p, i) => (
                <div key={i} onMouseDown={() => { onSelect({ coords: p.coords, label: p.label }); onChange(p.label); }}
                  style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: dropText, transition: "background 0.1s" }}
                  onMouseEnter={e => (e.currentTarget.style.background = dropHover)}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 15 }}>{p.type === "home" ? "🏠" : p.type === "work" ? "💼" : "⭐"}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{p.name || (p.type === "home" ? "Home" : p.type === "work" ? "Work" : "Saved")}</div>
                    <div style={{ fontSize: 10, color: D.textMuted }}>{p.label.split(",")[0]}</div>
                  </div>
                </div>
              ))}
            </>
          )}
          {recents && recents.length > 0 && (
            <>
              <div style={{ padding: "7px 12px 3px", fontSize: 9, fontWeight: 800, color: D.textDim, letterSpacing: "0.1em", borderTop: savedPlaces?.length ? `1px solid ${dropBorder}` : "none" }}>RECENT</div>
              {recents.slice(0, 4).map((r, i) => (
                <div key={i} onMouseDown={() => { onSelect(r); onChange(r.label); }}
                  style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 12, color: dropText }}
                  onMouseEnter={e => (e.currentTarget.style.background = dropHover)}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ color: D.textDim, fontSize: 13 }}>🕐</span>
                  <span>{r.label.split(",").slice(0, 2).join(",")}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {open && list.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: -14, right: -14, zIndex: 99999, background: dropBg, borderRadius: 12, border: `1px solid ${dropBorder}`, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", overflow: "hidden" }}>
          {list.map((s, i) => (
            <div key={i} onMouseDown={() => { onSelect(s); onChange(s.label); setOpen(false); }}
              style={{ padding: "9px 12px", fontSize: 12, color: dropText, cursor: "pointer", display: "flex", gap: 8, borderBottom: i < list.length - 1 ? `1px solid ${dropBorder}` : "none" }}
              onMouseEnter={e => (e.currentTarget.style.background = dropHover)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: D.textDim }}>📍</span>
              <span style={{ lineHeight: 1.4 }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────────────────────────────
function SetLocModal({ title, onClose, onGPS, onMap, onManual }: {
  title: string; onClose: () => void; onGPS: () => void; onMap: () => void; onManual: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ ...glass, borderRadius: 20, padding: 24, width: 310, boxShadow: "0 24px 64px rgba(0,0,0,0.8)" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: D.text, marginBottom: 16 }}>{title}</div>
        <button onClick={onGPS} style={{ width: "100%", padding: 12, background: "rgba(37,99,235,0.12)", border: "1px solid rgba(37,99,235,0.3)", borderRadius: 12, cursor: "pointer", fontSize: 13, color: "#60a5fa", fontWeight: 600, marginBottom: 8, textAlign: "left" as const }}>
          📍 Use my current location
        </button>
        <button onClick={onMap} style={{ width: "100%", padding: 12, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 12, cursor: "pointer", fontSize: 13, color: "#34d399", fontWeight: 600, marginBottom: 14, textAlign: "left" as const }}>
          🗺 Pick on map
        </button>
        <div style={{ fontSize: 11, color: D.textMuted, marginBottom: 6 }}>Or type address:</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === "Enter" && q.trim() && onManual(q)}
            placeholder="Search address…"
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${D.border}`, fontSize: 12, background: D.surface, color: D.text, outline: "none" }} />
          <button onClick={() => q.trim() && onManual(q)} style={{ padding: "8px 14px", background: D.primary, border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>→</button>
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 10, padding: 8, background: "none", border: "none", color: D.textDim, fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function SaveModal({ onSave, onClose }: { onSave: (type: SavedType, name?: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ ...glass, borderRadius: 20, padding: 24, width: 290, boxShadow: "0 24px 64px rgba(0,0,0,0.8)" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: D.text, marginBottom: 16 }}>Save this place as</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button onClick={() => onSave("home")} style={{ flex: 1, padding: 10, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#34d399", fontWeight: 700 }}>🏠 Home</button>
          <button onClick={() => onSave("work")} style={{ flex: 1, padding: 10, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#fbbf24", fontWeight: 700 }}>💼 Work</button>
        </div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Custom name (Gym, College…)"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${D.border}`, fontSize: 12, background: D.surface, color: D.text, marginBottom: 8, boxSizing: "border-box" as const, outline: "none" }} />
        <button onClick={() => name.trim() && onSave("custom", name.trim())}
          style={{ width: "100%", padding: 10, background: name.trim() ? D.primary : D.surfaceHi, border: "none", borderRadius: 8, color: name.trim() ? "#fff" : D.textDim, fontSize: 12, fontWeight: 700, cursor: name.trim() ? "pointer" : "not-allowed" }}>
          ⭐ Save with custom name
        </button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: 8, background: "none", border: "none", color: D.textDim, fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

function fmtEta(m: number) { return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; }

function stepIcon(t: string) {
  const s = t.toLowerCase();
  if (s.includes("left"))       return "↰";
  if (s.includes("right"))      return "↱";
  if (s.includes("arrive"))     return "🏁";
  if (s.includes("roundabout")) return "↻";
  if (s.includes("merge"))      return "⤵";
  if (s.includes("head") || s.includes("depart")) return "➤";
  return "↑";
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [fromTxt,  setFromTxt]  = useState("");
  const [toTxt,    setToTxt]    = useState("");
  const [fromLoc,  setFromLoc]  = useState<Loc | null>(null);
  const [toLoc,    setToLoc]    = useState<Loc | null>(null);
  const [stopTxt,  setStopTxt]  = useState("");
  const [stopLoc,  setStopLoc]  = useState<Loc | null>(null);
  const [showStop, setShowStop] = useState(false);
  const [mode,     setMode]     = useState<Mode>("car");
  const [pickFor,  setPickFor]  = useState<"from"|"to"|"stop"|"home"|"work"|null>(null);
  const [routes,   setRoutes]   = useState<OsrmRoute[]>([]);
  const [selRoute, setSelRoute] = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [gpsing,   setGpsing]   = useState<string|null>(null);
  const [err,      setErr]      = useState("");
  const [myPos,    setMyPos]    = useState<[number,number]|null>(null);
  const [showSteps,setShowSteps]= useState(false);
  const [panel,    setPanel]    = useState<Panel>("search");

  const [nearbyPlaces,   setNearbyPlaces]   = useState<NearbyPlace[]>([]);
  const [nearbyLoading,  setNearbyLoading]  = useState(false);
  const [activeCat,      setActiveCat]      = useState<string|null>(null);
  const [nearbySearch,   setNearbySearch]   = useState("");
  const [onTheWay,       setOnTheWay]       = useState<NearbyPlace[]>([]);
  const [onWayLoading,   setOnWayLoading]   = useState(false);
  const [activeOnWayCat, setActiveOnWayCat] = useState<string|null>(null);
  const [onWayCustom,    setOnWayCustom]    = useState("");
  const [busStops,       setBusStops]       = useState<NearbyPlace[]>([]);
  const [busRoutesFound, setBusRoutesFound] = useState<typeof BMTC>([]);

  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>(() => {
    try { return JSON.parse(localStorage.getItem("srfSaved") || "[]"); } catch { return []; }
  });
  const [recents, setRecents] = useState<Loc[]>(() => {
    try { return JSON.parse(localStorage.getItem("srfRecents") || "[]"); } catch { return []; }
  });

  const [fuelPrice,    setFuelPrice]    = useState(103.5);
  const [fuelMileage,  setFuelMileage]  = useState(15);
  const [showFuelEdit, setShowFuelEdit] = useState(false);
  const [savePlaceTarget, setSavePlaceTarget] = useState<NearbyPlace|null>(null);
  const [setLocModal,     setSetLocModal]     = useState<"home"|"work"|"custom"|null>(null);

  // Live tracking
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      pos => setMyPos([pos.coords.latitude, pos.coords.longitude]),
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  function gps(field: string, onDone: (l: Loc) => void) {
    if (!navigator.geolocation) { setErr("Geolocation not supported."); return; }
    setGpsing(field); setErr("");
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const coords: [number,number] = [pos.coords.latitude, pos.coords.longitude];
        const label = await reverseGeocode(coords[0], coords[1]);
        onDone({ coords, label });
        setGpsing(null);
      },
      e => {
        const m: Record<number,string> = { 1:"Location denied — allow in browser settings.", 2:"Location unavailable.", 3:"Timed out." };
        setErr(m[e.code] || "GPS error."); setGpsing(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  const handleMapClick = useCallback(async (ll: L.LatLng) => {
    const coords: [number,number] = [ll.lat, ll.lng];
    const label = await reverseGeocode(ll.lat, ll.lng);
    const loc = { coords, label };
    if (pickFor === "from") { setFromTxt(label); setFromLoc(loc); }
    if (pickFor === "to")   { setToTxt(label);   setToLoc(loc);   }
    if (pickFor === "stop") { setStopTxt(label); setStopLoc(loc); }
    if (pickFor === "home") persistSaved("home", loc);
    if (pickFor === "work") persistSaved("work", loc);
    setPickFor(null); setSetLocModal(null);
  }, [pickFor]);

  function persistSaved(type: SavedType, loc: Loc, name?: string) {
    const updated = type === "custom"
      ? [...savedPlaces, { ...loc, type, name }]
      : [...savedPlaces.filter(p => p.type !== type), { ...loc, type, name }];
    setSavedPlaces(updated);
    localStorage.setItem("srfSaved", JSON.stringify(updated));
  }

  async function getDirections() {
    setErr(""); setRoutes([]); setSelRoute(0); setShowSteps(false);
    setOnTheWay([]); setActiveOnWayCat(null);
    setBusStops([]);
    if (!fromTxt.trim() || !toTxt.trim()) { setErr("Enter both From and To."); return; }
    setLoading(true);

    let fLoc = fromLoc, tLoc = toLoc;
    if (!fLoc) { const r = await geocode(fromTxt); if (!r) { setErr(`Not found: "${fromTxt}"`); setLoading(false); return; } fLoc = r; setFromLoc(r); setFromTxt(r.label); }
    if (!tLoc) { const r = await geocode(toTxt);   if (!r) { setErr(`Not found: "${toTxt}"`);   setLoading(false); return; } tLoc = r; setToLoc(r);   setToTxt(r.label);   }

    // Resolve stop if entered
    let sLoc = stopLoc;
    if (showStop && stopTxt.trim() && !sLoc) {
      const r = await geocode(stopTxt);
      if (r) { sLoc = r; setStopLoc(r); setStopTxt(r.label); }
    }

    const mObj = MODES.find(m => m.id === mode)!;
    const rts = await fetchRoutes(fLoc!.coords, tLoc!.coords, mObj.osrm, sLoc?.coords ?? null);
    if (!rts.length) { setErr("No route found. Try different locations."); setLoading(false); return; }

    if (!sLoc) {
      rts.sort((a, b) => {
        const distDiff = a.distKm - b.distKm;
        if (Math.abs(distDiff) > 0.1) return distDiff;
        return a.durationMin - b.durationMin;
      });
    }
    setRoutes(rts); setSelRoute(0); setPanel("result");
    setBusRoutesFound(findBusRoutes(fLoc!.label, tLoc!.label));
    if (mode === "bus") {
  fetchBusStops(fLoc!.coords[0], fLoc!.coords[1]).then(stops => setBusStops(stops));
  // Also fetch metro stations
  overpassFetch(`[out:json][timeout:10];node["railway"~"station|subway_entrance"](around:1500,${fLoc!.coords[0]},${fLoc!.coords[1]});out body 6;`)
    .then(els => {
      const metros = els.filter((e: any) => e.lat && e.lon).map((e: any) => ({
        id: e.id + 999999,
        coords: [e.lat, e.lon] as [number, number],
        name: e.tags?.name || e.tags?.["name:en"] || "Metro Station",
        type: "metro",
        address: "",
        category: "metro",
      }));
      setBusStops(prev => [...prev, ...metros]);
    });
}

    const newR = [fLoc!, tLoc!, ...recents.filter(r => r.label !== fLoc!.label && r.label !== tLoc!.label)].slice(0, 10);
    setRecents(newR); localStorage.setItem("srfRecents", JSON.stringify(newR));
    setLoading(false);
  }

  async function doNearby(cat?: string, text?: string) {
    const center = myPos || fromLoc?.coords || BENGALURU;
    setNearbyLoading(true); setNearbyPlaces([]);
    if (cat) { setActiveCat(cat); const p = await fetchNearby(center[0], center[1], cat); setNearbyPlaces(p); }
    else if (text) { setActiveCat(null); const p = await fetchNearbyText(center[0], center[1], text); setNearbyPlaces(p); }
    setNearbyLoading(false);
  }

  async function doOnTheWay(catOrText: string, isCustom = false) {
    if (!routes.length) return;
    if (!isCustom && activeOnWayCat === catOrText) { setActiveOnWayCat(null); setOnTheWay([]); return; }
    setActiveOnWayCat(catOrText); setOnWayLoading(true); setOnTheWay([]);
    const p = await fetchOnTheWay(routes[selRoute].coords, catOrText);
    setOnTheWay(p); setOnWayLoading(false);
  }

  function swap() { setFromTxt(toTxt); setToTxt(fromTxt); setFromLoc(toLoc); setToLoc(fromLoc); setRoutes([]); }

  // ── CLEAR: resets everything
  function clear() {
    setFromTxt(""); setToTxt(""); setStopTxt("");
    setFromLoc(null); setToLoc(null); setStopLoc(null);
    setRoutes([]); setSelRoute(0); setErr(""); setPickFor(null);
    setShowSteps(false); setShowStop(false);
    setNearbyPlaces([]); setActiveCat(null);
    setOnTheWay([]); setActiveOnWayCat(null); setOnWayCustom("");
    setBusStops([]); setBusRoutesFound([]);
    setShowFuelEdit(false);
    setPanel("search");
  }

  const route    = routes[selRoute];
  const modeObj  = MODES.find(m => m.id === mode)!;
  const fuelCost = route && mode !== "walk" && mode !== "bus" ? {
    low:  Math.round((route.distKm / (fuelMileage * 1.1)) * fuelPrice),
    high: Math.round((route.distKm / (fuelMileage * 0.75)) * fuelPrice),
  } : null;
  const trafficEta = route
    ? (mode === "car" ? Math.round(route.durationMin * 1.6) : mode === "bus" ? Math.round(route.durationMin * 1.4) : mode === "bike" ? Math.round(route.durationMin * 1.2) : mode === "walk" ? Math.round(route.distKm * 13.5) : route.durationMin)
    : 0;
  const waypointDots = route ? route.steps.filter((_, i) => i > 0 && i < route.steps.length - 1 && i % 4 === 0) : [];
  const allNearbyOnMap = [...nearbyPlaces, ...onTheWay];
  // Panel is "open" (has width) when there's content to show
  const panelOpen = panel === "nearby" || panel === "saved" || panel === "recents" || (panel === "result" && routes.length > 0);

  const sideItems = [
    { id: "search",  icon: "🔍", label: "Search"  },
    { id: "nearby",  icon: "📍", label: "Nearby"  },
    { id: "saved",   icon: "⭐", label: "Saved"   },
    { id: "recents", icon: "🕐", label: "Recents" },
  ];

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", fontFamily: "'Segoe UI', system-ui, sans-serif", background: D.bg, color: D.text }}>

      {/* ════ FULL SCREEN MAP ════ */}
      <MapContainer center={BENGALURU} zoom={13} style={{ width: "100%", height: "100%", zIndex: 1 }} zoomControl={false}>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
        />
        {/* Alternate route */}
        {routes[1] && (
          <Polyline positions={routes[1].coords}
            pathOptions={{ color: "#475569", weight: 5, opacity: 0.5, dashArray: "10 7" }}
            eventHandlers={{ click: () => setSelRoute(1) }}
          />
        )}
        {/* Selected route */}
        {route && (
          <Polyline positions={route.coords}
            pathOptions={{ color: modeObj.color, weight: 6, opacity: 0.95 }}
          />
        )}
        {/* Waypoint dots */}
        {waypointDots.map((step, i) => (
          <Marker key={`wp-${i}`} position={step.coords} icon={makeWaypointDot(modeObj.color)}>
            <Popup>
              <div style={{ fontSize: 11, maxWidth: 160, background: D.surface, color: D.text, padding: 4, borderRadius: 6 }}>
                {step.text}
              </div>
            </Popup>
          </Marker>
        ))}
        {/* Alt label */}
        {routes[1] && selRoute === 0 && (
          <Marker position={routes[1].coords[Math.floor(routes[1].coords.length / 2)]}
            icon={L.divIcon({
              className: "",
              html: `<div style="background:rgba(10,10,12,0.88);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:3px 9px;font-size:10px;font-weight:700;color:#a1a1aa;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5);cursor:pointer">Alternative · ${routes[1].distKm.toFixed(1)}km</div>`,
              iconSize: [90, 24], iconAnchor: [45, 12],
            })}
            eventHandlers={{ click: () => setSelRoute(1) }}
          />
        )}
        {/* Pins */}
        {fromLoc && (
          <Marker position={fromLoc.coords} icon={PIN_A}>
            <Popup>
              <div style={{ color: "#1e293b", fontSize: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>🟢 Start</div>
                <div>{fromLoc.label}</div>
              </div>
            </Popup>
          </Marker>
        )}
        {toLoc && (
          <Marker position={toLoc.coords} icon={PIN_B}>
            <Popup>
              <div style={{ color: "#1e293b", fontSize: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>🔴 Destination</div>
                <div>{toLoc.label}</div>
              </div>
            </Popup>
          </Marker>
        )}
        {stopLoc && (
          <Marker position={stopLoc.coords} icon={PIN_S}>
            <Popup>
              <div style={{ color: "#1e293b", fontSize: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>🟠 Stop</div>
                <div>{stopLoc.label}</div>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Nearby markers — rich popups with name + address + category */}
        {allNearbyOnMap.map(p => (
          <Marker key={`np-${p.id}-${p.type}`} position={p.coords}
            icon={makeNearbyPin(CAT_COLORS[p.type] || "#64748b", CAT_ICONS[p.type] || "📍")}>
            <Popup>
              <div style={{ fontSize: 12, color: "#1e293b", minWidth: 160, maxWidth: 220 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 16 }}>{CAT_ICONS[p.type] || "📍"}</span>
                  <b style={{ fontSize: 13 }}>{p.name}</b>
                </div>
                {p.address && (
                  <div style={{ color: "#64748b", marginBottom: 4, fontSize: 11 }}>📌 {p.address}</div>
                )}
                <div style={{ display: "inline-block", padding: "2px 8px", background: `${CAT_COLORS[p.type] || "#64748b"}22`, borderRadius: 10, fontSize: 10, fontWeight: 700, color: CAT_COLORS[p.type] || "#64748b", marginBottom: 6 }}>
                  {CAT_LABELS[p.type] || p.category || p.type}
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  <button onClick={() => { setToTxt(p.name); setToLoc({ coords: p.coords, label: p.name }); }}
                    style={{ flex: 1, padding: "4px 0", background: "#e8f0fe", border: "none", borderRadius: 6, color: "#1a73e8", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>→ Set Dest</button>
                  <button onClick={() => setSavePlaceTarget(p)}
                    style={{ padding: "4px 8px", background: "#fef3c7", border: "none", borderRadius: 6, color: "#d97706", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>⭐ Save</button>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Bus stops */}
        {busStops.map(p => (
          <Marker key={`bs-${p.id}`} position={p.coords} icon={makeNearbyPin("#8b5cf6", "🚌")}>
            <Popup>
              <div style={{ fontSize: 12, color: "#1e293b", minWidth: 140 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>🚌 {p.name}</div>
                <div style={{ color: "#64748b", fontSize: 10 }}>Bus Stop{p.address ? ` · Ref: ${p.address}` : ""}</div>
              </div>
            </Popup>
          </Marker>
        ))}

        <LiveDot pos={myPos} />
        <ClickHandler active={!!pickFor} onPick={handleMapClick} />
        <FlyTo from={fromLoc} to={toLoc} stop={stopLoc} />
      </MapContainer>

      {/* Map pick hint */}
      {pickFor && (
        <div style={{ position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)", zIndex: 1000, ...glass, color: D.text, padding: "9px 22px", borderRadius: 28, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 24px rgba(0,0,0,0.6)", display: "flex", alignItems: "center", gap: 12 }}>
          📌 Tap map to set {pickFor === "from" ? "origin" : pickFor === "to" ? "destination" : pickFor === "stop" ? "stop" : pickFor === "home" ? "home" : "work"}
          <button onClick={() => { setPickFor(null); setSetLocModal(null); }} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 6, color: D.text, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
        </div>
      )}

      {/* ════ LEFT SIDEBAR ════ */}
      <aside style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 72, zIndex: 500, background: D.bg, borderRight: `1px solid ${D.border}`, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 16, gap: 0, boxShadow: "2px 0 16px rgba(0,0,0,0.4)" }}>
        <div style={{ width: 40, height: 40, background: D.primary, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24, boxShadow: "0 4px 12px rgba(37,99,235,0.4)", fontSize: 20 }}>🗺</div>
        {sideItems.map(item => (
          <button key={item.id}
            onClick={() => {
              const next = item.id as Panel;
              if (next === "nearby") {
                // Switch to nearby: clear route display, show fresh nearby
                setPanel("nearby");
              } else if (panel === next) {
                setPanel(routes.length > 0 ? "result" : "search");
              } else {
                setPanel(next);
              }
            }}
            style={{ width: 48, height: 48, borderRadius: 12, background: panel === item.id ? D.primaryBg : "transparent", border: panel === item.id ? `1px solid rgba(37,99,235,0.3)` : "1px solid transparent", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, transition: "all 0.15s", marginBottom: 6, borderRight: panel === item.id ? `2px solid ${D.primary}` : "2px solid transparent" }}>
            <span style={{ fontSize: 16 }}>{item.icon}</span>
            <span style={{ fontSize: 8, color: panel === item.id ? D.primary : D.textMuted, fontWeight: 600 }}>{item.label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {myPos && (
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: D.primary, marginBottom: 16, boxShadow: "0 0 0 3px rgba(37,99,235,0.2)" }} title="Live location active" />
        )}
      </aside>

      {/* ════ SIDE PANEL ════ */}
      <div style={{ position: "absolute", top: 0, left: 72, bottom: 0, width: panelOpen ? 340 : 0, zIndex: 400, background: D.bg, borderRight: `1px solid ${D.border}`, boxShadow: "2px 0 24px rgba(0,0,0,0.5)", overflow: "hidden", transition: "width 0.25s ease", display: "flex", flexDirection: "column" }}>

        {/* ── NEARBY ── */}
        {panel === "nearby" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingTop: 80 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.text, marginBottom: 4 }}>📍 Nearby Places</div>
            <div style={{ fontSize: 11, color: D.textMuted, marginBottom: 12 }}>
              {myPos ? "📡 Using your live location" : "⚠️ Allow GPS for accurate results"}
            </div>
            <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
              <input value={nearbySearch} onChange={e => setNearbySearch(e.target.value)}
                onKeyDown={e => e.key === "Enter" && nearbySearch.trim() && doNearby(undefined, nearbySearch.trim())}
                placeholder="Search cafes, temples, malls, metro…"
                style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `1px solid ${D.border}`, fontSize: 12, background: D.surface, color: D.text, outline: "none", fontFamily: "inherit" }} />
              <button onClick={() => nearbySearch.trim() && doNearby(undefined, nearbySearch.trim())}
                style={{ padding: "9px 14px", background: D.primary, border: "none", borderRadius: 10, color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>🔍</button>
            </div>
            <div style={{ fontSize: 9, fontWeight: 800, color: D.textDim, letterSpacing: "0.1em", marginBottom: 8 }}>CATEGORIES</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
              {CATS.map(cat => (
                <button key={cat.id} onClick={() => { setNearbySearch(""); setActiveCat(cat.id); doNearby(cat.id); }}
                  style={{ padding: "9px 4px", background: activeCat === cat.id ? D.primaryBg : D.surface, border: `1.5px solid ${activeCat === cat.id ? D.primary : D.border}`, borderRadius: 10, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "all 0.15s" }}>
                  <span style={{ fontSize: 18 }}>{cat.icon}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, color: activeCat === cat.id ? D.primary : D.textMuted }}>{cat.label}</span>
                </button>
              ))}
            </div>
            {nearbyLoading && (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <div style={{ fontSize: 26, marginBottom: 6 }}>🔍</div>
                <div style={{ fontSize: 12, color: D.textMuted }}>Searching nearby…</div>
              </div>
            )}
            {!nearbyLoading && (activeCat || nearbySearch) && nearbyPlaces.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 0", fontSize: 12, color: D.textMuted }}>No results found. Try a different search.</div>
            )}
            {nearbyPlaces.map(p => (
              <div key={p.id} style={{ padding: "10px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{CAT_ICONS[p.type] || "📍"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  {p.address && <div style={{ fontSize: 10, color: D.textMuted, marginTop: 1 }}>{p.address}</div>}
                  <div style={{ fontSize: 9, color: CAT_COLORS[p.type] || D.textDim, marginTop: 2, fontWeight: 600 }}>{CAT_LABELS[p.type] || p.category || p.type}</div>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={() => { setToTxt(p.name); setToLoc({ coords: p.coords, label: p.name }); setPanel("search"); }}
                    style={{ padding: "3px 7px", background: D.primaryBg, border: `1px solid ${D.borderHov}`, borderRadius: 6, color: "#60a5fa", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>Go</button>
                  <button onClick={() => setSavePlaceTarget(p)}
                    style={{ padding: "3px 7px", background: "rgba(245,158,11,0.1)", border: "none", borderRadius: 6, color: "#fbbf24", fontSize: 10, cursor: "pointer" }}>⭐</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── SAVED ── */}
        {panel === "saved" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingTop: 80 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.text, marginBottom: 14 }}>⭐ Saved Places</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button onClick={() => setSetLocModal("home")} style={{ flex: 1, padding: 11, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)", borderRadius: 10, cursor: "pointer", fontSize: 11, color: "#34d399", fontWeight: 700 }}>🏠 Set Home</button>
              <button onClick={() => setSetLocModal("work")} style={{ flex: 1, padding: 11, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 10, cursor: "pointer", fontSize: 11, color: "#fbbf24", fontWeight: 700 }}>💼 Set Work</button>
              <button onClick={() => setSetLocModal("custom")} style={{ flex: 1, padding: 11, background: "rgba(37,99,235,0.1)", border: "1px solid rgba(37,99,235,0.25)", borderRadius: 10, cursor: "pointer", fontSize: 11, color: "#60a5fa", fontWeight: 700 }}>⭐ Add Custom</button>
            </div>
            {savedPlaces.length === 0 && <div style={{ fontSize: 12, color: D.textMuted, textAlign: "center", padding: "20px 0" }}>No saved places yet.</div>}
            {savedPlaces.map((p, i) => (
              <div key={i} style={{ padding: 10, background: D.surface, borderRadius: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 10, border: `1px solid ${D.border}` }}>
                <span style={{ fontSize: 20 }}>{p.type === "home" ? "🏠" : p.type === "work" ? "💼" : "⭐"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: D.text }}>{p.name || (p.type === "home" ? "Home" : p.type === "work" ? "Work" : "Saved")}</div>
                  <div style={{ fontSize: 10, color: D.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label.split(",").slice(0, 2).join(",")}</div>
                </div>
                <button onClick={() => { setToTxt(p.label); setToLoc({ coords: p.coords, label: p.label }); setPanel("search"); }}
                  style={{ padding: "4px 8px", background: D.primaryBg, border: `1px solid ${D.borderHov}`, borderRadius: 8, fontSize: 10, color: "#60a5fa", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>Go</button>
                <button onClick={() => { const u = savedPlaces.filter((_, j) => j !== i); setSavedPlaces(u); localStorage.setItem("srfSaved", JSON.stringify(u)); }}
                  style={{ padding: "4px 6px", background: "rgba(239,68,68,0.1)", border: "none", borderRadius: 8, fontSize: 10, color: "#f87171", cursor: "pointer", flexShrink: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ── RECENTS ── */}
        {panel === "recents" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingTop: 80 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.text, marginBottom: 14 }}>🕐 Recent Searches</div>
            {recents.length === 0 && <div style={{ fontSize: 12, color: D.textMuted, textAlign: "center", padding: "20px 0" }}>No recent searches yet.</div>}
            {recents.map((r, i) => (
              <div key={i} onClick={() => { setToTxt(r.label); setToLoc(r); setPanel("search"); }}
                style={{ padding: "10px 10px", borderBottom: `1px solid ${D.border}`, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}
                onMouseEnter={e => (e.currentTarget.style.background = D.surface)}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 14, color: D.textDim }}>🕐</span>
                <span style={{ fontSize: 12, color: D.textMuted }}>{r.label.split(",").slice(0, 2).join(",")}</span>
              </div>
            ))}
            {recents.length > 0 && (
              <button onClick={() => { setRecents([]); localStorage.removeItem("srfRecents"); }}
                style={{ marginTop: 14, width: "100%", padding: 9, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, color: "#f87171", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                🗑 Clear all recents
              </button>
            )}
          </div>
        )}

        {/* ── RESULT ── */}
        {panel === "result" && routes.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto" }}>
            {/* Header */}
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: D.textMuted, display: "flex", alignItems: "center", gap: 4, overflow: "hidden", flexWrap: "wrap" as const }}>
                  <span style={{ color: "#10b981", fontWeight: 800, flexShrink: 0 }}>A</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 80 }}>{fromTxt.split(",")[0]}</span>
                  {stopLoc && <>
                    <span style={{ color: D.border, flexShrink: 0 }}>→</span>
                    <span style={{ color: "#f97316", fontWeight: 800, flexShrink: 0 }}>S</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 70 }}>{stopTxt.split(",")[0]}</span>
                  </>}
                  <span style={{ color: D.border, flexShrink: 0 }}>→</span>
                  <span style={{ color: "#ef4444", fontWeight: 800, flexShrink: 0 }}>B</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 80 }}>{toTxt.split(",")[0]}</span>
                </div>
              </div>
              <button onClick={() => { setPanel("search"); }}
                style={{ padding: "3px 8px", background: D.surface, border: `1px solid ${D.border}`, borderRadius: 6, fontSize: 10, color: D.textMuted, cursor: "pointer", flexShrink: 0 }}>Edit</button>
              <button onClick={clear}
                style={{ padding: "3px 8px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, fontSize: 10, color: "#f87171", cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>✕ Clear</button>
            </div>

            {/* Mode selector */}
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}` }}>
              <div style={{ display: "flex", gap: 5 }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => { setMode(m.id); setRoutes([]); setBusStops([]); setTimeout(getDirections, 50); }}
                    style={{ flex: 1, padding: "8px 2px", background: mode === m.id ? m.color : D.surface, border: mode === m.id ? "none" : `1px solid ${D.border}`, borderRadius: 10, cursor: "pointer", color: mode === m.id ? "#fff" : D.textMuted, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: "all 0.15s", boxShadow: mode === m.id ? `0 2px 12px ${m.color}44` : "none" }}>
                    <span style={{ fontSize: 15 }}>{m.icon}</span>
                    <span style={{ fontSize: 9, fontWeight: 700 }}>{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Stats — single source of truth, no duplicate card */}
            <div style={{ display: "grid", gridTemplateColumns: fuelCost ? "1fr 1fr 1fr" : "1fr 1fr", borderBottom: `1px solid ${D.border}` }}>
              <div style={{ padding: "12px 0", textAlign: "center", borderRight: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: D.textDim, letterSpacing: "0.1em" }}>DISTANCE</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#60a5fa" }}>{route.distKm.toFixed(1)}<span style={{ fontSize: 12, color: D.textMuted, fontWeight: 400 }}> km</span></div>
              </div>
              <div style={{ padding: "12px 0", textAlign: "center", borderRight: fuelCost ? `1px solid ${D.border}` : "none" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: D.textDim, letterSpacing: "0.1em" }}>ETA W/ TRAFFIC</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#34d399" }}>{fmtEta(trafficEta)}</div>
                <div style={{ fontSize: 9, color: D.textDim }}>{mode === "walk" ? "~" + Math.round(route.distKm * 12) + " min (fast pace)" : "~" + fmtEta(route.durationMin) + " ideal"}</div>
              </div>
              {fuelCost && (
                <div style={{ padding: "12px 0", textAlign: "center", cursor: "pointer" }} onClick={() => setShowFuelEdit(!showFuelEdit)}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: D.textDim, letterSpacing: "0.1em" }}>FUEL EST. ✎</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#fb923c" }}>₹{fuelCost.low}–{fuelCost.high}</div>
                  <div style={{ fontSize: 9, color: D.textDim }}>tap to edit</div>
                </div>
              )}
            </div>

            {/* Fuel editor */}
            {showFuelEdit && (
              <div style={{ padding: "10px 14px", background: "rgba(245,158,11,0.06)", borderBottom: `1px solid rgba(245,158,11,0.2)` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24", marginBottom: 7 }}>⛽ Vehicle settings</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: D.textMuted, marginBottom: 3 }}>Fuel price (₹/L)</div>
                    <input type="number" value={fuelPrice} onChange={e => setFuelPrice(parseFloat(e.target.value) || 0)}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 7, border: `1px solid rgba(245,158,11,0.3)`, fontSize: 12, background: D.surface, color: D.text, boxSizing: "border-box" as const, outline: "none" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: D.textMuted, marginBottom: 3 }}>Mileage (km/L)</div>
                    <input type="number" value={fuelMileage} onChange={e => setFuelMileage(parseFloat(e.target.value) || 1)}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: 7, border: `1px solid rgba(245,158,11,0.3)`, fontSize: 12, background: D.surface, color: D.text, boxSizing: "border-box" as const, outline: "none" }} />
                  </div>
                </div>
              </div>
            )}

            {/* Route selector */}
            {routes.length > 1 && (
              <div style={{ padding: "8px 14px", borderBottom: `1px solid ${D.border}`, display: "flex", gap: 6 }}>
                {routes.map((rt, i) => (
                  <button key={i} onClick={() => setSelRoute(i)}
                    style={{ flex: 1, padding: "7px 6px", background: selRoute === i ? D.primaryBg : D.surface, border: `1.5px solid ${selRoute === i ? D.primary : D.border}`, borderRadius: 10, cursor: "pointer", fontSize: 10, fontWeight: 700, color: selRoute === i ? "#60a5fa" : D.textMuted, lineHeight: 1.4, textAlign: "center" as const }}>
                    {i === 0 ? "🏆 Shortest" : "🔄 Alternative"}<br />
                    <span style={{ fontWeight: 400, fontSize: 9 }}>{rt.distKm.toFixed(1)}km · {fmtEta(rt.durationMin)}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Bus info */}
            {mode === "bus" && (
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: D.textDim, letterSpacing: "0.1em", marginBottom: 8 }}>🚌 BMTC BUS ROUTES</div>
                {busRoutesFound.length === 0 && <div style={{ fontSize: 11, color: D.textMuted }}>No matching routes for this area.</div>}
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 10 }}>
                  {busRoutesFound.map((rt, i) => (
                    <div key={i} style={{ padding: "4px 10px", background: D.surfaceTop, border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, color: "#c4b5fd" }}>{rt.number}</div>
                  ))}
                </div>
                {busRoutesFound.slice(0, 3).map((rt, i) => (
                  <div key={i} style={{ padding: "6px 10px", background: "rgba(139,92,246,0.08)", borderRadius: 8, marginBottom: 5, border: `1px solid rgba(139,92,246,0.15)` }}>
                    <div style={{ fontSize: 11, color: D.text, fontWeight: 600 }}>{rt.from} → {rt.to}</div>
                    <div style={{ fontSize: 10, color: "#a78bfa" }}>via {rt.via.join(" · ")}</div>
                  </div>
                ))}
                {busStops.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: D.textDim, marginBottom: 5 }}>NEAREST BUS STOPS</div>
                    {busStops.slice(0, 4).map((s, i) => (
                      <div key={i} style={{ fontSize: 11, color: D.textMuted, padding: "3px 0", display: "flex", gap: 6 }}>
                        <span>🚏</span><span>{s.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Places on the way — with custom search */}
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${D.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: D.textDim, letterSpacing: "0.1em", marginBottom: 8 }}>🗺 PLACES ON THE WAY</div>
              {/* Custom search */}
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <input
                  value={onWayCustom}
                  onChange={e => setOnWayCustom(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && onWayCustom.trim()) doOnTheWay(onWayCustom.trim(), true); }}
                  placeholder="Cafe, temple, mall, metro…"
                  style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: `1px solid ${D.border}`, fontSize: 11, background: D.surface, color: D.text, outline: "none", fontFamily: "inherit" }}
                />
                <button onClick={() => onWayCustom.trim() && doOnTheWay(onWayCustom.trim(), true)}
                  style={{ padding: "7px 12px", background: D.primary, border: "none", borderRadius: 8, color: "#fff", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>→</button>
              </div>
              {/* Category chips */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                {CATS.slice(0, 8).map(cat => (
                  <button key={cat.id} onClick={() => doOnTheWay(cat.id)}
                    style={{ padding: "4px 10px", background: activeOnWayCat === cat.id ? D.primaryBg : D.surface, border: `1px solid ${activeOnWayCat === cat.id ? D.primary : D.border}`, borderRadius: 14, cursor: "pointer", fontSize: 10, color: activeOnWayCat === cat.id ? "#60a5fa" : D.textMuted, fontWeight: 600 }}>
                    {cat.icon} {cat.label}
                  </button>
                ))}
              </div>
              {onWayLoading && <div style={{ fontSize: 11, color: D.textMuted, marginTop: 8, textAlign: "center" }}>Searching along route…</div>}
              {!onWayLoading && activeOnWayCat && onTheWay.length === 0 && (
                <div style={{ fontSize: 11, color: D.textMuted, marginTop: 6 }}>Nothing found along this route.</div>
              )}
              {onTheWay.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 130, overflowY: "auto" }}>
                  {onTheWay.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${D.border}` }}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{CAT_ICONS[p.type] || "📍"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: D.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                        {p.address && <div style={{ fontSize: 9, color: D.textDim }}>{p.address}</div>}
                      </div>
                      <button onClick={() => setSavePlaceTarget(p)} style={{ padding: "2px 6px", background: "rgba(245,158,11,0.1)", border: "none", borderRadius: 5, color: "#fbbf24", fontSize: 10, cursor: "pointer", flexShrink: 0 }}>⭐</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Step by step */}
            <button onClick={() => setShowSteps(!showSteps)}
              style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", color: D.textMuted, fontSize: 12, fontWeight: 600, borderBottom: showSteps ? `1px solid ${D.border}` : "none" }}>
              <span>🗺 Step-by-step ({route.steps.length} steps)</span>
              <span style={{ transition: "transform 0.2s", display: "inline-block", transform: showSteps ? "rotate(180deg)" : "none" }}>▾</span>
            </button>

            {showSteps && (
              <div style={{ borderBottom: `1px solid ${D.border}` }}>
                {route.steps.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 14px", borderBottom: i < route.steps.length - 1 ? `1px solid ${D.border}` : "none", background: i % 2 === 0 ? "transparent" : D.surface }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: s.text.toLowerCase().includes("arrive") ? "rgba(239,68,68,0.15)" : D.primaryBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 11, color: s.text.toLowerCase().includes("arrive") ? "#f87171" : "#60a5fa" }}>
                      {stepIcon(s.text)}
                    </div>
                    <span style={{ flex: 1, fontSize: 11, color: D.textMuted, lineHeight: 1.5 }}>{s.text}</span>
                    <span style={{ fontSize: 10, color: D.textDim, flexShrink: 0, marginTop: 3 }}>
                      {s.distM >= 1000 ? `${(s.distM / 1000).toFixed(1)}km` : `${s.distM}m`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ height: 20 }} />
          </div>
        )}
      </div>

      {/* ════ TOP HEADER BAR ════ */}
      <header style={{ position: "absolute", top: 0, left: 72, right: 0, height: 68, zIndex: 450, background: "rgba(10,10,12,0.92)", backdropFilter: "blur(16px)", borderBottom: `1px solid ${D.border}`, display: "flex", alignItems: "center", padding: "0 20px", gap: 16 }}>
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: D.textDim, letterSpacing: "0.12em", marginBottom: 2 }}>PROJECT</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: D.text, letterSpacing: "-0.01em" }}>Bengaluru Smart Route Finder</div>
        </div>

        <div style={{ flex: 1, display: "flex", alignItems: "center", background: D.surface, borderRadius: 14, border: `1px solid ${D.border}`, height: 46, padding: "0 16px", gap: 12, minWidth: 0 }}>
          {/* FROM */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            <AutoInput value={fromTxt} placeholder="From" dot="#10b981"
              onChange={v => { setFromTxt(v); if (!v) setFromLoc(null); }}
              onSelect={l => { setFromLoc(l); setFromTxt(l.label); }}
              savedPlaces={savedPlaces} recents={recents}
            />
          </div>
          <button onClick={() => gps("from", l => { setFromLoc(l); setFromTxt(l.label); })}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: D.textMuted, flexShrink: 0, padding: 0 }} title="Current location">
            {gpsing === "from" ? "⌛" : "📍"}
          </button>
          <button onClick={() => setPickFor(pickFor === "from" ? null : "from")}
            style={{ background: pickFor === "from" ? D.primaryBg : "none", border: "none", cursor: "pointer", fontSize: 14, color: pickFor === "from" ? "#60a5fa" : D.textMuted, flexShrink: 0, padding: "3px 6px", borderRadius: 6 }} title="Pick on map">🗺</button>

          <div style={{ width: 1, height: 24, background: D.border, flexShrink: 0 }} />
          <button onClick={swap} style={{ background: "none", border: "none", cursor: "pointer", color: D.textMuted, fontSize: 16, flexShrink: 0, padding: 0 }} title="Swap">⇅</button>
          <div style={{ width: 1, height: 24, background: D.border, flexShrink: 0 }} />

          {/* TO */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            <AutoInput value={toTxt} placeholder="Destination" dot="#ef4444"
              onChange={v => { setToTxt(v); if (!v) setToLoc(null); }}
              onSelect={l => { setToLoc(l); setToTxt(l.label); }}
              savedPlaces={savedPlaces} recents={recents}
            />
          </div>
          <button onClick={() => gps("to", l => { setToLoc(l); setToTxt(l.label); })}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: D.textMuted, flexShrink: 0, padding: 0 }}>
            {gpsing === "to" ? "⌛" : "📍"}
          </button>
          <button onClick={() => setPickFor(pickFor === "to" ? null : "to")}
            style={{ background: pickFor === "to" ? "rgba(239,68,68,0.1)" : "none", border: "none", cursor: "pointer", fontSize: 14, color: pickFor === "to" ? "#f87171" : D.textMuted, flexShrink: 0, padding: "3px 6px", borderRadius: 6 }}>🗺</button>

          <button onClick={getDirections} disabled={loading}
            style={{ background: loading ? D.surfaceHi : D.primary, border: "none", borderRadius: 10, padding: "8px 18px", color: loading ? D.textDim : "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", flexShrink: 0, boxShadow: loading ? "none" : "0 2px 12px rgba(37,99,235,0.4)", whiteSpace: "nowrap" as const }}>
            {loading ? "⏳" : "Find Route"}
          </button>
        </div>

        {/* Add stop / stop controls */}
        {!showStop ? (
          <button onClick={() => setShowStop(true)} title="Add a stop"
            style={{ background: D.surface, border: `1px solid ${D.border}`, borderRadius: 10, padding: "8px 12px", color: D.textMuted, fontSize: 12, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" as const }}>
            + Stop
          </button>
        ) : null}

        {/* Clear all */}
        {(fromTxt || toTxt || routes.length > 0) && (
          <button onClick={clear} title="Clear everything"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, padding: "8px 12px", color: "#f87171", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" as const }}>
            Clear
          </button>
        )}
      </header>

      {/* Add stop row */}
      {showStop && (
        <div style={{ position: "absolute", top: 68, left: 72, right: 0, zIndex: 440, background: "rgba(10,10,12,0.95)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${D.border}`, padding: "8px 20px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#fb923c", flexShrink: 0, fontWeight: 700 }}>🟠 Stop:</span>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: D.surface, borderRadius: 10, padding: "6px 12px", border: `1px solid rgba(249,115,22,0.3)` }}>
            <AutoInput value={stopTxt} placeholder="Add a stop (landmark, address…)" dot="#f97316"
              onChange={v => { setStopTxt(v); if (!v) setStopLoc(null); }}
              onSelect={l => { setStopLoc(l); setStopTxt(l.label); }}
            />
          </div>
          <button onClick={() => setPickFor("stop")} style={{ background: pickFor === "stop" ? "rgba(249,115,22,0.1)" : D.surface, border: `1px solid ${pickFor === "stop" ? "rgba(249,115,22,0.4)" : D.border}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 13, color: "#fb923c" }}>🗺</button>
          <button onClick={() => { setShowStop(false); setStopTxt(""); setStopLoc(null); setPickFor(null); if (routes.length > 0) getDirections(); }} style={{ background: "rgba(239,68,68,0.1)", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 13, color: "#f87171" }}>✕</button>
        </div>
      )}

      {/* ════ COMMUTE MODE PILL ════ */}
      {routes.length > 0 && (
        <div style={{ position: "absolute", top: showStop ? 116 : 82, left: "50%", transform: "translateX(-50%)", zIndex: 430 }}>
          <div style={{ ...glass, borderRadius: 20, padding: "4px", display: "flex", gap: 4, boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
            {MODES.map(m => (
              <button key={m.id} onClick={() => { setMode(m.id); setRoutes([]); setBusStops([]); setTimeout(getDirections, 50); }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 14, background: mode === m.id ? m.color : "transparent", border: "none", cursor: "pointer", color: mode === m.id ? "#fff" : D.textMuted, fontWeight: mode === m.id ? 700 : 400, fontSize: 13, transition: "all 0.15s", boxShadow: mode === m.id ? `0 4px 16px ${m.color}55` : "none" }}>
                <span>{m.icon}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ════ ROUTE SUMMARY CARD (bottom right) — single instance, only shown when no side panel open ════ */}
      {route && !panelOpen && (
        <div style={{ position: "absolute", bottom: 24, right: 24, zIndex: 420, width: 300 }}>
          <div style={{ ...glass, borderRadius: 20, padding: 20, boxShadow: "0 24px 64px rgba(0,0,0,0.7)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span>{modeObj.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: D.text }}>Route Summary</span>
              </div>
              <span style={{ background: "rgba(37,99,235,0.2)", color: "#60a5fa", fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 20 }}>LIVE</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: fuelCost ? "1fr 1fr 1fr" : "1fr 1fr", gap: 8, marginBottom: 14 }}>
              <div style={{ background: D.surface, borderRadius: 12, padding: "8px 6px", textAlign: "center" as const }}>
                <div style={{ fontSize: 9, color: D.textDim, fontWeight: 700 }}>DISTANCE</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: D.text }}>{route.distKm.toFixed(1)}<span style={{ fontSize: 10, color: D.textMuted }}> km</span></div>
              </div>
              <div style={{ background: D.surface, borderRadius: 12, padding: "8px 6px", textAlign: "center" as const }}>
                <div style={{ fontSize: 9, color: D.textDim, fontWeight: 700 }}>ETA</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#34d399" }}>{fmtEta(trafficEta)}</div>
              </div>
              {fuelCost && (
                <div style={{ background: D.surface, borderRadius: 12, padding: "8px 6px", textAlign: "center" as const }}>
                  <div style={{ fontSize: 9, color: D.textDim, fontWeight: 700 }}>FUEL</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#fb923c" }}>₹{fuelCost.low}–{fuelCost.high}</div>
                </div>
              )}
            </div>
            <button onClick={() => setPanel("result")}
              style={{ width: "100%", padding: "10px 0", background: D.primary, border: "none", borderRadius: 12, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 16px rgba(37,99,235,0.4)` }}>
              View Full Directions →
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {err && !route && (
        <div style={{ position: "absolute", bottom: 24, right: 24, zIndex: 420, ...glass, borderRadius: 14, padding: "12px 16px", maxWidth: 300, fontSize: 12, color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }}>
          ⚠️ {err}
        </div>
      )}

      {/* ════ ZOOM CONTROLS ════ */}
      <div style={{ position: "absolute", bottom: 24, left: panelOpen ? 428 : 92, zIndex: 420, display: "flex", flexDirection: "column", gap: 8, transition: "left 0.25s" }}>
        <div style={{ ...glass, borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <button onClick={() => { const m = document.querySelector(".leaflet-control-zoom-in") as HTMLElement; m?.click(); }}
            style={{ padding: "10px 12px", background: "none", border: "none", cursor: "pointer", color: D.textMuted, fontSize: 18, borderBottom: `1px solid ${D.border}` }}>+</button>
          <button onClick={() => { const m = document.querySelector(".leaflet-control-zoom-out") as HTMLElement; m?.click(); }}
            style={{ padding: "10px 12px", background: "none", border: "none", cursor: "pointer", color: D.textMuted, fontSize: 18 }}>−</button>
        </div>
      </div>

      {/* GPS toast */}
      {gpsing && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 2000, ...glass, color: D.text, padding: "9px 22px", borderRadius: 24, fontSize: 12, fontWeight: 500, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          ⌛ Getting your location…
        </div>
      )}

      {/* Modals */}
      {savePlaceTarget && (
        <SaveModal
          onSave={(type, name) => { persistSaved(type, { coords: savePlaceTarget.coords, label: savePlaceTarget.name }, name); setSavePlaceTarget(null); }}
          onClose={() => setSavePlaceTarget(null)}
        />
      )}
      {setLocModal && (
        <SetLocModal
          title={`Set ${setLocModal === "home" ? "🏠 Home" : setLocModal === "work" ? "💼 Work" : "⭐ Custom"} location`}
          onClose={() => setSetLocModal(null)}
          onGPS={() => { setSetLocModal(null); gps(setLocModal, l => persistSaved(setLocModal!, l)); }}
          onMap={() => { if (setLocModal !== "custom") setPickFor(setLocModal); setSetLocModal(null); }}
          onManual={async q => { const r = await geocode(q); if (r) persistSaved(setLocModal!, r); setSetLocModal(null); }}
        />
      )}
    </div>
  );
}
