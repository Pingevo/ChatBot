export async function getPersona(shopname, platform) {
  if (!shopname || platform !== "shopee") return null;
  return {
    persona_id: `persona-${shopname}`,
    shopname,
    platform,
    bot_name: `ผู้ช่วย ${shopname}`,
    enabled: true,
    notes: `บุคลิกของ ${shopname}`,
  };
}
