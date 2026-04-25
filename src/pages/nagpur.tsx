import { useEffect, useState, useRef, useCallback } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import GeoRasterLayer from "georaster-layer-for-leaflet";
import parseGeoraster from "georaster";
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip,
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer,
} from "recharts";
import {
  Layers, Leaf, Map, Droplets, Thermometer,
  CloudRain, Sprout, MapPin, Plus, Minus, Activity,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LayerMeta {
  name: string;
  band: number;
  icon: React.ElementType;
  desc: string;
  dotColor: string;
}

// ─── Layer definitions ────────────────────────────────────────────────────────

const LAYERS: LayerMeta[] = [
  { name: "NDVI",          band: 0, icon: Leaf,        desc: "Vegetation Index",     dotColor: "#22c55e" },
  { name: "LULC",          band: 1, icon: Map,         desc: "Land Use / Cover",     dotColor: "#94a3b8" },
  { name: "Water",         band: 2, icon: Droplets,    desc: "Water Bodies",         dotColor: "#38bdf8" },
  { name: "Temperature",   band: 3, icon: Thermometer, desc: "Land Surface Temp",    dotColor: "#f97316" },
  { name: "Rainfall",      band: 4, icon: CloudRain,   desc: "Precipitation",        dotColor: "#3b82f6" },
  { name: "Soil Moisture", band: 5, icon: Sprout,      desc: "Soil Moisture",        dotColor: "#a16207" },
  { name: "GeoPoints",     band: 6, icon: MapPin,      desc: "Points of Interest",   dotColor: "#ef4444" },
];

// ─── Smooth heatmap color helpers ────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

function lerpColor(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
  t: number, opacity: number
): string {
  return `rgba(${Math.round(lerp(r1, r2, t))},${Math.round(lerp(g1, g2, t))},${Math.round(lerp(b1, b2, t))},${opacity})`;
}

function bandToColor(band: number, val: number): string | null {
  if (val === null || val === undefined || isNaN(val)) return null;
  const n = clamp(val / 255, 0, 1);

  switch (band) {
    case 0: { // NDVI — smooth red→yellow→green
      if (n < 0.2)  return lerpColor(239,68,68, 250,204,21, n / 0.2, 0.68);
      if (n < 0.5)  return lerpColor(250,204,21, 34,197,94, (n - 0.2) / 0.3, 0.70);
      return lerpColor(34,197,94, 21,128,61, (n - 0.5) / 0.5, 0.72);
    }
    case 1: { // LULC
      if (val < 60)  return `rgba(59,130,246,0.65)`;
      if (val < 150) return `rgba(148,163,184,0.65)`;
      return lerpColor(34,197,94, 21,128,61, (val - 150) / 105, 0.68);
    }
    case 2: { // Water
      const op = 0.35 + n * 0.42;
      return lerpColor(186,230,253, 2,132,199, n, op);
    }
    case 3: { // Temperature (15–45°C mapped 0–255)
      const t = 15 + n * 30;
      if (t < 25) return lerpColor(34,197,94, 250,204,21, (t - 15) / 10, 0.66);
      if (t < 35) return lerpColor(250,204,21, 239,68,68, (t - 25) / 10, 0.70);
      return lerpColor(239,68,68, 127,29,29, (t - 35) / 10, 0.72);
    }
    case 4: { // Rainfall — pale→deep blue
      return lerpColor(191,219,254, 29,78,216, n, 0.62 + n * 0.12);
    }
    case 5: { // Soil Moisture — brown→lime
      return lerpColor(180,100,50, 101,163,13, n, 0.68);
    }
    case 6: { // GeoPoints
      return val > 0 ? "rgba(239,68,68,0.85)" : null;
    }
    default: {
      const g = Math.round(n * 255);
      return `rgba(${g},${g},${g},0.65)`;
    }
  }
}

function bandToReadable(band: number, raw: number): string {
  if (raw === null || raw === undefined || isNaN(raw)) return "—";
  switch (band) {
    case 0: return (raw / 255).toFixed(2);
    case 1: {
      if (raw < 60) return "Water";
      if (raw < 150) return "Urban";
      return "Vegetation";
    }
    case 2: return `${(raw / 255 * 100).toFixed(1)}%`;
    case 3: return `${(15 + (raw / 255) * 30).toFixed(1)}°C`;
    case 4: return `${(raw / 255 * 200).toFixed(1)} mm`;
    case 5: return `${(raw / 255 * 100).toFixed(1)}%`;
    default: return raw.toFixed(1);
  }
}

// ─── Stats / chart data ──────────────────────────────────────────────────────

const STATS = {
  ndvi:     { avg: 0.61, good: 55, medium: 28, bad: 17 },
  temp:     { avg: 31.4 },
  rainfall: { total: 142.3 },
  moisture: { avg: 38.7 },
};

const DONUT_DATA = [
  { name: "Good",   value: STATS.ndvi.good,   color: "#22c55e" },
  { name: "Medium", value: STATS.ndvi.medium, color: "#facc15" },
  { name: "Poor",   value: STATS.ndvi.bad,    color: "#ef4444" },
];

const RAINFALL_DATA = [
  { month: "Jan", mm: 8 }, { month: "Feb", mm: 14 }, { month: "Mar", mm: 10 },
  { month: "Apr", mm: 22 }, { month: "May", mm: 48 }, { month: "Jun", mm: 142 },
];

// ─── Card helper ─────────────────────────────────────────────────────────────

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: 16,
      boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ─── Zoom controls ────────────────────────────────────────────────────────────

function ZoomControls() {
  const map = useMap();
  const btn: React.CSSProperties = {
    width: 36, height: 36, background: "#fff", border: "none", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#374151", transition: "background 0.12s",
  };
  return (
    <div style={{
      position: "absolute", top: 16, right: 16, zIndex: 500,
      background: "#fff", border: "1px solid #e5e7eb",
      borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
      overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      <button
        style={btn}
        onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
        onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
        onClick={() => map.zoomIn()}
        title="Zoom in"
      >
        <Plus size={16} />
      </button>
      <div style={{ height: 1, background: "#e5e7eb" }} />
      <button
        style={btn}
        onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
        onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
        onClick={() => map.zoomOut()}
        title="Zoom out"
      >
        <Minus size={16} />
      </button>
    </div>
  );
}

// ─── GeoTIFF layer ────────────────────────────────────────────────────────────

function GeoTiffLayer({
  url, band, onLoad, onPixelHover,
}: {
  url: string;
  band: number;
  onLoad: () => void;
  onPixelHover: (vals: number[] | null) => void;
}) {
  const map = useMap();
  const layerRef     = useRef<any>(null);
  const georasterRef = useRef<any>(null);

  useMapEvents({
    mousemove(e) {
      const gr = georasterRef.current;
      if (!gr) { onPixelHover(null); return; }
      try {
        const { lat, lng } = e.latlng;
        const { xmin, xmax, ymin, ymax, width, height, values } = gr;
        const col = Math.floor(((lng - xmin) / (xmax - xmin)) * width);
        const row = Math.floor(((ymax - lat) / (ymax - ymin)) * height);
        if (col < 0 || col >= width || row < 0 || row >= height) {
          onPixelHover(null); return;
        }
        onPixelHover(values.map((b: number[][]) => b[row]?.[col] ?? NaN));
      } catch { onPixelHover(null); }
    },
    mouseout() { onPixelHover(null); },
  });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => r.arrayBuffer())
      .then(async buf => {
        if (cancelled) return;
        const gr: any = await parseGeoraster(buf);
        if (cancelled) return;
        georasterRef.current = gr;
        onLoad();
        const layer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.74,
          resolution: 256,
          pixelValuesToColorFn: (vals: number[]) =>
            bandToColor(band, vals[band]) ?? "transparent",
        });
        layer.addTo(map);
        layerRef.current = layer;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }
    };
  }, [url, band, map]);

  return null;
}

