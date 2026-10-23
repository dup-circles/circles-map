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
  lng: "fldw2oxwHsjLzuTkU", id: "fldBLjQIZ12zpUnH6", publicar: "fldnnKsIDR9RLnomK",
  paisCod: "fldofhJb4Cy1nyEyT"
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

const cache = new Map();
async function geocodificar(q, pais = "") {
  const clave = `${q}|${pais}`;
  if (cache.has(clave)) return cache.get(clave);
  let u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(q)}`;
  if (pais) u += `&countrycodes=${pais.toLowerCase()}`;
  let res = null;
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (r.ok) { const j = await r.json(); if (j[0]) res = { lat: +j[0].lat, lng: +j[0].lon }; }
  } catch (e) { res = null; }
  await sleep(1100); // política de Nominatim: 1 pedido por segundo
  cache.set(clave, res);
  return res;
}

// Limpieza de datos cargados a mano
const limpiarCiudad = c => {
  c = txt(c).replace(/\([^)]*\)/g, " ");
  if (c.includes(" - ")) c = c.split(" - ").pop();
  return c.replace(/\b(area|region|zone)\b/ig, " ").replace(/\s+/g, " ").trim();
};
const limpiarCalle = c => {
  const lineas = txt(c).split(/\r?\n/).map(l => l.replace(/\([^)]*\)/g, " ").trim())
    .filter(l => l && !/(to be determined|tbd|unknown|none|call for|varies|variable|various|rotating|online|zoom)/i.test(l));
  return (lineas[0] || "").replace(/\s+/g, " ").trim();
};
const limpiarPais = p => /^(other|otro|none|unknown)$/i.test(txt(p)) ? "" : txt(p);

async function buscarExacta(f) {
  const calle = limpiarCalle(f[F.calle]), ciudad = limpiarCiudad(f[F.ciudad]), venue = txt(f[F.venue]).split(/\r?\n/)[0];
  const estado = txt(f[F.estado]), pais = limpiarPais(f[F.pais]), cp = txt(f[F.cp]);
  const cod = /^[A-Z]{2}$/.test(txt(f[F.paisCod])) ? txt(f[F.paisCod]) : "";
  const variantes = [];
  if (calle && ciudad) {
    variantes.push([calle, ciudad, estado, cp, pais], [calle, ciudad, estado, pais], [calle, ciudad, pais]);
  }
  if (calle && cp) variantes.push([calle, cp, pais]);
  if (venue && ciudad && !/^(none|unknown|variable)/i.test(venue)) variantes.push([venue, ciudad, pais]);
  const vistas = new Set();
  for (const v of variantes) {
    const q = v.filter(Boolean).join(", ");
    if (vistas.has(q)) continue; vistas.add(q);
    const p = await geocodificar(q, cod);
    if (p) return p;
  }
  return null;
}
async function buscarAproximada(f) {
  const ciudad = limpiarCiudad(f[F.ciudad]), estado = txt(f[F.estado]), pais = limpiarPais(f[F.pais]);
  const cod = /^[A-Z]{2}$/.test(txt(f[F.paisCod])) ? txt(f[F.paisCod]) : "";
  for (const v of [[ciudad, estado, pais], [ciudad, pais], [estado, pais]]) {
    if (!v[0]) continue;
    const p = await geocodificar(v.filter(Boolean).join(", "), cod);
    if (p) return p;
  }
  return null;
}

const records = await leerTodo();
console.log(`Círculos en Airtable: ${records.length}`);

// --- Coordenadas ---------------------------------------------------------------
const APROX_VIEJO = "Ubicación aproximada (centro de la ciudad): revisar dirección";
const APROX = "Ubicación aproximada (centro de la ciudad). Si corregís la dirección, borrá Latitude y Longitude para que el robot vuelva a buscar";
const NO_ENCONTRADA = "Dirección no encontrada: corregirla o cargar Latitude y Longitude a mano";
const cambios = [];
let ubicados = 0, mejorados = 0, aproximados = 0, sinUbicar = 0;
for (const rec of records) {
  const f = rec.fields;
  const tiene = num(f[F.lat]) !== null && num(f[F.lng]) !== null;
  const estado = txt(f[ESTADO_ID]);
  if (tiene && estado !== APROX_VIEJO) continue;   // ya ubicado (o aproximado ya revisado)
  const exacta = await buscarExacta(f);
  if (exacta) {
    tiene ? mejorados++ : ubicados++;
    cambios.push({ id: rec.id, fields: { [F.lat]: exacta.lat.toFixed(6), [F.lng]: exacta.lng.toFixed(6), [ESTADO_CAMPO]: "" } });
    f[F.lat] = exacta.lat.toFixed(6); f[F.lng] = exacta.lng.toFixed(6);
    continue;
  }
  if (tiene) { cambios.push({ id: rec.id, fields: { [ESTADO_CAMPO]: APROX } }); aproximados++; continue; }
  const aprox = await buscarAproximada(f);
  if (aprox) {
    aproximados++;
    cambios.push({ id: rec.id, fields: { [F.lat]: aprox.lat.toFixed(6), [F.lng]: aprox.lng.toFixed(6), [ESTADO_CAMPO]: APROX } });
    f[F.lat] = aprox.lat.toFixed(6); f[F.lng] = aprox.lng.toFixed(6);
  } else {
    sinUbicar++;
    if (estado !== NO_ENCONTRADA) cambios.push({ id: rec.id, fields: { [ESTADO_CAMPO]: NO_ENCONTRADA } });
  }
}
for (let i = 0; i < cambios.length; i += 10) {
  await airtable("", { method: "PATCH", body: JSON.stringify({ records: cambios.slice(i, i + 10) }) });
}
console.log(`Coordenadas: ${ubicados} nuevas exactas, ${mejorados} aproximadas mejoradas a exactas, ${aproximados} aproximadas, ${sinUbicar} sin ubicar`);

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
