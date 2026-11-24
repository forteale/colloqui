// ============================================================
//  SlotBook — API (Netlify Function + Netlify Blobs)
//  Nessun database esterno: tutto vive nello store Blobs del sito.
// ============================================================
import { getStore } from "@netlify/blobs";
import { randomBytes, randomUUID, scryptSync, createHmac, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const STORE_NAME = "slotbook";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 ore

// ── Helpers generali ─────────────────────────────────────────
const db = () => getStore({ name: STORE_NAME, consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status = 400, extra = {}) => json({ ok: false, error: msg, ...extra }, status);

class HttpError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const norm = (s) => str(s).toLowerCase().replace(/\s+/g, " ");
const isTime = (s) => /^\d{2}:\d{2}$/.test(s);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const slotKeyPart = (t) => t.replace(":", "");

export function genSlots(ini, fin, dur) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const out = [];
  if (!isTime(ini) || !isTime(fin) || !(dur > 0)) return out;
  for (let t = toMin(ini); t < toMin(fin) && out.length < 300; t += dur) {
    const h = Math.floor(t / 60), m = t % 60;
    out.push(String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"));
  }
  return out;
}

// Chiavi nello store
const K = {
  secret: "cfg/secret",
  user: (u) => `users/${u}`,
  ev: (id) => `ev/${id}`,
  slug: (s) => `slug/${s}`,
  pren: (ev, bk) => `pren/${ev}/${bk}`,
  slot: (ev, gid, t) => `slot/${ev}/${gid}/${slotKeyPart(t)}`,
};
const bookingKey = (cognome, classe) => b64u(norm(cognome) + "|" + norm(classe || ""));

async function listValues(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const vals = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return vals.filter(Boolean);
}
async function deletePrefix(store, prefix) {
  const { blobs } = await store.list({ prefix });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
}

// ── Auth ─────────────────────────────────────────────────────
async function getSecret(store) {
  const fromEnv = process.env.SLOTBOOK_SECRET;
  if (fromEnv) return fromEnv;
  let s = await store.get(K.secret);
  if (!s) {
    await store.set(K.secret, randomBytes(32).toString("hex"), { onlyIfNew: true });
    s = await store.get(K.secret);
  }
  return s;
}
const hashPw = (pw, salt) => scryptSync(pw, salt, 32).toString("hex");
function checkPw(pw, user) {
  const a = Buffer.from(hashPw(pw, user.salt), "hex");
  const b = Buffer.from(user.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
async function makeToken(store, user) {
  const body = b64u(JSON.stringify({ u: user.username, r: user.ruolo, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = createHmac("sha256", await getSecret(store)).update(body).digest("base64url");
  return body + "." + sig;
}
async function requireUser(req, store) {
  const h = req.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = tok.split(".");
  if (!body || !sig) throw new HttpError("Non autenticato.", 401);
  const exp = createHmac("sha256", await getSecret(store)).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError("Sessione non valida.", 401);
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (p.exp < Date.now()) throw new HttpError("Sessione scaduta, accedi di nuovo.", 401);
  const user = await store.get(K.user(p.u), { type: "json" });
  if (!user) throw new HttpError("Utente non più esistente.", 401);
  return user;
}
const publicUser = (u) => ({ username: u.username, ruolo: u.ruolo, created_at: u.created_at });
const validUsername = (u) => /^[a-z0-9._-]{3,40}$/.test(u);

async function createUser(store, username, password, ruolo) {
  username = norm(username);
  if (!validUsername(username)) throw new HttpError("Username: 3-40 caratteri tra lettere minuscole, numeri, punto, trattino.");
  if (String(password || "").length < 8) throw new HttpError("La password deve avere almeno 8 caratteri.");
  const salt = randomBytes(16).toString("hex");
  const user = { username, salt, hash: hashPw(String(password), salt), ruolo: ruolo === "admin" ? "admin" : "user", created_at: new Date().toISOString() };
  const { modified } = await store.setJSON(K.user(username), user, { onlyIfNew: true });
  if (!modified) throw new HttpError("Username già esistente.", 409);
  return user;
}

// ── Eventi ───────────────────────────────────────────────────
function cleanEvento(input, existing) {
  const nome = str(input.nome, 150);
  const slug = str(input.slug, 80).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const data_evento = str(input.data_evento, 10);
  const slot_attivi = !!input.slot_attivi;
  if (!nome || !slug || !isDate(data_evento)) throw new HttpError("Compila nome, slug e data.");

  const oldGroups = new Map((existing?.gruppi || []).map((g) => [g.id, g]));
  const gruppi = (Array.isArray(input.gruppi) ? input.gruppi : []).slice(0, 30).map((g, i) => {
    const classi = [...new Set((Array.isArray(g.classi) ? g.classi : []).map((c) => str(c, 20).toUpperCase()).filter(Boolean))];
    const orario_inizio = str(g.orario_inizio, 5), orario_fine = str(g.orario_fine, 5);
    const durata_slot = Math.round(Number(g.durata_slot));
    if (!isTime(orario_inizio) || !isTime(orario_fine)) throw new HttpError(`Gruppo ${i + 1}: orari non validi.`);
    if (!(durata_slot >= 1 && durata_slot <= 240)) throw new HttpError(`Gruppo ${i + 1}: durata slot non valida.`);
    if (!classi.length) throw new HttpError("Ogni gruppo deve avere almeno una classe.");
    // id stabile: se il gruppo esisteva già si mantiene, così le prenotazioni restano collegate
    const id = g.id && oldGroups.has(g.id) ? g.id : randomUUID().slice(0, 8);
    const fp = Math.round(Number(g.famiglie_previste));
    const famiglie_previste = fp >= 1 && fp <= 500 ? fp : null;
    return { id, nome: str(g.nome, 80) || `Gruppo ${i + 1}`, classi, orario_inizio, orario_fine, durata_slot, famiglie_previste };
  });
  if (slot_attivi && !gruppi.length) throw new HttpError("Aggiungi almeno un gruppo di classi.");
  const tutte = gruppi.flatMap((g) => g.classi);
  if (new Set(tutte).size !== tutte.length) throw new HttpError("La stessa classe non può stare in due gruppi.");

  const TIPI = ["testo", "numero", "email", "telefono", "data", "select", "checkbox"];
  const campi = (Array.isArray(input.campi) ? input.campi : []).slice(0, 30).map((c, i) => {
    const tipo = TIPI.includes(c.tipo) ? c.tipo : "testo";
    const etichetta = str(c.etichetta, 100);
    if (!etichetta) throw new HttpError(`Campo personalizzato ${i + 1}: manca l'etichetta.`);
    const opzioni = tipo === "select"
      ? (Array.isArray(c.opzioni) ? c.opzioni : String(c.opzioni || "").split(",")).map((o) => str(o, 100)).filter(Boolean)
      : null;
    return { nome: str(c.nome, 40).replace(/[^a-z0-9_]/g, "") || `campo_${i}`, etichetta, tipo, obbligatorio: !!c.obbligatorio, opzioni };
  });
  const nomi = campi.map((c) => c.nome);
  if (new Set(nomi).size !== nomi.length) campi.forEach((c, i) => (c.nome = `campo_${i}`));

  return { nome, slug, data_evento, slot_attivi, gruppi, campi };
}
const canSee = (user, ev) => user.ruolo === "admin" || ev.utente_id === user.username;

async function getEventoBySlug(store, slug) {
  const ref = await store.get(K.slug(str(slug, 80).toLowerCase()), { type: "json" });
  if (!ref) return null;
  return store.get(K.ev(ref.id), { type: "json" });
}
const publicEvento = (ev) => ({
  nome: ev.nome, slug: ev.slug, data_evento: ev.data_evento, slot_attivi: ev.slot_attivi,
  gruppi: ev.gruppi.map((g) => ({ id: g.id, nome: g.nome, classi: g.classi, durata_slot: g.durata_slot })),
  campi: ev.campi,
});
function gruppoPerClasse(ev, classe) {
  if (!ev.gruppi.length) return null;
  return ev.gruppi.find((g) => g.classi.includes(str(classe, 20).toUpperCase())) || null;
}

// ── Prenotazioni (pubblico) ──────────────────────────────────
async function slotsStatus(store, ev, g) {
  const all = genSlots(g.orario_inizio, g.orario_fine, g.durata_slot);
  const { blobs } = await store.list({ prefix: `slot/${ev.id}/${g.id}/` });
  const taken = new Set(blobs.map((b) => b.key.split("/").pop()));
  return all.map((t) => ({ time: t, taken: taken.has(slotKeyPart(t)) }));
}

function cleanDatiExtra(ev, input) {
  const out = {};
  for (const c of ev.campi) {
    const v = input?.[c.nome];
    if (c.tipo === "checkbox") out[c.nome] = !!v;
    else out[c.nome] = str(v, 500);
    if (c.obbligatorio && (c.tipo === "checkbox" ? !out[c.nome] : !out[c.nome])) throw new HttpError(`Compila il campo "${c.etichetta}".`);
    if (c.tipo === "select" && out[c.nome] && !(c.opzioni || []).includes(out[c.nome])) throw new HttpError(`Valore non valido per "${c.etichetta}".`);
  }
  return out;
}

async function prenota(store, body) {
  const ev = await getEventoBySlug(store, body.slug);
  if (!ev) throw new HttpError("Evento non trovato.", 404);
  const cognome = str(body.cognome, 80), nome = str(body.nome, 80);
  if (!cognome || !nome) throw new HttpError("Compila cognome e nome.");
  const g = gruppoPerClasse(ev, body.classe);
  if (ev.gruppi.length && !g) throw new HttpError("Seleziona una classe valida.");
  const classe = g ? str(body.classe, 20).toUpperCase() : null;
  const dati_extra = cleanDatiExtra(ev, body.dati_extra);
  const bk = bookingKey(cognome, classe);
  const pKey = K.pren(ev.id, bk);
  const now = new Date().toISOString();
  const existing = await store.get(pKey, { type: "json" });

  if (!ev.slot_attivi) {
    if (existing) throw new HttpError("Questo cognome è già registrato per questa classe.", 409);
    const rec = { id: bk, evento_id: ev.id, gruppo_id: g?.id || null, cognome, nome, classe, orario: null, dati_extra, created_at: now, updated_at: now };
    const { modified } = await store.setJSON(pKey, rec, { onlyIfNew: true });
    if (!modified) throw new HttpError("Questo cognome è già registrato per questa classe.", 409);
    return { ok: true, modified: false, prenotazione: rec };
  }

  const orario = str(body.orario, 5);
  if (!genSlots(g.orario_inizio, g.orario_fine, g.durata_slot).includes(orario)) throw new HttpError("Orario non valido.");

  if (existing && existing.orario === orario) {
    // Stesso orario: aggiorna solo nome/dati
    const rec = { ...existing, nome, dati_extra, updated_at: now };
    await store.setJSON(pKey, rec);
    return { ok: true, modified: true, prenotazione: rec };
  }

  // Occupa lo slot in modo atomico: se qualcuno l'ha preso un attimo prima, fallisce
  const sKey = K.slot(ev.id, g.id, orario);
  const claim = await store.setJSON(sKey, { pren: bk, at: now }, { onlyIfNew: true });
  if (!claim.modified) throw new HttpError("slot_taken", 409);

  if (existing) {
    const rec = { ...existing, nome, gruppo_id: g.id, orario, dati_extra, updated_at: now };
    await store.setJSON(pKey, rec);
    if (existing.orario && existing.gruppo_id) {
      const oldKey = K.slot(ev.id, existing.gruppo_id, existing.orario);
      const old = await store.get(oldKey, { type: "json" });
      if (old && old.pren === bk) await store.delete(oldKey);
    }
    return { ok: true, modified: true, prenotazione: rec };
  }
  const rec = { id: bk, evento_id: ev.id, gruppo_id: g.id, cognome, nome, classe, orario, dati_extra, created_at: now, updated_at: now };
  const { modified } = await store.setJSON(pKey, rec, { onlyIfNew: true });
  if (!modified) {
    await store.delete(sKey); // un'altra richiesta dello stesso alunno è arrivata in contemporanea
    throw new HttpError("Questo alunno risulta già prenotato: ricarica la pagina.", 409);
  }
  return { ok: true, modified: false, prenotazione: rec };
}

async function deletePrenotazione(store, ev, bk) {
  const pKey = K.pren(ev.id, bk);
  const p = await store.get(pKey, { type: "json" });
  if (!p) return;
  await store.delete(pKey);
  if (p.orario && p.gruppo_id) {
    const sKey = K.slot(ev.id, p.gruppo_id, p.orario);
    const s = await store.get(sKey, { type: "json" });
    if (s && s.pren === bk) await store.delete(sKey);
  }
}

// ── Router ───────────────────────────────────────────────────
export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const store = db();
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  try {
    // ---- PUBBLICO ----
    if (parts[0] === "public") {
      if (method === "GET" && parts[1] === "evento") {
        const ev = await getEventoBySlug(store, url.searchParams.get("slug"));
        if (!ev) return fail("Evento non trovato o link scaduto.", 404);
        return json({ ok: true, evento: publicEvento(ev) });
      }
      if (method === "GET" && parts[1] === "slots") {
        const ev = await getEventoBySlug(store, url.searchParams.get("slug"));
        if (!ev) return fail("Evento non trovato.", 404);
        if (!ev.slot_attivi) return json({ ok: true, slots: [], existing: null });
        const classe = url.searchParams.get("classe") || "";
        const g = gruppoPerClasse(ev, classe);
        if (!g) return fail("Nessun gruppo per questa classe.", 404);
        const slots = await slotsStatus(store, ev, g);
        let existing = null;
        const cognome = str(url.searchParams.get("cognome"), 80);
        if (cognome.length >= 2) {
          const p = await store.get(K.pren(ev.id, bookingKey(cognome, classe.toUpperCase())), { type: "json" });
          if (p) existing = { cognome: p.cognome, nome: p.nome, classe: p.classe, orario: p.orario, dati_extra: p.dati_extra };
        }
        return json({ ok: true, slots, existing });
      }
      if (method === "POST" && parts[1] === "prenota") return json(await prenota(store, await body()));
      return fail("Non trovato.", 404);
    }

    // ---- AUTH ----
    if (parts[0] === "auth") {
      if (method === "GET" && parts[1] === "status") {
        const { blobs } = await store.list({ prefix: "users/" });
        return json({ ok: true, needsSetup: blobs.length === 0 });
      }
      if (method === "POST" && parts[1] === "setup") {
        const { blobs } = await store.list({ prefix: "users/" });
        if (blobs.length) return fail("Configurazione già completata.", 403);
        // lock: solo la prima richiesta di setup passa
        const lock = await store.set("cfg/setup-done", new Date().toISOString(), { onlyIfNew: true });
        if (!lock.modified) return fail("Configurazione già completata.", 403);
        const b = await body();
        try {
          const user = await createUser(store, b.username, b.password, "admin");
          return json({ ok: true, token: await makeToken(store, user), user: publicUser(user) });
        } catch (e) { await store.delete("cfg/setup-done"); throw e; }
      }
      if (method === "POST" && parts[1] === "login") {
        const b = await body();
        const user = await store.get(K.user(norm(b.username)), { type: "json" });
        if (!user || !checkPw(String(b.password || ""), user)) return fail("Credenziali errate.", 401);
        return json({ ok: true, token: await makeToken(store, user), user: publicUser(user) });
      }
      if (method === "GET" && parts[1] === "me") {
        const user = await requireUser(req, store);
        return json({ ok: true, user: publicUser(user) });
      }
      if (method === "POST" && parts[1] === "password") {
        const user = await requireUser(req, store);
        const b = await body();
        if (!checkPw(String(b.attuale || ""), user)) return fail("Password attuale errata.", 403);
        if (String(b.nuova || "").length < 8) return fail("La nuova password deve avere almeno 8 caratteri.");
        const salt = randomBytes(16).toString("hex");
        await store.setJSON(K.user(user.username), { ...user, salt, hash: hashPw(String(b.nuova), salt) });
        return json({ ok: true });
      }
      return fail("Non trovato.", 404);
    }

    // ---- AREA RISERVATA ----
    const user = await requireUser(req, store);

    if (parts[0] === "eventi") {
      if (method === "GET" && !parts[1]) {
        const evs = (await listValues(store, "ev/")).filter((e) => canSee(user, e));
        evs.sort((a, b) => (a.data_evento < b.data_evento ? 1 : -1));
        return json({ ok: true, eventi: evs });
      }
      if (method === "POST" && !parts[1]) {
        const ev = { id: randomUUID(), ...cleanEvento(await body()), utente_id: user.username, created_at: new Date().toISOString() };
        const { modified } = await store.setJSON(K.slug(ev.slug), { id: ev.id }, { onlyIfNew: true });
        if (!modified) return fail("Slug già usato da un altro evento: scegline un altro.", 409);
        await store.setJSON(K.ev(ev.id), ev);
        return json({ ok: true, evento: ev });
      }
      const ev = parts[1] ? await store.get(K.ev(parts[1]), { type: "json" }) : null;
      if (!ev || !canSee(user, ev)) return fail("Evento non trovato.", 404);

      if (method === "GET" && !parts[2]) return json({ ok: true, evento: ev });
      if (method === "PUT" && !parts[2]) {
        const upd = { ...ev, ...cleanEvento(await body(), ev), updated_at: new Date().toISOString() };
        if (upd.slug !== ev.slug) {
          const { modified } = await store.setJSON(K.slug(upd.slug), { id: ev.id }, { onlyIfNew: true });
          if (!modified) return fail("Slug già usato da un altro evento: scegline un altro.", 409);
          await store.delete(K.slug(ev.slug));
        }
        await store.setJSON(K.ev(ev.id), upd);
        return json({ ok: true, evento: upd });
      }
      if (method === "DELETE" && !parts[2]) {
        await deletePrefix(store, `pren/${ev.id}/`);
        await deletePrefix(store, `slot/${ev.id}/`);
        await store.delete(K.slug(ev.slug));
        await store.delete(K.ev(ev.id));
        return json({ ok: true });
      }
      if (parts[2] === "prenotazioni") {
        if (method === "GET" && !parts[3]) {
          const pr = await listValues(store, `pren/${ev.id}/`);
          pr.sort((a, b) => String(a.orario || "").localeCompare(String(b.orario || "")) || a.cognome.localeCompare(b.cognome));
          return json({ ok: true, prenotazioni: pr });
        }
        if (method === "DELETE" && parts[3]) {
          await deletePrenotazione(store, ev, parts[3]);
          return json({ ok: true });
        }
      }
      return fail("Non trovato.", 404);
    }

    if (parts[0] === "utenti") {
      if (user.ruolo !== "admin") return fail("Solo gli admin possono gestire gli utenti.", 403);
      if (method === "GET" && !parts[1]) {
        const us = (await listValues(store, "users/")).map(publicUser);
        us.sort((a, b) => a.created_at.localeCompare(b.created_at));
        return json({ ok: true, utenti: us });
      }
      if (method === "POST" && !parts[1]) {
        const b = await body();
        const u = await createUser(store, b.username, b.password, b.ruolo);
        return json({ ok: true, utente: publicUser(u) });
      }
      if (method === "DELETE" && parts[1]) {
        const target = norm(decodeURIComponent(parts[1]));
        if (target === user.username) return fail("Non puoi eliminare te stesso.");
        const evs = (await listValues(store, "ev/")).filter((e) => e.utente_id === target);
        for (const e of evs) {
          await deletePrefix(store, `pren/${e.id}/`);
          await deletePrefix(store, `slot/${e.id}/`);
          await store.delete(K.slug(e.slug));
          await store.delete(K.ev(e.id));
        }
        await store.delete(K.user(target));
        return json({ ok: true });
      }
      return fail("Non trovato.", 404);
    }

    return fail("Non trovato.", 404);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    console.error(e);
    return fail("Errore interno del server.", 500);
  }
};
