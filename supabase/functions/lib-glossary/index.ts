// lib-glossary: admin quản lý thư viện thuật ngữ. Không ràng buộc chuẩn JSON research.
// POST { action: "list" }
//    | { action: "save", term: {...} }            (có term_id → sửa, không có → thêm)
//    | { action: "delete", term_id }
//    | { action: "import", terms: [{...}, ...] }  (thêm mới hoặc cập nhật theo term + industry)
import { cors, json, serviceClient, requireAdmin, HttpError } from "../_shared/common.ts";

const COLS = "term_id,slug,term,full_name,vi_name,industry,aliases,short_def,body,formula,example,related,auto_link,match_case,is_published,updated_at";

const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "term";
const text = (v: unknown, max: number) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `field_too_long_${max}`);
  return s;
};
const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [])
  .map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function clean(t: any) {
  const term = text(t?.term, 80);
  const short_def = text(t?.short_def ?? t?.definition, 500);
  if (!term) throw new HttpError(400, "term_required");
  if (!short_def) throw new HttpError(400, `short_def_required:${term}`);
  const industry = (text(t.industry, 30) ?? "general").toLowerCase();
  if (!/^[a-z_]{2,30}$/.test(industry)) throw new HttpError(400, `invalid_industry:${industry}`);
  return {
    term, short_def, industry,
    full_name: text(t.full_name, 200), vi_name: text(t.vi_name, 200),
    body: text(t.body, 20000), formula: text(t.formula, 2000), example: text(t.example, 4000),
    aliases: list(t.aliases), related: list(t.related),
    auto_link: bool(t.auto_link, true), match_case: bool(t.match_case, true), is_published: bool(t.is_published, true),
  };
}

async function freeSlug(db: any, base: string, industry: string, selfId?: string) {
  for (const s of [base, `${base}-${industry.replace(/_/g, "-")}`, `${base}-${Date.now().toString(36)}`]) {
    const { data, error } = await db.from("lib_glossary_terms").select("term_id").eq("slug", s).maybeSingle();
    if (error) throw error;
    if (!data || data.term_id === selfId) return s;
  }
  throw new HttpError(409, "slug_conflict");
}

async function findSame(db: any, term: string, industry: string) {
  const { data, error } = await db.from("lib_glossary_terms").select("term_id,slug").eq("industry", industry).ilike("term", term.replace(/[%_\\]/g, "\\$&"));
  if (error) throw error;
  return data?.[0] ?? null;
}

async function save(db: any, actor: string, raw: any) {
  const row = clean(raw);
  const id: string | undefined = raw?.term_id || (await findSame(db, row.term, row.industry))?.term_id;
  const now = new Date().toISOString();
  if (id) {
    const slug = await freeSlug(db, slugify(row.term), row.industry, id);
    const { data, error } = await db.from("lib_glossary_terms").update({ ...row, slug, updated_at: now, updated_by: actor }).eq("term_id", id).select(COLS).single();
    if (error) throw error;
    return { action: "updated", term: data };
  }
  const slug = await freeSlug(db, slugify(row.term), row.industry);
  const { data, error } = await db.from("lib_glossary_terms").insert({ ...row, slug, created_by: actor, updated_by: actor }).select(COLS).single();
  if (error) throw error;
  return { action: "created", term: data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const svc = serviceClient();
  try {
    const actor = await requireAdmin(req, svc);
    const body = await req.json().catch(() => ({}));
    const db = svc.schema("invstock");
    if (body.action === "list") {
      const { data, error } = await db.from("lib_glossary_terms").select(COLS).order("term");
      if (error) throw error;
      return json({ success: true, terms: data });
    }
    if (body.action === "save") return json({ success: true, ...(await save(db, actor, body.term)) });
    if (body.action === "delete") {
      if (!body.term_id) throw new HttpError(400, "term_id_required");
      const { error } = await db.from("lib_glossary_terms").delete().eq("term_id", body.term_id);
      if (error) throw error;
      return json({ success: true });
    }
    if (body.action === "import") {
      const items = Array.isArray(body.terms) ? body.terms : [];
      if (!items.length) throw new HttpError(400, "terms_required");
      if (items.length > 500) throw new HttpError(400, "too_many_terms");
      const results: unknown[] = [];
      for (const [i, t] of items.entries()) {
        try { const r = await save(db, actor, t); results.push({ i, term: r.term.term, action: r.action }); }
        catch (e) { results.push({ i, term: t?.term ?? null, error: e instanceof HttpError ? e.message : String((e as any)?.message ?? e) }); }
      }
      return json({ success: true, results });
    }
    throw new HttpError(400, "unknown_action");
  } catch (e) {
    if (e instanceof HttpError) return json({ success: false, error: e.message }, e.status);
    console.error("lib-glossary-error", e);
    return json({ success: false, error: (e as any)?.message ?? "lib_glossary_failed" }, 500);
  }
});
