import { request } from "@/ui/shared/api/request";

export const getConfig = () => request<{ maxUploadMb: number }>("/api/config");
