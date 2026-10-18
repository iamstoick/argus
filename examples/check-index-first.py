"""Claude Code PreToolUse hook: nudge the agent to check the Argus index before
creating new code files. Fail-open: any error exits 0 silently.

Install (automatic via `argus init`, or manual):
  1. Copy this file to <project>/.claude/hooks/check-index-first.py and chmod +x it.
  2. Merge examples/claude-hooks.json into <project>/.claude/settings.json,
     replacing the command path with the absolute destination path.
"""

import json
import os
import sys

CODE_EXTS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".py",
    ".pyi",
    ".go",
    ".rs",
    ".php",
    ".rb",
}


def main() -> int:
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    if not isinstance(event, dict) or event.get("tool_name") != "Write":
        return 0
    tool_input = event.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return 0
    path = tool_input.get("file_path") or ""
    _, ext = os.path.splitext(path)
    if ext.lower() not in CODE_EXTS:
        return 0
    if os.path.exists(path):
        return 0  # overwriting an existing file: not new-symbol creation
    context = (
        "Argus index-first rule: you are creating a new code file. Before adding new "
        "functions, classes, or utilities, call the lookup_dictionary MCP tool "
        '(mode "hybrid") to reuse existing code instead of duplicating it.'
    )
    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": context,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
