/**
 * 画面文言の辞書（日本語）。
 *
 * 運用ルール§6「文言のハードコード禁止」。画面側は必ずここを経由する。
 * ブランド固有名詞（Sentio / Google / freee）だけは例外として直接書いてよい。
 */
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
    passwordHint: "8文字以上",
    submit: "ログイン",
    signUp: "新規登録",
    signUpLead: "はじめての方は、同じ欄に入力して「新規登録」を押してください。",
    legalLead: "登録すると、以下に同意したものとみなされます。",
    terms: "利用規約",
    privacy: "プライバシーポリシー",
    confirmSent: "確認メールを送りました。メール内のリンクを開くとログインできます。",
  },

  landing: {
    title: "報告を待たずに、会社の状況がわかる",
    // register と同じ理由で段落を分ける。1段落にすると句の途中で折り返す
    lead: "Sentio は、すでに会社にある情報から変化と予兆を読み取ります。",
    // register.lead2 と同一文言にして語彙を揃える。
    // 「入力も報告も要りません」は主語が無く、何がたまるのかも言っていない
    lead2: "意思決定に必要な情報が、待っているだけでたまっていく。",
    // 獲得物を書く。「はじめる」だと何が手に入るか見えない。
    // 一方で「最初のレポートが届く」系は実装が無いので書かない（約束と実装のギャップを作らない）
    start: "会社情報を接続する",
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
    needsReauthDesc: "連携先での許可が切れました。再接続すると元に戻ります。",
    preparing: "準備中",
    eventsCount: "イベント",
    transactionsCount: "取引",
    lastSync: "最終同期",
    never: "—",
    emptyTitle: "まだ何も接続されていません",
    emptyBody: "上のいずれかを接続すると、ここに同期の状況が表示されます。",
    loadFailedTitle: "接続状況を読み込めませんでした",
    loadFailedBody: "通信が一時的に途切れた可能性があります。もう一度読み込んでください。",
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
    zeroTitle: "1件も取り込めませんでした",
    zeroBody: "列の対応が合っていない可能性があります。対応を見直してください。",
    recheck: "列の対応を見直す",
    analyzeFailed: "列の対応を推定できませんでした。別のCSVでお試しください。",
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
    draftNotice: "本文面は草案です。正式版は法務確認後に差し替えます。",
    updatedAt: "最終更新",
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
