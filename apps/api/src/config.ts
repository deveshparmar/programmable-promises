function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  jwtSecret: required("JWT_SECRET"),
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? "",
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
  paypalMode: process.env.PAYPAL_MODE === "live" ? "live" : "sandbox",
  aiProvider: process.env.AI_PROVIDER ?? "openai",
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "gpt-4o-mini",
  appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:4200").replace(/\/$/, ""),
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
};

export const paypalBaseUrl =
  config.paypalMode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export function paypalConfigured(): boolean {
  return Boolean(config.paypalClientId && config.paypalClientSecret);
}

export function aiConfigured(): boolean {
  return config.aiProvider === "mock" || Boolean(config.aiApiKey);
}
