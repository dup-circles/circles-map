// Robot del mapa de círculos DUP
// 1) Lee todos los círculos de Airtable
// 2) Calcula coordenadas faltantes (Nominatim / OpenStreetMap) y las guarda en Airtable
// 3) Descarga las fotos de los círculos publicados
// 4) Escribe sitio/data/circulos.json para la página
//
// Solo escribe en Airtable los campos Latitude, Longitude y "Estado mapa".

import { mkdir, writeFile, copyFile } from "node:fs/promises";

const TOKEN = process.env.AIRTABLE_TOKEN;
if (!TOKEN) { console.error("Falta el secreto AIRTABLE_TOKEN"); process.exit(1); }

const BASE = "appSias45AaIRiFWA";
const TABLE = "tblXjtZI857HIqarB";
const F = {
  nombre: "fld7jaJ1WUIMxBJsn", pais: "fldhHXURpXbNZ6c29", estado: "fld5qBILDvP6XzfZT",
  ciudad: "fldUykq6i4GoXeFao", venue: "fldev2BGQTJGrSnHP", calle: "fldt4ijqNaIdDhnBa",
  cp: "fldr1blVgWKDirB1u", nombrePila: "fldhYkfdsW7Rjk1yk", apellido: "fldefHPlN5ADQwdrI",
  tel: "fldjasftvLh7VbD8Y", email: "fldYpkAFaKUsuLolJ", frecuencia: "fldgg4vQNNs4oCFMQ",
  comentarios: "fldtMpMezNjpJXBD5", web: "fldunr9AuPPO9FVV6", webFixed: "fldm0DYk9RjAdV2QT",
  modificado: "fldhjjNPI1QdWoRza", foto: "fldFHNtdJyBcuGCno", lat: "fldmtlBCkoXSVTR3M",
  lng: "fldw2oxwHsjLzuTkU", id: "fldBLjQIZ12zpUnH6", publicar: "fldnnKsIDR9RLnomK"
};
const ESTADO_CAMPO = "Estado mapa";
const ESTADO_ID = "flddkFIbasxUUPuE0";
const UA = "DUP-mapa-circulos/1.0 (https://github.com/matias-dup/mapa-circulos)";
const OUT = "sitio";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = v => {
  if (v == null) return "";
  if (typeof v === "object" && "value" in v) v = v.value;   // campos de IA
  if (Array.isArray(v)) v = v.join(", ");
  v = String(v).trim();
  return /^(none|unknown|n\/a|-)$/i.test(v) ? "" : v;
};
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const urlDe = v => { const m = txt(v).match(/https?:\/\/[^\s<>"]+/); return m ? m[0] : ""; };

async function airtable(path, opts = {}) {
  for (let intento = 0; intento < 5; intento++) {
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) }
    });
    if (r.status === 429) { await sleep(30000); continue; }
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
    await sleep(250); // máximo 5 pedidos por segundo
    return r.json();
  }
  throw new Error("Airtable: demasiados pedidos seguidos");
}

async function leerTodo() {
  const out = []; let offset = "";
  do {
    const q = `?pageSize=100&returnFieldsByFieldId=true${offset ? `&offset=${offset}` : ""}`;
    const res = await airtable(q);
    out.push(...res.records); offset = res.offset || "";
  } while (offset);
  return out;
}

async function geocodificar(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  await sleep(1100); // política de Nominatim: 1 pedido por segundo
  if (!r.ok) return null;
  const j = await r.json();
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}

const records = await leerTodo();
console.log(`Círculos en Airtable: ${records.length}`);

// --- Coordenadas faltantes ---------------------------------------------------
const cambios = [];
let ubicados = 0, aproximados = 0, sinUbicar = 0;
for (const rec of records) {
  const f = rec.fields;
  if (num(f[F.lat]) !== null && num(f[F.lng]) !== null) continue;
  const calle = txt(f[F.calle]).replace(/\([^)]*\)/g, "").trim();
  const ciudad = txt(f[F.ciudad]), estado = txt(f[F.estado]), pais = txt(f[F.pais]), cp = txt(f[F.cp]);
  let punto = null, nota = "";
  if (calle && ciudad) punto = await geocodificar([calle, ciudad, estado, cp, pais].filter(Boolean).join(", "));
  if (!punto && ciudad) {
    punto = await geocodificar([ciudad, estado, pais].filter(Boolean).join(", "));
    if (punto) nota = "Ubicación aproximada (centro de la ciudad): revisar dirección";
  }
  if (punto) {
    if (nota) aproximados++; else ubicados++;
    cambios.push({ id: rec.id, fields: { [F.lat]: punto.lat.toFixed(6), [F.lng]: punto.lng.toFixed(6), [ESTADO_CAMPO]: nota } });
    f[F.lat] = punto.lat.toFixed(6); f[F.lng] = punto.lng.toFixed(6);
  } else {
    sinUbicar++;
    const aviso = "Dirección no encontrada: corregirla o cargar Latitude y Longitude a mano";
    if (txt(f[ESTADO_ID]) !== aviso) cambios.push({ id: rec.id, fields: { [ESTADO_CAMPO]: aviso } });
  }
}
for (let i = 0; i < cambios.length; i += 10) {
  await airtable("", { method: "PATCH", body: JSON.stringify({ records: cambios.slice(i, i + 10) }) });
}
console.log(`Coordenadas nuevas: ${ubicados} exactas, ${aproximados} aproximadas, ${sinUbicar} sin ubicar`);

// --- Datos y fotos de los círculos publicados -------------------------------------
await mkdir(`${OUT}/data`, { recursive: true });
await mkdir(`${OUT}/fotos`, { recursive: true });
await copyFile("index.html", `${OUT}/index.html`);

const publicados = [];
let fotosOk = 0, fotosError = 0;
for (const rec of records) {
  const f = rec.fields;
  if (!f[F.publicar]) continue;
  const lat = num(f[F.lat]), lng = num(f[F.lng]);
  if (lat === null || lng === null) continue;
  const id = f[F.id];
  let foto = "";
  const adj = Array.isArray(f[F.foto]) ? f[F.foto][0] : null;
  if (adj) {
    try {
      const url = adj.thumbnails?.large?.url || adj.url;
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      const ext = (r.headers.get("content-type") || "").includes("png") ? "png" : "jpg";
      foto = `${id}.${ext}`;
      await writeFile(`${OUT}/fotos/${foto}`, Buffer.from(await r.arrayBuffer()));
      fotosOk++;
    } catch (e) { foto = ""; fotosError++; }
  }
  const contacto = [txt(f[F.nombrePila]), txt(f[F.apellido])].filter(Boolean).join(" ");
  const direccion = [txt(f[F.calle]), txt(f[F.ciudad]), txt(f[F.estado]), txt(f[F.pais])].filter(Boolean).join(", ");
  publicados.push({
    id, nombre: txt(f[F.nombre]), pais: txt(f[F.pais]), ciudad: txt(f[F.ciudad]), venue: txt(f[F.venue]),
    direccion, contacto, telefono: txt(f[F.tel]), email: txt(f[F.email]),
    frecuencia: txt(f[F.frecuencia]), comentarios: txt(f[F.comentarios]),
    web: urlDe(f[F.webFixed]) || urlDe(f[F.web]),
    actualizado: txt(f[F.modificado]).slice(0, 10), foto, lat, lng
  });
}
await writeFile(`${OUT}/data/circulos.json`, JSON.stringify(publicados));
console.log(`Publicados en el mapa: ${publicados.length} (fotos: ${fotosOk} ok, ${fotosError} con error)`);
