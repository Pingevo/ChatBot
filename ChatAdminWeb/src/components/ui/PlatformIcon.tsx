// PlatformIcon — แสดง logo ของ platform (Shopee/Lazada/TikTok)
// ถ้ามีไฟล์ใน /public/brands/ จะใช้ logo จริง
// ถ้าไม่มี จะ fallback เป็นตัวอักษร (S/T/L) แบบเดิม
//
// ชื่อไฟล์ที่รองรับ (ผู้ใช้จะใส่เองใน /public/brands/):
//   shopee.svg, shopee.png
//   tiktok.svg, tiktok.png
//   lazada.svg, lazada.png
import { useState } from "react";
import { Platform } from "@/lib/types";

interface Props {
  platform: Platform;
  size?: number;
}

const labels: Record<Platform, string> = {
  shopee: "S",
  tiktok: "T",
  lazada: "L",
};

const classes: Record<Platform, string> = {
  shopee: "platform-shopee",
  tiktok: "platform-tiktok",
  lazada: "platform-lazada",
};

// ลองโหลด logo จาก /public/brands/ ถ้ามี
const LOGO_PATHS: Record<Platform, string> = {
  shopee: "/brands/shopee.png",
  tiktok: "/brands/tiktok.png",
  lazada: "/brands/lazada.png",
};

export function PlatformIcon({ platform, size = 24 }: Props) {
  const [logoError, setLogoError] = useState(false);
  const hasLogo = !logoError;

  if (hasLogo) {
    return (
      <img
        src={LOGO_PATHS[platform]}
        alt={platform}
        width={size}
        height={size}
        className="rounded-md object-contain shrink-0"
        style={{ width: size, height: size }}
        title={platform}
        onError={() => setLogoError(true)}
      />
    );
  }

  // Fallback — ตัวอักษร
  return (
    <div
      className={`${classes[platform]} rounded-md flex items-center justify-center text-white font-bold shrink-0`}
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      title={platform}
    >
      {labels[platform]}
    </div>
  );
}
