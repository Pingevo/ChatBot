// Role/permission store — matrix อยู่ใน system_configs doc {config_key:"role_permissions"}
// seed จาก DEFAULT_PERMISSIONS ครั้งแรก — dev แก้ผ่านหน้า /roles, server cache 30s
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import {
  BUILTIN_ROLES, DEFAULT_PERMISSIONS, SUPER_ROLE,
  type AccessLevel,
} from "@/lib/pages";

const CONFIG_KEY = "role_permissions";
const ACCESS_LEVELS: AccessLevel[] = ["none", "read", "edit"];

export interface RoleDef {
  key: string;
  label: string;
  builtin: boolean;
}

export interface RolePermissionsDoc {
  config_key: string;
  roles: RoleDef[];
  permissions: Record<string, Record<string, AccessLevel>>;
  updated_by?: string;
  updated_at?: Date;
}

function seedDoc(): Omit<RolePermissionsDoc, "_id"> {
  return {
    config_key: CONFIG_KEY,
    roles: BUILTIN_ROLES.map((k) => ({ key: k, label: k, builtin: true })),
    permissions: DEFAULT_PERMISSIONS,
  };
}

export async function getRolePermissions(): Promise<RolePermissionsDoc> {
  const coll = await getCollection<RolePermissionsDoc>(COLLECTIONS.systemConfigs);
  const doc = await coll.findOne({ config_key: CONFIG_KEY });
  if (doc) return doc;
  const seed = seedDoc();
  await coll.insertOne(seed as RolePermissionsDoc);
  return seed as RolePermissionsDoc;
}

/** validate + save — builtin roles ลบไม่ได้, dev ห้ามถูกลบ, levels ต้อง valid */
export async function updateRolePermissions(
  updates: {
    roles?: { key: string; label?: string; builtin?: boolean }[];
    permissions?: Record<string, Record<string, string>>;
  },
  updatedBy: string
): Promise<{ error?: string }> {
  const coll = await getCollection<RolePermissionsDoc>(COLLECTIONS.systemConfigs);
  const doc = await getRolePermissions();
  const $set: Record<string, unknown> = { updated_by: updatedBy, updated_at: new Date() };

  if (updates.roles !== undefined) {
    const roles = updates.roles.filter(
      (r) => typeof r?.key === "string" && /^[a-z0-9_-]{2,30}$/.test(r.key)
    );
    if (roles.some((r) => r.key === SUPER_ROLE) === false)
      return { error: "role 'dev' ต้องมีอยู่เสมอ" };
    const keys = new Set(roles.map((r) => r.key));
    if (keys.size !== roles.length) return { error: "role key ซ้ำ" };
    for (const b of BUILTIN_ROLES)
      if (!keys.has(b)) return { error: `ลบ builtin role '${b}' ไม่ได้` };
    $set.roles = roles.map((r) => ({
      key: r.key,
      label: String(r.label || r.key).slice(0, 60),
      builtin: (BUILTIN_ROLES as readonly string[]).includes(r.key),
    }));
  }

  if (updates.permissions !== undefined) {
    const out: Record<string, Record<string, AccessLevel>> = {};
    for (const [page, row] of Object.entries(updates.permissions)) {
      out[page] = {};
      for (const [role, lvl] of Object.entries(row ?? {})) {
        if (ACCESS_LEVELS.includes(lvl as AccessLevel))
          out[page][role] = lvl as AccessLevel;
      }
    }
    // dev ได้ edit ทุกหน้าเสมอ (resolveAccess บังคับอยู่แล้ว แต่เก็บให้ตรงกันด้วย)
    for (const row of Object.values(out)) row[SUPER_ROLE] = "edit";
    $set.permissions = out;
  }

  await coll.updateOne({ config_key: CONFIG_KEY }, { $set }, { upsert: true });
  return {};
}
