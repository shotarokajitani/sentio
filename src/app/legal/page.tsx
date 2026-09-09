import { notFound } from "next/navigation";
import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";
import { SENTIO_PRICE_JPY_TAX_INCLUDED, SENTIO_TRIAL_DAYS } from "@/lib/pricing";

export const metadata = { title: `${t.legal.noticeTitle} — ${t.brand}` };

/**
 * **このページだけは静的生成しない**（2026-09-09 検収者）。
 *
 * 既定のまま静的生成すると、**ビルド時点で `SENTIO_SUPPORT_EMAIL` が未設定なら
 * 404 が焼き付く。** 後から値を入れても、再デプロイするまで 404 のままである。
 *
 * トップのフッターのリンクは静的のままでよい。**こちらだけ動的にしておけば、
 * ずれる向きが「ページは出るが、リンクがまだ出ない」に限られる。**
 * 逆（リンクは出るのにページが 404）を起こさせない。
 */
export const dynamic = "force-dynamic";

/**
 * 特定商取引法に基づく表記（2026-09-09 検収者の承認済み文言）。
 *
 * **窓口のアドレスが設定されていなければ 404 を返す**（fail-closed）。
 * `support@sentio-ai.jp` は 2026-09-09 時点で**バウンスも返らず受信箱にも届かない**
 * （DR-1 が未了）。**届かないアドレスを法定の表記に載せるくらいなら、ページを出さない。**
 * 値が入っている環境では、**次のリクエストから**表記が出る（上の `force-dynamic`）。
 * ただし Vercel は環境変数の変更を**動いているデプロイには反映しない**ので、
 * 値を入れたあとは**再デプロイが要る**。ここが持っているのは
 * 「ビルド時点の値を焼き付けない」ところまでである。
 *
 * 金額と無料期間は `@/lib/pricing` から差し込む。**数字をここに書かない。**
 * 6項目（提供内容 / 価格 / 支払 / 提供時期 / 申込期間 / 解約）の文言は
 * 申込前の最終確認画面と**同じ辞書**から出す。食い違うと、確認画面の意味が無くなる。
 */
export default function LegalPage() {
  const supportEmail = process.env.SENTIO_SUPPORT_EMAIL?.trim();
  if (!supportEmail) notFound();

  const n = t.legalNotice;

  return (
    <main className="page prose">
      <Masthead />

      <h1>{t.legal.noticeTitle}</h1>

      <h2>{n.sellerLabel}</h2>
      <p>{n.seller}</p>

      <h2>{n.representativeLabel}</h2>
      <p>{n.representative}</p>

      <h2>{n.addressLabel}</h2>
      <p>{n.postalCode}</p>
      <p>{n.address}</p>

      <h2>{n.phoneLabel}</h2>
      <p>{n.phone}</p>
      <p>{n.phoneHours}</p>
      <p>{n.phoneNote}</p>

      <h2>{n.emailLabel}</h2>
      <p>{supportEmail}</p>

      <h2>{n.priceLabel}</h2>
      <p>{n.price(SENTIO_PRICE_JPY_TAX_INCLUDED)}</p>
      <p>{n.priceTrial(SENTIO_TRIAL_DAYS)}</p>
      <p>{n.priceTrialNote}</p>

      <h2>{n.extraCostLabel}</h2>
      <p>{n.extraCost}</p>

      <h2>{n.paymentMethodLabel}</h2>
      <p>{n.paymentMethod1}</p>
      <p>{n.paymentMethod2}</p>
      <p>{n.paymentMethod3}</p>

      <h2>{n.paymentTimingLabel}</h2>
      <p>{n.paymentTiming(SENTIO_TRIAL_DAYS)}</p>
      <p>{n.paymentTimingNote}</p>

      <h2>{n.contentLabel}</h2>
      <p>{n.content1}</p>
      <p>{n.content2}</p>

      <h2>{n.deliveryLabel}</h2>
      <p>{n.delivery}</p>

      <h2>{n.applicationPeriodLabel}</h2>
      <p>{n.applicationPeriod}</p>

      <h2>{n.cancelLabel}</h2>
      <p>{n.cancel1}</p>
      <p>{n.cancel2}</p>
      <p>{n.cancel3}</p>

      <h2>{n.refundLabel}</h2>
      <p>{n.refund1}</p>
      <p>{n.refund2}</p>

      <h2>{n.environmentLabel}</h2>
      <p>{n.environment1}</p>
      <p>{n.environment2}</p>

      <p className="footnote">
        <a href="/terms">{t.login.terms}</a> ／ <a href="/privacy">{t.login.privacy}</a>
      </p>
    </main>
  );
}
