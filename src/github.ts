import { Octokit } from "@octokit/rest";
import jwt from "jsonwebtoken";
import { config } from "./config";

function generateJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 600,
      iss: config.github.appId,
    },
    config.github.privateKey,
    { algorithm: "RS256" }
  );
}

export async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  const appOctokit = new Octokit({ auth: `Bearer ${generateJWT()}` });

  const { data } = await appOctokit.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  return new Octokit({ auth: data.token });
}

export async function getRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "true",
  });

  return data.tree
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path!);
}

export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref: string
): Promise<string> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref,
  });

  if ("content" in data && data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  throw new Error(`Could not read file: ${filePath}`);
}

export async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  baseSha: string
): Promise<void> {
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
}

export async function commitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  files: { path: string; content: string }[],
  message: string
): Promise<string> {
  // Get the latest commit on the branch
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const latestCommitSha = refData.object.sha;

  const { data: commitData } = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: latestCommitSha,
  });
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const treeItems = await Promise.all(
    files.map(async (file) => {
      const { data: blob } = await octokit.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    })
  );

  // Create tree
  const { data: tree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // Create commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.sha,
    parents: [latestCommitSha],
  });

  // Update branch reference
  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  return newCommit.sha;
}

export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<number> {
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head,
    base,
  });
  return data.number;
}

export async function addIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}
