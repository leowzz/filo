import { useQuery } from "@tanstack/react-query";
import { Cloud, Globe2, KeyRound, Network } from "lucide-react";
import { api } from "./api";
import { s3Providers } from "./s3Providers";
import type { RemoteProtocol, S3Provider, Volume } from "./types";
import rustfsIcon from "./assets/providers/rustfs.ico";
import tosIcon from "./assets/providers/tos.png";
import ossIcon from "./assets/providers/oss.ico";

const icons = { rustfs: rustfsIcon, tos: tosIcon, oss: ossIcon };

export const remoteProtocols: Record<
  Exclude<RemoteProtocol, "ftps">,
  { name: string; description: string; defaultPort: number }
> = {
  ftp: {
    name: "FTP",
    description: "连接 FTP 文件服务器，可启用 SSL 加密",
    defaultPort: 21,
  },
  sftp: {
    name: "SFTP",
    description: "通过 SSH 安全传输文件",
    defaultPort: 22,
  },
  smb: {
    name: "SMB / Samba",
    description: "连接 Windows、NAS 或 Samba 共享目录",
    defaultPort: 445,
  },
};

export function isRemoteProtocol(value: string): value is RemoteProtocol {
  return (
    value === "ftps" ||
    Object.prototype.hasOwnProperty.call(remoteProtocols, value)
  );
}

export function RemoteProviderIcon({ protocol }: { protocol: RemoteProtocol }) {
  const Icon =
    protocol === "sftp" ? KeyRound : protocol === "smb" ? Network : Globe2;
  return (
    <span
      className="storage-provider-icon remote-provider-icon"
      aria-hidden="true"
    >
      <Icon size={25} strokeWidth={1.8} />
    </span>
  );
}

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
    enabled: volume.root.type === "s3" || volume.root.type === "remote",
    staleTime: 60_000,
  });
  if (volume.root.type === "local") return <>本地文件系统</>;
  const connection = connections.data?.find(
    (item) => item.id === volume.connection_id,
  );
  if (!connection)
    return <>{volume.root.type === "remote" ? "远程存储" : "S3 存储"}</>;
  if (volume.root.type === "remote") {
    const protocol = connection.config.protocol;
    return (
      <>
        {protocol && isRemoteProtocol(protocol)
          ? remoteProtocols[protocol === "ftps" ? "ftp" : protocol].name
          : "远程存储"}
      </>
    );
  }
  const provider = connection.config.provider ?? "generic";
  return <>{provider === "generic" ? "通用" : s3Providers[provider].name}</>;
}
