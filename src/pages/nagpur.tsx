import { useEffect, useState, useRef, useCallback, useMemo } from "react";
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
  CloudRain, Sprout, MapPin, Plus, Minus,
  Activity, Satellite, Globe,
} from "lucide-react";

// ─── Polyfill ─────────────────────────────────────────────────────────────────
if (!(Math as any).clamp) {
  (Math as any).clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ─── Layer definitions ────────────────────────────────────────────────────────

interface LayerMeta {
  name: string;
  band: number;
  icon: React.ElementType;
  desc: string;
  dotColor: string;
}

const LAYERS: LayerMeta[] = [
  { name: "All",          band: -1, icon: Layers,     desc: "All Layers Combined", dotColor: "#0ea5e9" },
  { name: "NDVI",          band: 0, icon: Leaf,        desc: "Vegetation Index",   dotColor: "#22c55e" },
  { name: "LULC",          band: 1, icon: Map,         desc: "Land Use / Cover",   dotColor: "#94a3b8" },
  { name: "Water",         band: 2, icon: Droplets,    desc: "Water Bodies",       dotColor: "#38bdf8" },
  { name: "Temperature",   band: 3, icon: Thermometer, desc: "Land Surface Temp",  dotColor: "#f97316" },
  { name: "Rainfall",      band: 4, icon: CloudRain,   desc: "Precipitation",      dotColor: "#3b82f6" },
  { name: "Soil Moisture", band: 5, icon: Sprout,      desc: "Soil Moisture",      dotColor: "#a16207" },
  { name: "GeoPoints",     band: 6, icon: MapPin,      desc: "Points of Interest", dotColor: "#ef4444" },
];

// ─── Layer stats (single source of truth) ────────────────────────────────────

const LAYER_STATS: Record<number, Record<string, any>> = {
  0: { name: "NDVI",          avg: 0.61,  good: 55, medium: 28, bad: 17,  unit: "",     label: "Avg NDVI" },
  1: { name: "LULC",          water: 18,  urban: 32, veg: 50 },
  2: { name: "Water",         coverage: 12.4, good: 62, medium: 25, bad: 13 },
  3: { name: "Temperature",   avg: 31.4,  good: 30, medium: 45, bad: 25,  unit: "°C",   label: "Avg Temp" },
  4: { name: "Rainfall",      total: 142.3, monthly: [
        { month: "Jan", mm: 8 }, { month: "Feb", mm: 14 }, { month: "Mar", mm: 10 },
        { month: "Apr", mm: 22 }, { month: "May", mm: 48 }, { month: "Jun", mm: 142 },
      ] },
  5: { name: "Soil Moisture", avg: 38.7,  good: 42, medium: 38, bad: 20,  unit: "%",    label: "Avg Moisture" },
  6: { name: "GeoPoints",     count: 1245, clusters: [
        { zone: "North", count: 312 }, { zone: "South", count: 278 },
        { zone: "East",  count: 421 }, { zone: "West",  count: 234 },
      ] },
};

// ─── Basemap definitions ──────────────────────────────────────────────────────

type MapType = "osm" | "satellite" | "hybrid";

const BASEMAPS: { id: MapType; label: string; icon: React.ElementType }[] = [
  { id: "osm",       label: "OSM",  icon: Globe },
  { id: "satellite", label: "SAT",  icon: Satellite },
  { id: "hybrid",    label: "HYB",  icon: Map },
];

// ─── Color / heatmap helpers ─────────────────────────────────────────────────

/**
 * Per‑band expected data ranges (raw pixel values in GeoTIFF).
 * We stretch each band's actual range → 0..1 so colors ALWAYS span
 * the full palette regardless of how the data was encoded.
 */
const BAND_RANGE: Record<number, [number, number]> = {
  0: [-1, 1],     // NDVI
  1: [0, 255],    // LULC
  2: [0, 1],      // Water mask
  3: [15, 45],    // Temperature °C
  4: [0, 200],    // Rainfall mm
  5: [0, 1],      // Soil moisture (fractional 0–1, display as %)
  6: [0, 1],      // GeoPoints
};

/** Safe stretch with proper bounds */
function stretch(val: number, band: number): number {
  const [lo, hi] = BAND_RANGE[band] ?? [0, 1];
  if (val === null || val === undefined || isNaN(val)) return 0;
  if (hi === lo) return 0;
  return Math.max(0, Math.min(1, (val - lo) / (hi - lo)));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * clamp(t, 0, 1);
}

function lerpRGBA(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
  t: number, op: number
): string {
  return `rgba(${Math.round(lerp(r1,r2,t))},${Math.round(lerp(g1,g2,t))},${Math.round(lerp(b1,b2,t))},${op.toFixed(2)})`;
}

/** Multi‑stop gradient interpolation */
function multiStop(stops: number[][], t: number, op: number): string {
  const n = stops.length - 1;
  const scaled = clamp(t, 0, 1) * n;
  const i = Math.min(Math.floor(scaled), n - 1);
  const tt = scaled - i;
  const [r1,g1,b1] = stops[i];
  const [r2,g2,b2] = stops[i + 1];
  return lerpRGBA(r1,g1,b1, r2,g2,b2, tt, op);
}

// Colour stops for each band
const NDVI_STOPS   = [[180,0,0],[239,68,68],[250,204,21],[163,230,53],[34,197,94],[21,128,61]];
const TEMP_STOPS   = [[34,197,94],[163,230,53],[250,204,21],[251,146,60],[239,68,68],[127,29,29]];
const RAIN_STOPS   = [[219,234,254],[147,197,253],[96,165,250],[59,130,246],[29,78,216],[30,27,75]];
const MOIST_STOPS  = [[146,64,14],[217,119,6],[253,224,71],[163,230,53],[34,197,94],[21,128,61]];
const WATER_STOPS  = [[224,242,254],[125,211,252],[14,165,233],[2,132,199],[7,89,133],[12,74,110]];

function bandToColor(band: number, val: number): string | null {
  if (val === null || val === undefined || isNaN(val)) return null;
  if (val === 0 && band !== 0 && band !== 6) return null;

  const n = stretch(val, band);

  switch (band) {
    case 0: {
      const op = 0.55 + n * 0.35;
      return multiStop(NDVI_STOPS, n, op);
    }
    case 1: {
      if (val <= 50)  return "rgba(37,99,235,0.80)";
      if (val <= 100) return "rgba(100,116,139,0.78)";
      if (val <= 150) return "rgba(74,222,128,0.78)";
      if (val <= 200) return "rgba(21,128,61,0.80)";
      return "rgba(251,191,36,0.78)";
    }
    case 2: {
      if (n < 0.05) return null;
      const op = 0.45 + n * 0.45;
      return multiStop(WATER_STOPS, n, op);
    }
    case 3: {
      return multiStop(TEMP_STOPS, n, 0.72);
    }
    case 4: {
      if (n < 0.04) return null;
      const op = 0.50 + n * 0.40;
      return multiStop(RAIN_STOPS, n, op);
    }
    case 5: {
      return multiStop(MOIST_STOPS, n, 0.75);
    }
    case 6: {
      return val > 0 ? "rgba(220,38,38,0.90)" : null;
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
    case 0: return raw.toFixed(2);
    case 1: { if (raw < 60) return "Water"; if (raw < 150) return "Urban"; return "Vegetation"; }
    case 2: return `${(raw / 255 * 100).toFixed(1)}%`;
    case 3: return `${(15 + (raw / 255) * 30).toFixed(1)}°C`;
    case 4: return `${(raw / 255 * 200).toFixed(1)} mm`;
    case 5: {
      console.log("Soil raw:", raw);
      // If values are 0–1 (fractional), multiply by 100 for percentage.
      // If values are already 0–100, use raw directly.
      return raw <= 1
        ? `${(raw * 100).toFixed(1)}%`
        : `${raw.toFixed(1)}%`;
    }
    default: return raw.toFixed(1);
  }
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb",
      borderRadius: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", ...style,
    }}>
      {children}
    </div>
  );
}

