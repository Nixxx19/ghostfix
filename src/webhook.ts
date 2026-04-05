import crypto from "crypto";
import { Request, Response } from "express";
import { config } from "./config";
import { getInstallationOctokit } from "./github";
import { createProvider } from "./ai";
import { fixIssue } from "./fixer";

function verifySignature(payload: string, signature: string): boolean {
  const expected = `sha256=${crypto
    .createHmac("sha256", config.github.webhookSecret)
    .update(payload)
    .digest("hex")}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers["x-hub-signature-256"] as string;
  const event = req.headers["x-github-event"] as string;
  const rawBody = (req as any).rawBody as string;

  // Verify webhook signature
  if (!signature || !verifySignature(rawBody, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body;

  // We only care about issues being labeled
  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;

    if (label === config.triggerLabel) {
      const issue = payload.issue;
      const repo = payload.repository;
      const installationId = payload.installation?.id;

      if (!installationId) {
        console.error("[webhook] No installation ID in payload");
        res.status(400).json({ error: "Missing installation ID" });
        return;
      }

      // Respond immediately, process in background
      res.status(202).json({ message: "Processing issue" });

      try {
        const octokit = await getInstallationOctokit(installationId);
        const ai = createProvider();

        await fixIssue(
          octokit,
          ai,
          repo.owner.login,
          repo.name,
          issue.number,
          issue.title,
          issue.body || ""
        );
      } catch (err) {
        console.error(`[webhook] Error processing issue #${issue.number}:`, err);
      }

      return;
    }
  }

  res.status(200).json({ message: "OK" });
}
