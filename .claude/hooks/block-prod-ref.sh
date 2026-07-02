#!/bin/bash
IN=$(cat)
if echo "$IN" | grep -q 'kwpldqbnkraftaahnpev'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"本番Project Refへの直接操作は禁止。本番反映はCI/CDのみ"}}'; exit 2
fi; exit 0
