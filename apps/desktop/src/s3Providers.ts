import type { S3Config, S3Provider } from "./types";

export const s3Providers = {
  generic: {
    name: "通用 S3 协议",
    description: "AWS S3、MinIO 及其他兼容服务",
    region: "us-east-1",
  },
  rustfs: {
    name: "RustFS",
    description: "连接自建 RustFS 服务",
    region: "us-east-1",
  },
  tos: {
    name: "火山云 TOS",
    description: "按地域自动配置 S3 访问地址",
    region: "cn-beijing",
  },
  oss: {
    name: "阿里云 OSS",
    description: "按地域自动配置 S3 访问地址",
    region: "cn-hangzhou",
  },
} satisfies Record<
  S3Provider,
  { name: string; description: string; region: string }
>;

// Public-cloud region presets, checked against the provider docs on 2026-09-16.
// https://www.volcengine.com/docs/6349/107356
// https://help.aliyun.com/zh/oss/user-guide/regions-and-endpoints
export const cloudRegions: Record<
  "tos" | "oss",
  readonly (readonly [string, string])[]
> = {
  tos: [
    ["cn-beijing", "华北2（北京）"],
    ["cn-guangzhou", "华南1（广州）"],
    ["cn-shanghai", "华东2（上海）"],
    ["cn-hongkong", "中国香港"],
    ["ap-southeast-1", "亚太东南（柔佛）"],
    ["ap-southeast-3", "亚太东南（雅加达）"],
  ],
  oss: [
    ["cn-hangzhou", "华东1（杭州）"],
    ["cn-shanghai", "华东2（上海）"],
    ["cn-wuhan-lr", "华中1（武汉）"],
    ["cn-qingdao", "华北1（青岛）"],
    ["cn-beijing", "华北2（北京）"],
    ["cn-zhangjiakou", "华北3（张家口）"],
    ["cn-huhehaote", "华北5（呼和浩特）"],
    ["cn-wulanchabu", "华北6（乌兰察布）"],
    ["cn-shenzhen", "华南1（深圳）"],
    ["cn-heyuan", "华南2（河源）"],
    ["cn-guangzhou", "华南3（广州）"],
    ["cn-chengdu", "西南1（成都）"],
    ["cn-zhongwei", "西北2（中卫）"],
    ["cn-hongkong", "中国香港"],
    ["ap-northeast-1", "日本（东京）"],
    ["ap-northeast-2", "韩国（首尔）"],
    ["ap-southeast-1", "新加坡"],
    ["ap-southeast-3", "马来西亚（吉隆坡）"],
    ["ap-southeast-5", "印度尼西亚（雅加达）"],
    ["ap-southeast-6", "菲律宾（马尼拉）"],
    ["ap-southeast-7", "泰国（曼谷）"],
    ["ap-southeast-8", "马来西亚（柔佛州）"],
    ["sa-east-1", "巴西（圣保罗）"],
    ["eu-central-1", "德国（法兰克福）"],
    ["eu-west-1", "英国（伦敦）"],
    ["eu-west-2", "法国（巴黎）"],
    ["us-west-1", "美国（硅谷）"],
    ["us-east-1", "美国（弗吉尼亚）"],
    ["na-south-1", "墨西哥"],
    ["me-east-1", "阿联酋（迪拜）"],
  ],
};

export type EndpointMode = "public" | "internal" | "custom";

export function cloudEndpoint(
  provider: S3Provider,
  region: string,
  internal = false,
): string {
  if (!region.trim()) return "";
  if (provider === "tos")
    return `https://tos-s3-${region.trim()}.${internal ? "ivolces" : "volces"}.com`;
  if (provider === "oss")
    return `https://s3.oss-${region.trim()}${internal ? "-internal" : ""}.aliyuncs.com`;
  return "";
}

export function endpointMode(
  provider: S3Provider,
  config?: S3Config,
): EndpointMode {
  if (!config) return "public";
  // Keep saved URLs exactly, including custom endpoints and legacy HTTP URLs.
  if (config.endpoint === cloudEndpoint(provider, config.region))
    return "public";
  if (config.endpoint === cloudEndpoint(provider, config.region, true))
    return "internal";
  return "custom";
}

export function validEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}
