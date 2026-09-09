/**
 * 画面文言の辞書（日本語）。
 *
 * 運用ルール§6「文言のハードコード禁止」。画面側は必ずここを経由する。
 * ブランド固有名詞（Sentio / Google / freee）だけは例外として直接書いてよい。
 */
/**
 * 金額の表示は**この関数1つだけ**が組み立てる（2026-09-09 決定）。
 * 数字は受け取る。**辞書に数字を書かない**——正本は `src/lib/pricing.ts` である。
 */
const monthlyPrice = (yen: number) => `月額 ${yen.toLocaleString("ja-JP")}円（税込）`;

export const ja = {
  brand: "Sentio",

  common: {
    loading: "読み込んでいます",
    signOut: "ログアウト",
    retry: "もう一度読み込む",
  },

  login: {
    title: "ログイン",
    lead: "メールアドレスとパスワードだけで始められます。",
    email: "メールアドレス",
    password: "パスワード",
    siteUrl: "自社サイトのURL（任意）",
    siteUrlHint:
      "入れておくと、外から見た自社の分析と競合の推定が動きます。あとからでも構いません。",
    passwordHint: "8文字以上",
    submit: "ログイン",
    signUp: "新規登録",
    // 入口を分けたので、押し分けの説明（「同じ欄に入力して『新規登録』を押してください」）は
    // 要らなくなった。**押し分けが無くなれば、その説明も要らない**（2026-09-08）
    signUpTitle: "新規登録",
    signUpLead2: "メールアドレスとパスワードだけで始められます。",
    toSignup: "はじめての方はこちら",
    toLogin: "アカウントをお持ちの方はこちら",
    legalLead: "登録すると、以下に同意したものとみなされます。",
    terms: "利用規約",
    privacy: "プライバシーポリシー",
    confirmSent: "確認メールを送りました。メール内のリンクを開くとログインできます。",
  },

  /**
   * ランディング（2026-09-09 検収者の承認済み文言）。**7ブロック。ページは増やさない。**
   *
   * 原則が4つある。**「検出」「予兆」を主語にしない**（本番の findings は0行）。
   * **「会計データを接続」と書かない**（繋がっているのは Googleカレンダーだけ）。
   * **「など」を使わない。** **数字は本番の実測値だけを使い、前に「実測では」を置く。**
   */
  landing: {
    // ブロック1
    title: "毎朝、会社の状態が1通届きます。",
    lead: "Googleカレンダーを読み取り専用でつなぐと、翌朝から届きます。",
    lead2: "日々の入力も、報告も要りません。",
    start: "会社情報を接続する",
    startTrial: (days: number) => `${days}日間は無料です。`,

    // ブロック2。**できることだけを書く**
    nowTitle: "いま届くもの",
    now: [
      {
        title: "予定が6時間ごとに自動で取り込まれます",
        body: "接続した時点で、過去1年ぶんをまとめて読み込みます。",
      },
      {
        title: "「平常」の間隔が数字で出ます",
        body: "実測では、予定の間隔の中央値が3日、短い方から4分の1が1日、長い方から4分の1が12.5日でした。",
      },
      {
        title: "毎朝1通、その日の状態が届きます",
        body: "何も起きていない日は「何も起きていない」と書きます。何も届かない日を作りません。",
      },
      {
        title: "連携が切れたら、その日のうちにお知らせします",
        body: "取り込みが止まっていることを、止まったまま放置しません。",
      },
    ],

    // ブロック3。**できないことを同じ大きさで書く**（後から知らせない）
    notYetTitle: "いまできないこと",
    notYet: [
      {
        title: "つなげるのは Googleカレンダーだけです",
        body: "会計や販売の連携は、まだありません。",
      },
      {
        title: "会計データはCSVで取り込みます",
        body: "銀行の入出金明細を、画面からアップロードしていただきます。自動では取り込めません。",
      },
      {
        title: "変化の自動検出は、まだ動いていません",
        body: "仕組みは入っていますが、検出の実績はまだありません。できるようになったら、ここに書き足します。",
      },
    ],

    // ブロック4
    stepsTitle: "始め方",
    steps: [
      "Googleアカウントでログインします",
      "Googleカレンダーを接続します（読み取りの権限だけです）",
      "翌朝から、状態をまとめたメールが届きます",
    ],

    // ブロック5。金額は `src/lib/pricing.ts` から渡す
    priceTitle: "料金",
    priceAmount: monthlyPrice,
    priceTrial: (days: number) => `お申し込みから${days}日間は無料です。`,
    priceTrialNote: "無料期間の終了日までに解約された場合、料金は発生しません。",
    priceCancel: "解約はいつでもできます。",
    priceCancelNote: "解約後も、お支払いいただいた期間の終了日まではご利用いただけます。",

    // ブロック6
    faqTitle: "よくある質問",
    faq: [
      {
        q: "カレンダーの内容は書き換えられますか",
        a: "いいえ。求める権限は「予定の読み取り」の1つだけです。書き込みの権限は要求していません。",
      },
      {
        q: "取り込んだ情報はどう扱われますか",
        a: "お客様の会社の状態を出すためだけに使います。詳しくはプライバシーポリシーをご覧ください。",
      },
      {
        q: "解約するとどうなりますか",
        a: "ログイン後の「プランと支払いを管理」からいつでも解約できます。お支払いいただいた期間の終了日までは、そのままご利用いただけます。期間の途中で利用が止まることはありません。",
      },
    ],

    // ブロック7
    company: "株式会社ディセーノ",
    companyAddress: "〒150-0043 東京都渋谷区道玄坂1丁目10番8号 渋谷道玄坂東急ビル2F-C",
  },

  register: {
    title: "見えない変化・予兆に、気づける",
    // 2文を1段落にすると「意思決定／に必要な」のように句の途中で折り返す。
    // 文の切れ目で改行させるため段落を分ける
    lead: "会社情報を接続するだけで、Sentioが日々の動きを読み取ります。",
    lead2: "意思決定に必要な情報が、待っているだけでたまっていく。",
    toConnect: "会社情報を接続する",
  },

  connect: {
    title: "会社情報の接続",
    lead: "接続した分だけ見えるようになります。まだ接続していない項目があっても機能します。",
    calendarName: "Google カレンダー",
    calendarDesc: "予定・会議の変化を検知します",
    freeeName: "freee 会計",
    freeeDesc: "仕訳・取引データを同期します",
    csvName: "会計CSV",
    csvDesc: "freee を使っていない場合はCSVを取り込めます",
    connect: "接続",
    reconnect: "再接続",
    connected: "接続済み",
    needsReauth: "要再連携",
    // バッジ（要再連携）とボタン（再接続）と同じことを3回言わない（2026-09-07）。
    // 状態はバッジが言う。説明文は**戻せることだけ**を言う
    needsReauthDesc: "再接続すると元に戻ります。",
    preparing: "準備中",
    eventsCount: "イベント",
    transactionsCount: "取引",
    lastSync: "最終同期",
    never: "—",
    emptyTitle: "まだ何も接続されていません",
    emptyBody: "上のいずれかを接続すると、ここに同期の状況が表示されます。",
    loadFailedTitle: "接続状況を読み込めませんでした",
    loadFailedBody: "通信が一時的に途切れた可能性があります。もう一度読み込んでください。",

    // 連携解除（契約 スライスD / privacy §6「Sentio の画面から解除した場合」の経路）。
    // 二段確認はアカウントのメールアドレス入力（U-2・2026-08-27 確定）
    // 畳んだ操作を開くボタン。**中身が空のときは出さない**（freee の行）
    moreActions: "その他の操作",
    disconnect: "連携を解除",
    disconnectTitle: (name: string) => `${name}の連携を解除します`,
    disconnectLead:
      "この連携から取り込んだデータはすべて削除され、アクセストークン・リフレッシュトークンは直ちに破棄されます。取り消せません。",
    disconnectPrompt: "続けるには、ログイン中のメールアドレスを入力してください。",
    disconnectSubmit: "連携を解除する",
    disconnectCancel: "やめる",
    disconnectClose: "閉じる",
    disconnectWorking: "解除しています",
    disconnectMismatch: "メールアドレスが一致しません。",
    disconnectNoEmail:
      "ログイン情報を確認できませんでした。読み込み直すか、いったんログインし直してください。",
    disconnectDone: (n: number) => `連携を解除し、${n}件のデータを削除しました。`,
    // 409（deletion_blocked）。**「消えた」と読める言い方をしない**（受入基準 D-1-5）
    disconnectBlocked:
      "解除を中止しました。削除対象の件数が想定を超えています。データは削除されていません。",
    disconnectBlockedCount: (n: number) => `対象として数えられた件数: ${n}件`,
    disconnectBlockedHelp: "お手数ですが、サポートへご連絡ください。",
    disconnectFailed:
      "解除できませんでした。データが削除されたかどうかは確認できていません。接続状況を読み込み直してください。",

    // 週次レポートへの導線（契約 スライスW・実装順3）。/connect から1本だけ出す
    weeklyReport: "今週の会社を見る",
  },

  /**
   * プランの節（契約 スライスBU）。`/connect` に置く。**新しい画面を作らない**（BU-D1）。
   *
   * **金額はここにしか無い**（BU-D6・停止点）。コードに直書きすると、値を変える日に
   * 画面のどこに散っているかを探すことになる。正本は `docs/spec/09_pricing.md` の
   * 2026-09-02 の決定（**税込**。税別にすると値決めの根拠を自分で破る）。
   */
  billing: {
    sectionTitle: "プラン",
    standardName: "標準プラン",
    // 09_pricing.md の決定そのもの。**税込であることを書かないと、この額は意味が変わる**。
    // 数字は `src/lib/pricing.ts` から渡す（2026-09-09）。**辞書に数字を書かない**
    standardPrice: monthlyPrice,
    standardDesc: "調べる回数の上限が上がります。日々の入力は今までどおり要りません。",
    trialState: "試用中",
    subscribe: "標準プランにする",
    // 押した直後、Stripe の画面へ出るまでの間。押せない状態であることを言う（BU-2-3）
    starting: "手続きの画面を開いています",
    subscribedState: "標準プラン・購読中",
    // ④-b（2026-09-08）。**解約という語を主に出さない**——ここでできるのは
    // 解約だけではなく、支払い方法の変更と請求書の取得も含むためである。
    // 画面は Stripe のものになるので、日本語の程度と見た目は Stripe 側に依存する
    managePlan: "プランと支払いを管理",
    // ボタンの文言だけでは「解約はここ」と分からない（④-b の目的は解約導線である）。
    // **有料の契約が入る段階では、解約方法が分かりやすく示されている必要がある**
    manageNote: "解約もこちらから行えます。",
    // past_due のとき（2026-09-08）。**直す場所は「支払い方法の更新」であって、
    // 新規購読の作成ではない。** 状態に合う一文にする
    paymentIssueState: "お支払いを確認できていません",
    paymentNote: "お支払い方法の更新もこちらから行えます。",
    // `incomplete`（決済の途中で購読の行だけがある状態）。**「試用中」に落とさない**
    incompleteState: "お支払いの手続きが完了していません",
    // `paused`。**補足は付けない**（解約でも支払いでもない）
    pausedState: "一時停止中です",
    /**
     * **知らない状態**（Stripe が将来足す状態を含む）。中立の表示だけを出す。
     *
     * 知らないものを「試用中」や「購読中」として見せない——
     * 関門を否定リストにしたのと同じ発想である（2026-09-08 決定）。
     * **情緒的な語を使わない。** 解約も支払いも補足しない
     */
    unknownState: "ご契約の状態を確認しています。",
    // 409（already_subscribed）。**失敗ではなく、行き先が違う**ので別の文言にする
    alreadySubscribed: "すでに購読があります。プランと支払いの管理からお手続きください",
    openingPortal: "管理画面を開いています",
    // 失敗の文言は開始と同じ考え方（BU-D5）。内部コードもステータスも出さない
    portalFailed: "いま管理画面を開けませんでした。しばらくして再度お試しください",
    /**
     * 開始に失敗したときの唯一の文言（BU-D5 / BU-2-2）。
     *
     * **ステータスコードも設定の欠落も書かない。** 500 の中身は Sentio 側の不備であり、
     * 利用者に伝えても直せない。`/api/csv/analyze` の 401 で採った方針
     * （未認証の相手に内部事情を教えない）と揃えている。
     */
    startFailed: "いま手続きを開始できませんでした。しばらくして再度お試しください",
  },

  // 週次レポート画面（契約 スライスW）。Google カレンダーから取り込んだ予定だけを集計する
  report: {
    title: "今週の会社",
    lead: "接続した Google カレンダーの予定から、今週の会議の量を集計しています。",
    // 週の範囲は JST で描く。サーバ（UTC）で切ると月曜の早朝が前週に見える
    weekRange: (start: string, end: string) => `${start} 〜 ${end}`,
    meetingsLabel: "会議",
    minutesLabel: "総会議時間",
    attendeesLabel: "のべ出席者",
    allDayCountLabel: "うち終日",
    countUnit: (n: number) => `${n}件`,
    peopleUnit: (n: number) => `${n}人`,
    duration: (minutes: number) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (h === 0) return `${m}分`;
      return m === 0 ? `${h}時間` : `${h}時間${m}分`;
    },
    // 前週比。増加は符号を付けて向きを一目で分かるようにする
    change: (percent: number) => `前週比 ${percent > 0 ? "+" : ""}${percent}%`,
    previous: (value: string) => `前週 ${value}`,
    // 前週の実績が無いとき。**「0%」と書かない**（受入基準 W-1-5）
    noComparison: "比較できるだけの履歴がありません",
    scheduleHeading: "今週の予定",
    // 遡って表示しているときの予定リストの見出し（契約 スライスRF の追補）。
    // **「先週の予定」と書かない。** 遡り先は最大8週前まであり、前週とは限らない。
    // 何週前かは書かず、週の範囲（上に出ている weekRange）に語らせる
    fallbackScheduleHeading: "この週の予定",
    untitled: "（件名なし）",
    allDayLabel: "終日",
    // 出席者は人数だけを出す（W-D4）。メールアドレスは画面に出さない
    attendeeCount: (n: number) => `出席者 ${n}人`,
    // 当週が0件で過去の週へ遡ったときに出す一文（契約 スライスRF）。
    // **何週前かは書かない。** 週の範囲そのものが上に出ている方が正確である
    fallbackNotice: "今週はまだ予定がありません。直近の実績を表示しています。",
    emptyTitle: "この週に予定がありません",
    emptyBody:
      "カレンダーに予定が無かったか、まだ同期されていない可能性があります。接続の状況を確認できます。",
    loadFailedTitle: "週次レポートを読み込めませんでした",
    loadFailedBody: "通信が一時的に途切れた可能性があります。もう一度読み込んでください。",
    backToConnect: "接続の設定へ",
  },

  csv: {
    name: "入出金CSV",
    desc: "銀行明細・Stripe入金レポート等を取り込みます",
    ingested: "取込済み",
    rows: (n: number) => `明細 ${n}件`,
    dropZone: "CSVファイルをドロップ、またはクリックして選択",
    analyzing: "列の対応を推定しています",
    confirmTitle: "列の対応",
    colSentio: "Sentioの項目",
    colCsv: "CSVの列",
    fields: {
      date: "日付",
      description: "摘要",
      amount: "金額",
      direction: "入出金区分",
      credit: "入金",
      debit: "出金",
      balance: "残高",
    },
    ingest: "この対応で取り込む",
    restart: "やり直す",
    ingesting: "取り込んでいます",
    done: (n: number) => `${n}件を取り込みました。`,
    skipped: (n: number, total: number) => `${total}行のうち ${n}行は取り込めませんでした。`,
    // **同じ内容の行を黙って消さない**（①-5）。入れ直したときに「増えなかった」
    // だけだと壊れて見える。「重ならないようにした」と言い切る
    duplicates: (n: number) => `重複していた ${n} 件は取り込みませんでした。`,
    zeroTitle: "1件も取り込めませんでした",
    zeroBody: "列の対応が合っていない可能性があります。対応を見直してください。",
    recheck: "列の対応を見直す",
    analyzeFailed: "列の対応を推定できませんでした。別のCSVでお試しください。",
    // 「列の対応を推定できませんでした」と別の文にする（契約 スライスCH・CH-D7）。
    // あの1文は既に4つの別原因を飲み込んでおり、もう1つ足すと診断できなくなる。
    // **何を直せばいいのかを書く。**「別のCSVで」では伝わらない
    noHeaderRowTitle: "列名の行が見つかりませんでした",
    noHeaderRowBody:
      "1行目がデータで始まっています。全銀協フォーマットなど、列名の行が無い形式には対応していません。" +
      "列名つきで書き出したCSVをお試しください。",
    ingestFailed: "取り込みに失敗しました。時間をおいてもう一度お試しください。",
    tooShort: "データ行が見つかりません。ヘッダー行と明細行のあるCSVをお使いください。",
  },

  complete: {
    title: "接続が完了しました",
    lead: "ここから先、Sentio が自動で読み取ります。あなたが操作することはありません。",
    syncedEvents: (n: number) => `過去12か月分の予定を ${n} 件取り込みました。`,
    backToConnect: "接続状況を見る",
  },

  legal: {
    termsTitle: "利用規約",
    privacyTitle: "プライバシーポリシー",
    updatedAt: "最終更新",
    /** 特定商取引法に基づく表記（`/legal`）。フッターのリンク名にも使う */
    noticeTitle: "特定商取引法に基づく表記",
  },

  /**
   * 特定商取引法に基づく表記の本文（2026-09-09 検収者の承認済み文言）。
   *
   * **`/legal` と申込前の最終確認画面が、同じものをここから読む。**
   * 別の言い方をすると、同じ約束が2つの文で存在することになる（法定の最終確認画面は
   * 「表示した内容で申し込ませる」ための面なので、表記と食い違ってはならない）。
   *
   * 金額と無料期間の数字は受け取る。**正本は `src/lib/pricing.ts` である。**
   */
  legalNotice: {
    sellerLabel: "販売事業者",
    seller: "株式会社ディセーノ",
    representativeLabel: "代表責任者",
    representative: "梶谷 将太郎",
    addressLabel: "所在地",
    postalCode: "〒150-0043",
    address: "東京都渋谷区道玄坂1丁目10番8号 渋谷道玄坂東急ビル2F-C",
    phoneLabel: "電話番号",
    phone: "070-2834-0672",
    phoneHours: "受付時間: 平日 10:00〜18:00（土日祝を除く）",
    phoneNote: "※お問い合わせはメールにて承ります。",
    emailLabel: "メールアドレス",

    // 最終確認画面が出す6項目（1）〜（6）は、ここから同じ文字列を持っていく
    contentLabel: "提供内容と分量",
    content1: "1つのご契約につき、1社ぶんのご利用が可能です。",
    content2: "接続した情報をもとに、毎朝1通、状態をまとめたメールをお送りします。",

    priceLabel: "販売価格",
    price: monthlyPrice,
    priceTrial: (days: number) => `お申し込みから${days}日間は無料でご利用いただけます。`,
    priceTrialNote: "無料期間の終了日までに解約された場合、料金は発生しません。",

    extraCostLabel: "商品代金以外に必要な費用",
    extraCost:
      "インターネット接続に必要な通信費用、および接続先サービス（Google カレンダー等）の利用にかかる費用は、お客様のご負担となります。",

    paymentMethodLabel: "支払方法",
    paymentMethod1: "クレジットカード決済（Stripe Inc. の決済システムを利用します）。",
    paymentMethod2: "ご利用いただけるカードブランドは、お申し込み画面に表示されます。",
    // 一回払いの商品を作らないという決定（2026-09-09）と対になる一文
    paymentMethod3: "分割払いには対応していません。",

    paymentTimingLabel: "支払時期",
    paymentTiming: (days: number) =>
      `無料期間（${days}日間）の終了日に、初回のお支払いが発生します。`,
    paymentTimingNote: "以後は毎月、初回のお支払い日と同じ日に決済されます。",

    deliveryLabel: "サービスの提供時期",
    delivery: "お申し込み手続きの完了後、ただちにご利用いただけます。",

    applicationPeriodLabel: "申込期間",
    applicationPeriod: "期間の定めはありません。",

    cancelLabel: "解約について",
    cancel1: "ご利用中のプランは、いつでも解約できます。",
    cancel2: "ログイン後の「プランと支払いを管理」から手続きしてください。",
    // ポータルの解約が at_period_end であることと一致していなければならない
    cancel3:
      "解約のお手続きをいただいた場合も、お支払いいただいた期間の終了日までは引き続きご利用いただけます。期間の途中で利用が停止することはありません。",

    refundLabel: "返品・返金について",
    refund1: "本サービスは役務の提供のため、返品はお受けできません。",
    refund2: "解約後の未経過期間について、日割りでの返金は行いません。",

    environmentLabel: "動作環境",
    environment1: "最新版の Google Chrome、Microsoft Edge、Safari、Firefox のいずれか。",
    environment2: "Google カレンダーとの連携には Google アカウントが必要です。",
  },

  /**
   * 無料期間の終わりの知らせ（A-7・2026-09-09）。
   *
   * **お金の話は黙って始めない。** 終了日・金額・やめ方の3つを揃えて、始まる前に出す。
   * 金額は `src/lib/pricing.ts` から渡す。**辞書に数字を書かない。**
   */
  trialEnding: {
    subject: (endDate: string) => `【Sentio】無料期間が ${endDate} に終わります`,
    lead: (endDate: string) =>
      `ご利用中の無料期間は ${endDate} に終わります。この日までは料金は発生しません。`,
    amount: monthlyPrice,
    timing: (endDate: string) =>
      `${endDate} に、初回のお支払いが発生します。以後は毎月、同じ日に決済されます。`,
    cancelLead: "続けない場合は、終了日までに解約してください。手続きはこちらから行えます。",
    note: "解約されても、無料期間の終了日まではそのままご利用いただけます。",
  },

  /** 申込前の最終確認（特商法の最終確認画面の義務。6項目をまとめて出す） */
  checkoutNotice: {
    title: "お申し込み内容の確認",
    lead: "お申し込みの前に、以下をご確認ください。",
    toLegal: "特定商取引法に基づく表記",
  },

  errors: {
    unknown: "うまくいきませんでした。時間をおいてもう一度お試しください。",
    invalid_credentials: "メールアドレスかパスワードが違います。",
    weak_password: "パスワードは8文字以上にしてください。",
    email_taken: "このメールアドレスは登録済みです。ログインしてください。",
    missing_fields: "メールアドレスとパスワードを入力してください。",
    oauth_denied: "連携が許可されませんでした。もう一度お試しください。",
    oauth_state_mismatch: "接続の手続きが中断されました。最初からやり直してください。",
    oauth_incomplete: "接続の手続きが完了しませんでした。もう一度お試しください。",
    connect_failed: "接続に失敗しました。時間をおいてもう一度お試しください。",
    freee_unavailable: "freee 連携は現在準備中です。",
  },
} as const;

export type Dict = typeof ja;