// ─── Dynamic analytics panel content ─────────────────────────────────────────

function AnalyticsContent({ activeLayer }: { activeLayer: number }) {
  const stats = useMemo(() => LAYER_STATS[activeLayer] ?? {}, [activeLayer]);
  const meta  = LAYERS.find(l => l.band === activeLayer) ?? LAYERS[0];

  const donutData = useMemo(() => {
    if (activeLayer === -1) return null;
    if ("good" in stats) return [
      { name: "Good",   value: stats.good,   color: "#22c55e" },
      { name: "Medium", value: stats.medium, color: "#facc15" },
      { name: "Bad",    value: stats.bad,    color: "#ef4444" },
    ];
    return null;
  }, [stats]);

  function SummaryCards() {
    if (activeLayer === -1) return (
      <>
        <SummaryGrid items={[
          { label: "Avg NDVI",     value: "0.61",    accent: "#22c55e", bg: "#f0fdf4", icon: Leaf },
          { label: "Avg Temp",     value: "31.4°C",  accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
          { label: "Water Cover",  value: "12.4%",   accent: "#0ea5e9", bg: "#f0f9ff", icon: Droplets },
          { label: "Soil Moist.",  value: "38.7%",   accent: "#84cc16", bg: "#f7fee7", icon: Sprout },
        ]} />
      </>
    );
    if (activeLayer === 0) return (
      <SummaryGrid items={[
        { label: "Avg NDVI",    value: stats.avg.toFixed(2),       accent: "#22c55e", bg: "#f0fdf4", icon: Leaf },
        { label: "Good Areas",  value: `${stats.good}%`,           accent: "#16a34a", bg: "#dcfce7", icon: Activity },
        { label: "Medium",      value: `${stats.medium}%`,         accent: "#ca8a04", bg: "#fefce8", icon: Activity },
        { label: "Poor Areas",  value: `${stats.bad}%`,            accent: "#dc2626", bg: "#fef2f2", icon: Activity },
      ]} />
    );
    if (activeLayer === 1) return (
      <SummaryGrid items={[
        { label: "Vegetation", value: `${stats.veg}%`,   accent: "#22c55e", bg: "#f0fdf4", icon: Leaf },
        { label: "Urban",      value: `${stats.urban}%`, accent: "#64748b", bg: "#f8fafc", icon: Map },
        { label: "Water",      value: `${stats.water}%`, accent: "#0ea5e9", bg: "#f0f9ff", icon: Droplets },
      ]} />
    );
    if (activeLayer === 2) return (
      <SummaryGrid items={[
        { label: "Coverage",  value: `${stats.coverage}%`, accent: "#0ea5e9", bg: "#f0f9ff", icon: Droplets },
        { label: "High",      value: `${stats.good}%`,     accent: "#0284c7", bg: "#e0f2fe", icon: Activity },
        { label: "Low",       value: `${stats.bad}%`,      accent: "#7dd3fc", bg: "#f0f9ff", icon: Activity },
      ]} />
    );
    if (activeLayer === 3) return (
      <SummaryGrid items={[
        { label: "Avg Temp",   value: `${stats.avg}°C`,    accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
        { label: "Cool Zones", value: `${stats.good}%`,    accent: "#22c55e", bg: "#f0fdf4", icon: Activity },
        { label: "Hot Zones",  value: `${stats.bad}%`,     accent: "#dc2626", bg: "#fef2f2", icon: Activity },
      ]} />
    );
    if (activeLayer === 4) return (
      <SummaryGrid items={[
        { label: "Total (Jun)", value: `${stats.total} mm`, accent: "#3b82f6", bg: "#eff6ff", icon: CloudRain },
        { label: "Peak Month",  value: "Jun",               accent: "#1d4ed8", bg: "#dbeafe", icon: Activity },
      ]} />
    );
    if (activeLayer === 5) return (
      <SummaryGrid items={[
        { label: "Avg Moisture", value: `${stats.avg}%`,   accent: "#84cc16", bg: "#f7fee7", icon: Sprout },
        { label: "Wet Zones",    value: `${stats.good}%`,  accent: "#16a34a", bg: "#f0fdf4", icon: Activity },
        { label: "Dry Zones",    value: `${stats.bad}%`,   accent: "#92400e", bg: "#fef3c7", icon: Activity },
      ]} />
    );
    if (activeLayer === 6) return (
      <SummaryGrid items={[
        { label: "Total Points", value: stats.count.toLocaleString(), accent: "#ef4444", bg: "#fef2f2", icon: MapPin },
        { label: "Largest Zone", value: "East (421)",                 accent: "#f97316", bg: "#fff7ed", icon: Activity },
      ]} />
    );
    return null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SummaryCards />
      {activeLayer === -1 && (
        <>
          <Card style={{ padding: "14px 16px" }}>
            <p style={sectionLabel}>Layer Overview</p>
            {[
              { label: "NDVI",         pct: 61, color: "#22c55e" },
              { label: "Water Cover",  pct: 12, color: "#38bdf8" },
              { label: "Urban",        pct: 32, color: "#94a3b8" },
              { label: "Vegetation",   pct: 50, color: "#4ade80" },
              { label: "Soil Moist.",  pct: 39, color: "#84cc16" },
            ].map(r => (
              <div key={r.label} style={{ marginBottom: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: "#475569" }}>{r.label}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#111827" }}>{r.pct}%</span>
                </div>
                <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${r.pct}%`, background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
                </div>
              </div>
            ))}
          </Card>
          <Card style={{ padding: "14px 16px" }}>
            <p style={sectionLabel}>Environmental Health</p>
            <ResponsiveContainer width="100%" height={88}>
              <BarChart
                data={[
                  { name: "NDVI",  value: 61 },
                  { name: "Water", value: 12 },
                  { name: "Temp",  value: 55 },
                  { name: "Rain",  value: 71 },
                  { name: "Soil",  value: 42 },
                ]}
                margin={{ top: 0, right: 0, bottom: 0, left: -24 }}
              >
                <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
                <ReTooltip contentStyle={tooltipStyle} itemStyle={{ color: "#374151" }} cursor={{ fill: "rgba(0,0,0,0.025)" }} />
                <Bar dataKey="value" fill="#22c55e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
      {donutData && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>{meta.name} Distribution</p>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ResponsiveContainer width={96} height={96}>
              <PieChart>
                <Pie data={donutData} cx="50%" cy="50%" innerRadius={25} outerRadius={43} dataKey="value" strokeWidth={0}>
                  {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <ReTooltip contentStyle={tooltipStyle} itemStyle={{ color: "#374151" }} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {donutData.map(d => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: d.color, flexShrink: 0, display: "inline-block" }} />
                  <span style={{ fontSize: 11, color: "#475569" }}>{d.name}</span>
                  <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto", paddingLeft: 8 }}>{d.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
      {activeLayer === 4 && stats.monthly && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Monthly Rainfall (mm)</p>
          <ResponsiveContainer width="100%" height={88}>
            <BarChart data={stats.monthly} margin={{ top: 0, right: 0, bottom: 0, left: -24 }}>
              <XAxis dataKey="month" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
              <ReTooltip contentStyle={tooltipStyle} itemStyle={{ color: "#374151" }} cursor={{ fill: "rgba(0,0,0,0.025)" }} />
              <Bar dataKey="mm" fill="#38bdf8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}
      {activeLayer === 1 && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Land Cover Breakdown</p>
          {[
            { label: "Vegetation", pct: stats.veg,   color: "#22c55e" },
            { label: "Urban",      pct: stats.urban,  color: "#94a3b8" },
            { label: "Water",      pct: stats.water,  color: "#38bdf8" },
          ].map(r => (
            <div key={r.label} style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: "#475569" }}>{r.label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#111827" }}>{r.pct}%</span>
              </div>
              <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${r.pct}%`, background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
              </div>
            </div>
          ))}
        </Card>
      )}
      {activeLayer === 6 && stats.clusters && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Points by Zone</p>
          <ResponsiveContainer width="100%" height={88}>
            <BarChart data={stats.clusters} margin={{ top: 0, right: 0, bottom: 0, left: -24 }}>
              <XAxis dataKey="zone" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} />
              <ReTooltip contentStyle={tooltipStyle} itemStyle={{ color: "#374151" }} cursor={{ fill: "rgba(0,0,0,0.025)" }} />
              <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}
      {activeLayer === 3 && (
        <Card style={{ padding: "14px 16px" }}>
          <p style={sectionLabel}>Temperature Range</p>
          <div style={{ height: 10, borderRadius: 99, background: "linear-gradient(to right, #22c55e, #facc15, #ef4444)", marginBottom: 6 }} />
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 9.5, color: "#22c55e", fontWeight: 600 }}>15°C Cool</span>
            <span style={{ fontSize: 9.5, color: "#facc15", fontWeight: 600 }}>30°C Warm</span>
            <span style={{ fontSize: 9.5, color: "#ef4444", fontWeight: 600 }}>45°C Hot</span>
          </div>
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#fff7ed", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <Thermometer size={14} color="#f97316" />
            <span style={{ fontSize: 12, color: "#111827", fontWeight: 600 }}>District Avg: {stats.avg}°C</span>
          </div>
        </Card>
      )}
      <Card style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        {(() => {
          const Icon = meta.icon;
          return (
            <div style={{ width: 32, height: 32, borderRadius: 9, background: "#e0f2fe", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon size={14} color="#0284c7" />
            </div>
          );
        })()}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{meta.name}</p>
          <p style={{ fontSize: 10, color: "#9ca3af" }}>{meta.desc}</p>
        </div>
        <div style={{ background: "#e0f2fe", borderRadius: 999, padding: "3px 10px", flexShrink: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#0284c7" }}>Active</span>
        </div>
      </Card>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12,
};
const tooltipStyle: React.CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 11,
};

function SummaryGrid({ items }: { items: { label: string; value: string; accent: string; bg: string; icon: React.ElementType }[] }) {
  const cols = items.length <= 2 ? "1fr 1fr" : items.length === 3 ? "1fr 1fr 1fr" : "1fr 1fr";
  return (
    <div style={{ display: "grid", gridTemplateColumns: cols, gap: 9 }}>
      {items.map(s => {
        const Icon = s.icon;
        return (
          <div key={s.label} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 1px 6px rgba(0,0,0,0.05)", padding: "11px 10px 9px" }}>
            <div style={{ background: s.bg, borderRadius: 8, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 7 }}>
              <Icon size={12} color={s.accent} />
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#111827", lineHeight: 1.2 }}>{s.value}</p>
            <p style={{ fontSize: 9.5, color: "#9ca3af", marginTop: 2 }}>{s.label}</p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Zoom + Basemap controls ──────────────────────────────────────────────────

function MapControls({ mapType, setMapType }: { mapType: MapType; setMapType: (t: MapType) => void }) {
  const map = useMap();

  const btnBase: React.CSSProperties = {
    width: 36, height: 34, background: "#fff", border: "none", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#374151", fontSize: 11, fontWeight: 600, transition: "background 0.12s",
  };

  function Divider() {
    return <div style={{ height: 1, background: "#e5e7eb" }} />;
  }

  return (
    <div style={{
      position: "absolute", top: 16, right: 16, zIndex: 600,
      display: "flex", flexDirection: "column",
      background: "#fff", border: "1px solid #e5e7eb",
      borderRadius: 13, boxShadow: "0 4px 18px rgba(0,0,0,0.09)",
      overflow: "hidden",
    }}>
      <button style={btnBase}
        onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
        onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
        onClick={() => map.zoomIn()} title="Zoom in">
        <Plus size={15} />
      </button>
      <Divider />
      <button style={btnBase}
        onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
        onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
        onClick={() => map.zoomOut()} title="Zoom out">
        <Minus size={15} />
      </button>
      <div style={{ height: 6 }} />
      <div style={{ height: 1, background: "#e5e7eb" }} />
      <div style={{ height: 2 }} />
      {BASEMAPS.map((bm, i) => {
        const Icon = bm.icon;
        const active = mapType === bm.id;
        return (
          <div key={bm.id}>
            {i > 0 && <Divider />}
            <button
              style={{
                ...btnBase,
                background: active ? "#e0f2fe" : "#fff",
                color: active ? "#0284c7" : "#6b7280",
                fontWeight: active ? 700 : 500,
              }}
              onClick={() => setMapType(bm.id)}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#fff"; }}
              title={bm.label}
            >
              <Icon size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Basemap tiles ────────────────────────────────────────────────────────────

function BasemapTiles({ mapType }: { mapType: MapType }) {
  if (mapType === "osm") {
    return <TileLayer
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      maxZoom={22}
      attribution="© OpenStreetMap contributors"
    />;
  }
  if (mapType === "satellite") {
    return <TileLayer
      url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      maxZoom={22}
      attribution="© Esri"
    />;
  }
  return (
    <>
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        maxZoom={22}
        attribution="© Esri"
      />
      <TileLayer
        url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
        maxZoom={22}
        opacity={0.9}
        attribution=""
      />
    </>
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
        if (col < 0 || col >= width || row < 0 || row >= height) { onPixelHover(null); return; }
        onPixelHover(values.map((b: number[][]) => b[row]?.[col] ?? NaN));
      } catch { onPixelHover(null); }
    },
    mouseout() { onPixelHover(null); },
  });

  useEffect(() => {
    if (layerRef.current) {
      layerRef.current.redraw();
    }
  }, [band]);

  useEffect(() => {
    let cancelled = false;

    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }

    fetch(url)
      .then(r => r.arrayBuffer())
      .then(async buf => {
        if (cancelled) return;

        const gr: any = await parseGeoraster(buf);
        if (cancelled) return;

        georasterRef.current = gr;
        onLoad();

        const newLayer = new GeoRasterLayer({
          georaster: gr,
          opacity: 0.74,
          resolution: 256,
          keepBuffer: 0,
          updateWhenZooming: true,
          updateWhenIdle: false,
          pixelValuesToColorFn: (vals: number[]) => {
            if (!vals || !vals.length) return null;

            // ALL mode: render NDVI-based green heatmap
            if (band === -1) {
              const ndvi = vals[0];
              if (ndvi === null || ndvi === undefined || isNaN(ndvi)) return null;
              const n = Math.max(0, Math.min(1, (ndvi + 1) / 2)); // normalize -1..1 → 0..1
              return `rgba(34,197,94,${(0.4 + n * 0.5).toFixed(2)})`; // green heatmap
            }

            const value = vals[band];
            return bandToColor(band, value);
          },
        });

        newLayer.addTo(map);
        layerRef.current = newLayer;

        newLayer.redraw();
      })
      .catch(console.error);

    const onZoomEnd = () => {
      if (layerRef.current) {
        layerRef.current.redraw();
      }
    };
    map.on("zoomend", onZoomEnd);

    return () => {
      cancelled = true;
      map.off("zoomend", onZoomEnd);
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      georasterRef.current = null;
    };
  }, [url, band]);

  return null;
}

// ─── Layers dropdown ──────────────────────────────────────────────────────────

function LayersDropdown({ activeLayer, onSelect }: { activeLayer: number; onSelect: (b: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeMeta = LAYERS.find(l => l.band === activeLayer) ?? LAYERS[0];

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position: "absolute", top: 16, left: 16, zIndex: 700 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
          padding: "8px 14px", boxShadow: "0 4px 16px rgba(0,0,0,0.09)",
          cursor: "pointer", transition: "box-shadow 0.15s",
        }}
        onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 6px 22px rgba(0,0,0,0.13)")}
        onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.09)")}
      >
        <Layers size={14} color="#0ea5e9" />
        <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{activeMeta.name}</span>
        <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 2 }}>▾</span>
      </button>
      <div style={{
        position: "absolute", top: "calc(100% + 8px)", left: 0,
        background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16,
        boxShadow: "0 8px 32px rgba(0,0,0,0.11)", minWidth: 212,
        overflow: "hidden",
        opacity: open ? 1 : 0,
        transform: open ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.97)",
        pointerEvents: open ? "auto" : "none",
        transition: "opacity 0.18s, transform 0.18s",
      }}>
        <div style={{ padding: "10px 14px 6px" }}>
          <p style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Select Layer
          </p>
        </div>
        {LAYERS.map(layer => {
          const Icon = layer.icon;
          const active = activeLayer === layer.band;
          return (
            <button
              key={layer.band}
              onClick={() => { onSelect(layer.band); setOpen(false); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "8px 14px", border: "none", cursor: "pointer",
                background: active ? "#f0f9ff" : "transparent",
                color: active ? "#0284c7" : "#374151",
                fontSize: 12, fontWeight: active ? 600 : 500,
                textAlign: "left", transition: "background 0.10s",
              }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: layer.dotColor, flexShrink: 0, display: "inline-block" }} />
              <Icon size={13} color={active ? "#0284c7" : "#9ca3af"} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: active ? 600 : 500 }}>{layer.name}</div>
                <div style={{ fontSize: 10, color: "#9ca3af" }}>{layer.desc}</div>
              </div>
              {active && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0ea5e9", flexShrink: 0, display: "inline-block" }} />}
            </button>
          );
        })}
        <div style={{ height: 6 }} />
      </div>
    </div>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

const TOOLTIP_FIELDS: { label: string; band: number; color: string }[] = [
  { label: "NDVI",         band: 0, color: "#22c55e" },
  { label: "LULC",         band: 1, color: "#94a3b8" },
  { label: "Water",        band: 2, color: "#38bdf8" },
  { label: "Temperature",  band: 3, color: "#f97316" },
  { label: "Rainfall",     band: 4, color: "#3b82f6" },
  { label: "Soil Moisture",band: 5, color: "#a16207" },
];

function MapTooltip({ pixelVals, mousePos, activeLayer }: { pixelVals: number[] | null; mousePos: { x: number; y: number }; activeLayer: number }) {
  if (!pixelVals) return null;

  // ALL mode: show all fields; specific layer: show only that layer
  const fieldsToShow =
    activeLayer === -1
      ? TOOLTIP_FIELDS
      : TOOLTIP_FIELDS.filter(f => f.band === activeLayer);

  return (
    <div className="pointer-events-none fixed z-[9999]" style={{ left: mousePos.x + 18, top: mousePos.y + 18 }}>
      <div style={{
        background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
        boxShadow: "0 8px 28px rgba(0,0,0,0.10)", padding: "10px 14px", minWidth: 188,
      }}>
        <p style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
          {activeLayer === -1 ? "All Pixel Values" : "Pixel Value"}
        </p>
        {fieldsToShow.map(f => (
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Nagpur() {
  const [activeLayer, setActiveLayer] = useState<number>(-1);
  const [loading,     setLoading]     = useState(true);
  const [pixelVals,   setPixelVals]   = useState<number[] | null>(null);
  const [mousePos,    setMousePos]    = useState({ x: 0, y: 0 });
  const [mapType,     setMapType]     = useState<MapType>("osm");
  const [fadeKey,     setFadeKey]     = useState(0);

  const activeMeta = LAYERS.find(l => l.band === activeLayer) ?? LAYERS[0];
  const stats      = useMemo(() => LAYER_STATS[activeLayer] ?? {}, [activeLayer]);

  const handleSelect = useCallback((band: number) => {
    setActiveLayer(band);
    setLoading(true);
    setFadeKey(k => k + 1);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [handleMouseMove]);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%", fontFamily: "'Inter', system-ui, sans-serif", overflow: "hidden", background: "#f1f5f9" }}>

      {/* ── Map ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", cursor: "crosshair" }}>

        <style>{`
          @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
          @keyframes spin    { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
          .layer-fade { animation: fadeIn 0.35s ease; }
        `}</style>

        {loading && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            background: "rgba(248,250,252,0.84)", backdropFilter: "blur(6px)",
          }}>
            <div style={{ animation: "spin 1s linear infinite", display: "flex", marginBottom: 10 }}>
              <Layers size={32} color="#0ea5e9" />
            </div>
            <p style={{ color: "#475569", fontSize: 13, fontWeight: 500 }}>Loading {activeMeta.name}…</p>
          </div>
        )}

        <div key={fadeKey} className="layer-fade" style={{ width: "100%", height: "100%" }}>
          <MapContainer
            center={[21.1458, 79.0882] as [number, number]}
            zoom={10}
            maxZoom={22}
            style={{ width: "100%", height: "100vh" }}
            zoomControl={false}
          >
            <BasemapTiles mapType={mapType} />
            <GeoTiffLayer
              key={activeLayer}
              url="/Nagpur_2025.tif"
              band={activeLayer}
              onLoad={() => setLoading(false)}
              onPixelHover={setPixelVals}
            />
            <MapControls mapType={mapType} setMapType={setMapType} />
          </MapContainer>
        </div>

        <LayersDropdown activeLayer={activeLayer} onSelect={handleSelect} />

        <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 600, pointerEvents: "none" }}>
          <div style={{
            background: "rgba(255,255,255,0.95)", border: "1px solid #e5e7eb",
            borderRadius: 999, padding: "5px 14px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: activeMeta.dotColor, display: "inline-block" }} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#374151" }}>{activeMeta.name}</span>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>· {activeMeta.desc}</span>
          </div>
        </div>

        <div style={{ position: "absolute", bottom: 24, left: 16, zIndex: 500 }}>
          <Card style={{ padding: "12px 16px", minWidth: 212 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <Activity size={12} color="#0ea5e9" />
              <span style={{ fontSize: 9.5, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Environmental Health
              </span>
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 9 }}>{activeMeta.name}</p>
            <div style={{ display: "flex", height: 6, borderRadius: 99, overflow: "hidden", gap: 2 }}>
              <div style={{ background: "#22c55e", width: `${stats.good ?? 50}%`, borderRadius: "99px 0 0 99px", transition: "width 0.5s" }} />
              <div style={{ background: "#facc15", width: `${stats.medium ?? 30}%`, transition: "width 0.5s" }} />
              <div style={{ background: "#ef4444", width: `${stats.bad ?? 20}%`, borderRadius: "0 99px 99px 0", transition: "width 0.5s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
              {([ ["Good", `${stats.good ?? 50}%`, "#16a34a"], ["Mid", `${stats.medium ?? 30}%`, "#ca8a04"], ["Poor", `${stats.bad ?? 20}%`, "#dc2626"] ] as [string, string, string][])
                .map(([l, p, c]) => <span key={l} style={{ fontSize: 9, color: c, fontWeight: 600 }}>{l} {p}</span>)}
            </div>
          </Card>
        </div>

        <MapTooltip pixelVals={pixelVals} mousePos={mousePos} activeLayer={activeLayer} />
      </div>

      {/* ── Right Analytics Panel ─────────────────────────────────────────── */}
      <aside style={{
        width: 272, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "#f8fafc", borderLeft: "1px solid #e5e7eb", overflowY: "auto", zIndex: 10,
      }}>
        <div style={{ padding: "18px 16px 12px", borderBottom: "1px solid #e5e7eb", background: "#fff" }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Analytics</p>
          <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Nagpur District · 2025</p>
        </div>
        <div style={{ padding: "12px 12px 20px" }}>
          <AnalyticsContent activeLayer={activeLayer} />
        </div>
      </aside>
    </div>
  );
}
