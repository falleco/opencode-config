import { tool } from "@opencode-ai/plugin"

/**
 * Get current git context in one call
 */
export default tool({
  description: "Get current git context: branch, status, recent commits, diff stats",
  args: {},
  async execute() {
    const [branch, status, log, diff, remoteStatus] = await Promise.all([
      Bun.$`git branch --show-current`.text().catch(() => "unknown"),
      Bun.$`git status --short`.text().catch(() => ""),
      Bun.$`git log --oneline -5`.text().catch(() => "No commits"),
      Bun.$`git diff --stat HEAD~1 2>/dev/null`.text().catch(() => ""),
      Bun.$`git status -sb | head -1`.text().catch(() => ""),
    ])

    // Parse ahead/behind from remote status
    let syncStatus = ""
    if (remoteStatus.includes("ahead")) {
      const match = remoteStatus.match(/ahead (\d+)/)
      if (match) syncStatus = `↑${match[1]} ahead`
    }
    if (remoteStatus.includes("behind")) {
      const match = remoteStatus.match(/behind (\d+)/)
      if (match) syncStatus += `${syncStatus ? ", " : ""}↓${match[1]} behind`
    }
    if (!syncStatus && remoteStatus.includes("...")) {
      syncStatus = "✓ up to date"
    }

    const statusTrimmed = status.trim()
    const statusDisplay = statusTrimmed
      ? statusTrimmed.split("\n").slice(0, 10).join("\n") +
        (statusTrimmed.split("\n").length > 10 ? `\n... +${statusTrimmed.split("\n").length - 10} more` : "")
      : "(clean)"

    return `Branch: ${branch.trim()}${syncStatus ? ` [${syncStatus}]` : ""}

Status:
${statusDisplay}

Recent commits:
${log.trim()}

Last commit changed:
${diff.trim() || "(no previous commit)"}`
  },
})
