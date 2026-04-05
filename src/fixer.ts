import { Octokit } from "@octokit/rest";
import { AIProvider } from "./ai";
import {
  getRepoTree,
  getFileContent,
  createBranch,
  commitFiles,
  createPullRequest,
  addIssueComment,
} from "./github";

interface FileChange {
  path: string;
  content: string;
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
  ".scala", ".sh", ".bash", ".zsh", ".css", ".scss", ".html",
  ".vue", ".svelte", ".json", ".yaml", ".yml", ".toml", ".md",
  ".sql", ".graphql", ".proto", ".dockerfile", ".tf",
]);

function isCodeFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function selectRelevantFiles(allFiles: string[], maxFiles: number = 40): string[] {
  // Filter out non-code files, tests, and common noise
  const noise = ["node_modules/", "dist/", "build/", ".git/", "vendor/", "__pycache__/", ".next/"];

  return allFiles
    .filter((f) => isCodeFile(f) && !noise.some((n) => f.includes(n)))
    .slice(0, maxFiles);
}

function buildPrompt(
  issueTitle: string,
  issueBody: string,
  fileTree: string[],
  fileContents: Map<string, string>
): string {
  let filesSection = "";
  for (const [path, content] of fileContents) {
    filesSection += `\n--- ${path} ---\n${content}\n`;
  }

  return `You are an expert software engineer. A GitHub issue has been filed and you need to fix it.

## Issue
**Title:** ${issueTitle}
**Description:**
${issueBody}

## Repository file tree
${fileTree.join("\n")}

## Relevant source files
${filesSection}

## Your task
Analyze the issue and the code, then produce a fix. Respond ONLY with a JSON array of file changes. Each element must have:
- "path": the file path (existing or new)
- "content": the complete new file content
- "explanation": a brief explanation of what you changed and why

Example response format:
\`\`\`json
[
  {
    "path": "src/utils.ts",
    "content": "// full file content here...",
    "explanation": "Fixed the off-by-one error in the loop"
  }
]
\`\`\`

Important:
- Return the COMPLETE file content, not just the diff
- Only include files that need changes
- Make minimal, focused changes -do not refactor unrelated code
- If you cannot determine a fix, return an empty array []`;
}

function parseAIResponse(response: string): FileChange[] {
  console.log("[fixer] Raw AI response length:", response.length);
  console.log("[fixer] Raw AI response (first 500 chars):", response.slice(0, 500));

  // Try multiple extraction strategies
  let jsonStr = "";

  // Strategy 1: Extract from ```json ... ``` blocks
  const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  }

  // Strategy 2: Extract from ``` ... ``` blocks
  if (!jsonStr) {
    const codeBlockMatch = response.match(/```\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
  }

  // Strategy 3: Find JSON array directly in the response
  if (!jsonStr) {
    const arrayMatch = response.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0].trim();
    }
  }

  // Strategy 4: Use the whole response
  if (!jsonStr) {
    jsonStr = response.trim();
  }

  console.log("[fixer] Extracted JSON (first 300 chars):", jsonStr.slice(0, 300));

  const parsed = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) {
    throw new Error("AI response is not a JSON array");
  }

  return parsed.map((item: any) => ({
    path: item.path,
    content: item.content,
  }));
}

export async function fixIssue(
  octokit: Octokit,
  ai: AIProvider,
  owner: string,
  repo: string,
  issueNumber: number,
  issueTitle: string,
  issueBody: string
): Promise<void> {
  console.log(`[fixer] Processing issue #${issueNumber}: ${issueTitle}`);

  // Post a comment that we're working on it
  await addIssueComment(
    octokit, owner, repo, issueNumber,
    `👻 **Ghostfix** is analyzing this issue and working on a fix using **${ai.name}**...\n\nI'll open a PR once I have a solution.`
  );

  // Get default branch
  const { data: repoData } = await octokit.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;

  // Get the latest commit SHA
  const { data: refData } = await octokit.git.getRef({
    owner, repo,
    ref: `heads/${defaultBranch}`,
  });
  const baseSha = refData.object.sha;

  // Get repo file tree
  const allFiles = await getRepoTree(octokit, owner, repo, defaultBranch);
  const relevantPaths = selectRelevantFiles(allFiles);

  // Fetch file contents (in parallel, batched)
  const fileContents = new Map<string, string>();
  const batchSize = 10;

  for (let i = 0; i < relevantPaths.length; i += batchSize) {
    const batch = relevantPaths.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const content = await getFileContent(octokit, owner, repo, filePath, defaultBranch);
          // Skip very large files
          if (content.length > 50000) return null;
          return { path: filePath, content };
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (result) {
        fileContents.set(result.path, result.content);
      }
    }
  }

  console.log(`[fixer] Loaded ${fileContents.size} files for analysis`);

  // Build prompt and call AI
  const prompt = buildPrompt(issueTitle, issueBody || "No description provided.", allFiles, fileContents);
  const aiResponse = await ai.analyzeAndFix(prompt);

  // Parse the response
  let changes: FileChange[];
  try {
    changes = parseAIResponse(aiResponse);
  } catch (err) {
    console.error("[fixer] Failed to parse AI response:", err);
    await addIssueComment(
      octokit, owner, repo, issueNumber,
      `👻 **Ghostfix** couldn't generate a valid fix for this issue. The AI response was not in the expected format.\n\nA human will need to look at this one.`
    );
    return;
  }

  if (changes.length === 0) {
    await addIssueComment(
      octokit, owner, repo, issueNumber,
      `👻 **Ghostfix** analyzed the issue but couldn't determine a confident fix.\n\nThis may need manual investigation.`
    );
    return;
  }

  // Create a branch and commit the fix
  const branchName = `ai-fix/issue-${issueNumber}`;

  try {
    await createBranch(octokit, owner, repo, branchName, baseSha);
  } catch (err: any) {
    if (err.status === 422) {
      // Branch already exists -skip
      console.log(`[fixer] Branch ${branchName} already exists, aborting`);
      return;
    }
    throw err;
  }

  const commitMessage = `fix: resolve issue #${issueNumber}\n\n${issueTitle}\n\nAutomated fix generated by Ghostfix`;
  await commitFiles(octokit, owner, repo, branchName, changes, commitMessage);

  // Open a PR
  const prBody = `## Automated Fix for #${issueNumber}

**Issue:** ${issueTitle}

### Changes made
${changes.map((c) => `- \`${c.path}\``).join("\n")}

### How it works
This fix was automatically generated by **Ghostfix** using **${ai.name}**. It analyzed the repository code and the issue description to produce this fix.

> ⚠️ **Please review carefully before merging.** AI-generated fixes should always be verified by a human.

Closes #${issueNumber}`;

  const prNumber = await createPullRequest(
    octokit, owner, repo,
    `fix: ${issueTitle} (Issue #${issueNumber})`,
    prBody,
    branchName,
    defaultBranch
  );

  await addIssueComment(
    octokit, owner, repo, issueNumber,
    `👻 **Ghostfix** has opened a PR with a potential fix: #${prNumber}\n\nPlease review the changes and let me know if adjustments are needed.`
  );

  console.log(`[fixer] Created PR #${prNumber} for issue #${issueNumber}`);
}
