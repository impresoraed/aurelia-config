'use strict';
if (+process.versions.node.split('.')[0] < 16) { console.error('\n*** Este servidor necesita Node.js 16 o más nuevo (tienes el ' + process.versions.node + '). Descarga la versión LTS de https://nodejs.org\n'); process.exit(1); }
/* =====================================================================================================
   SERVIDOR DE LEGADOS DE AURELIA (fase 1: cuentas, códigos de invitación, personajes y guardado)
   - Se arranca con INICIAR_SERVIDOR.bat (o «node servidor.js»). Solo necesita Node.js: no hay que instalar nada más.
   - Todo se guarda en la carpeta «datos»: base_de_datos.json (cuentas y personajes), copias de seguridad
     en «datos/copias», el registro de actividad en «datos/registro.log» y la lista de códigos en «datos/codigos_invitacion.txt».
   - Mientras está abierto, en esta ventana se pueden escribir comandos de administrador: escribe «ayuda».
   ===================================================================================================== */
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), os = require('os'), readline = require('readline');
const WS = require('./ws_mini');

const PROTO = 1;                    // versión del protocolo juego↔servidor (la misma que NET_PROTO en index.html)
const SES_TTL = 24 * 3600 * 1000;   // una sesión sin usar caduca a las 24 h (después hay que volver a iniciar sesión)
const RESERVED = ['thor', 'zeus', 'odín', 'odin', 'freya', 'hela', 'atenea', 'ares', 'loki', 'guardia', 'mercader', 'barquero', 'maestro de hechizos', 'admin', 'administrador'];

const DIR = __dirname;
const DATA_DIR = process.env.AURELIA_DATOS ? path.resolve(process.env.AURELIA_DATOS) : path.join(DIR, 'datos');
const DB_FILE = path.join(DATA_DIR, 'base_de_datos.json');
const BK_DIR = path.join(DATA_DIR, 'copias');
const LOG_FILE = path.join(DATA_DIR, 'registro.log');
const CODES_TXT = path.join(DATA_DIR, 'codigos_invitacion.txt');
fs.mkdirSync(BK_DIR, { recursive: true });

/* ---------------- configuración (config.json, junto a este archivo) ---------------- */
const DEF_CONF = { puerto: 7777, versionMinima: '', maxPersonajes: 10, copiaCadaMinutos: 30, copiasGuardadas: 48, tunel: true, github: 'impresoraed/aurelia-config', githubArchivo: 'server.txt', githubRama: 'main' };
function loadConf() {
  const f = path.join(DIR, 'config.json'); let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { if (fs.existsSync(f)) { console.error('\n*** config.json tiene un error de escritura: ' + e.message + '\n    Se usan los valores de serie.\n'); } else fs.writeFileSync(f, JSON.stringify(DEF_CONF, null, 2)); }
  const o = Object.assign({}, DEF_CONF, c);
  if (process.env.AURELIA_PUERTO) o.puerto = +process.env.AURELIA_PUERTO;
  o.puerto = +o.puerto || 7777; o.maxPersonajes = Math.max(1, +o.maxPersonajes || 10);
  return o;
}
const CONF = loadConf();

/* ---------------- registro de actividad ---------------- */
const pad = (n) => String(n).padStart(2, '0');
function stamp(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
const fecha = (ms) => { const d = new Date(ms); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
let logN = 0;
function log(msg) {
  const line = '[' + stamp() + '] ' + msg;
  console.log(line);
  try {
    if (++logN % 200 === 0 && fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, path.join(DATA_DIR, 'registro_anterior.log'));
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}
const say = (msg) => console.log(msg);   // respuesta a un comando: solo en pantalla

/* ---------------- base de datos (un archivo JSON) ---------------- */
let db;
const emptyDb = () => ({ version: 1, cuentas: {}, pjs: {}, codigos: {}, sesiones: {} });
function loadDb() {
  if (!fs.existsSync(DB_FILE)) { db = emptyDb(); writeDbNow(); log('Base de datos nueva creada en ' + DB_FILE); return; }
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) {
    console.error('\n*** ERROR: el archivo de datos está dañado y no se puede leer:\n    ' + DB_FILE + '\n    (' + e.message + ')\n' +
      '    No se ha tocado nada. Para recuperar los datos, copia la copia más reciente de la carpeta «copias»\n    y renómbrala a base_de_datos.json.\n');
    process.exit(1);
  }
  for (const k of ['cuentas', 'pjs', 'codigos', 'sesiones']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
}
let dirty = false, saveT = null, changedSinceBackup = false;
function touch() { dirty = true; changedSinceBackup = true; if (!saveT) saveT = setTimeout(writeDbNow, 1500); }
function writeDbNow() {
  if (saveT) { clearTimeout(saveT); saveT = null; }
  dirty = false;
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    try { fs.renameSync(tmp, DB_FILE); } catch (e) { fs.copyFileSync(tmp, DB_FILE); fs.unlinkSync(tmp); }   // en Windows un antivirus puede bloquear el cambio de nombre
  } catch (e) { log('ERROR al guardar la base de datos: ' + e.message + ' (se reintenta en 5 s)'); dirty = true; saveT = setTimeout(writeDbNow, 5000); }
}
function backup(force) {
  if (!force && !changedSinceBackup) return null;
  if (dirty) writeDbNow();
  if (!fs.existsSync(DB_FILE)) return null;
  const name = 'base_de_datos_' + stamp().replace(' ', '_').replace(/:/g, '-') + '.json';
  try {
    fs.copyFileSync(DB_FILE, path.join(BK_DIR, name)); changedSinceBackup = false;
    const all = fs.readdirSync(BK_DIR).filter((n) => /^base_de_datos_.*\.json$/.test(n)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - CONF.copiasGuardadas))) fs.unlinkSync(path.join(BK_DIR, n));
    return name;
  } catch (e) { log('ERROR al hacer la copia de seguridad: ' + e.message); return null; }
}

/* ---------------- utilidades ---------------- */
const norm = (s) => String(s == null ? '' : s).normalize('NFC').trim();
const keyOf = (s) => norm(s).toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const RE_USER = /^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ_.\-]{3,20}$/;
const RE_PJ = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 '\-]{3,14}$/;
const RE_KEY = /^[a-z_]{1,20}$/;
function verParts(v) { return (String(v || '').match(/\d+/g) || []).map(Number); }
function verLess(a, b) { const A = verParts(a), B = verParts(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const x = A[i] || 0, y = B[i] || 0; if (x !== y) return x < y; } return false; }

