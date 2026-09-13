"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

/**
 * 送信を1回に絞る（2026-09-13 の本番ログ・二度押し）。**判断だけを持つ。**
 *
 * 応答に約2秒かかる間にボタンが二度押され、同じ Turnstile のトークンで2回目が届き、
 * 1回目は成功しているのにエラーが出ていた。**2回目の submit はブラウザの外に出さない。**
 * Enter キーでの再送信も同じ `submit` イベントを通るので、ここで止まる。
 */
export function createSubmitGuard(): (event: { preventDefault(): void }) => boolean {
  let sent = false;
  return (event) => {
    if (sent) {
      event.preventDefault();
      return false;
    }
    sent = true;
    return true;
  };
}

/**
 * 送信ボタン。送信中は押せず、文言を変える。
 *
 * **`name="intent"` はボタンに付けない**（フォームの hidden に置く）。
 * 押せなくした（disabled の）ボタンの値は送信データから落ちるので、
 * ボタンに持たせると、無効化した瞬間に登録が「ログイン」として届く。
 */
export function SubmitButton(props: { pending: boolean; label: string; pendingLabel: string }) {
  return (
    <button className="btn" type="submit" disabled={props.pending} aria-busy={props.pending}>
      {props.pending ? props.pendingLabel : props.label}
    </button>
  );
}

/** ログイン／登録のフォーム。送信は通常の POST（`/api/auth/session`）のまま */
export function LoginForm(props: {
  intent: "login" | "signup";
  label: string;
  pendingLabel: string;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const guard = useRef<ReturnType<typeof createSubmitGuard> | null>(null);
  if (guard.current === null) guard.current = createSubmitGuard();

  // **「戻る」でこの画面に戻ったとき、押せないまま残さない。**
  // ブラウザが画面を丸ごと保存して戻す（bfcache）と、送信中の状態のまま表示される
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      guard.current = createSubmitGuard();
      setPending(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (guard.current!(event)) setPending(true);
  };

  return (
    <form method="post" action="/api/auth/session" className="section" onSubmit={onSubmit}>
      <input type="hidden" name="intent" value={props.intent} />
      {props.children}
      <div className="actions">
        <SubmitButton pending={pending} label={props.label} pendingLabel={props.pendingLabel} />
      </div>
      {props.after}
    </form>
  );
}
