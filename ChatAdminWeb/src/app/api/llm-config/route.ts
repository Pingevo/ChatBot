// GET/PUT /api/llm-config — LLM key pool + model roles (dev only)
import { NextRequest, NextResponse } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { getLlmConfigMasked, updateLlmConfig, MODEL_ROLES } from "@/backend/service/llmConfigService";

function error(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const r = await requirePageEdit(req, "llm"); // dev only
  if (!r.ok) return r.response;
  const cfg = await getLlmConfigMasked();
  return NextResponse.json({ ok: true, ...cfg, model_roles: MODEL_ROLES });
}

export async function PUT(req: NextRequest) {
  const r = await requirePageEdit(req, "llm"); // dev only
  if (!r.ok) return r.response;
  let body: {
    pool?: "gemini" | "openrouter";
    add_keys?: (string | { name?: string; value?: string })[];
    remove_sha256?: string[];
    set_enabled?: { sha256: string; enabled: boolean }[];
    rename?: { sha256: string; name: string }[];
    models?: Record<string, string>;
  };
  try {
    body = await req.json();
  } catch {
    return error("invalid body");
  }
  try {
    await updateLlmConfig(
      {
        pool: body.pool,
        add_keys: body.add_keys,
        remove_sha256: body.remove_sha256,
        set_enabled: body.set_enabled,
        rename: body.rename,
        models: body.models,
      },
      r.ctx.admin.username || r.ctx.admin.email || "dev"
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return error(e instanceof Error ? e.message : "update failed");
  }
}
