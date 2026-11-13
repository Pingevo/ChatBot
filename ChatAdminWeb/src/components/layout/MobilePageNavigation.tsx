"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

type MobilePageNavigationValue = {
  goBack: (fallback?: string) => void;
};

const MobilePageNavigationContext = createContext<MobilePageNavigationValue>({
  goBack: () => {},
});

export function MobilePageNavigationProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const routeHistory = useRef<string[]>([]);

  useEffect(() => {
    if (!pathname) return;
    const history = routeHistory.current;
    if (history.at(-1) === pathname) return;
    if (history.at(-2) === pathname) history.pop();
    else history.push(pathname);
  }, [pathname]);

  const goBack = useCallback((fallback = "/dashboard") => {
    const history = routeHistory.current;
    if (history.length > 1) {
      history.pop();
      router.push(history[history.length - 1]);
      return;
    }
    if (history[0] !== fallback) {
      history.splice(0, history.length, fallback);
      router.push(fallback);
    }
  }, [router]);

  const value = useMemo(() => ({ goBack }), [goBack]);
  return (
    <MobilePageNavigationContext.Provider value={value}>
      {children}
    </MobilePageNavigationContext.Provider>
  );
}

export function useMobilePageNavigation() {
  return useContext(MobilePageNavigationContext);
}
