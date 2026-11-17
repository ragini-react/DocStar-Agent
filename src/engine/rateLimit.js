// Rolling-window limits for sign-ups: at most `max_signups_per_hour` in any 60 minutes and `max_signups_per_day` in
// any 24 hours, counted from the accounts the agent started. Returns when the next slot frees, so a deferred task
// gets an exact run_after instead of polling. Qualification and discovery never count against it.
import { numSetting } from '../db/index.js'

/** Pure: given sign-up start times (ISO), the limits and a moment, whether a sign-up may start and if not, when. */
export function nextSlot(times, { perHour, perDay, at = Date.now() }) {
  const ms = times.map(t => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b)
  const inHour = ms.filter(t => t > at - 3600_000)
  const inDay = ms.filter(t => t > at - 86400_000)
  const waits = []
  if (inHour.length >= perHour) waits.push({ ms: inHour[inHour.length - perHour] + 3600_000 - at, why: `${inHour.length} sign-ups in the last hour (limit ${perHour})` })
  if (inDay.length >= perDay) waits.push({ ms: inDay[inDay.length - perDay] + 86400_000 - at, why: `${inDay.length} sign-ups in the last 24 hours (limit ${perDay})` })
  if (!waits.length) return { ok: true, waitMs: 0, usedHour: inHour.length, usedDay: inDay.length }
  const worst = waits.sort((a, b) => b.ms - a.ms)[0]
  return { ok: false, waitMs: Math.max(1000, worst.ms + 5_000), reason: worst.why, usedHour: inHour.length, usedDay: inDay.length }
}

export function signupSlot(db, at = Date.now()) {
  const times = db.prepare(`SELECT created_at FROM accounts WHERE created_at > ?`).all(new Date(at - 86400_000).toISOString()).map(r => r.created_at)
  return nextSlot(times, { perHour: numSetting(db, 'max_signups_per_hour', 3), perDay: numSetting(db, 'max_signups_per_day', 10), at })
}