/* contraseñas: se guarda una huella con sal (scrypt); la contraseña en sí no se guarda en ningún sitio */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPass = (pass, salt) => new Promise((res, rej) => crypto.scrypt(String(pass), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
async function newPass(pass) { const salt = crypto.randomBytes(16); return { sal: salt.toString('hex'), hash: (await hashPass(pass, salt)).toString('hex') }; }
async function checkPass(acc, pass) { const h = await hashPass(pass, Buffer.from(acc.sal, 'hex')), ref = Buffer.from(acc.hash, 'hex'); return ref.length === h.length && crypto.timingSafeEqual(ref, h); }
function passProblem(user, pass) {
  if (pass.length < 6 || pass.length > 40) return 'La contraseña debe tener entre 6 y 40 caracteres.';
  if (pass.toLowerCase() === user.toLowerCase()) return 'La contraseña no puede ser igual que el nombre de la cuenta.';
  return '';
}

/* códigos de invitación: 8 letras/números sin los que se confunden (0/O, 1/I/L), p. ej. K7QM-3XHD */
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const codeKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function newCode() {
  for (;;) {
    let s = ''; const b = crypto.randomBytes(16);
    for (let i = 0; i < 16 && s.length < 9; i++) { if (b[i] >= 248) continue; s += ABC[b[i] % ABC.length]; if (s.length === 4) s += '-'; }
    if (s.length === 9 && !db.codigos[codeKey(s)]) return s;
  }
}
function writeCodesTxt() {
  const L = Object.values(db.codigos).sort((a, b) => a.creado - b.creado);
  const free = L.filter((c) => !c.usado), used = L.filter((c) => c.usado);
  const txt = 'CÓDIGOS DE INVITACIÓN DE LEGADOS DE AURELIA (este archivo se rehace solo; para crear códigos escribe «codigo» en la ventana del servidor)\r\n\r\n' +
    'SIN USAR (' + free.length + '):\r\n' + (free.map((c) => '  ' + c.codigo + '   creado el ' + fecha(c.creado)).join('\r\n') || '  (ninguno)') + '\r\n\r\n' +
    'USADOS (' + used.length + '):\r\n' + (used.map((c) => '  ' + c.codigo + '   cuenta «' + c.usado.cuenta + '» el ' + fecha(c.usado.fecha)).join('\r\n') || '  (ninguno)') + '\r\n';
  try { fs.writeFileSync(CODES_TXT, txt); } catch (e) {}
}

/* ---------------- conexiones y sesiones ---------------- */
const conns = new Set();
const online = new Map();        // cuenta (en minúsculas) → conexión
const failsByAcc = new Map();    // cuenta → horas de los últimos intentos fallidos

function send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) {} }
function reply(c, id, o) { send(c, Object.assign({ t: 'res', id }, o)); }
const fail = (c, id, err) => reply(c, id, { ok: false, err });

function pjMeta(p) { return { id: p.id, name: p.name, cls: p.cls, race: p.race, look: p.look, fac: p.fac, created: p.created, last: p.last || 0 }; }
function accData(k) {
  const a = db.cuentas[k], pj = a.pjs.map((id) => db.pjs[id]).filter(Boolean), saves = {};
  for (const p of pj) if (p.save) saves[p.id] = p.save;
  return { user: a.nombre, admin: !!a.admin, max: CONF.maxPersonajes, chars: pj.map(pjMeta), saves };
}
function dropSessions(k) { for (const [h, s] of Object.entries(db.sesiones)) if (s.c === k) delete db.sesiones[h]; }
function kick(k, msg) {
  const c = online.get(k); if (!c) return false;
  online.delete(k); c.acc = null;
  send(c, { t: 'expulsado', msg }); c.ws.close(4001, 'expulsado');
  return true;
}
function startSession(c, id, k, extra) {
  const a = db.cuentas[k], now = Date.now();
  const prev = online.get(k);
  if (prev && prev !== c) kick(k, 'Alguien ha entrado con tu cuenta desde otro equipo. Si no has sido tú, pide al administrador que te cambie la contraseña.');
  dropSessions(k);                                     // una sola sesión por cuenta
  if (c.acc && c.acc !== k && online.get(c.acc) === c) online.delete(c.acc);
  const tok = crypto.randomBytes(24).toString('hex');
  db.sesiones[sha(tok)] = { c: k, exp: now + SES_TTL };
  c.acc = k; c.tokH = sha(tok); online.set(k, c);
  a.ultima = now; touch();
  log((extra && extra.nueva ? 'Cuenta nueva «' + a.nombre + '»' + (a.admin ? ' (ADMINISTRADOR)' : '') + ' y entra' : 'Entra «' + a.nombre + '»') + ' desde ' + c.ip + ' (juego ' + (c.ver || '?') + ')');
  reply(c, id, Object.assign({ ok: true, token: tok }, accData(k), extra || {}));
}
function authed(c) {
  if (!c.acc || !db.cuentas[c.acc] || !c.tokH || !db.sesiones[c.tokH]) { c.acc = null; return false; }
  return true;
}
function tooMany(c, k) {
  const now = Date.now();
  c.tries = (c.tries || []).filter((t) => now - t < 60000); c.tries.push(now);
  if (c.tries.length > 10) return 'Demasiados intentos seguidos. Espera un minuto.';
  if (k) { const f = (failsByAcc.get(k) || []).filter((t) => now - t < 5 * 60000); failsByAcc.set(k, f); if (f.length >= 5) return 'Demasiados intentos fallidos con esta cuenta. Espera unos minutos.'; }
  return '';
}

