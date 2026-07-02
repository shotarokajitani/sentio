#!/bin/bash
IN=$(cat)
if echo "$IN" | grep -qE 'sk_live|whsec_|xoxb-|GOCSPX-|re_[A-Za-z0-9]{16}'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"秘密の実値らしき文字列を検出。値はVault/Secretsへ、文書にはポインタのみ"}}'; exit 2
fi; exit 0
