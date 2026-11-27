"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

export function useShopeeSendStatus() {
  const [enabled, setEnabled] = useState(false);
  const refresh = useCallback(async () => {
    const response = await api().get<{ enabled: boolean }>("/system/shopee-send-status");
    const next = response.data.enabled === true;
    setEnabled(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    api().get<{ enabled: boolean }>("/system/shopee-send-status")
      .then((response) => { if (active) setEnabled(response.data.enabled === true); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, []);

  return { enabled, refresh };
}
