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

function isBotMentioned(text: string): boolean {
  const mention = `@${config.botName}`;
  return text.toLowerCase().includes(mention.toLowerCase());
}

async function processIssue(
  installationId: number,
  repo: { owner: { login: string }; name: string },
  issue: { number: number; title: string; body?: string }
): Promise<void> {
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
  const installationId = payload.installation?.id;

  if (!installationId) {
    res.status(200).json({ message: "OK" });
    return;
  }

  // Trigger 1: Issue labeled with ai-fix
  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;

    if (label === config.triggerLabel) {
      const timestamp = new Date().toISOString();
      res.status(202).json({ message: "Processing issue", timestamp });
      processIssue(installationId, payload.repository, payload.issue);
      return;
    }
  }

  // Trigger 2: @ghostfix-bot mentioned in an issue comment
  if (event === "issue_comment" && payload.action === "created") {
    const comment = payload.comment?.body || "";

    if (isBotMentioned(comment)) {
      const issue = payload.issue;

      // Don't respond to our own comments
      if (payload.comment?.performed_via_github_app?.id?.toString() === config.github.appId) {
        res.status(200).json({ message: "Ignoring own comment" });
        return;
      }

      console.log(`[webhook] Bot mentioned in issue #${issue.number}`);
      const timestamp = new Date().toISOString();
      res.status(202).json({ message: "Processing mention", timestamp });
      processIssue(installationId, payload.repository, issue);
      return;
    }
  }

  const timestamp = new Date().toISOString();
  res.status(200).json({ message: "OK", timestamp });
}