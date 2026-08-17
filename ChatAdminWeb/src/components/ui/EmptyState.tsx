// EmptyState — friendly placeholder when no data
import { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  description?: string;
}

export function EmptyState({ icon: Icon, title, description }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-pale-sky-soft flex items-center justify-center mb-3">
        <Icon size={24} className="text-deep-space" />
      </div>
      <p className="text-text font-medium">{title}</p>
      {description && <p className="text-text-muted text-sm mt-1 max-w-xs">{description}</p>}
    </div>
  );
}