/* ---------------- mensajes del juego ---------------- */
const H = {};
H.registro = async (c, m) => {
  const user = norm(m.user), k = keyOf(user), pass = String(m.pass || ''), ck = codeKey(m.code);
  const tm = tooMany(c); if (tm) return fail(c, m.id, tm);
  if (!ck) return fail(c, m.id, 'Escribe el código de invitación.');
  const code = db.codigos[ck];
  if (!code) return fail(c, m.id, 'Ese código de invitación no existe. Revisa que esté bien escrito.');
  if (code.usado) return fail(c, m.id, 'Ese código de invitación ya se ha usado.');
  if (!RE_USER.test(user)) return fail(c, m.id, 'El nombre de cuenta debe tener de 3 a 20 caracteres: letras, números, punto, guion o guion bajo (sin espacios).');
  const pp = passProblem(user, pass); if (pp) return fail(c, m.id, pp);
  if (db.cuentas[k]) return fail(c, m.id, 'Ya existe una cuenta con ese nombre. Elige otro.');
  const pw = await newPass(pass);
  if (db.cuentas[k] || code.usado) return fail(c, m.id, 'Ese nombre o ese código se acaban de usar. Prueba otra vez.');
  const first = Object.keys(db.cuentas).length === 0, now = Date.now();
  db.cuentas[k] = { nombre: user, sal: pw.sal, hash: pw.hash, admin: first, creada: now, ultima: now, pjs: [], codigo: code.codigo };
  code.usado = { cuenta: user, fecha: now };
  touch(); writeCodesTxt();
  startSession(c, m.id, k, { nueva: true });
};
H.login = async (c, m) => {
  const k = keyOf(m.user), a = db.cuentas[k];
  const tm = tooMany(c, k); if (tm) return fail(c, m.id, tm);
  if (!a || !(await checkPass(a, String(m.pass || '')))) {
    if (a) { failsByAcc.get(k).push(Date.now()); log('Contraseña incorrecta para «' + a.nombre + '» desde ' + c.ip); }
    return fail(c, m.id, 'Cuenta o contraseña incorrectas.');
  }
  if (a.bloqueada) return fail(c, m.id, 'Esta cuenta está bloqueada. Habla con el administrador del juego.');
  failsByAcc.delete(k);
  startSession(c, m.id, k);
};
H.reanudar = (c, m) => {                       // reconexión tras un corte (o tras reiniciar el servidor) sin volver a escribir la contraseña
  const h = sha(m.token || ''), s = db.sesiones[h], now = Date.now();
  const a = s && db.cuentas[s.c];
  if (!s || s.exp < now || !a || a.bloqueada) { if (s) { delete db.sesiones[h]; touch(); } return fail(c, m.id, 'La sesión ha caducado: vuelve a iniciar sesión.'); }
  const prev = online.get(s.c);
  if (prev && prev !== c) { prev.acc = null; prev.ws.terminate(); }   // la conexión vieja de esta misma sesión (cortada)
  s.exp = now + SES_TTL; c.acc = s.c; c.tokH = h; online.set(s.c, c); a.ultima = now; touch();
  log('Reconecta «' + a.nombre + '» desde ' + c.ip);
  reply(c, m.id, { ok: true, user: a.nombre, admin: !!a.admin });
};
H.salir = (c) => {
  leaveWorld(c);
  if (!c.acc) return;
  const a = db.cuentas[c.acc];
  if (c.tokH) delete db.sesiones[c.tokH];
  if (online.get(c.acc) === c) online.delete(c.acc);
  if (a) log('Cierra sesión «' + a.nombre + '»');
  c.acc = null; c.tokH = null; touch();
};
H.crearPj = (c, m) => {
  if (!authed(c)) return fail(c, m.id, 'Tienes que iniciar sesión.');
  const a = db.cuentas[c.acc], o = m.ch || {};
  const name = norm(o.name).replace(/\s+/g, ' '), nk = name.toLowerCase();
  if (!RE_PJ.test(name)) return fail(c, m.id, 'El nombre debe tener de 3 a 14 caracteres: letras, números, espacios, guion o apóstrofo.');
  if (a.pjs.length >= CONF.maxPersonajes) return fail(c, m.id, 'Has llegado al máximo de ' + CONF.maxPersonajes + ' personajes.');
  if (RESERVED.includes(nk)) return fail(c, m.id, 'Ese nombre está reservado. Elige otro.');
  if (Object.values(db.pjs).some((p) => p.name.toLowerCase() === nk)) return fail(c, m.id, 'Ya hay un personaje con ese nombre en el servidor. Elige otro.');
  const cls = String(o.cls || ''), race = String(o.race || ''), fac = Math.round(+o.fac || 0);
  if (!RE_KEY.test(cls) || !RE_KEY.test(race) || !(fac >= 0 && fac <= 9)) return fail(c, m.id, 'Datos del personaje no válidos.');
  const look = o.look && typeof o.look === 'object' && !Array.isArray(o.look) && JSON.stringify(o.look).length < 4000 ? o.look : {};
  const id = 'c' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), now = Date.now();
  db.pjs[id] = { id, cuenta: c.acc, name, cls, race, look, fac, created: now, last: 0, save: null };
  a.pjs.push(id); touch();
  log('«' + a.nombre + '» crea el personaje ' + name + ' (' + cls + ', ' + race + ')');
  reply(c, m.id, { ok: true, ch: pjMeta(db.pjs[id]) });
};
H.borrarPj = (c, m) => {
  if (!authed(c)) return fail(c, m.id, 'Tienes que iniciar sesión.');
  const a = db.cuentas[c.acc], p = db.pjs[m.cid];
  if (!p || p.cuenta !== c.acc) return fail(c, m.id, 'Ese personaje no existe.');
  delete db.pjs[p.id]; a.pjs = a.pjs.filter((id) => id !== p.id); touch();
  log('«' + a.nombre + '» borra el personaje ' + p.name + ' (nivel ' + ((p.save && p.save.lvl) || 1) + ')');
  reply(c, m.id, { ok: true });
};
H.guardar = (c, m) => {
  if (!authed(c)) return;
  const p = db.pjs[m.cid], d = m.data;
  if (!p || p.cuenta !== c.acc || !d || typeof d !== 'object' || Array.isArray(d)) return;
  const saved = +d.saved || 0, prev = p.save;
  if (prev && (+prev.saved || 0) > saved) return send(c, { t: 'ok_guardar', cid: p.id, saved });   // llega tarde: ya hay algo más nuevo
  if (prev && d.lvl > (prev.lvl || 1)) log(p.name + ' sube a nivel ' + d.lvl);
  p.save = d; touch();
  send(c, { t: 'ok_guardar', cid: p.id, saved });
};
H.pjMeta = (c, m) => {
  if (!authed(c)) return;
  const p = db.pjs[m.cid]; if (!p || p.cuenta !== c.acc) return;
  p.last = Math.min(Date.now(), +m.last || Date.now()); touch();
};
H.ping = (c, m) => send(c, { t: 'pong', id: m.id });

