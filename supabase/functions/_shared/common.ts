import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.86.0";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    (JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default as string | undefined);
  if (!url || !key) throw new Error("server_configuration_missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Returns the caller's user id when the bearer token is a valid user session, else null. */
export async function callerId(req: Request, svc: SupabaseClient): Promise<string | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await svc.auth.getUser(token);
  return error || !data?.user ? null : data.user.id;
}

export async function requireAdmin(req: Request, svc: SupabaseClient): Promise<string> {
  const uid = await callerId(req, svc);
  if (!uid) throw new HttpError(401, "not_signed_in");
  const { data, error } = await svc.schema("invstock").from("research_reviewers")
    .select("user_id").eq("user_id", uid).eq("is_active", true).eq("reviewer_role", "admin").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(403, "not_admin");
  return uid;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export function fromPgBytea(v: string): Uint8Array {
  const h = v.startsWith("\\x") ? v.slice(2) : v;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
