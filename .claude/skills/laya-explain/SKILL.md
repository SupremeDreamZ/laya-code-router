---
name: laya-explain
description: Show why Laya Router selected the model used for the last prompt.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

<laya-explain>
Return the report below verbatim in a plain text code block. Do not add analysis or use tools.

!`node "${CLAUDE_SKILL_DIR}/../../../bin/laya-explain.mjs" "${CLAUDE_SESSION_ID}"`