/* ---------------- fase 2: los jugadores se ven entre sí ----------------
   Cada juego manda su posición unas 10 veces por segundo («p») y su equipo cuando cambia («eq»); el servidor lo reparte a los
   demás que estén dentro del mundo. Al entrar alguien se presenta a todos («pj») y recibe a los que ya están; al salir se avisa («sale»).
   El chat cercano, el global y los privados también pasan por aquí. */
const num = (v, d) => { v = +v; return Number.isFinite(v) ? v : (d || 0); };
const inWorld = () => [...conns].filter((o) => o.pj);
function bcast(c, o) { const s = JSON.stringify(o); for (const x of conns) if (x !== c && x.pj) { try { x.ws.send(s); } catch (e) {} } }
const pjMsg = (c) => ({ t: 'pj', id: c.pj.id, name: c.pj.name, cls: c.pj.cls, race: c.pj.race, look: c.pj.look, fac: c.pj.fac, eq: c.pj.eq || {} });
function leaveWorld(c) { const tr = typeof trOf === 'function' && trOf(c); if (tr) trCancel(tr, c); if (!c.pj) return; bcast(c, { t: 'sale', id: c.pj.id }); c.pj = null; c.st = null; }
function cleanEq(eq) {
  const o = {}; if (!eq || typeof eq !== 'object') return o;
  for (const k of ['weapon', 'armor', 'shield', 'helm']) { const it = eq[k]; if (!it || typeof it !== 'object') continue;
    o[k] = { il: num(it.il), tn: it.tn === undefined ? undefined : num(it.tn), r: num(it.r), cloth: it.cloth ? 1 : 0, wt: typeof it.wt === 'string' ? it.wt.slice(0, 12) : undefined, slot: k }; }
  return o;
}
H.eq = (c, m) => { if (!authed(c)) return; c.eqTmp = cleanEq(m.eq); if (c.pj) { c.pj.eq = c.eqTmp; bcast(c, pjMsg(c)); } };
H.p = (c, m) => {
  if (!authed(c)) return;
  const p = db.pjs[m.cid]; if (!p || p.cuenta !== c.acc) return;
  if (!c.pj || c.pj.id !== p.id) {                       // entra al mundo (o cambia de personaje)
    leaveWorld(c);
    c.pj = { id: p.id, name: p.name, cls: p.cls, race: p.race, look: p.look, fac: p.fac, eq: c.eqTmp || {} };
    bcast(c, pjMsg(c));
    for (const o of inWorld()) if (o !== c) { send(c, pjMsg(o)); if (o.st) send(c, o.st); }
    for (const g of GOLD.values()) send(c, { t: 'oro', op: 'pon', id: g.id, x: g.x, y: g.y, mk: g.mk, amt: g.amt, by: g.by });
    log(p.name + ' entra al mundo (' + inWorld().length + ' jugador(es) dentro)');
  }
  const st = { t: 'p', id: p.id, x: num(m.x), y: num(m.y), vx: num(m.vx), vy: num(m.vy), a: num(m.a), mv: m.mv ? 1 : 0, hp: num(m.hp), mh: num(m.mh, 1), lv: Math.round(num(m.lv, 1)), at: num(m.at), ca: num(m.ca), al: m.al ? 1 : 0, mk: String(m.mk || '').slice(0, 30) };
  c.st = st; bcast(c, st);
};
/* ---------------- oro en el suelo (lo ven todos; se lo lleva el primero que llega) ---------------- */
const GOLD = new Map(); let goldN = 0;
H.tirarOro = (c, m) => {
  if (!authed(c) || !c.pj) return;
  const amt = Math.floor(num(m.amt)); if (!(amt >= 1 && amt <= 1e9)) return;
  const g = { id: 'o' + (++goldN) + Date.now().toString(36), x: num(m.x), y: num(m.y), mk: String(m.mk || '').slice(0, 30), amt, by: c.pj.id, byName: c.pj.name, t: Date.now() };
  GOLD.set(g.id, g);
  const msg = { t: 'oro', op: 'pon', id: g.id, x: g.x, y: g.y, mk: g.mk, amt: g.amt, by: g.by };
  for (const o of inWorld()) send(o, o === c ? Object.assign({ tmp: String(m.tmp || '').slice(0, 30) }, msg) : msg);   // a quien la tira se le dice cuál de sus bolsas es
  log(c.pj.name + ' tira ' + amt + ' de oro al suelo');
};
H.cogerOro = (c, m) => {
  if (!authed(c) || !c.pj) return;
  const g = GOLD.get(String(m.id || '')); if (!g) return;   // ya se lo ha llevado otro
  GOLD.delete(g.id);
  send(c, { t: 'oro', op: 'tuyo', id: g.id, amt: g.amt, de: g.by !== c.pj.id ? g.byName : '' });
  for (const o of inWorld()) send(o, { t: 'oro', op: 'quita', id: g.id });
  if (g.by !== c.pj.id) log(c.pj.name + ' recoge ' + g.amt + ' de oro que tiró ' + g.byName);
};
setInterval(() => { const now = Date.now(); for (const g of GOLD.values()) if (now - g.t > 15 * 60000) { GOLD.delete(g.id); for (const o of inWorld()) send(o, { t: 'oro', op: 'quita', id: g.id }); } }, 60000).unref();   // a los 15 minutos desaparece

