const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Keep the numeric expiry compatible with saved snoozes and the push relay.
// A new actionable message can still wake a snooze with no time limit.
export const UNTIL_NEW_ACTIVITY = Number.MAX_SAFE_INTEGER;

export function snoozeChoices(now: number) {
  const today = new Date(now);
  function atLocalHour(days: number, hour: number) {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  }
  return {
    durations: [
      { short: '15m', label: '15 minutes', until: now + 15 * MINUTE },
      { short: '30m', label: '30 minutes', until: now + 30 * MINUTE },
      { short: '1h', label: '1 hour', until: now + HOUR },
      { short: '3h', label: '3 hours', until: now + 3 * HOUR },
    ],
    calendar: [
      { label: 'This afternoon', until: atLocalHour(0, 14), show: today.getHours() < 13 },
      { label: 'This evening', until: atLocalHour(0, 18), show: today.getHours() < 17 },
      { label: 'Tomorrow morning', until: atLocalHour(1, 9), show: true },
      { label: 'Next week', until: atLocalHour((8 - today.getDay()) % 7 || 7, 9), show: true },
    ].filter(({ show }) => show),
  };
}

export function localSnoozeInput(instant: number): string {
  const date = new Date(instant);
  return new Date(instant - date.getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);
}
