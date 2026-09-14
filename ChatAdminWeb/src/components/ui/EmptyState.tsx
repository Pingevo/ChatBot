// EmptyState — friendly placeholder when no data
import { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  description?: string;
}

export function EmptyState({ icon: Icon, title, description }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-12 sm:py-16 text-center px-4">
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-surface-2 flex items-center justify-center mb-4 ring-1 ring-border">
        <Icon size={22} className="text-text-subtle sm:hidden" />
        <Icon size={24} className="text-text-subtle hidden sm:block" />
      </div>
      <p className="text-text font-medium text-sm sm:text-base">{title}</p>
      {description && <p className="text-text-muted text-xs sm:text-sm mt-1 max-w-xs">{description}</p>}
    </div>
  );
}