/* ---------------- comercio entre jugadores ---------------- */
const TRADES = new Map(); let trN = 0;
const trOf = (c) => [...TRADES.values()].find((x) => x.a === c || x.b === c);
const cleanItems = (L) => (Array.isArray(L) ? L : []).filter((it) => it && typeof it === 'object' && !Array.isArray(it) && typeof it.slot === 'string').slice(0, 12).filter((it) => JSON.stringify(it).length < 3000);
function trState(x) {
  for (const [me, ot] of [[x.a, x.b], [x.b, x.a]]) { const o = x.off.get(ot) || { items: [], gold: 0 }; send(me, { t: 'tr', op: 'estado', id: x.id, yoOk: !!x.ok.get(me), el: { items: o.items, gold: o.gold, ok: !!x.ok.get(ot) } }); }
}
function trCancel(x, who) {
  TRADES.delete(x.id);
  for (const o of [x.a, x.b]) send(o, { t: 'tr', op: 'cancelado', id: x.id, msg: o === who ? 'Has cancelado el comercio.' : 'El comercio se ha cancelado.' });
}
H.trPide = (c, m) => {
  if (!authed(c) || !c.pj) return;
  const to = String(m.to || '').trim().toLowerCase(), o = inWorld().find((x) => x !== c && x.pj.name.toLowerCase() === to);
  if (!o) return send(c, { t: 'tr', op: 'no', msg: (m.to || 'Ese jugador') + ' no está en el mundo.' });
  if (trOf(c) || trOf(o)) return send(c, { t: 'tr', op: 'no', msg: o.pj.name + ' ya está comerciando con alguien.' });
  const id = 't' + (++trN) + Date.now().toString(36);
  TRADES.set(id, { id, a: c, b: o, pend: true, off: new Map(), ok: new Map() });
  send(o, { t: 'tr', op: 'pide', id, from: c.pj.name });
};
H.trResp = (c, m) => {
  const x = TRADES.get(String(m.id || '')); if (!x || x.b !== c || !x.pend) return;
  if (!m.ok || !x.a.pj || !c.pj) { TRADES.delete(x.id); return send(x.a, { t: 'tr', op: 'no', msg: (c.pj ? c.pj.name : 'El otro jugador') + ' no quiere comerciar ahora.' }); }
  x.pend = false;
  send(x.a, { t: 'tr', op: 'abre', id: x.id, with: c.pj.name }); send(c, { t: 'tr', op: 'abre', id: x.id, with: x.a.pj.name });
  log('Comercio abierto: ' + x.a.pj.name + ' ↔ ' + c.pj.name);
};
H.trPon = (c, m) => {
  const x = TRADES.get(String(m.id || '')); if (!x || x.pend || (x.a !== c && x.b !== c)) return;
  x.off.set(c, { items: cleanItems(m.items), gold: Math.max(0, Math.floor(num(m.gold))) });
  x.ok.clear(); trState(x);                                       // cualquier cambio obliga a volver a aceptar
};
H.trOk = (c, m) => {
  const x = TRADES.get(String(m.id || '')); if (!x || x.pend || (x.a !== c && x.b !== c)) return;
  x.ok.set(c, true);
  if (x.ok.get(x.a) && x.ok.get(x.b)) {
    TRADES.delete(x.id);
    const oa = x.off.get(x.a) || { items: [], gold: 0 }, ob = x.off.get(x.b) || { items: [], gold: 0 };
    send(x.a, { t: 'tr', op: 'hecho', id: x.id, recibe: ob }); send(x.b, { t: 'tr', op: 'hecho', id: x.id, recibe: oa });
    log('Comercio hecho: ' + (x.a.pj ? x.a.pj.name : '?') + ' da ' + oa.items.length + ' obj. y ' + oa.gold + ' oro · ' + (x.b.pj ? x.b.pj.name : '?') + ' da ' + ob.items.length + ' obj. y ' + ob.gold + ' oro');
  } else trState(x);
};
H.trCancela = (c, m) => { const x = TRADES.get(String(m.id || '')); if (x && (x.a === c || x.b === c)) trCancel(x, c); };

H.fuera = (c) => { if (c.pj) { log(c.pj.name + ' sale del mundo'); leaveWorld(c); } };
H.chat = (c, m) => {
  if (!authed(c) || !c.pj) return;
  const txt = String(m.txt || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 140); if (!txt.trim()) return;
  const now = Date.now(); c.chatT = (c.chatT || []).filter((x) => now - x < 5000); if (c.chatT.length >= 8) return; c.chatT.push(now);   // sin inundar el chat
  if (m.k === 'near' || m.k === 'global') { bcast(c, { t: 'chat', k: m.k, id: c.pj.id, name: c.pj.name, txt }); if (m.k === 'global') log('[Global] ' + c.pj.name + ': ' + txt); return; }
  if (m.k === 'priv') {
    const to = String(m.to || '').trim().toLowerCase(), o = inWorld().find((x) => x.pj.name.toLowerCase() === to);
    if (!o) return send(c, { t: 'chat', k: 'err', txt: (m.to || 'Ese jugador') + ' no está conectado.' });
    send(o, { t: 'chat', k: 'priv', id: c.pj.id, name: c.pj.name, txt });
  }
};

function onConn(ws, req) {
  const c = { ws, ip: String(req.socket.remoteAddress || '?').replace(/^::ffff:/, ''), hello: false, acc: null, tokH: null, tries: [], ver: '' };
  conns.add(c);
  ws.on('message', async (txt) => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hola') {
      c.ver = String(m.ver || '').slice(0, 20);
      let bad = '';
      if (m.proto !== PROTO) bad = 'Tu versión del juego no es compatible con este servidor. Instala la versión más reciente.';
      else if (CONF.versionMinima && verLess(c.ver, CONF.versionMinima)) bad = 'Tu versión del juego (' + c.ver + ') es antigua: el servidor pide la ' + CONF.versionMinima + ' o más nueva. Instala la última versión.';
      if (bad) { send(c, { t: 'hola', ok: false, msg: bad }); log('Rechazado ' + c.ip + ': versión ' + (c.ver || '?') + ' (protocolo ' + m.proto + ')'); setTimeout(() => ws.close(4000, 'version'), 300); return; }
      c.hello = true; send(c, { t: 'hola', ok: true, proto: PROTO });
      return;
    }
    if (!c.hello) { ws.close(1008, 'falta hola'); return; }
    const f = H[m.t]; if (!f) return;
    try { await f(c, m); } catch (e) { log('ERROR atendiendo «' + m.t + '»: ' + (e && e.stack || e)); if (m.id) fail(c, m.id, 'Error del servidor. Inténtalo otra vez.'); }
  });
  ws.on('close', () => {
    leaveWorld(c);
    conns.delete(c);
    if (c.acc && online.get(c.acc) === c) { online.delete(c.acc); const a = db.cuentas[c.acc]; if (a) log('Sale «' + a.nombre + '»'); }
  });
}

