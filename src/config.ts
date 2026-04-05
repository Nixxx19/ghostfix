import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  github: {
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: fs.readFileSync(
      path.resolve(requireEnv("GITHUB_PRIVATE_KEY_PATH")),
      "utf-8"
    ),
    webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
  },
  port: parseInt(process.env.PORT || "3000", 10),
  triggerLabel: process.env.TRIGGER_LABEL || "ai-fix",
  botName: process.env.BOT_NAME || "ghostfix-bot",
};
