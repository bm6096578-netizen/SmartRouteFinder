import { useState, useRef, useCallback, useEffect } from "react";
import {
  MapContainer, TileLayer, Marker, Popup,
  useMap, useMapEvents, Polyline,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const BENGALURU: [number, number] = [12.9716, 77.5946];

// ── OSRM ─────────────────────────────────────────────────────────────────
interface OsrmRoute {
  coords: [number, number][];
  distKm: number;
  durationMin: number;
  steps: { text: string; distM: number; coords: [number, number] }[];
}

async function fetchRoutes(from: [number, number], to: [number, number], profile: string): Promise<OsrmRoute[]> {
  try {
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
  if (type === "arrive")   return "Arrive at destination";
  if (type === "depart")   return `Head ${mod} on ${name}`.trim();
  if (type === "turn")     return `Turn ${mod}${name ? " onto " + name : ""}`.trim();
  if (type === "continue") return `Continue on ${name}`.trim();
  if (type === "roundabout") return `Enter roundabout, take exit onto ${name}`.trim();
  if (type === "merge")    return `Merge ${mod} onto ${name}`.trim();
  if (type === "fork")     return `Keep ${mod} onto ${name}`.trim();
  return `${type} ${mod} ${name}`.trim() || "Continue";
}

// ── Nominatim ─────────────────────────────────────────────────────────────
interface Loc { coords: [number, number]; label: string; }

async function geocode(q: string): Promise<Loc | null> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + " Bengaluru")}&format=json&limit=1&countrycodes=in`,
      { headers: { "Accept-Language": "en" } }
    );
    const d = await r.json();
    if (!d.length) return null;
    return { coords: [parseFloat(d[0].lat), parseFloat(d[0].lon)], label: shortLabel(d[0].display_name) };
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
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + " Bengaluru")}&format=json&limit=7&countrycodes=in`,
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

// ── Overpass ──────────────────────────────────────────────────────────────
interface NearbyPlace { id: number; coords: [number, number]; name: string; type: string; address: string; }

const OVERPASS_QUERIES: Record<string, string> = {
  food:      `node["amenity"~"restaurant|cafe|fast_food|food_court"]`,
  hospital:  `node["amenity"~"hospital|clinic|pharmacy|doctors"]`,
  atm:       `node["amenity"="atm"]`,
  hotel:     `node["tourism"~"hotel|guest_house|hostel|motel"]`,
  police:    `node["amenity"="police"]`,
  fuel:      `node["amenity"="fuel"]`,
  busstop:   `node["highway"="bus_stop"]`,
  college:   `node["amenity"~"university|college|school"]`,
};

async function overpassQuery(query: string): Promise<any[]> {
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.elements || [];
  } catch { return []; }
}

async function fetchNearby(lat: number, lng: number, category: string, radius = 1500): Promise<NearbyPlace[]> {
  const q = OVERPASS_QUERIES[category] || `node["amenity"="${category}"]["name"]`;
  const query = `[out:json][timeout:15];${q}(around:${radius},${lat},${lng});out body 25;`;
  const els = await overpassQuery(query);
  return els.filter(e => e.lat && e.lon).map((e: any) => ({
    id: e.id,
    coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || CAT_LABELS[category] || category,
    type: category,
    address: [e.tags?.["addr:street"], e.tags?.["addr:housenumber"]].filter(Boolean).join(" ") || "",
  }));
}