/* ---------------- comandos de administrador (se escriben en esta ventana) ---------------- */
const HELP = [
  'COMANDOS DEL SERVIDOR',
  '  codigo [cantidad]           crea códigos de invitación (uno por tester). Ej.: codigo 5',
  '  codigos                     lista los códigos sin usar y los usados',
  '  borrarcodigo XXXX-XXXX      anula un código que todavía no se ha usado',
  '  cuentas                     lista las cuentas',
  '  conectados                  quién está jugando ahora',
  '  clave <cuenta> <nueva>      cambia la contraseña de una cuenta (si alguien la olvida)',
  '  admin <cuenta>              da permisos de administrador (trucos del chat y modo prueba)',
  '  quitaradmin <cuenta>        quita los permisos de administrador',
  '  expulsar <cuenta>           desconecta a alguien (puede volver a entrar)',
  '  bloquear <cuenta>           expulsa y no le deja volver a entrar  ·  desbloquear <cuenta>',
  '  borrarcuenta <cuenta> confirmar   borra la cuenta y sus personajes PARA SIEMPRE',
  '  copia                       hace ahora una copia de seguridad',
  '  direccion                   muestra la dirección del túnel y la vuelve a publicar en GitHub',
  '  ayuda                       muestra esta lista',
  '  salir                       guarda todo y apaga el servidor',
].join('\n');
const findAcc = (name) => { const k = keyOf(name), a = db.cuentas[k]; if (!a) say('No existe la cuenta «' + norm(name) + '». Escribe «cuentas» para ver la lista.'); return a ? k : null; };
const CMD = {
  ayuda() { say(HELP); },
  codigo(args) {
    const n = Math.min(50, Math.max(1, parseInt(args[0], 10) || 1)), out = [];
    for (let i = 0; i < n; i++) { const s = newCode(); db.codigos[codeKey(s)] = { codigo: s, creado: Date.now(), usado: null }; out.push(s); }
    touch(); writeCodesTxt();
    log('Creados ' + n + ' código(s) de invitación: ' + out.join('  '));
    say('Pásale uno a cada tester. También están en ' + CODES_TXT);
  },
  codigos() {
    const L = Object.values(db.codigos).sort((a, b) => a.creado - b.creado);
    const free = L.filter((c) => !c.usado), used = L.filter((c) => c.usado);
    say('Sin usar (' + free.length + '): ' + (free.map((c) => c.codigo).join('  ') || 'ninguno. Crea con «codigo»'));
    for (const c of used) say('  ' + c.codigo + '  usado por «' + c.usado.cuenta + '» el ' + fecha(c.usado.fecha));
  },
  borrarcodigo(args) {
    const k = codeKey(args[0]), c = db.codigos[k];
    if (!c) return say('No existe ese código.');
    if (c.usado) return say('Ese código ya lo usó «' + c.usado.cuenta + '»: no se puede anular (borra la cuenta si hace falta).');
    delete db.codigos[k]; touch(); writeCodesTxt(); log('Código anulado: ' + c.codigo);
  },
  cuentas() {
    const L = Object.entries(db.cuentas);
    if (!L.length) return say('No hay ninguna cuenta todavía.');
    for (const [k, a] of L) say('  ' + a.nombre.padEnd(20) + (a.admin ? ' [ADMIN]' : '') + (a.bloqueada ? ' [BLOQUEADA]' : '') + '  ' + a.pjs.length + ' personaje(s)  ·  ' + (online.has(k) ? 'CONECTADO' : 'última vez ' + fecha(a.ultima || a.creada)) +
      (a.pjs.length ? '  ·  ' + a.pjs.map((id) => db.pjs[id]).filter(Boolean).map((p) => p.name + ' nv' + ((p.save && p.save.lvl) || 1)).join(', ') : ''));
  },
  conectados() {
    if (!online.size) return say('No hay nadie conectado.');
    for (const [k, c] of online) say('  ' + db.cuentas[k].nombre + '  desde ' + c.ip + '  (juego ' + (c.ver || '?') + ')' + (c.pj ? '  ·  en el mundo con ' + c.pj.name + (c.st ? ' (' + Math.round(c.st.x) + ', ' + Math.round(c.st.y) + ')' : '') : '  ·  en los menús'));
  },
  async clave(args) {
    const k = args[0] && findAcc(args[0]); if (!k) return args[0] ? null : say('Uso: clave <cuenta> <nueva contraseña>');
    const pass = args.slice(1).join(' '), a = db.cuentas[k], pp = passProblem(a.nombre, pass);
    if (!pass) return say('Uso: clave <cuenta> <nueva contraseña>');
    if (pp) return say(pp);
    Object.assign(a, await newPass(pass)); dropSessions(k); touch();
    kick(k, 'El administrador ha cambiado la contraseña de tu cuenta. Entra con la nueva.');
    log('Contraseña cambiada para «' + a.nombre + '»');
  },
  admin(args) { const k = findAcc(args[0] || ''); if (!k) return; db.cuentas[k].admin = true; touch(); log('«' + db.cuentas[k].nombre + '» ahora es administrador (se nota al volver a entrar)'); },
  quitaradmin(args) { const k = findAcc(args[0] || ''); if (!k) return; db.cuentas[k].admin = false; touch(); log('«' + db.cuentas[k].nombre + '» ya no es administrador (se nota al volver a entrar)'); },
  expulsar(args) { const k = findAcc(args[0] || ''); if (!k) return; dropSessions(k); touch(); if (kick(k, 'El administrador te ha desconectado.')) log('Expulsado «' + db.cuentas[k].nombre + '»'); else say('No estaba conectado.'); },
  bloquear(args) { const k = findAcc(args[0] || ''); if (!k) return; db.cuentas[k].bloqueada = true; dropSessions(k); touch(); kick(k, 'Tu cuenta ha sido bloqueada por el administrador.'); log('Cuenta bloqueada: «' + db.cuentas[k].nombre + '»'); },
  desbloquear(args) { const k = findAcc(args[0] || ''); if (!k) return; delete db.cuentas[k].bloqueada; touch(); log('Cuenta desbloqueada: «' + db.cuentas[k].nombre + '»'); },
  borrarcuenta(args) {
    const k = findAcc(args[0] || ''); if (!k) return;
    if ((args[1] || '').toLowerCase() !== 'confirmar') return say('Esto borra la cuenta y todos sus personajes para siempre. Para hacerlo escribe: borrarcuenta ' + db.cuentas[k].nombre + ' confirmar');
    const a = db.cuentas[k]; backup(true);
    kick(k, 'Tu cuenta ha sido borrada por el administrador.'); dropSessions(k);
    for (const id of a.pjs) delete db.pjs[id];
    delete db.cuentas[k]; touch();
    log('Cuenta BORRADA: «' + a.nombre + '» y ' + a.pjs.length + ' personaje(s) (antes se hizo una copia de seguridad)');
  },
  copia() { const n = backup(true); if (n) say('Copia hecha: ' + path.join(BK_DIR, n)); },
  direccion() { say(tunUrl ? 'Dirección del túnel: ' + tunUrl : 'El túnel todavía no tiene dirección (o está desactivado en config.json).'); if (tunUrl) publishAddr(tunUrl); },
  salir() { shutdown(); },
};
function startConsole() {
  if (!process.stdin.isTTY && !process.env.AURELIA_CONSOLA) return;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const p = line.trim().split(/\s+/).filter(Boolean); if (!p.length) return;
    const f = CMD[p[0].toLowerCase()];
    if (!f) return say('Comando desconocido: «' + p[0] + '». Escribe «ayuda» para ver la lista.');
    try { await f(p.slice(1)); } catch (e) { say('Error: ' + e.message); }
  });
}

