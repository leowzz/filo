import { useQuery } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import { api } from "./api";
import { s3Providers } from "./s3Providers";
import type { S3Provider, Volume } from "./types";
import rustfsIcon from "./assets/providers/rustfs.ico";
import tosIcon from "./assets/providers/tos.png";
import ossIcon from "./assets/providers/oss.ico";

const icons = { rustfs: rustfsIcon, tos: tosIcon, oss: ossIcon };

export function S3ProviderIcon({ provider }: { provider: S3Provider }) {
  return (
    <span className="storage-provider-icon" aria-hidden="true">
      {provider === "generic" ? (
        <Cloud size={26} />
      ) : (
        <img src={icons[provider]} alt="" draggable={false} />
      )}
    </span>
  );
}

export function StorageTypeLabel({ volume }: { volume: Volume }) {
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    enabled: volume.root.type === "s3",
    staleTime: 60_000,
  });
  if (volume.root.type === "local") return <>本地文件系统</>;
  const connection = connections.data?.find(
    (item) => item.id === volume.connection_id,
  );
  if (!connection) return <>S3 存储</>;
  const provider = connection.config.provider ?? "generic";
  return <>{provider === "generic" ? "通用" : s3Providers[provider].name}</>;
}
