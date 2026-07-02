#!/bin/bash
IN=$(cat); P=$(echo "$IN" | grep -oE '"file_path"\s*:\s*"[^"]*"' | head -1)
if echo "$P" | grep -qE '\.env($|\.)' && ! echo "$P" | grep -q '\.env\.example'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":".envの読み取りは禁止（.env.exampleのみ許可）"}}'; exit 2
fi; exit 0