/* ---------------- arranque ---------------- */
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return; shuttingDown = true;
  log('Apagando el servidor…');
  if (tunProc) { try { tunProc.kill(); } catch (e) {} }
  for (const c of conns) { send(c, { t: 'apagado' }); c.ws.close(1001, 'servidor apagado'); }
  writeDbNow();
  setTimeout(() => process.exit(typeof code === 'number' ? code : 0), 400);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);   // SIGHUP: en Windows, al cerrar la ventana
process.on('uncaughtException', (e) => { log('ERROR inesperado (el servidor sigue funcionando): ' + (e && e.stack || e)); });

loadDb();
{ const now = Date.now(); let n = 0; for (const [h, s] of Object.entries(db.sesiones)) if (!s || s.exp < now) { delete db.sesiones[h]; n++; } if (n) touch(); }
writeCodesTxt();
backup(true);
setInterval(() => backup(false), Math.max(5, +CONF.copiaCadaMinutos || 30) * 60000).unref();
setInterval(() => {                                   // cada 25 s: se cierran las conexiones que ya no responden
  for (const c of conns) { if (!c.ws.alive) { c.ws.terminate(); continue; } c.ws.alive = false; c.ws.ping(); }
}, 25000).unref();
setInterval(() => { const now = Date.now(); for (const [h, s] of Object.entries(db.sesiones)) if (s.exp < now) { delete db.sesiones[h]; touch(); } }, 3600000).unref();

/* actualizaciones del juego: se sirven los archivos de la carpeta «actualizacion» (la prepara 3_PUBLICAR_ACTUALIZACION.bat).
   Solo nombres sencillos de esa carpeta, sin subcarpetas: nada de fuera se puede pedir. */
const UPD_DIR = path.join(DIR, 'actualizacion');
const MIME = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.pak': 'application/octet-stream' };
const srv = http.createServer((req, res) => {
  const u = String(req.url || '').split('?')[0];
  if (u.startsWith('/actualizacion/')) {
    const name = decodeURIComponent(u.slice('/actualizacion/'.length));
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); return res.end(); }
    const fp = path.join(UPD_DIR, name);
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No hay ninguna actualización publicada.'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      if (name === 'version.json') { try { const v = JSON.parse(fs.readFileSync(fp, 'utf8')); log('Comprueba actualizaciones ' + String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').replace(/^::ffff:/, '') + ' (publicada: ' + (v.juego || '?') + ')'); } catch (e) {} }
      fs.createReadStream(fp).pipe(res);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor de Legados de Aurelia en marcha. Jugadores conectados: ' + online.size + '\n');
});
WS.attach(srv, { maxPayload: 2 * 1024 * 1024 }, onConn);
srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('\n*** El puerto ' + CONF.puerto + ' ya está en uso. ¿Tienes otro servidor abierto? Ciérralo o cambia el puerto en config.json.\n');
  else console.error('\n*** No se puede abrir el servidor: ' + e.message + '\n');
  process.exit(1);
});
srv.listen(CONF.puerto, '0.0.0.0', () => {
  const ips = [];
  for (const [name, L] of Object.entries(os.networkInterfaces())) for (const i of L || []) if (i.family === 'IPv4' && !i.internal) ips.push('    ' + i.address + ':' + CONF.puerto + '   (' + name + ')');
  say('');
  say('==============================================================');
  say('  SERVIDOR DE LEGADOS DE AURELIA EN MARCHA  (puerto ' + CONF.puerto + ')');
  say('==============================================================');
  say('  En este mismo PC el juego se conecta a:  localhost:' + CONF.puerto);
  say('  Desde otros PC, una de estas direcciones (con Radmin VPN, la que empieza por 26.):');
  say(ips.join('\n') || '    (no se ha encontrado ninguna red)');
  say('  Cuentas: ' + Object.keys(db.cuentas).length + '  ·  personajes: ' + Object.keys(db.pjs).length + '  ·  códigos sin usar: ' + Object.values(db.codigos).filter((c) => !c.usado).length);
  say('  Escribe «ayuda» para ver los comandos. No cierres esta ventana mientras se juega.');
  if (!Object.keys(db.cuentas).length) {
    say('');
    say('  >> No hay ninguna cuenta todavía. Escribe «codigo» para crear tu primer código de invitación');
    say('     y regístrate TÚ PRIMERO en el juego: la primera cuenta que se crea es la del administrador.');
  }
  say('');
  log('Servidor en marcha en el puerto ' + CONF.puerto);
  startConsole();
  if (CONF.tunel !== false) startTunnel();
});

/* ---------------- el servidor se actualiza solo ----------------
   Cada 5 minutos mira en GitHub (actualizacion.json) si hay un servidor.js nuevo. Si lo hay, lo descarga y comprueba; si no hay
   nadie jugando se reinicia ya, y si hay gente avisa en el chat y se reinicia al minuto (los juegos se reconectan solos).
   El reinicio lo hace INICIAR_SERVIDOR.bat (vuelve a arrancar el servidor cuando este sale con el código 3). */
