export function validateSigning(env, platform) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim())
    throw new Error("缺少 TAURI_SIGNING_PRIVATE_KEY，不能生成可更新的发布包。");
  if (platform !== "darwin") return;
  for (const group of [
    [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
    ],
    ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"],
  ]) {
    const present = group.filter((key) => env[key]?.trim());
    if (present.length && present.length !== group.length)
      throw new Error(`签名配置不完整：${group.join(", ")}`);
  }
  if (env.APPLE_ID && !env.APPLE_CERTIFICATE)
    throw new Error("公证需要 Developer ID Application 证书。");
  if (
    env.APPLE_ID &&
    !env.APPLE_SIGNING_IDENTITY.startsWith("Developer ID Application:")
  )
    throw new Error("公证签名身份必须是 Developer ID Application。");
}