// ─── Floating Tooltip ────────────────────────────────────────────────────────

const TOOLTIP_FIELDS: { label: string; band: number; color: string }[] = [
  { label: "NDVI",         band: 0, color: "#22c55e" },
  { label: "LULC",         band: 1, color: "#94a3b8" },
  { label: "Water",        band: 2, color: "#38bdf8" },
  { label: "Temperature",  band: 3, color: "#f97316" },
  { label: "Rainfall",     band: 4, color: "#3b82f6" },
  { label: "Soil Moisture",band: 5, color: "#a16207" },
];

function MapTooltip({ pixelVals, mousePos }: {
  pixelVals: number[] | null;
  mousePos: { x: number; y: number };
}) {
  if (!pixelVals) return null;
  return (
    <div
      className="pointer-events-none fixed z-[9999]"
      style={{ left: mousePos.x + 18, top: mousePos.y + 18 }}
    >
      <div style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        boxShadow: "0 8px 28px rgba(0,0,0,0.10)",
        padding: "10px 14px",
        minWidth: 186,
      }}>
        <p style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          Pixel Values
        </p>
        {TOOLTIP_FIELDS.map(f => (
          <div key={f.label} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: f.color, flexShrink: 0, display: "inline-block" }} />
            <span style={{ fontSize: 11, color: "#6b7280", flex: 1 }}>{f.label}</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#111827", fontFamily: "monospace" }}>
              {bandToReadable(f.band, pixelVals[f.band])}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Layers Dropdown ─────────────────────────────────────────────────────────

function LayersDropdown({
  activeLayer,
  onSelect,
}: {
  activeLayer: number;
  onSelect: (band: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeMeta = LAYERS.find(l => l.band === activeLayer)!;

  return (
    <div ref={ref} style={{ position: "absolute", top: 16, left: 16, zIndex: 600 }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "#fff", border: "1px solid #e5e7eb",
          borderRadius: 12, padding: "8px 14px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.09)",
          cursor: "pointer", transition: "box-shadow 0.15s",
        }}
        onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 6px 22px rgba(0,0,0,0.13)")}
        onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.09)")}
      >
        <Layers size={15} color="#0ea5e9" />
        <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
          {activeMeta.name}
        </span>
        <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 2 }}>▾</span>
      </button>

      {/* Dropdown panel */}
      <div style={{
        position: "absolute", top: "calc(100% + 8px)", left: 0,
        background: "#fff", border: "1px solid #e5e7eb",
        borderRadius: 16, boxShadow: "0 8px 32px rgba(0,0,0,0.11)",
        minWidth: 210, overflow: "hidden",
        opacity: open ? 1 : 0,
        transform: open ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.97)",
        pointerEvents: open ? "auto" : "none",
        transition: "opacity 0.18s, transform 0.18s",
      }}>
        <div style={{ padding: "10px 12px 6px" }}>
          <p style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Select Layer
          </p>
        </div>
        {LAYERS.map(layer => {
          const Icon = layer.icon;
          const active = activeLayer === layer.band;
          return (
            <button
              key={layer.name}
              onClick={() => { onSelect(layer.band); setOpen(false); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "8px 14px", border: "none", cursor: "pointer",
                background: active ? "#f0f9ff" : "transparent",
                color: active ? "#0284c7" : "#374151",
                fontSize: 12, fontWeight: active ? 600 : 500,
                textAlign: "left", transition: "background 0.1s",
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: "50%",
                background: layer.dotColor, flexShrink: 0, display: "inline-block",
              }} />
              <Icon size={13} color={active ? "#0284c7" : "#9ca3af"} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: active ? 600 : 500 }}>{layer.name}</div>
                <div style={{ fontSize: 10, color: "#9ca3af" }}>{layer.desc}</div>
              </div>
              {active && (
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", background: "#0ea5e9",
                  flexShrink: 0, display: "inline-block",
                }} />
              )}
            </button>
          );
        })}
        <div style={{ height: 6 }} />
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Nagpur() {
  const [activeLayer, setActiveLayer] = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [pixelVals,   setPixelVals]   = useState<number[] | null>(null);
  const [mousePos,    setMousePos]    = useState({ x: 0, y: 0 });

  const activeMeta = LAYERS.find(l => l.band === activeLayer)!;

  const handleMouseMove = useCallback((e: MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [handleMouseMove]);

  return (
    <div style={{
      display: "flex", height: "100vh", width: "100%",
      fontFamily: "'Inter', system-ui, sans-serif",
      overflow: "hidden", background: "#f1f5f9",
    }}>

      {/* ── Full-width Map ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative" }}>

        {/* Loading overlay */}
        {loading && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            background: "rgba(248,250,252,0.85)", backdropFilter: "blur(6px)",
          }}>
            <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            <div style={{ animation: "spin 1s linear infinite", color: "#0ea5e9", marginBottom: 10, display: "flex" }}>
              <Layers size={34} color="#0ea5e9" />
            </div>
            <p style={{ color: "#475569", fontSize: 13, fontWeight: 500 }}>Loading {activeMeta.name}…</p>
          </div>
        )}

        <MapContainer
          center={[21.1458, 79.0882] as [number, number]}
          zoom={10}
          style={{ width: "100%", height: "100%" }}
          zoomControl={false}
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <GeoTiffLayer
            key={activeLayer}
            url="/Nagpur_2025.tif"
            band={activeLayer}
            onLoad={() => setLoading(false)}
            onPixelHover={setPixelVals}
          />
          <ZoomControls />
        </MapContainer>

        {/* Floating Layers Button + Dropdown */}
        <LayersDropdown
          activeLayer={activeLayer}
          onSelect={band => { setActiveLayer(band); setLoading(true); }}
        />

        {/* Bottom-left: status card */}
        <div style={{ position: "absolute", bottom: 24, left: 16, zIndex: 500 }}>
          <Card style={{ padding: "12px 16px", minWidth: 210 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <Activity size={12} color="#0ea5e9" />
              <span style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Environmental Health
              </span>
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 9 }}>
              {activeMeta.name}
            </p>
            <div style={{ display: "flex", height: 6, borderRadius: 99, overflow: "hidden", gap: 2 }}>
              <div style={{ background: "#22c55e", width: `${STATS.ndvi.good}%`,   borderRadius: "99px 0 0 99px", transition: "width 0.5s" }} />
              <div style={{ background: "#facc15", width: `${STATS.ndvi.medium}%`, transition: "width 0.5s" }} />
              <div style={{ background: "#ef4444", width: `${STATS.ndvi.bad}%`,    borderRadius: "0 99px 99px 0", transition: "width 0.5s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
              {([ ["Good", `${STATS.ndvi.good}%`, "#16a34a"], ["Mid", `${STATS.ndvi.medium}%`, "#ca8a04"], ["Poor", `${STATS.ndvi.bad}%`, "#dc2626"] ] as [string, string, string][])
                .map(([lbl, pct, col]) => (
                  <span key={lbl} style={{ fontSize: 9, color: col, fontWeight: 600 }}>{lbl} {pct}</span>
                ))}
            </div>
          </Card>
        </div>

        {/* Floating pixel tooltip */}
        <MapTooltip pixelVals={pixelVals} mousePos={mousePos} />
      </div>

      {/* ── Right Analytics Panel ─────────────────────────────────────────── */}
      <aside style={{
        width: 272, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "#f8fafc", borderLeft: "1px solid #e5e7eb",
        overflowY: "auto", zIndex: 10,
      }}>
        {/* Header */}
        <div style={{ padding: "20px 18px 14px", borderBottom: "1px solid #e5e7eb", background: "#fff" }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Analytics</p>
          <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Nagpur District · 2025</p>
        </div>

        <div style={{ padding: "14px 12px 20px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Stat cards 2×2 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            {([
              { label: "Avg NDVI",   value: STATS.ndvi.avg.toFixed(2),    icon: Leaf,        accent: "#22c55e", bg: "#f0fdf4" },
              { label: "Avg Temp",   value: `${STATS.temp.avg}°C`,        icon: Thermometer, accent: "#f97316", bg: "#fff7ed" },
              { label: "Rainfall",   value: `${STATS.rainfall.total} mm`, icon: CloudRain,   accent: "#3b82f6", bg: "#eff6ff" },
              { label: "Soil Moist", value: `${STATS.moisture.avg}%`,     icon: Sprout,      accent: "#84cc16", bg: "#f7fee7" },
            ] as const).map(s => {
              const Icon = s.icon as React.ElementType;
              return (
                <div key={s.label} style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                  boxShadow: "0 1px 6px rgba(0,0,0,0.05)", padding: "12px 11px 10px",
                }}>
                  <div style={{
                    background: s.bg, borderRadius: 8, width: 28, height: 28,
                    display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8,
                  }}>
                    <Icon size={13} color={s.accent} />
                  </div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: "#111827", lineHeight: 1.2 }}>{s.value}</p>
                  <p style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>{s.label}</p>
                </div>
              );
            })}
          </div>

          {/* Donut chart */}
          <Card style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 10.5, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
              NDVI Distribution
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ResponsiveContainer width={98} height={98}>
                <PieChart>
                  <Pie data={DONUT_DATA} cx="50%" cy="50%" innerRadius={26} outerRadius={44} dataKey="value" strokeWidth={0}>
                    {DONUT_DATA.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <ReTooltip
                    contentStyle={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 11 }}
                    itemStyle={{ color: "#374151" }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {DONUT_DATA.map(d => (
                  <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: d.color, flexShrink: 0, display: "inline-block" }} />
                    <span style={{ fontSize: 11, color: "#475569" }}>{d.name}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto", paddingLeft: 8 }}>{d.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Rainfall bar chart */}
          <Card style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 10.5, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
              Monthly Rainfall (mm)
            </p>
            <ResponsiveContainer width="100%" height={90}>
              <BarChart data={RAINFALL_DATA} margin={{ top: 0, right: 0, bottom: 0, left: -24 }}>
                <XAxis dataKey="month" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
                <ReTooltip
                  contentStyle={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 11 }}
                  itemStyle={{ color: "#374151" }}
                  cursor={{ fill: "rgba(0,0,0,0.025)" }}
                />
                <Bar dataKey="mm" fill="#38bdf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Active layer pill */}
          <Card style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            {(() => {
              const Icon = activeMeta.icon;
              return (
                <div style={{
                  width: 32, height: 32, borderRadius: 9, background: "#e0f2fe",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <Icon size={14} color="#0284c7" />
                </div>
              );
            })()}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{activeMeta.name}</p>
              <p style={{ fontSize: 10, color: "#9ca3af" }}>{activeMeta.desc}</p>
            </div>
            <div style={{ background: "#e0f2fe", borderRadius: 999, padding: "3px 10px", flexShrink: 0 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#0284c7" }}>Active</span>
            </div>
          </Card>

        </div>
      </aside>
    </div>
  );
}
