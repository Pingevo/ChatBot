// Avatar — customer/admin avatar with fallback initials
import { useMemo } from "react";

interface Props {
  name: string;
  src?: string;
  size?: number;
  className?: string;
}

export function Avatar({ name, src, size = 40, className = "" }: Props) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }, [name]);

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className={`rounded-full object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={`rounded-full bg-pale-sky text-deep-space flex items-center justify-center font-semibold ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </div>
  );
}
