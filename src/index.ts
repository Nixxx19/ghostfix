import express from "express";
import { config } from "./config";
import { handleWebhook } from "./webhook";

const app = express();

// Parse JSON body but keep raw body for signature verification
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Health check
app.get("/", (_req, res) => {
  res.json({
    name: "GitHub Issue Fixer Bot",
    status: "running",
    triggerLabel: config.triggerLabel,
  });
});

// Webhook endpoint
app.post("/webhook", handleWebhook);

app.listen(config.port, () => {
  console.log(`🤖 Issue Fixer Bot running on port ${config.port}`);
  console.log(`   Trigger label: "${config.triggerLabel}"`);
  console.log(`   Webhook URL: http://localhost:${config.port}/webhook`);
});
