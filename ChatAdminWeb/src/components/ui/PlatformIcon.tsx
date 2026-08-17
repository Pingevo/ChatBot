// PlatformIcon — colored badge per platform
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

export function PlatformIcon({ platform, size = 24 }: Props) {
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
