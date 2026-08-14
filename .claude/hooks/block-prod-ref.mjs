// 本番 Project Ref への直接操作を止める。matcher "*" で全ツールに掛かる。
import {
  readHookInput,
  collectStrings,
  deny,
  failClosed,
  COMMAND_KEYS,
  PATH_KEYS,
} from "./_input.mjs";

const PROD_REF = "kwpldqbnkraftaahnpev";

try {
  const input = readHookInput();

  // 止めるべきは「言及」ではなく「操作」。CLAUDE.md や .claude/rules/security.md は
  // 規則としてこの Ref を本文に含むため、ペイロード全体を走査すると
  // それらの文書の編集自体が deny され、フック自身で自縄自縛になる。
  // よってコマンド系・パス系フィールドに限定して走査する。
  const scanned = [...collectStrings(input, COMMAND_KEYS), ...collectStrings(input, PATH_KEYS)];

  if (scanned.some((s) => s.includes(PROD_REF))) {
    deny("本番Project Refへの直接操作は禁止。本番反映はCI/CDのみ");
  }

  process.exit(0);
} catch (e) {
  failClosed("block-prod-ref", e);
}
