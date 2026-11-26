//! Time triggers for bot watches: five-field cron in local time
//! (minute hour day-of-month month day-of-week) plus a few `@` shorthands.
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike};

#[derive(Clone, Debug, PartialEq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    days: u32,
    months: u16,
    weekdays: u8,
    any_day: bool,
    any_weekday: bool,
}

fn field(text: &str, min: u32, max: u32, name: &str) -> Result<(u64, bool)> {
    let mut bits = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().ok().filter(|s| *s > 0).with_context(|| format!("{name} 的步长无效"))?),
            None => (part, 1),
        };
        let (from, to) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (a.parse()?, b.parse()?)
        } else {
            let one: u32 = range.parse().with_context(|| format!("{name} 不是数字：{range}"))?;
            (one, if part.contains('/') { max } else { one })
        };
        if from < min || to > max || from > to {
            bail!("{name} 超出范围 {min}–{max}：{part}")
        }
        let mut value = from;
        while value <= to {
            bits |= 1 << value;
            value += step;
        }
    }
    Ok((bits, text == "*"))
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Self> {
        let expanded = match expr.trim() {
            "@hourly" => "0 * * * *",
            "@daily" => "0 9 * * *",
            "@workdays" => "0 9 * * 1-5",
            "@weekly" => "0 9 * * 1",
            other => other,
        };
        let parts: Vec<&str> = expanded.split_whitespace().collect();
        if parts.len() != 5 {
            bail!("定时需要 5 段：分 时 日 月 周（例如 0 9 * * 1-5）")
        }
        let (minutes, _) = field(parts[0], 0, 59, "分钟")?;
        let (hours, _) = field(parts[1], 0, 23, "小时")?;
        let (days, any_day) = field(parts[2], 1, 31, "日期")?;
        let (months, _) = field(parts[3], 1, 12, "月份")?;
        let (mut weekdays, any_weekday) = field(parts[4], 0, 7, "星期")?;
        // 7 is Sunday too.
        if weekdays & (1 << 7) != 0 {
            weekdays |= 1;
        }
        Ok(Self { minutes, hours: hours as u32, days: days as u32, months: months as u16, weekdays: (weekdays & 0x7f) as u8, any_day, any_weekday })
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        if self.months & (1 << date.month()) == 0 {
            return false;
        }
        let dom = self.days & (1 << date.day()) != 0;
        let dow = self.weekdays & (1 << date.weekday().num_days_from_sunday()) != 0;
        // Standard cron: when both are restricted, either one matches.
        match (self.any_day, self.any_weekday) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }

    /// The first matching minute strictly after `after`.
    pub fn next_after(&self, after: DateTime<Local>) -> Option<DateTime<Local>> {
        let start = after.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        let mut date = start.date_naive();
        for _ in 0..400 {
            if self.day_matches(date) {
                for hour in 0..24 {
                    if self.hours & (1 << hour) == 0 {
                        continue;
                    }
                    for minute in 0..60 {
                        if self.minutes & (1 << minute) == 0 {
                            continue;
                        }
                        // A time skipped by a daylight-saving jump does not exist.
                        let Some(at) = Local.from_local_datetime(&date.and_hms_opt(hour, minute, 0)?).earliest() else { continue };
                        if at >= start {
                            return Some(at);
                        }
                    }
                }
            }
            date = date.succ_opt()?;
        }
        None
    }
}

const WEEKDAYS: [&str; 7] = ["日", "一", "二", "三", "四", "五", "六"];

fn bits(mask: u64, max: u32) -> Vec<u32> {
    (0..=max).filter(|i| mask & (1 << i) != 0).collect()
}

/// A short Chinese description, e.g. 「每个工作日 09:00」.
pub fn describe(expr: &str) -> String {
    let Ok(cron) = Cron::parse(expr) else { return format!("定时「{expr}」") };
    let minutes = bits(cron.minutes, 59);
    let hours = bits(cron.hours as u64, 23);
    let weekdays = bits(cron.weekdays as u64, 6);
    let time = match (hours.as_slice(), minutes.as_slice()) {
        ([h], [m]) => format!("{h:02}:{m:02}"),
        (_, [m]) if hours.len() == 24 => format!("每小时第 {m} 分"),
        (hs, [m]) => format!("{} 点的第 {m} 分", hs.iter().map(u32::to_string).collect::<Vec<_>>().join("、")),
        _ => return format!("定时「{}」", expr.trim()),
    };
    let day = if !cron.any_day || cron.months != 0b1_1111_1111_1110 {
        return format!("定时「{}」", expr.trim());
    } else if cron.any_weekday || weekdays.len() == 7 {
        "每天".to_owned()
    } else if weekdays == [1, 2, 3, 4, 5] {
        "每个工作日".to_owned()
    } else {
        format!("每周{}", weekdays.iter().map(|d| WEEKDAYS[*d as usize]).collect::<Vec<_>>().join("、"))
    };
    if day == "每天" && time.starts_with("每小时") {
        return time;
    }
    format!("{day} {time}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
    }

    #[test]
    fn workday_mornings_skip_weekends() {
        let cron = Cron::parse("0 9 * * 1-5").unwrap();
        // 2026-11-27 is a Friday.
        assert_eq!(cron.next_after(at(2026, 11, 27, 8, 0)), Some(at(2026, 11, 27, 9, 0)));
        assert_eq!(cron.next_after(at(2026, 11, 27, 9, 0)), Some(at(2026, 11, 30, 9, 0)), "Friday 9:00 is past, next is Monday");
    }

    #[test]
    fn steps_lists_and_sunday_seven() {
        let every_two = Cron::parse("0 10-18/2 * * *").unwrap();
        assert_eq!(every_two.next_after(at(2026, 11, 27, 11, 5)), Some(at(2026, 11, 27, 12, 0)));
        assert_eq!(every_two.next_after(at(2026, 11, 27, 18, 0)), Some(at(2026, 11, 28, 10, 0)));
        let sunday = Cron::parse("30 20 * * 7").unwrap();
        assert_eq!(sunday.next_after(at(2026, 11, 27, 0, 0)), Some(at(2026, 11, 29, 20, 30)));
        assert_eq!(Cron::parse("@workdays").unwrap(), Cron::parse("0 9 * * 1-5").unwrap());
    }

    #[test]
    fn day_of_month_or_weekday_like_cron() {
        let either = Cron::parse("0 9 1 * 1").unwrap();
        assert_eq!(either.next_after(at(2026, 11, 27, 0, 0)), Some(at(2026, 11, 30, 9, 0)), "Monday comes before the 1st");
    }

    #[test]
    fn bad_expressions_are_rejected() {
        for bad in ["", "* * * *", "60 * * * *", "0 24 * * *", "0 9 * * 8", "0 9 * * */0", "a b c d e", "5-1 * * * *"] {
            assert!(Cron::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn descriptions_read_naturally() {
        assert_eq!(describe("0 9 * * 1-5"), "每个工作日 09:00");
        assert_eq!(describe("0 17 * * 5"), "每周五 17:00");
        assert_eq!(describe("30 18 * * *"), "每天 18:30");
        assert_eq!(describe("0 * * * *"), "每小时第 0 分");
        assert_eq!(describe("0 9 1 * *"), "定时「0 9 1 * *」");
    }
}
