"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

export function useShopeeSendStatus() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    api().get<{ enabled: boolean }>("/system/shopee-send-status")
      .then((response) => { if (active) setEnabled(response.data.enabled === true); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, []);

  return enabled;
}
