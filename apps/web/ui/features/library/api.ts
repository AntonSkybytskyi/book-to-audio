import type { ConfigView } from "@book-to-audio/contracts";
import { request } from "@/ui/shared/api/request";

export const getConfig = () => request<ConfigView>("/api/config");