async function fetchNearbyFreeText(lat: number, lng: number, text: string, radius = 2000): Promise<NearbyPlace[]> {
  // Try Nominatim search near location
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text + " Bengaluru")}&format=json&limit=15&countrycodes=in`,
      { headers: { "Accept-Language": "en" } }
    );
    const d = await r.json();
    return d
      .filter((x: any) => {
        const dlat = parseFloat(x.lat) - lat;
        const dlng = parseFloat(x.lon) - lng;
        return Math.sqrt(dlat * dlat + dlng * dlng) * 111000 < radius;
      })
      .map((x: any, i: number) => ({
        id: i,
        coords: [parseFloat(x.lat), parseFloat(x.lon)] as [number, number],
        name: shortLabel(x.display_name),
        type: "search",
        address: "",
      }));
  } catch { return []; }
}

async function fetchOnTheWay(routeCoords: [number, number][], category: string): Promise<NearbyPlace[]> {
  const step = Math.max(1, Math.floor(routeCoords.length / 8));
  const samples = routeCoords.filter((_, i) => i % step === 0).slice(0, 8);
  const q = OVERPASS_QUERIES[category] || `node["amenity"="${category}"]`;
  
  const query = `[out:json][timeout:20];(${samples.map(c => `${q}(around:400,${c[0]},${c[1]});`).join("")});out body 20;`;
  const els = await overpassQuery(query);
  // deduplicate by id
  const seen = new Set<number>();
  return els.filter(e => e.lat && e.lon && !seen.has(e.id) && seen.add(e.id)).slice(0, 15).map((e: any) => ({
    id: e.id,
    coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || CAT_LABELS[category] || category,
    type: category,
    address: e.tags?.["addr:street"] || "",
  }));
}

async function fetchBusStops(lat: number, lng: number, radius = 800): Promise<NearbyPlace[]> {
  const query = `[out:json][timeout:10];node["highway"="bus_stop"](around:${radius},${lat},${lng});out body 10;`;
  const els = await overpassQuery(query);
  return els.filter(e => e.lat && e.lon).map((e: any) => ({
    id: e.id,
    coords: [e.lat, e.lon] as [number, number],
    name: e.tags?.name || e.tags?.["name:en"] || "Bus Stop",
    type: "busstop",
    address: e.tags?.ref || "",
  }));
}

// ── BMTC data ─────────────────────────────────────────────────────────────
const BMTC_ROUTES = [
  { number: "500C", from: "Kempegowda BS", to: "Whitefield",     via: ["Majestic", "Indiranagar", "Marathahalli"] },
  { number: "201R", from: "Kempegowda BS", to: "Electronic City",via: ["Jayanagar", "BTM Layout", "Silk Board"] },
  { number: "335E", from: "Kempegowda BS", to: "Hebbal",         via: ["Mekhri Circle", "Nagawara"] },
  { number: "G1",   from: "Kempegowda BS", to: "Bellandur",      via: ["Koramangala", "HSR Layout"] },
  { number: "401",  from: "Shivajinagar",  to: "Banashankari",   via: ["Majestic", "Jayanagar"] },
  { number: "500A", from: "Majestic",      to: "Marathahalli",   via: ["Indiranagar", "Domlur"] },
  { number: "356F", from: "Majestic",      to: "Yelahanka",      via: ["Hebbal", "Kogilu"] },
  { number: "333",  from: "Majestic",      to: "Electronic City",via: ["Lalbagh", "Jayanagar", "BTM", "Silk Board"] },
  { number: "600",  from: "Kempegowda BS", to: "Mysuru Road",    via: ["Rajajinagar", "Vijayanagar"] },
  { number: "150",  from: "Shivajinagar",  to: "Koramangala",    via: ["Richmond Circle"] },
  { number: "G5",   from: "Shivajinagar",  to: "Manyata Tech",   via: ["Hebbal"] },
  { number: "400",  from: "Kempegowda BS", to: "Domlur",         via: ["MG Road", "Trinity"] },
  { number: "201",  from: "Jayanagar",     to: "Whitefield",     via: ["Koramangala", "Indiranagar", "Marathahalli"] },
  { number: "C9",   from: "Shivajinagar",  to: "Kengeri",        via: ["Majestic", "Vijayanagar"] },
  { number: "V1",   from: "Kempegowda BS", to: "Vidhan Soudha",  via: ["Cubbon Park"] },
];

function findBusRoutes(fromLabel: string, toLabel: string) {
  const words = (fromLabel + " " + toLabel).toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);
  return BMTC_ROUTES.filter(rt => {
    const text = [rt.from, rt.to, ...rt.via].join(" ").toLowerCase();
    return words.some(w => text.includes(w));
  }).slice(0, 5);
}

// ── Types & constants ─────────────────────────────────────────────────────
type Mode = "car" | "bike" | "walk" | "bus";
type SavedType = "home" | "work" | "custom";
interface SavedPlace { label: string; coords: [number, number]; type: SavedType; name?: string; }

const MODES: { id: Mode; icon: string; label: string; color: string; osrm: string }[] = [
  { id: "car",  icon: "🚗", label: "Drive", color: "#1a73e8", osrm: "driving" },
  { id: "bike", icon: "🏍", label: "Bike",  color: "#10b981", osrm: "driving" },
  { id: "walk", icon: "🚶", label: "Walk",  color: "#f59e0b", osrm: "foot"    },
  { id: "bus",  icon: "🚌", label: "Bus",   color: "#7c3aed", osrm: "driving" },
];

const CATEGORIES = [
  { id: "food",     icon: "🍽", label: "Food"     },
  { id: "hospital", icon: "🏥", label: "Hospital" },
  { id: "atm",      icon: "🏧", label: "ATM"      },
  { id: "hotel",    icon: "🏨", label: "Hotel"    },
  { id: "police",   icon: "👮", label: "Police"   },
  { id: "fuel",     icon: "⛽", label: "Fuel"     },
  { id: "college",  icon: "🎓", label: "College"  },
];

const CAT_LABELS: Record<string, string> = {
  food: "Restaurant", hospital: "Hospital", atm: "ATM",
  hotel: "Hotel", police: "Police", fuel: "Fuel Station",
  busstop: "Bus Stop", college: "College", search: "Place",
};

const CAT_COLORS: Record<string, string> = {
  food: "#ef4444", hospital: "#3b82f6", atm: "#10b981",
  hotel: "#f59e0b", police: "#1e40af", fuel: "#ea580c",
  busstop: "#7c3aed", college: "#0891b2", search: "#64748b",
};

const CAT_ICONS: Record<string, string> = {
  food: "🍽", hospital: "🏥", atm: "🏧", hotel: "🏨",
  police: "👮", fuel: "⛽", busstop: "🚌", college: "🎓", search: "📍",
};

// ── Pin icons ─────────────────────────────────────────────────────────────
function makePin(fill: string, letter: string) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:28px;height:40px;filter:drop-shadow(0 2px 5px rgba(0,0,0,0.4))">
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
    html: `<div style="background:${color};border:2.5px solid white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${emoji}</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

function makeWaypointDot(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="background:${color};border:2px solid white;border-radius:50%;width:10px;height:10px;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>`,
    iconSize: [10, 10], iconAnchor: [5, 5],
  });
}

const PIN_A = makePin("#10b981", "A");
const PIN_B = makePin("#f43f5e", "B");
const PIN_S = makePin("#f97316", "S");

// ── Map helpers ───────────────────────────────────────────────────────────
function ClickHandler({ active, onPick }: { active: boolean; onPick: (ll: L.LatLng) => void }) {
  const map = useMap();
  useEffect(() => { map.getContainer().style.cursor = active ? "crosshair" : ""; }, [active, map]);
  useMapEvents({ click(e) { if (active) onPick(e.latlng); } });
  return null;
}

function FlyTo({ from, to }: { from: Loc | null; to: Loc | null }) {
  const map = useMap();
  useEffect(() => {
    if (from && to) map.fitBounds(L.latLngBounds([from.coords, to.coords]), { padding: [80, 80], maxZoom: 15 });
    else if (from)  map.flyTo(from.coords, 15, { duration: 1 });
    else if (to)    map.flyTo(to.coords,   15, { duration: 1 });
  // eslint-disable-next-line
  }, [from?.coords.toString(), to?.coords.toString()]);
  return null;
}

function LiveDot({ pos }: { pos: [number, number] | null }) {
  const map = useMap();
  const layers = useRef<L.Layer[]>([]);
  useEffect(() => {
    layers.current.forEach(l => { try { map.removeLayer(l); } catch {} });
    layers.current = [];
    if (!pos) return;
    const pulse = L.circleMarker(pos, { radius: 18, fillColor: "#1a73e8", fillOpacity: 0.15, color: "#1a73e8", weight: 1, opacity: 0.35 }).addTo(map);
    const dot   = L.circleMarker(pos, { radius: 8,  fillColor: "#1a73e8", fillOpacity: 1,    color: "#fff",    weight: 2.5 }).addTo(map);
    layers.current = [pulse, dot];
    return () => { layers.current.forEach(l => { try { map.removeLayer(l); } catch {} }); };
  // eslint-disable-next-line
  }, [pos?.toString()]);
  return null;
}