const SELF = path.join(DIR, 'servidor.js');
const shaFile = (fp) => { try { return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); } catch (e) { return ''; } };
function httpGet(url, binary, hops) {
  return new Promise((res, rej) => {
    const rq = https.get(url, { headers: { 'User-Agent': 'aurelia-servidor', Accept: binary ? 'application/octet-stream' : 'application/vnd.github.raw' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && (hops || 0) < 5) { r.resume(); return httpGet(new URL(r.headers.location, url).href, binary, (hops || 0) + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => res(Buffer.concat(ch)));
    });
    rq.setTimeout(60000, () => rq.destroy(new Error('sin respuesta'))); rq.on('error', rej);
  });
}
let selfUpd = false;
async function checkSelfUpdate() {
  if (selfUpd || shuttingDown || CONF.autoActualizar === false || process.env.AURELIA_SIN_ACTUALIZAR) return;   // (en el PC de desarrollo no se actualiza solo)
  try {
    const man = JSON.parse((await httpGet('https://api.github.com/repos/' + (CONF.github || 'impresoraed/aurelia-config') + '/contents/actualizacion.json')).toString('utf8'));
    const s = man && man.servidor; if (!s || !s.sha || !man.url) return;
    if (s.sha === shaFile(SELF)) return;
    const files = [['servidor.js', s.sha]].concat(s.ws ? [['ws_mini.js', s.ws]] : []), got = [];
    for (const [n, sh] of files) { const b = await httpGet(man.url + n, true); if (crypto.createHash('sha256').update(b).digest('hex') !== sh) throw new Error(n + ' dañado'); got.push([n, b]); }
    selfUpd = true;
    const apply = () => {
      for (const [n, b] of got) { const fp = path.join(DIR, n); try { fs.copyFileSync(fp, fp + '.anterior'); } catch (e) {} fs.writeFileSync(fp, b); }
      log('Servidor actualizado (' + (man.juego || '') + '). Reiniciando…'); shutdown(3);
    };
    if (!inWorld().length && !online.size) return apply();
    log('Hay un servidor nuevo: se reinicia en 60 s (avisados los jugadores).');
    for (const o of conns) send(o, { t: 'chat', k: 'global', id: '', name: 'Servidor', txt: 'El servidor se reinicia en 1 minuto para actualizarse. Tu partida está guardada; el juego se reconectará solo.' });
    setTimeout(apply, 60000);
  } catch (e) { if (!/HTTP 404/.test(e.message)) log('No se ha podido comprobar si hay un servidor nuevo: ' + e.message); }
}
setTimeout(checkSelfUpdate, 20000); setInterval(checkSelfUpdate, 5 * 60000).unref();

/* ---------------- túnel de Cloudflare + dirección publicada en GitHub ----------------
   El servidor abre él solo el túnel (cloudflared) y, cada vez que Cloudflare le da una dirección nueva, la escribe en el archivo
   server.txt de tu GitHub. Los juegos instalados leen ese archivo al arrancar y al perder la conexión: siempre encuentran el servidor
   aunque la dirección cambie, sin reinstalar nada.
   Necesita: cloudflared.exe (en esta carpeta o instalado en Windows) y, para publicar, el archivo github_token.txt en esta carpeta
   con un token de GitHub que pueda escribir en ese repositorio (instrucciones en LEEME_SERVIDOR.txt). Sin token, el túnel funciona
   igual pero la dirección hay que ponerla a mano en GitHub. */
const { spawn } = require('child_process'), https = require('https');
let tunUrl = '', tunProc = null, tunFails = 0;
function findCloudflared() {
  const local = path.join(DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  const cands = process.platform === 'win32' ? [path.join(process.env['ProgramFiles(x86)'] || '', 'cloudflared', 'cloudflared.exe'), path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe')] : [];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return 'cloudflared';   // en el PATH de Windows (instalado con winget o el instalador oficial)
}
function startTunnel() {
  const exe = findCloudflared();
  let p;
  try { p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:' + CONF.puerto], { windowsHide: true }); }
  catch (e) { log('No se ha podido abrir el túnel de Cloudflare: ' + e.message); return; }
  tunProc = p; let seen = false;
  const onData = (b) => {
    const m = String(b).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !seen) { seen = true; tunFails = 0; const url = m[0]; if (url !== tunUrl) { tunUrl = url; log('Túnel abierto: ' + url); publishAddr(url); } }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', (e) => { if (e.code === 'ENOENT') { log('No se encuentra cloudflared: el túnel no se abre. Descárgalo (instrucciones en LEEME_SERVIDOR.txt) y pon cloudflared.exe en esta carpeta.'); tunProc = null; return; } log('Error del túnel: ' + e.message); });
  p.on('exit', (code) => {
    if (tunProc !== p) return; tunProc = null;
    if (shuttingDown) return;
    tunFails++; const wait = Math.min(60, 5 * tunFails);
    log('El túnel se ha cerrado (código ' + code + '). Se vuelve a abrir en ' + wait + ' s.');
    setTimeout(() => { if (!shuttingDown) startTunnel(); }, wait * 1000);
  });
}
function ghReq(method, apiPath, token, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ host: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'aurelia-servidor', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (r) => {
      let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} res({ status: r.statusCode, json: j }); });
    });
    req.on('error', rej); req.setTimeout(15000, () => req.destroy(new Error('sin respuesta'))); if (data) req.write(data); req.end();
  });
}
async function publishAddr(url, tries) {
  tries = tries || 0;
  const tf = path.join(DIR, 'github_token.txt');
  let token = ''; try { token = fs.readFileSync(tf, 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || ''; } catch (e) {}
  if (!token) { log('Para que los juegos encuentren esta dirección solos, falta github_token.txt (ver LEEME_SERVIDOR.txt). Ponla a mano en GitHub: ' + url); return; }
  const repo = String(CONF.github || ''), file = String(CONF.githubArchivo || 'server.txt'), branch = String(CONF.githubRama || 'main');
  const api = '/repos/' + repo + '/contents/' + encodeURIComponent(file);
  try {
    const cur = await ghReq('GET', api + '?ref=' + encodeURIComponent(branch), token);
    if (cur.status === 401 || cur.status === 403) return log('GitHub no acepta el token de github_token.txt (caducado o sin permiso de escritura en ' + repo + ').');
    const old = cur.json && cur.json.content ? Buffer.from(cur.json.content, 'base64').toString('utf8').trim() : '';
    if (old === url) return log('La dirección ya estaba publicada en GitHub.');
    const r = await ghReq('PUT', api, token, { message: 'Nueva dirección del servidor', content: Buffer.from(url + '\n').toString('base64'), branch, ...(cur.json && cur.json.sha ? { sha: cur.json.sha } : {}) });
    if (r.status === 200 || r.status === 201) log('Dirección publicada en GitHub: los juegos se conectarán solos a ' + url);
    else throw new Error('GitHub respondió ' + r.status + (r.json && r.json.message ? ' (' + r.json.message + ')' : ''));
  } catch (e) {
    log('No se ha podido publicar la dirección en GitHub: ' + e.message + (tries < 5 ? ' · se reintenta en 30 s' : ''));
    if (tries < 5) setTimeout(() => { if (url === tunUrl) publishAddr(url, tries + 1); }, 30000);
  }
}
