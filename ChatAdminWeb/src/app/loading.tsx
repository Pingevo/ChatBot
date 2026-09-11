// loading.tsx — หน้า loading สำหรับ Next.js App Router (shown during route transitions)
import { Loading } from "@/components/ui/Loading";

export default function LoadingPage() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loading size={32} />
    </div>
  );
}
