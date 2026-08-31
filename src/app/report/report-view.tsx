import { Masthead } from "@/components/Masthead";
import { t } from "@/i18n";
import type { Comparison, Meeting, WeeklySummary } from "@shared/report/weekly";

/**
 * 週次レポートの表示（契約 スライスW）。
 *
 * **状態を持たない。** 押すものが無いので "use client" にしない。
 * `/connect` は client component の `toLocaleString` に `timeZone` が無く、
 * サーバ（UTC）とクライアント（JST）で9時間ずれて hydration mismatch
 * （React error #418）を出している。この画面は
 * **サーバでしか描かず、かつ timeZone を明示する**ことで同じ形を作らない。
 *
 * `summary === null` は「読み取りに失敗した」。0件（空）とは別物として描く（W-3-1 / W-3-2）。
 */
export function ReportView({ summary }: { summary: WeeklySummary | null }) {
  return (
    <main className="page">
      <Masthead signedIn />

      <h1>{t.report.title}</h1>
      <p className="lead">{t.report.lead}</p>

      {summary === null ? (
        <div className="failure" role="alert" style={{ marginTop: 24 }}>
          <p className="failure-title">{t.report.loadFailedTitle}</p>
          <p className="failure-body">{t.report.loadFailedBody}</p>
          <div className="actions">
            <a className="btn btn-quiet" href="/report">
              {t.common.retry}
            </a>
          </div>
        </div>
      ) : (
        <Summary summary={summary} />
      )}

      <p className="footnote">
        <a href="/connect">{t.report.backToConnect}</a>
      </p>
    </main>
  );
}

function Summary({ summary }: { summary: WeeklySummary }) {
  // weekEnd は半開区間の上端（翌 JST 月曜00:00）なので、表示は1日戻して日曜にする
  const lastDay = new Date(new Date(summary.weekEnd).getTime() - DAY_MS);

  return (
    <>
      {/*
        遡ったことを黙って隠さない（契約 スライスRF・RF-D1）。
        先週の数字を「今週」として見せるのは、報告ゼロで見えるという約束に反する。
        何週前かは書かない。**週の範囲が直下に出ている**方が正確である
      */}
      {summary.isFallback && <p className="lead">{t.report.fallbackNotice}</p>}

      <p className="section-label" style={{ marginTop: 24 }}>
        {t.report.weekRange(formatDate(summary.weekStart), formatDate(lastDay.toISOString()))}
      </p>

      <section className="section">
        <div className="rows">
          <Figure
            label={t.report.meetingsLabel}
            value={t.report.countUnit(summary.meetingCount)}
            change={summary.meetingCountChange}
            previous={(n) => t.report.countUnit(n)}
            note={
              summary.allDayCount > 0
                ? `${t.report.allDayCountLabel} ${t.report.countUnit(summary.allDayCount)}`
                : null
            }
          />
          <Figure
            label={t.report.minutesLabel}
            value={t.report.duration(summary.totalMeetingMinutes)}
            change={summary.meetingMinutesChange}
            previous={(n) => t.report.duration(n)}
            note={null}
          />
          {/* 出席者は**人数だけ**（W-D4）。metrics.attendees の中身はここに来ない */}
          <Figure
            label={t.report.attendeesLabel}
            value={t.report.peopleUnit(summary.totalAttendees)}
            change={null}
            previous={null}
            note={null}
          />
        </div>
      </section>

      {summary.meetings.length === 0 ? (
        // 0件は失敗ではない。failure と同じ見た目にしない（W-3-1・運用ルール§6）
        <div className="empty">
          <p className="empty-title">{t.report.emptyTitle}</p>
          <p className="empty-body">{t.report.emptyBody}</p>
        </div>
      ) : (
        <section className="section">
          <p className="section-label">{t.report.scheduleHeading}</p>
          <div className="rows">
            {summary.meetings.map((m) => (
              <MeetingRow key={`${m.startsAt}-${m.title ?? ""}`} meeting={m} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Figure({
  label,
  value,
  change,
  previous,
  note,
}: {
  label: string;
  value: string;
  /** 比較しない指標は null。**前週が無いときの Comparison とは別の話** */
  change: Comparison | null;
  previous: ((value: number) => string) | null;
  note: string | null;
}) {
  return (
    <div className="row">
      <div className="row-body">
        <p className="row-desc">{label}</p>
        <p className="row-name">{value}</p>
        {note && <div className="row-meta">{note}</div>}
      </div>
      <div className="row-side">
        {change === null ? null : change.available ? (
          <div className="row-meta">
            <span>{t.report.change(change.changePercent)}</span>
            {previous && <span>{t.report.previous(previous(change.previous))}</span>}
          </div>
        ) : (
          // 前週の実績が無い。**0% と書かない**（W-1-5）
          <span className="row-desc">{t.report.noComparison}</span>
        )}
      </div>
    </div>
  );
}

function MeetingRow({ meeting }: { meeting: Meeting }) {
  return (
    <div className="row">
      <div className="row-body">
        <p className="row-name">{meeting.title ?? t.report.untitled}</p>
        <div className="row-meta">
          <span>{formatDate(meeting.startsAt)}</span>
          <span>
            {meeting.allDay
              ? t.report.allDayLabel
              : `${formatTime(meeting.startsAt)}–${formatTime(meeting.endsAt)}`}
          </span>
          {meeting.attendeeCount > 0 && (
            <span>{t.report.attendeeCount(meeting.attendeeCount)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const DAY_MS = 86_400_000;

/**
 * 日時は必ず JST で描く。**`timeZone` を省かない。**
 *
 * 省くと実行環境の既定タイムゾーンで描かれる。Vercel は UTC、閲覧者のブラウザは JST で、
 * 差はちょうど9時間になる。`/connect` が本番で React error #418 を出しているのが
 * まさにこの形である（`docs/contracts/slice-disconnect.md` の実測）。
 */
const DATE_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

function formatTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}
