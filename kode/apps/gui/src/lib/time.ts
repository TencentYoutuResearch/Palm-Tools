const DATE_TIME_SHORT = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_MEDIUM = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
})

const DATE_TIME_FULL = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
})

function parseDate(value: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatLocalDateTimeShort(value: string): string {
  const d = parseDate(value)
  return d ? DATE_TIME_SHORT.format(d) : value
}

export function formatLocalDateMedium(value: string): string {
  const d = parseDate(value)
  return d ? DATE_MEDIUM.format(d) : value
}

export function formatLocalDateTimeFull(value: string): string {
  const d = parseDate(value)
  return d ? DATE_TIME_FULL.format(d) : value
}
