export function releaseSigningEnvironment(env, platform) {
  const result = { ...env };
  // Actions injects missing secrets as empty strings, but Tauri checks presence.
  for (const key of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    if (!result[key]?.trim()) delete result[key];
  }
  validateSigning(result, platform);
  return result;
}

export function validateSigning(env, platform) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim())
    throw new Error("缺少 TAURI_SIGNING_PRIVATE_KEY，不能生成可更新的发布包。");
  if (platform !== "darwin") return;
  for (const key of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
  ]) {
    if (!env[key]?.trim())
      throw new Error(`macOS 发布缺少 ${key}，必须配置证书签名。`);
  }
  if (env.APPLE_SIGNING_IDENTITY.trim() === "-")
    throw new Error("macOS 发布必须配置证书签名，不能使用 ad-hoc。");
  const notarization = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const present = notarization.filter((key) => env[key]?.trim());
  if (present.length && present.length !== notarization.length)
    throw new Error(`公证配置不完整：${notarization.join(", ")}`);
  if (
    env.APPLE_ID &&
    !env.APPLE_SIGNING_IDENTITY.startsWith("Developer ID Application:")
  )
    throw new Error("公证签名身份必须是 Developer ID Application。");
}
