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
  nombre: "fld7jaJ1WUIMxBJsn", pais: "fldhHXURpXbNZ6c29",
  ciudad: "fldUykq6i4GoXeFao", venue: "fldev2BGQTJGrSnHP", calle: "fldt4ijqNaIdDhnBa",
  cp: "fldr1blVgWKDirB1u", nombrePila: "fldhYkfdsW7Rjk1yk", apellido: "fldefHPlN5ADQwdrI",
  tel: "fldjasftvLh7VbD8Y", email: "fldYpkAFaKUsuLolJ", frecuencia: "fldgg4vQNNs4oCFMQ",
  comentarios: "fldtMpMezNjpJXBD5", web: "fldunr9AuPPO9FVV6",
  modificado: "fldhjjNPI1QdWoRza", foto: "fldFHNtdJyBcuGCno", lat: "fldmtlBCkoXSVTR3M",
  lng: "fldw2oxwHsjLzuTkU", id: "fldBLjQIZ12zpUnH6", publicar: "fldnnKsIDR9RLnomK"
};
const ESTADO_CAMPO = "Estado mapa";
const ESTADO_ID = "flddkFIbasxUUPuE0";
const UA = "DUP-mapa-circulos/1.0 (https://github.com/dup-circles/circles-map)";
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
// Link de la web: acepta "https://…", "www.…" o "dominio.org/…" (sin el campo de IA "website fixed").
// Los dominios sin "https://" solo valen con terminaciones conocidas, para no convertir "St.Louis" o "Ithaca.NY" en links.
const TLD = new Set("com org net edu gov info io co me app art life community center church online site world earth love dance de uk fr es it nl be ch at au nz ca us ar mx br cl uy pe co ie se dk no fi pl cz pt gr hu ro ru jp in za il tr eu".split(" "));
const urlDe = v => {
  const t = txt(v);
  const m = t.match(/https?:\/\/[^\s<>"\]]+/);
  if (m) return m[0].replace(/[.,;)]+$/, "");   // saca el ")" final de links con formato [texto](link)
  const sinMails = t.replace(/\S+@\S+/g, " ");
  for (const d of sinMails.matchAll(/\b(?:www\.)?[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.([a-z]{2,})(?:\/[^\s<>"]*)?/g))
    if (TLD.has(d[1]) || d[0].startsWith("www.")) return "https://" + d[0].replace(/[.,;)]+$/, "");
  return "";
};

// Código de país (ISO de 2 letras) a partir del nombre escrito, sin el campo de IA "country ab".
// Usa los nombres de países que trae Node en varios idiomas, más algunos alias comunes.
const sinTildes = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\b(and|the)\b/g, " ").replace(/\s+/g, " ").trim();
const CODIGOS = new Map();
{
  const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const NO_ISO = new Set("AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH NT QO RH SU TA TP UK UN VD XA XB YD YU ZR ZZ".split(" "));
  const idiomas = ["en", "es", "fr", "de", "it", "pt", "nl", "sv", "da", "nb", "fi", "pl", "cs", "hu", "tr", "ro"].map(l => new Intl.DisplayNames([l], { type: "region" }));
  for (const a of letras) for (const b of letras) {
    const c = a + b;
    if (NO_ISO.has(c)) continue;   // códigos reservados o viejos (UK, FX, EU…): Nominatim no los usa
    for (const dn of idiomas) {
      let n; try { n = dn.of(c); } catch { continue; }
      if (n && n !== c) CODIGOS.set(sinTildes(n), c);
    }
  }
  const alias = { "usa": "US", "us": "US", "u s a": "US", "united states of america": "US", "america": "US",
    "uk": "GB", "u k": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB", "great britain": "GB",
    "holland": "NL", "deutschland": "DE", "turkey": "TR", "czech republic": "CZ", "russia": "RU", "south korea": "KR", "korea": "KR",
    "russian federation": "RU", "hong kong": "HK", "macau": "MO", "macao": "MO", "macedonia": "MK", "ivory coast": "CI", "palestine": "PS",
    "aotearoa": "NZ", "burma": "MM", "swaziland": "SZ", "cape verde": "CV", "east timor": "TL", "vatican": "VA",
    "congo democratic republic of": "CD", "democratic republic of congo": "CD" };
  for (const [k, v] of Object.entries(alias)) CODIGOS.set(k, v);
}
// Acepta también la forma "Korea, Republic of" / "Iran, Islamic Republic of" (usa lo que va antes de la coma)
const codigoPais = p => { const t = txt(p); return CODIGOS.get(sinTildes(t)) || CODIGOS.get(sinTildes(t.split(",")[0])) || ""; };

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

const cacheP = new Map();
async function photon(q, pais = "") {
  const clave = `${q}|${pais}`;
  if (cacheP.has(clave)) return cacheP.get(clave);
  let res = null;
  try {
    const r = await fetch(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA } });
    if (r.ok) {
      const j = await r.json();
      const ok = (j.features || []).find(ft => {
        const p = ft.properties || {};
        if (pais && (p.countrycode || "").toUpperCase() !== pais) return false;
        return p.type === "house" || p.type === "street" || !["place", "boundary"].includes(p.osm_key);
      });
      if (ok) res = { lat: ok.geometry.coordinates[1], lng: ok.geometry.coordinates[0] };
    }
  } catch (e) { res = null; }
  await sleep(1100);
  cacheP.set(clave, res);
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

// Punto de referencia de la ciudad (con código postal si hay) para descartar resultados en otra ciudad
const MAX_KM = 30;
const distKm = (a, b) => {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
async function referencia(f) {
  const ciudad = limpiarCiudad(f[F.ciudad]), pais = limpiarPais(f[F.pais]), cp = txt(f[F.cp]);
  const cod = codigoPais(f[F.pais]);
  if (!ciudad) return null;
  if (cp) { const p = await geocodificar([ciudad, cp, pais].filter(Boolean).join(", "), cod); if (p) return p; }
  return geocodificar([ciudad, pais].filter(Boolean).join(", "), cod);
}
const cerca = (p, ref) => !ref || distKm(p, ref) <= MAX_KM;

async function buscarExacta(f) {
  const calle = limpiarCalle(f[F.calle]), ciudad = limpiarCiudad(f[F.ciudad]), venue = txt(f[F.venue]).split(/\r?\n/)[0];
  const pais = limpiarPais(f[F.pais]), cp = txt(f[F.cp]);
  const cod = codigoPais(f[F.pais]);
  const variantes = [];
  if (calle && ciudad) {
    variantes.push([calle, ciudad, cp, pais], [calle, ciudad, pais]);
  }
  if (calle && cp) variantes.push([calle, cp, pais]);
  if (venue && ciudad && !/^(none|unknown|variable)/i.test(venue)) variantes.push([venue, ciudad, pais]);
  const consultas = [...new Set(variantes.map(v => v.filter(Boolean).join(", ")))];
  if (!consultas.length) return null;
  const ref = await referencia(f);
  for (const q of consultas) { const p = await geocodificar(q, cod); if (p && cerca(p, ref)) return p; }
  for (const q of consultas) { const p = await photon(q, cod); if (p && cerca(p, ref)) return p; }   // segundo buscador
  return null;
}
async function buscarAproximada(f) {
  const ciudad = limpiarCiudad(f[F.ciudad]), cp = txt(f[F.cp]), pais = limpiarPais(f[F.pais]);
  const cod = codigoPais(f[F.pais]);
  for (const v of [[ciudad, cp, pais], [ciudad, pais]]) {
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
const APROX_ANTERIOR = "Ubicación aproximada (centro de la ciudad). Si corregís la dirección, borrá Latitude y Longitude para que el robot vuelva a buscar";
const APROX = "Ubicación aproximada (centro de la ciudad): no se encontró la dirección exacta. Si la corregís, borrá Latitude y Longitude para que el robot vuelva a buscar";
const NO_ENCONTRADA = "Dirección no encontrada: corregirla o cargar Latitude y Longitude a mano";
const cambios = [];
let ubicados = 0, mejorados = 0, aproximados = 0, sinUbicar = 0;
for (const rec of records) {
  const f = rec.fields;
  const tiene = num(f[F.lat]) !== null && num(f[F.lng]) !== null;
  const estado = txt(f[ESTADO_ID]);
  if (tiene && estado !== APROX_VIEJO && estado !== APROX_ANTERIOR) continue;   // ya ubicado, o aproximado ya revisado
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
// --- Revisión opcional: pines a más de 30 km de su ciudad (se activa desde el botón Run workflow) ---
let lejos = 0;
if (process.env.REVISAR === "1") {
  const tocados = new Set(cambios.map(c => c.id));
  for (const rec of records) {
    const f = rec.fields;
    if (tocados.has(rec.id) || txt(f[ESTADO_ID])) continue;   // solo los que no tienen aviso
    const lat = num(f[F.lat]), lng = num(f[F.lng]);
    if (lat === null || lng === null) continue;
    const ref = await referencia(f);
    if (!ref) continue;
    const d = distKm({ lat, lng }, ref);
    if (d > MAX_KM) {
      lejos++;
      cambios.push({ id: rec.id, fields: { [ESTADO_CAMPO]: `Revisar ubicación: el pin está a ${Math.round(d)} km de ${limpiarCiudad(f[F.ciudad])}` } });
    }
  }
  console.log(`Revisión: ${lejos} pines lejos de su ciudad`);
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
  const direccion = [txt(f[F.calle]), txt(f[F.ciudad]), txt(f[F.cp]), txt(f[F.pais])].filter(Boolean).join(", ");
  publicados.push({
    id, nombre: txt(f[F.nombre]), pais: txt(f[F.pais]), ciudad: txt(f[F.ciudad]), venue: txt(f[F.venue]),
    direccion, contacto, telefono: txt(f[F.tel]), email: txt(f[F.email]),
    frecuencia: txt(f[F.frecuencia]), comentarios: txt(f[F.comentarios]),
    web: urlDe(f[F.web]),
    actualizado: txt(f[F.modificado]).slice(0, 10), foto, lat, lng,
    aprox: /aproximad|centro de/i.test(txt(f[ESTADO_ID])),   // ubicación aproximada: el mapa la muestra distinta
    sinDireccion: !limpiarCalle(f[F.calle])                  // no hay dirección real (Unknown, "contact for details", etc.)
  });
}
await writeFile(`${OUT}/data/circulos.json`, JSON.stringify(publicados));
console.log(`Publicados en el mapa: ${publicados.length} (fotos: ${fotosOk} ok, ${fotosError} con error)`);
