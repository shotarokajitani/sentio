/**
 * 静音時間の規則。**このファイルが正本。**
 *
 * Edge Function 側の写しは `supabase/functions/_shared/quiet-hours.ts`。
 * Edge は `supabase/functions/` の外を import できないため二重に持つ
 * （`retention` 対と同じ形）。ずれは `tests/unit/quiet-hours.test.ts` が機械で止める。
 */
export interface DeliveryInput {
  urgency: "immediate" | "weekly" | "monthly";
  category: string;
}

export interface DeliveryResult {
  deliver: boolean;
  deferUntil?: Date;
}

// Ongoing-loss exceptions: delivered even during quiet hours
export const QUIET_HOUR_EXCEPTIONS = new Set(["site_down"]);

// Quiet hours: 23:00 - 06:00 JST
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 6;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJSTHour(date: Date): number {
  const jstTime = new Date(date.getTime() + JST_OFFSET_MS);
  return jstTime.getUTCHours();
}

export function isQuietHour(date: Date): boolean {
  const hour = toJSTHour(date);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function nextMorning(date: Date): Date {
  // Calculate next 6:00 AM JST
  const jstTime = new Date(date.getTime() + JST_OFFSET_MS);
  const jstDate = new Date(
    Date.UTC(
      jstTime.getUTCFullYear(),
      jstTime.getUTCMonth(),
      jstTime.getUTCDate(),
      QUIET_END_HOUR,
      0,
      0,
      0,
    ),
  );

  // If current JST time is past or at quiet end, move to next day
  if (jstTime.getUTCHours() >= QUIET_START_HOUR || jstTime.getUTCHours() >= QUIET_END_HOUR) {
    // If it's 23:xx, next morning is tomorrow
    if (jstTime.getUTCHours() >= QUIET_START_HOUR) {
      jstDate.setUTCDate(jstDate.getUTCDate() + 1);
    }
  }

  // Convert back from JST to UTC
  return new Date(jstDate.getTime() - JST_OFFSET_MS);
}

export function shouldDeliverNow(input: DeliveryInput, now: Date): DeliveryResult {
  // Only immediate urgency is subject to quiet hours
  if (input.urgency !== "immediate") {
    return { deliver: true };
  }

  // Exception categories bypass quiet hours
  if (QUIET_HOUR_EXCEPTIONS.has(input.category)) {
    return { deliver: true };
  }

  // Check if in quiet hours
  if (isQuietHour(now)) {
    return {
      deliver: false,
      deferUntil: nextMorning(now),
    };
  }

  return { deliver: true };
}