// ── AutoInput ─────────────────────────────────────────────────────────────
function AutoInput({ value, placeholder, dot, onChange, onSelect, savedPlaces, recents }: {
  value: string; placeholder: string; dot: string;
  onChange: (v: string) => void; onSelect: (l: Loc) => void;
  savedPlaces?: SavedPlace[]; recents?: Loc[];
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

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <input value={value} onChange={e => change(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => { setOpen(false); setFocus(false); }, 200)}
          placeholder={placeholder}
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#1e293b", fontSize: 13, fontFamily: "inherit", minWidth: 0 }}
        />
        {value && (
          <button onMouseDown={() => { onChange(""); setList([]); setOpen(false); }}
            style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 16, padding: 0, flexShrink: 0 }}>×</button>
        )}
      </div>

      {showQuick && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: -14, right: -14, zIndex: 99999, background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden" }}>
          {savedPlaces && savedPlaces.length > 0 && (
            <>
              <div style={{ padding: "7px 12px 3px", fontSize: 9, fontWeight: 800, color: "#94a3b8", letterSpacing: "0.1em" }}>SAVED PLACES</div>
              {savedPlaces.map((p, i) => (
                <div key={i} onMouseDown={() => { onSelect({ coords: p.coords, label: p.label }); onChange(p.label); }}
                  style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 16 }}>{p.type === "home" ? "🏠" : p.type === "work" ? "💼" : "⭐"}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}>{p.name || (p.type === "home" ? "Home" : p.type === "work" ? "Work" : "Saved")}</div>
                    <div style={{ fontSize: 10, color: "#94a3b8" }}>{p.label.split(",")[0]}</div>
                  </div>
                </div>
              ))}
            </>
          )}
          {recents && recents.length > 0 && (
            <>
              <div style={{ padding: "7px 12px 3px", fontSize: 9, fontWeight: 800, color: "#94a3b8", letterSpacing: "0.1em", borderTop: savedPlaces?.length ? "1px solid #f1f5f9" : "none" }}>RECENT</div>
              {recents.slice(0, 4).map((r, i) => (
                <div key={i} onMouseDown={() => { onSelect(r); onChange(r.label); }}
                  style={{ padding: "7px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 12, color: "#334155" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>🕐</span>
                  <span>{r.label.split(",").slice(0, 2).join(",")}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {open && list.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: -14, right: -14, zIndex: 99999, background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden" }}>
          {list.map((s, i) => (
            <div key={i} onMouseDown={() => { onSelect(s); onChange(s.label); setOpen(false); }}
              style={{ padding: "9px 12px", fontSize: 12, color: "#334155", cursor: "pointer", display: "flex", gap: 8, borderBottom: i < list.length - 1 ? "1px solid #f1f5f9" : "none" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ color: "#94a3b8" }}>📍</span>
              <span style={{ lineHeight: 1.4 }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function stepIcon(t: string) {
  const s = t.toLowerCase();
  if (s.includes("left"))       return "↰";
  if (s.includes("right"))      return "↱";
  if (s.includes("arrive"))     return "🏁";
  if (s.includes("roundabout")) return "↻";
  if (s.includes("merge"))      return "⤵";
  if (s.includes("ramp") || s.includes("exit")) return "↗";
  if (s.includes("head") || s.includes("depart")) return "➤";
  return "↑";
}

function fmtEta(m: number) { return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; }

// ── Set location modal ─────────────────────────────────────────────────────
function SetLocModal({ title, onClose, onGPS, onMap, onManual }: {
  title: string; onClose: () => void;
  onGPS: () => void; onMap: () => void; onManual: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 22, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1e293b", marginBottom: 14 }}>{title}</div>
        <button onClick={onGPS} style={{ width: "100%", padding: 11, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#1d4ed8", fontWeight: 600, marginBottom: 8, textAlign: "left" as const }}>
          📍 Use my current location
        </button>
        <button onClick={onMap} style={{ width: "100%", padding: 11, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#16a34a", fontWeight: 600, marginBottom: 12, textAlign: "left" as const }}>
          🗺 Pick on map
        </button>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 5 }}>Or type address:</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search address…"
            onKeyDown={e => e.key === "Enter" && q.trim() && onManual(q)}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, outline: "none" }} />
          <button onClick={() => q.trim() && onManual(q)} style={{ padding: "8px 12px", background: "#1a73e8", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>→</button>
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 10, padding: 8, background: "none", border: "none", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Save place modal ───────────────────────────────────────────────────────
function SaveModal({ onSave, onClose }: { onSave: (type: SavedType, name?: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 22, width: 280, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1e293b", marginBottom: 14 }}>Save this place as</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <button onClick={() => onSave("home")} style={{ flex: 1, padding: 10, background: "#f0fdf4", border: "1.5px solid #bbf7d0", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#16a34a", fontWeight: 700 }}>🏠 Home</button>
          <button onClick={() => onSave("work")} style={{ flex: 1, padding: 10, background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 10, cursor: "pointer", fontSize: 12, color: "#d97706", fontWeight: 700 }}>💼 Work</button>
        </div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Custom name (e.g. Gym, College…)"
          style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, marginBottom: 8, boxSizing: "border-box" as const, outline: "none" }} />
        <button onClick={() => name.trim() && onSave("custom", name.trim())}
          style={{ width: "100%", padding: 9, background: name.trim() ? "#1a73e8" : "#e2e8f0", border: "none", borderRadius: 8, color: name.trim() ? "#fff" : "#94a3b8", fontSize: 12, fontWeight: 700, cursor: name.trim() ? "pointer" : "not-allowed" }}>
          ⭐ Save with custom name
        </button>
        <button onClick={onClose} style={{ width: "100%", marginTop: 8, padding: 8, background: "none", border: "none", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [fromTxt,  setFromTxt]  = useState("");
  const [toTxt,    setToTxt]    = useState("");
  const [fromLoc,  setFromLoc]  = useState<Loc | null>(null);
  const [toLoc,    setToLoc]    = useState<Loc | null>(null);
  const [stopTxt,  setStopTxt]  = useState("");
  const [stopLoc,  setStopLoc]  = useState<Loc | null>(null);
  const [showStop, setShowStop] = useState(false);
  const [mode,     setMode]     = useState<Mode>("car");
  const [pickFor,  setPickFor]  = useState<"from" | "to" | "stop" | "home" | "work" | null>(null);
  const [routes,   setRoutes]   = useState<OsrmRoute[]>([]);
  const [selRoute, setSelRoute] = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [gpsing,   setGpsing]   = useState<string | null>(null);
  const [err,      setErr]      = useState("");
  const [myPos,    setMyPos]    = useState<[number, number] | null>(null);
  const [showSteps,setShowSteps]= useState(false);
  const [panel,    setPanel]    = useState<"search" | "result" | "nearby" | "saved" | "recents">("search");

  // Nearby state
  const [nearbyPlaces,   setNearbyPlaces]   = useState<NearbyPlace[]>([]);
  const [nearbyLoading,  setNearbyLoading]  = useState(false);
  const [activeCat,      setActiveCat]      = useState<string | null>(null);
  const [nearbySearch,   setNearbySearch]   = useState("");
  const [onTheWay,       setOnTheWay]       = useState<NearbyPlace[]>([]);
  const [onWayLoading,   setOnWayLoading]   = useState(false);
  const [activeOnWayCat, setActiveOnWayCat] = useState<string | null>(null);
  const [busStops,       setBusStops]       = useState<NearbyPlace[]>([]);

  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>(() => {
    try { return JSON.parse(localStorage.getItem("srfSaved") || "[]"); } catch { return []; }
  });
  const [recents, setRecents] = useState<Loc[]>(() => {
    try { return JSON.parse(localStorage.getItem("srfRecents") || "[]"); } catch { return []; }
  });

  const [fuelPrice,    setFuelPrice]    = useState(103.5);
  const [fuelMileage,  setFuelMileage]  = useState(15);
  const [showFuelEdit, setShowFuelEdit] = useState(false);
  const [busRoutes,    setBusRoutes]    = useState<typeof BMTC_ROUTES>([]);
  const [savePlaceTarget, setSavePlaceTarget] = useState<NearbyPlace | null>(null);
  const [setLocModal,     setSetLocModal]     = useState<"home" | "work" | null>(null);

  // Live location
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      pos => setMyPos([pos.coords.latitude, pos.coords.longitude]),
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // GPS one shot
  function gps(field: string, onDone: (l: Loc) => void) {
    if (!navigator.geolocation) { setErr("Geolocation not supported."); return; }
    setGpsing(field); setErr("");
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        const label = await reverseGeocode(coords[0], coords[1]);
        onDone({ coords, label });
        setGpsing(null);
      },
      e => {
        const m: Record<number, string> = { 1: "Location access denied. Please allow in browser settings.", 2: "Location unavailable.", 3: "Timed out — try again." };
        setErr(m[e.code] || "GPS error."); setGpsing(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // Map click
  const handleMapClick = useCallback(async (ll: L.LatLng) => {
    const coords: [number, number] = [ll.lat, ll.lng];
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

  // Get directions
  async function getDirections() {
    setErr(""); setRoutes([]); setSelRoute(0); setShowSteps(false);
    // Clear all map overlays from previous search
    setNearbyPlaces([]); setActiveCat(null);
    setOnTheWay([]); setActiveOnWayCat(null);
    setBusStops([]);

    if (!fromTxt.trim() || !toTxt.trim()) { setErr("Enter both From and To."); return; }
    setLoading(true);

    let fLoc = fromLoc, tLoc = toLoc;
    if (!fLoc) { const r = await geocode(fromTxt); if (!r) { setErr(`Not found: "${fromTxt}"`); setLoading(false); return; } fLoc = r; setFromLoc(r); setFromTxt(r.label); }
    if (!tLoc) { const r = await geocode(toTxt);   if (!r) { setErr(`Not found: "${toTxt}"`);   setLoading(false); return; } tLoc = r; setToLoc(r);   setToTxt(r.label);   }

    const mObj = MODES.find(m => m.id === mode)!;
    const rts = await fetchRoutes(fLoc!.coords, tLoc!.coords, mObj.osrm);
    if (!rts.length) { setErr("No route found. Try different locations."); setLoading(false); return; }

    rts.sort((a, b) => a.distKm - b.distKm);
    setRoutes(rts); setSelRoute(0); setPanel("result");
    setBusRoutes(findBusRoutes(fLoc!.label, tLoc!.label));

    // Bus stops near route start if bus mode
    if (mode === "bus") {
      fetchBusStops(fLoc!.coords[0], fLoc!.coords[1]).then(stops => setBusStops(stops));
    }

    const newRecents = [fLoc!, tLoc!, ...recents.filter(r => r.label !== fLoc!.label && r.label !== tLoc!.label)].slice(0, 10);
    setRecents(newRecents);
    localStorage.setItem("srfRecents", JSON.stringify(newRecents));
    setLoading(false);
  }

  // Nearby search
  async function doNearbySearch(cat?: string, freeText?: string) {
    const center = myPos || fromLoc?.coords || BENGALURU;
    setNearbyLoading(true); setNearbyPlaces([]);
    if (cat) {
      setActiveCat(cat);
      const places = await fetchNearby(center[0], center[1], cat);
      setNearbyPlaces(places);
    } else if (freeText) {
      setActiveCat(null);
      const places = await fetchNearbyFreeText(center[0], center[1], freeText);
      setNearbyPlaces(places);
    }
    setNearbyLoading(false);
  }

  // On the way
  async function loadOnTheWay(cat: string) {
    if (!routes.length) return;
    if (activeOnWayCat === cat) { setActiveOnWayCat(null); setOnTheWay([]); return; }
    setActiveOnWayCat(cat); setOnWayLoading(true); setOnTheWay([]);
    const places = await fetchOnTheWay(routes[selRoute].coords, cat);
    setOnTheWay(places);
    setOnWayLoading(false);
  }

  function swap() { setFromTxt(toTxt); setToTxt(fromTxt); setFromLoc(toLoc); setToLoc(fromLoc); setRoutes([]); setSelRoute(0); }

  function clear() {
    setFromTxt(""); setToTxt(""); setStopTxt("");
    setFromLoc(null); setToLoc(null); setStopLoc(null);
    setRoutes([]); setSelRoute(0); setErr(""); setPickFor(null);
    setShowSteps(false); setShowStop(false);
    setNearbyPlaces([]); setActiveCat(null);
    setOnTheWay([]); setActiveOnWayCat(null);
    setBusStops([]); setBusRoutes([]);
    setPanel("search");
  }

  const route    = routes[selRoute];
  const modeObj  = MODES.find(m => m.id === mode)!;
  const fuelCost = route && mode !== "walk" ? {
    low:  Math.round((route.distKm / (fuelMileage * 1.1)) * fuelPrice),
    high: Math.round((route.distKm / (fuelMileage * 0.75)) * fuelPrice),
  } : null;
  const trafficEta = route
    ? (mode === "car" || mode === "bus" ? Math.round(route.durationMin * 1.6) : mode === "bike" ? Math.round(route.durationMin * 1.2) : route.durationMin)
    : 0;

  const waypointDots = route ? route.steps.filter((_, i) => i > 0 && i < route.steps.length - 1 && i % 4 === 0) : [];
  const allNearbyOnMap = [...nearbyPlaces, ...onTheWay];
  const panelOpen = panel !== "search" || routes.length > 0;

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>

      {/* ════ MAP ════ */}
      <MapContainer center={BENGALURU} zoom={13} style={{ width: "100%", height: "100%", zIndex: 1 }} zoomControl={false}>
        {/* OSM Standard tile — best landmark visibility */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
        />

        {/* Alternate route — dark grey dashed, behind */}
        {routes[1] && (
          <Polyline positions={routes[1].coords}
            pathOptions={{ color: "#475569", weight: 5, opacity: 0.55, dashArray: "10 7" }}
            eventHandlers={{ click: () => setSelRoute(1) }}
          />
        )}

        {/* Selected route — solid colored */}
        {route && (
          <Polyline positions={route.coords}
            pathOptions={{ color: modeObj.color, weight: 6, opacity: 0.95 }}
          />
        )}

        {/* Waypoint dots along route */}
        {waypointDots.map((step, i) => (
          <Marker key={`wp-${i}`} position={step.coords} icon={makeWaypointDot(modeObj.color)}>
            <Popup><div style={{ fontSize: 11, maxWidth: 160 }}>{step.text}</div></Popup>
          </Marker>
        ))}

        {/* Alternate label */}
        {routes[1] && selRoute === 0 && (
          <Marker
            position={routes[1].coords[Math.floor(routes[1].coords.length / 2)]}
            icon={L.divIcon({
              className: "",
              html: `<div style="background:#fff;border:1.5px solid #64748b;border-radius:8px;padding:3px 9px;font-size:10px;font-weight:700;color:#475569;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.15);cursor:pointer">Alt · ${fmtEta(routes[1].durationMin)}</div>`,
              iconSize: [90, 24], iconAnchor: [45, 12],
            })}
            eventHandlers={{ click: () => setSelRoute(1) }}
          />
        )}

        {/* A / B / Stop pins */}
        {fromLoc && <Marker position={fromLoc.coords} icon={PIN_A}><Popup><b>From:</b> {fromLoc.label}</Popup></Marker>}
        {toLoc   && <Marker position={toLoc.coords}   icon={PIN_B}><Popup><b>To:</b> {toLoc.label}</Popup></Marker>}
        {stopLoc && <Marker position={stopLoc.coords} icon={PIN_S}><Popup><b>Stop:</b> {stopLoc.label}</Popup></Marker>}

        {/* Nearby markers — colored dots */}
        {allNearbyOnMap.map(p => (
          <Marker key={`np-${p.id}-${p.type}`} position={p.coords}
            icon={makeNearbyPin(CAT_COLORS[p.type] || "#64748b", CAT_ICONS[p.type] || "📍")}>
            <Popup>
              <div style={{ fontSize: 12 }}>
                <b>{p.name}</b>
                {p.address && <div style={{ color: "#64748b", marginTop: 2 }}>{p.address}</div>}
                <button onClick={() => setSavePlaceTarget(p)} style={{ marginTop: 6, padding: "3px 8px", background: "#e8f0fe", border: "none", borderRadius: 5, color: "#1a73e8", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>⭐ Save</button>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Bus stops */}
        {busStops.map(p => (
          <Marker key={`bs-${p.id}`} position={p.coords} icon={makeNearbyPin("#7c3aed", "🚌")}>
            <Popup><div style={{ fontSize: 12 }}><b>{p.name}</b>{p.address ? <div style={{ color: "#64748b" }}>{p.address}</div> : null}</div></Popup>
          </Marker>
        ))}

        <LiveDot pos={myPos} />
        <ClickHandler active={!!pickFor} onPick={handleMapClick} />
        <FlyTo from={fromLoc} to={toLoc} />
      </MapContainer>

      {/* Pick hint banner */}
      {pickFor && (
        <div style={{ position: "absolute", top: 72, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: "#1a73e8", color: "#fff", padding: "8px 20px", borderRadius: 24, fontSize: 13, fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.25)", display: "flex", alignItems: "center", gap: 10 }}>
          📌 Tap map to set {pickFor === "from" ? "origin" : pickFor === "to" ? "destination" : pickFor === "stop" ? "stop" : pickFor === "home" ? "home" : "work"}
          <button onClick={() => { setPickFor(null); setSetLocModal(null); }} style={{ background: "rgba(255,255,255,0.25)", border: "none", borderRadius: 6, color: "#fff", padding: "2px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
        </div>
      )}

      {/* ════ LEFT SIDEBAR ════ */}
      <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 52, zIndex: 500, background: "#fff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 10, gap: 2, boxShadow: "2px 0 8px rgba(0,0,0,0.06)" }}>
        {[
          { id: "search",  icon: "🔍", label: "Search"  },
          { id: "nearby",  icon: "📍", label: "Nearby"  },
          { id: "saved",   icon: "⭐", label: "Saved"   },
          { id: "recents", icon: "🕐", label: "Recents" },
        ].map(item => (
          <button key={item.id}
            onClick={() => setPanel(p => p === item.id as any ? "search" : item.id as any)}
            style={{ width: 42, height: 42, borderRadius: 10, background: panel === item.id ? "#e8f0fe" : "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, transition: "background 0.15s" }}>
            <span style={{ fontSize: 16 }}>{item.icon}</span>
            <span style={{ fontSize: 8, color: panel === item.id ? "#1a73e8" : "#64748b", fontWeight: 600 }}>{item.label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {myPos && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#1a73e8", marginBottom: 12, boxShadow: "0 0 0 3px rgba(26,115,232,0.2)" }} title="Live location active" />}
      </div>

      {/* ════ SIDE PANEL ════ */}
      <div style={{ position: "absolute", top: 0, left: 52, bottom: 0, width: panelOpen ? 340 : 0, zIndex: 400, background: "#fff", borderRight: "1px solid #e2e8f0", boxShadow: "2px 0 12px rgba(0,0,0,0.07)", overflow: "hidden", transition: "width 0.25s ease", display: "flex", flexDirection: "column" }}>

        {/* ── NEARBY ── */}
        {panel === "nearby" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>📍 Explore Nearby</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>
              {myPos ? "📡 Using your live location" : "⚠️ Allow GPS for accurate results"}
            </div>

            {/* Free text search */}
            <div style={{ display: "flex", gap: 7, marginBottom: 12 }}>
              <input
                value={nearbySearch}
                onChange={e => setNearbySearch(e.target.value)}
                onKeyDown={e => e.key === "Enter" && nearbySearch.trim() && doNearbySearch(undefined, nearbySearch.trim())}
                placeholder="Search restaurants, colleges, ATMs…"
                style={{ flex: 1, padding: "8px 12px", borderRadius: 9, border: "1px solid #e2e8f0", fontSize: 12, outline: "none", fontFamily: "inherit" }}
              />
              <button onClick={() => nearbySearch.trim() && doNearbySearch(undefined, nearbySearch.trim())} style={{ padding: "8px 12px", background: "#1a73e8", border: "none", borderRadius: 9, color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 700 }}>🔍</button>
            </div>

            {/* Category buttons */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
              {CATEGORIES.map(cat => (
                <button key={cat.id} onClick={() => { setNearbySearch(""); doNearbySearch(cat.id); }} style={{ padding: "8px 4px", background: activeCat === cat.id ? "#e8f0fe" : "#f8fafc", border: `1.5px solid ${activeCat === cat.id ? "#1a73e8" : "#e2e8f0"}`, borderRadius: 9, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: "all 0.15s" }}>
                  <span style={{ fontSize: 18 }}>{cat.icon}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, color: activeCat === cat.id ? "#1a73e8" : "#475569" }}>{cat.label}</span>
                </button>
              ))}
            </div>

            {nearbyLoading && (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <div style={{ fontSize: 26, marginBottom: 6 }}>🔍</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>Searching nearby…</div>
                <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 3 }}>May take a few seconds</div>
              </div>
            )}
            {!nearbyLoading && (activeCat || nearbySearch) && nearbyPlaces.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 0", fontSize: 12, color: "#94a3b8" }}>No results found. Try a different search.</div>
            )}
            {nearbyPlaces.map(p => (
              <div key={p.id} style={{ padding: "9px 10px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "flex-start", gap: 9 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{CAT_ICONS[p.type] || "📍"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  {p.address && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>{p.address}</div>}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={() => { setToTxt(p.name); setToLoc({ coords: p.coords, label: p.name }); setPanel("search"); }} style={{ padding: "3px 7px", background: "#e8f0fe", border: "none", borderRadius: 6, color: "#1a73e8", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>Go</button>
                  <button onClick={() => setSavePlaceTarget(p)} style={{ padding: "3px 7px", background: "#fffbeb", border: "none", borderRadius: 6, color: "#d97706", fontSize: 10, cursor: "pointer" }}>⭐</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── SAVED ── */}
        {panel === "saved" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 12 }}>⭐ Saved Places</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button onClick={() => setSetLocModal("home")} style={{ flex: 1, padding: 10, background: "#f0fdf4", border: "1.5px solid #bbf7d0", borderRadius: 10, cursor: "pointer", fontSize: 11, color: "#16a34a", fontWeight: 700 }}>🏠 Set Home</button>
              <button onClick={() => setSetLocModal("work")} style={{ flex: 1, padding: 10, background: "#fffbeb", border: "1.5px solid #fde68a", borderRadius: 10, cursor: "pointer", fontSize: 11, color: "#d97706", fontWeight: 700 }}>💼 Set Work</button>
            </div>
            {savedPlaces.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "20px 0" }}>No saved places yet.<br />Set Home, Work, or save from nearby.</div>}
            {savedPlaces.map((p, i) => (
              <div key={i} style={{ padding: 10, background: "#f8fafc", borderRadius: 10, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>{p.type === "home" ? "🏠" : p.type === "work" ? "💼" : "⭐"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}>{p.name || (p.type === "home" ? "Home" : p.type === "work" ? "Work" : "Saved")}</div>
                  <div style={{ fontSize: 10, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label.split(",").slice(0, 2).join(",")}</div>
                </div>
                <button onClick={() => { setToTxt(p.label); setToLoc({ coords: p.coords, label: p.label }); setPanel("search"); }} style={{ padding: "4px 8px", background: "#e8f0fe", border: "none", borderRadius: 8, fontSize: 10, color: "#1a73e8", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>Go</button>
                <button onClick={() => { const u = savedPlaces.filter((_, j) => j !== i); setSavedPlaces(u); localStorage.setItem("srfSaved", JSON.stringify(u)); }} style={{ padding: "4px 6px", background: "#fef2f2", border: "none", borderRadius: 8, fontSize: 10, color: "#dc2626", cursor: "pointer", flexShrink: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ── RECENTS ── */}
        {panel === "recents" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 12 }}>🕐 Recent Searches</div>
            {recents.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "20px 0" }}>No recent searches yet.</div>}
            {recents.map((r, i) => (
              <div key={i} onClick={() => { setToTxt(r.label); setToLoc(r); setPanel("search"); }}
                style={{ padding: "9px 10px", borderBottom: "1px solid #f1f5f9", cursor: "pointer", display: "flex", alignItems: "center", gap: 9 }}
                onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 14, color: "#94a3b8" }}>🕐</span>
                <span style={{ fontSize: 12, color: "#334155" }}>{r.label.split(",").slice(0, 2).join(",")}</span>
              </div>
            ))}
            {recents.length > 0 && (
              <button onClick={() => { setRecents([]); localStorage.removeItem("srfRecents"); }} style={{ marginTop: 12, width: "100%", padding: 8, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                🗑 Clear all recents
              </button>
            )}
          </div>
        )}

        {/* ── RESULT ── */}
        {(panel === "result" || panel === "search") && routes.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto" }}>

            {/* Header: summary + clear at top */}
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#64748b", display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
                  <span style={{ color: "#10b981", fontWeight: 800, flexShrink: 0 }}>A</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fromTxt.split(",")[0]}</span>
                  <span style={{ color: "#cbd5e1", flexShrink: 0 }}>→</span>
                  <span style={{ color: "#f43f5e", fontWeight: 800, flexShrink: 0 }}>B</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{toTxt.split(",")[0]}</span>
                </div>
              </div>
              <button onClick={() => { setPanel("search"); setRoutes([]); }} style={{ padding: "3px 8px", background: "#f1f5f9", border: "none", borderRadius: 6, fontSize: 10, color: "#475569", cursor: "pointer", flexShrink: 0 }}>Edit</button>
              <button onClick={clear} style={{ padding: "3px 8px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, fontSize: 10, color: "#dc2626", cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>✕ Clear</button>
            </div>

            {/* Mode buttons */}
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ display: "flex", gap: 5 }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => { setMode(m.id); setRoutes([]); setBusStops([]); setTimeout(getDirections, 50); }}
                    style={{ flex: 1, padding: "7px 2px", background: mode === m.id ? m.color : "#f8fafc", border: mode === m.id ? "none" : "1px solid #e2e8f0", borderRadius: 9, cursor: "pointer", color: mode === m.id ? "#fff" : "#64748b", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: "all 0.15s", boxShadow: mode === m.id ? `0 2px 8px ${m.color}44` : "none" }}>
                    <span style={{ fontSize: 15 }}>{m.icon}</span>
                    <span style={{ fontSize: 9, fontWeight: 700 }}>{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: fuelCost ? "1fr 1fr 1fr" : "1fr 1fr", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ padding: "10px 0", textAlign: "center", borderRight: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em" }}>DISTANCE</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#1a73e8" }}>{route.distKm.toFixed(1)} km</div>
              </div>
              <div style={{ padding: "10px 0", textAlign: "center", borderRight: fuelCost ? "1px solid #f1f5f9" : "none" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em" }}>ETA W/ TRAFFIC</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#16a34a" }}>{fmtEta(trafficEta)}</div>
                <div style={{ fontSize: 8, color: "#cbd5e1" }}>~{fmtEta(route.durationMin)} ideal</div>
              </div>
              {fuelCost && (
                <div style={{ padding: "10px 0", textAlign: "center", cursor: "pointer" }} onClick={() => setShowFuelEdit(!showFuelEdit)}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em" }}>FUEL EST. ✎</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#ea580c" }}>₹{fuelCost.low}–{fuelCost.high}</div>
                  <div style={{ fontSize: 8, color: "#cbd5e1" }}>tap to edit</div>
                </div>
              )}
            </div>

            {/* Fuel editor */}
            {showFuelEdit && (
              <div style={{ padding: "10px 14px", background: "#fffbeb", borderBottom: "1px solid #fde68a" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#92400e", marginBottom: 6 }}>⛽ Vehicle settings</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#92400e", marginBottom: 3 }}>Fuel price (₹/L)</div>
                    <input type="number" value={fuelPrice} onChange={e => setFuelPrice(parseFloat(e.target.value) || 0)} style={{ width: "100%", padding: "6px 8px", borderRadius: 7, border: "1px solid #fde68a", fontSize: 12, background: "#fff", boxSizing: "border-box" as const, outline: "none" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 9, color: "#92400e", marginBottom: 3 }}>Mileage (km/L)</div>
                    <input type="number" value={fuelMileage} onChange={e => setFuelMileage(parseFloat(e.target.value) || 1)} style={{ width: "100%", padding: "6px 8px", borderRadius: 7, border: "1px solid #fde68a", fontSize: 12, background: "#fff", boxSizing: "border-box" as const, outline: "none" }} />
                  </div>
                </div>
                <div style={{ fontSize: 9, color: "#a16207", marginTop: 5 }}>Range accounts for traffic, idling & AC. Actual may vary.</div>
              </div>
            )}

            {/* Route selector */}
            {routes.length > 1 && (
              <div style={{ padding: "8px 14px", borderBottom: "1px solid #f1f5f9", display: "flex", gap: 6 }}>
                {routes.map((rt, i) => (
                  <button key={i} onClick={() => setSelRoute(i)}
                    style={{ flex: 1, padding: "7px 6px", background: selRoute === i ? "#e8f0fe" : "#f8fafc", border: `1.5px solid ${selRoute === i ? "#1a73e8" : "#e2e8f0"}`, borderRadius: 9, cursor: "pointer", fontSize: 10, fontWeight: 700, color: selRoute === i ? "#1a73e8" : "#64748b", lineHeight: 1.4, textAlign: "center" as const }}>
                    {i === 0 ? "🏆 Shortest" : "⚡ Faster"}<br />
                    <span style={{ fontWeight: 400, fontSize: 9 }}>{rt.distKm.toFixed(1)}km · {fmtEta(rt.durationMin)}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Bus routes + stops */}
            {mode === "bus" && (
              <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", marginBottom: 7 }}>🚌 BMTC BUS ROUTES</div>
                {busRoutes.length === 0 && <div style={{ fontSize: 11, color: "#94a3b8" }}>No matching routes found for this area.</div>}
                {busRoutes.map((rt, i) => (
                  <div key={i} style={{ padding: "7px 10px", background: "#f5f3ff", borderRadius: 9, marginBottom: 5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                      <span style={{ background: "#7c3aed", color: "#fff", padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 800 }}>{rt.number}</span>
                      <span style={{ fontSize: 11, color: "#1e293b", fontWeight: 600 }}>{rt.from} → {rt.to}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#7c3aed" }}>via {rt.via.join(" · ")}</div>
                  </div>
                ))}
                {busStops.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", marginBottom: 4 }}>NEAREST BUS STOPS</div>
                    {busStops.slice(0, 4).map((s, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#475569", padding: "3px 0", display: "flex", gap: 6, alignItems: "center" }}>
                        <span>🚏</span><span>{s.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Places on the way */}
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", marginBottom: 7 }}>🗺 PLACES ON THE WAY</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                {CATEGORIES.map(cat => (
                  <button key={cat.id} onClick={() => loadOnTheWay(cat.id)}
                    style={{ padding: "4px 10px", background: activeOnWayCat === cat.id ? "#e8f0fe" : "#f1f5f9", border: `1px solid ${activeOnWayCat === cat.id ? "#1a73e8" : "#e2e8f0"}`, borderRadius: 14, cursor: "pointer", fontSize: 10, color: activeOnWayCat === cat.id ? "#1a73e8" : "#64748b", fontWeight: 600 }}>
                    {cat.icon} {cat.label}
                  </button>
                ))}
              </div>
              {onWayLoading && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, textAlign: "center" }}>Searching along route…</div>}
              {!onWayLoading && activeOnWayCat && onTheWay.length === 0 && (
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>No {activeOnWayCat} found along this route.</div>
              )}
              {onTheWay.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 140, overflowY: "auto" }}>
                  {onTheWay.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #f8fafc" }}>
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{CAT_ICONS[p.type] || "📍"}</span>
                      <span style={{ fontSize: 11, color: "#334155", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                      <button onClick={() => setSavePlaceTarget(p)} style={{ padding: "2px 6px", background: "#fffbeb", border: "none", borderRadius: 5, color: "#d97706", fontSize: 10, cursor: "pointer", flexShrink: 0 }}>⭐</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Step by step */}
            <button onClick={() => setShowSteps(!showSteps)}
              style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", color: "#475569", fontSize: 12, fontWeight: 600, borderBottom: showSteps ? "1px solid #f1f5f9" : "none" }}>
              <span>🗺 Step-by-step ({route.steps.length} steps)</span>
              <span style={{ transition: "transform 0.2s", display: "inline-block", transform: showSteps ? "rotate(180deg)" : "none" }}>▾</span>
            </button>

            {showSteps && (
              <div style={{ borderBottom: "1px solid #f1f5f9" }}>
                {route.steps.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 14px", borderBottom: i < route.steps.length - 1 ? "1px solid #f8fafc" : "none", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: s.text.toLowerCase().includes("arrive") ? "#fef2f2" : "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 11, color: s.text.toLowerCase().includes("arrive") ? "#f43f5e" : "#1a73e8" }}>
                      {stepIcon(s.text)}
                    </div>
                    <span style={{ flex: 1, fontSize: 11, color: "#475569", lineHeight: 1.5 }}>{s.text}</span>
                    <span style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0, marginTop: 3 }}>
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

      {/* ════ TOP SEARCH BAR ════ */}
      <div style={{ position: "absolute", top: 12, left: panelOpen ? 412 : 72, right: 12, zIndex: 1000, transition: "left 0.25s ease", pointerEvents: "auto", maxWidth: 500 }}>

        {panel !== "search" && routes.length === 0 && (
          <div onClick={() => setPanel("search")} style={{ background: "#fff", borderRadius: 28, padding: "11px 18px", boxShadow: "0 2px 12px rgba(0,0,0,0.15)", display: "flex", alignItems: "center", gap: 10, cursor: "text" }}>
            <span style={{ fontSize: 16 }}>🔍</span>
            <span style={{ color: "#94a3b8", fontSize: 13 }}>Search Bengaluru…</span>
          </div>
        )}

        {panel === "search" && routes.length === 0 && (
          <div style={{ background: "#fff", borderRadius: 16, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", overflow: "visible" }}>
            <div style={{ padding: "11px 14px 7px", display: "flex", alignItems: "center", gap: 8 }}>
              <AutoInput value={fromTxt} placeholder="From — search, GPS or pick on map" dot="#10b981"
                onChange={v => { setFromTxt(v); if (!v) setFromLoc(null); }}
                onSelect={l => { setFromLoc(l); setFromTxt(l.label); }}
                savedPlaces={savedPlaces} recents={recents}
              />
              <button onClick={() => gps("from", l => { setFromLoc(l); setFromTxt(l.label); })} title="Current location"
                style={{ background: gpsing === "from" ? "#e8f5e9" : "#f1f5f9", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0 }}>
                {gpsing === "from" ? "⌛" : "📍"}
              </button>
              <button onClick={() => setPickFor(pickFor === "from" ? null : "from")} title="Pick on map"
                style={{ background: pickFor === "from" ? "#e3f2fd" : "#f1f5f9", border: `1px solid ${pickFor === "from" ? "#1a73e8" : "transparent"}`, borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0 }}>🗺</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", padding: "0 14px", gap: 8 }}>
              <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
              <button onClick={swap} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "50%", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#64748b", fontSize: 12 }}>⇅</button>
              <div style={{ flex: 1, height: "1px", background: "#f1f5f9" }} />
            </div>

            <div style={{ padding: "7px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <AutoInput value={toTxt} placeholder="To — destination" dot="#f43f5e"
                onChange={v => { setToTxt(v); if (!v) setToLoc(null); }}
                onSelect={l => { setToLoc(l); setToTxt(l.label); }}
                savedPlaces={savedPlaces} recents={recents}
              />
              <button onClick={() => gps("to", l => { setToLoc(l); setToTxt(l.label); })}
                style={{ background: gpsing === "to" ? "#fce4ec" : "#f1f5f9", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0 }}>
                {gpsing === "to" ? "⌛" : "📍"}
              </button>
              <button onClick={() => setPickFor(pickFor === "to" ? null : "to")}
                style={{ background: pickFor === "to" ? "#fce4ec" : "#f1f5f9", border: `1px solid ${pickFor === "to" ? "#f43f5e" : "transparent"}`, borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0 }}>🗺</button>
            </div>

            {showStop && (
              <div style={{ padding: "0 14px 7px", display: "flex", alignItems: "center", gap: 8 }}>
                <AutoInput value={stopTxt} placeholder="Add a stop along the way" dot="#f97316"
                  onChange={v => { setStopTxt(v); if (!v) setStopLoc(null); }}
                  onSelect={l => { setStopLoc(l); setStopTxt(l.label); }}
                />
                <button onClick={() => setPickFor("stop")} style={{ background: pickFor === "stop" ? "#fff7ed" : "#f1f5f9", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0 }}>🗺</button>
                <button onClick={() => { setShowStop(false); setStopTxt(""); setStopLoc(null); }} style={{ background: "#fef2f2", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 13, flexShrink: 0, color: "#dc2626" }}>✕</button>
              </div>
            )}

            {err && <div style={{ margin: "0 14px 8px", padding: "7px 10px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12, color: "#dc2626" }}>⚠️ {err}</div>}

            <div style={{ padding: "0 14px 12px", display: "flex", gap: 7 }}>
              <button onClick={getDirections} disabled={loading}
                style={{ flex: 1, padding: "10px 0", background: loading ? "#e2e8f0" : "#1a73e8", border: "none", borderRadius: 10, color: loading ? "#94a3b8" : "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", boxShadow: loading ? "none" : "0 2px 10px rgba(26,115,232,0.3)" }}>
                {loading ? "⏳ Routing…" : "🧭 Get Directions"}
              </button>
              {!showStop && (
                <button onClick={() => setShowStop(true)} title="Add a stop"
                  style={{ padding: "10px 12px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, cursor: "pointer", fontSize: 13, color: "#ea580c", fontWeight: 700 }}>+</button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* GPS toast */}
      {gpsing && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 2000, background: "rgba(0,0,0,0.75)", color: "#fff", padding: "8px 20px", borderRadius: 20, fontSize: 12, fontWeight: 500 }}>
          ⌛ Getting your location…
        </div>
      )}

      {/* Save modal */}
      {savePlaceTarget && (
        <SaveModal
          onSave={(type, name) => { persistSaved(type, { coords: savePlaceTarget.coords, label: savePlaceTarget.name }, name); setSavePlaceTarget(null); }}
          onClose={() => setSavePlaceTarget(null)}
        />
      )}

      {/* Set home/work modal */}
      {setLocModal && (
        <SetLocModal
          title={`Set ${setLocModal === "home" ? "🏠 Home" : "💼 Work"} location`}
          onClose={() => setSetLocModal(null)}
          onGPS={() => {
            setSetLocModal(null);
            gps(setLocModal, l => persistSaved(setLocModal!, l));
          }}
          onMap={() => { setPickFor(setLocModal); setSetLocModal(null); }}
          onManual={async q => {
            const r = await geocode(q);
            if (r) persistSaved(setLocModal!, r);
            setSetLocModal(null);
          }}
        />
      )}
    </div>
  );
}
