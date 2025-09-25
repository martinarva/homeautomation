"""
NordPool 15-min (EE) via Pyscript — single raw_all stream with smart polling (RAW ONLY)

Creates/updates:
- sensor.nordpool_15_min_raw_pyscript
  state  : current 15-min market price (€/kWh), derived from cached data if possible
  attrs  : raw_all (local today + local tomorrow + spill hour)
           updatedAt_tm_utc, updatedAt_tm_local
           status_y, status_t, status_tm
           areaStates_y, areaStates_t, areaStates_tm
           slots_today, slots_tomorrow, slots_all, expected_slots_today, expected_slots_tomorrow
           today_first_slot, today_last_slot, today_complete
           tm_first_slot, tm_last_slot, tomorrow_complete, tm_stale
           today_date_local, tomorrow_date_local_expected
           last_fetch_at_local

Scheduling:
- Runs on startup
- Every 15 minutes (script decides whether API calls are needed)
- We chase “tomorrow” only from 13:00 local until midnight, or when status_tm != Final

Install:
- Save as apps/pyscript/nordpool_15min_raw_only.py (or any .py under pyscript/)
- Create helper sensor: sensor.nordpool_15_min_raw_pyscript (unit: EUR/kWh, state class: measurement)

Notes:
- Handles CET↔EE spill hour.
- Validates “today/tomorrow” windows by date/contiguity instead of only counting slots.
"""

import json
import datetime as dt
import aiohttp
import asyncio
import random

# ---------- Config ----------
AREA       = "EE"
CURRENCY   = "EUR"
RESOLUTION = 15  # minutes

SENSOR_RAW = "sensor.nordpool_15_min_raw_pyscript"

# ---------- Timezones ----------
try:
    from zoneinfo import ZoneInfo
    EE_TZ  = ZoneInfo("Europe/Tallinn")
    CET_TZ = ZoneInfo("Europe/Paris")   # CET/CEST market calendar
except Exception:
    EE_TZ  = dt.timezone(dt.timedelta(hours=3))
    CET_TZ = dt.timezone(dt.timedelta(hours=1))

API_BASE = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPriceIndices"
HEADERS  = {
    "Accept": "application/json",
    "User-Agent": "HomeAssistant-Pyscript-Nordpool/1.4 (+raw_only)"
}

# ---------- HTTP / parsing helpers ----------
async def _fetch_date(session, date, area, currency, resolution) -> dict | None:
    url = (
        f"{API_BASE}?date={date}"
        f"&market=DayAhead&indexNames={area}&currency={currency}&resolutionInMinutes={resolution}"
    )
    log.info(f"🔗 GET {url}")
    try:
        async with session.get(url, headers=HEADERS, timeout=30) as resp:
            body = await resp.text()
            if resp.status != 200:
                log.warning(f"HTTP {resp.status} for {date}; body[:200]={body[:200]}")
                return None
            try:
                return json.loads(body)
            except Exception as ex:
                log.error(f"JSON parse error for {date}: {ex}; body[:160]={body[:160]}")
                return None
    except Exception as ex:
        log.error(f"Request error for {date}: {ex}")
        return None

def _parse_utc(ts: str) -> dt.datetime:
    # e.g. "2025-09-23T00:00:00Z"
    return dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)

def _fmt_local(ts: dt.datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%S%z")

def _parse_updated_pair(val: str | None):
    """Return (utc_str, local_str) for updatedAt (or (None, None))."""
    if not val:
        return (None, None)
    try:
        ts = dt.datetime.fromisoformat(val.replace("Z", "+00:00"))
        return (ts.strftime("%Y-%m-%dT%H:%M:%S%z"), _fmt_local(ts.astimezone(EE_TZ)))
    except Exception as ex:
        log.warning(f"⚠️ Failed to parse updatedAt '{val}': {ex}")
        return (val, val)

def _status_for_area(data: dict | None, area: str) -> tuple[str, list]:
    """Extract status string for AREA from areaStates[]."""
    if not data:
        return ("Missing", [])
    area_states = data.get("areaStates") or []
    found = "Unknown"
    for row in area_states:
        st = row.get("state")
        areas = row.get("areas") or []
        if area in areas and st:
            found = st
            break
    return (found, area_states)

# ---------- slot utilities ----------
def _expected_slots(start_local: dt.datetime, end_local: dt.datetime) -> int:
    # 15-minute buckets; handles DST (92/96/100) by computing exact seconds
    seconds = int((end_local - start_local).total_seconds())
    return max(0, seconds // (15 * 60))

def _count_slots_in_range(raw_all, start_local: dt.datetime, end_local: dt.datetime) -> int:
    n = 0
    for row in raw_all or []:
        try:
            sl = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            if start_local <= sl < end_local:
                n += 1
        except Exception:
            continue
    return n

def _slice_slots(raw_all, start_local: dt.datetime, end_local: dt.datetime):
    out = []
    for row in raw_all or []:
        try:
            sl = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            if start_local <= sl < end_local:
                out.append(row)
        except Exception:
            continue
    return out

def _first_last(raw_all, start_local, end_local):
    slots = _slice_slots(raw_all, start_local, end_local)
    if not slots:
        return (None, None)
    return (slots[0]["start"], slots[-1]["end"])

def _is_contiguous_15m(raw_all, start_local, end_local):
    """Check 15-min contiguity over [start_local, end_local)."""
    slots = _slice_slots(raw_all, start_local, end_local)
    if not slots:
        return False
    try:
        # Ensure sorted
        slots.sort(key=lambda r: r["start"])
        prev_end = dt.datetime.strptime(slots[0]["start"], "%Y-%m-%dT%H:%M:%S%z")
        for row in slots:
            s = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            e = dt.datetime.strptime(row["end"],   "%Y-%m-%dT%H:%M:%S%z")
            if s != prev_end:
                return False
            if (e - s).total_seconds() != 900:
                return False
            prev_end = e
        # Last slot must reach end_local (or up to raw_all_end if checking tm+spill; we pass exact window)
        return prev_end == end_local
    except Exception:
        return False

# ---------- builders ----------
def _combine_to_raw_all(combined, start_local, end_local):
    def fmt(ts): return ts.strftime("%Y-%m-%dT%H:%M:%S%z")
    return [
        {"start": fmt(e["sl"]), "end": fmt(e["el"]), "value": e["p"]}
        for e in combined
        if (start_local <= e["sl"] < end_local)
    ]

def _price_now_from_raw_all(raw_all, now_local):
    for row in raw_all or []:
        try:
            sl = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            el = dt.datetime.strptime(row["end"],   "%Y-%m-%dT%H:%M:%S%z")
            if sl <= now_local < el:
                return float(row["value"])
        except Exception:
            continue
    return None

# ---------- main ----------
@time_trigger("startup")
@time_trigger("period(minute=15)")   # every 15 minutes; internal logic decides whether to fetch
@service
async def nordpool_update(area=AREA, currency=CURRENCY, resolution=RESOLUTION):
    # overlap guard
    if getattr(nordpool_update, "_running", False):
        log.info("⏳ Previous nordpool_update still running; skipping this tick")
        return
    nordpool_update._running = True

    try:
        await asyncio.sleep(random.uniform(0.0, 3.0))  # jitter

        # Load cache
        prev_attrs      = state.getattr(SENSOR_RAW) or {}
        cached_raw_all  = prev_attrs.get("raw_all") or []
        prev_status_t   = prev_attrs.get("status_t")
        prev_status_tm  = prev_attrs.get("status_tm")

        # Local bounds
        now_utc   = dt.datetime.now(dt.timezone.utc)
        now_local = now_utc.astimezone(EE_TZ)
        today0    = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow0 = today0 + dt.timedelta(days=1)
        day_after0= today0 + dt.timedelta(days=2)

        # Spill window for end bound
        spill_hours = int((EE_TZ.utcoffset(tomorrow0) - CET_TZ.utcoffset(tomorrow0)).total_seconds() // 3600)
        spill_hours = max(0, spill_hours)
        raw_all_end = day_after0 + dt.timedelta(hours=spill_hours)

        # Purge any stale slots (< today0) from cache (midnight rollover safety)
        if cached_raw_all:
            try:
                cached_raw_all = [r for r in cached_raw_all
                                  if dt.datetime.strptime(r["start"], "%Y-%m-%dT%H:%M:%S%z") >= today0]
            except Exception:
                pass

        # Expected counts
        expected_today    = _expected_slots(today0,   tomorrow0)
        expected_tomorrow = _expected_slots(tomorrow0, day_after0)

        # Cached counts
        slots_today_cached    = _count_slots_in_range(cached_raw_all, today0,   tomorrow0)
        slots_tomorrow_cached = _count_slots_in_range(cached_raw_all, tomorrow0, day_after0)

        # Contiguity validation
        today_contig_ok    = _is_contiguous_15m(cached_raw_all, today0,   tomorrow0) if slots_today_cached == expected_today else False
        tomorrow_contig_ok = _is_contiguous_15m(cached_raw_all, tomorrow0, raw_all_end) if slots_tomorrow_cached >= expected_tomorrow else False

        # Decide whether to fetch
        need_y_t = (slots_today_cached < expected_today) or (not today_contig_ok) or (prev_status_t and prev_status_t != "Final")
        tomorrow_window = (now_local.hour >= 13)
        need_tm  = False
        if tomorrow_window:
            need_tm = (slots_tomorrow_cached < expected_tomorrow) or (not tomorrow_contig_ok) or (prev_status_tm and prev_status_tm != "Final")

        combined = []
        data_y = data_t = data_tm = None

        # Early exit if nothing needed and we have cache
        if not need_y_t and not need_tm and cached_raw_all:
            market_now = _price_now_from_raw_all(cached_raw_all, now_local)
            today_first, today_last = _first_last(cached_raw_all, today0, tomorrow0)
            tm_first, tm_last       = _first_last(cached_raw_all, tomorrow0, raw_all_end)

            base_attrs = {
                **prev_attrs,
                "raw_all": cached_raw_all,
                "status_t": prev_status_t or "Final",
                "status_tm": prev_status_tm or ("Final" if slots_tomorrow_cached >= expected_tomorrow else "Missing"),
                "slots_today": slots_today_cached,
                "slots_tomorrow": slots_tomorrow_cached,
                "slots_all": len(cached_raw_all),
                "expected_slots_today": expected_today,
                "expected_slots_tomorrow": expected_tomorrow,
                "today_first_slot": today_first,
                "today_last_slot":  today_last,
                "today_complete":   today_contig_ok and (slots_today_cached == expected_today),
                "tm_first_slot": tm_first,
                "tm_last_slot":  tm_last,
                "tomorrow_complete": slots_tomorrow_cached >= expected_tomorrow and tomorrow_contig_ok,
                "tm_stale": not tomorrow_contig_ok,
                "today_date_local": today0.strftime("%Y-%m-%d"),
                "tomorrow_date_local_expected": tomorrow0.strftime("%Y-%m-%d"),
                "last_fetch_at_local": prev_attrs.get("last_fetch_at_local"),
                "unit_of_measurement": "EUR/kWh",
                "state_class": "measurement",
            }

            state.set(SENSOR_RAW, market_now, new_attributes=base_attrs)
            log.info("✅ No fetch needed; cache valid. Today=%d/%d (contig=%s), Tomorrow=%d/%d (contig=%s)",
                     slots_today_cached, expected_today, today_contig_ok,
                     slots_tomorrow_cached, expected_tomorrow, tomorrow_contig_ok)
            return

        # Build CET dates for fetch
        now_cet = now_utc.astimezone(CET_TZ)
        d_y  = (now_cet.date() - dt.timedelta(days=1)).strftime("%Y-%m-%d")
        d_t  = (now_cet.date()).strftime("%Y-%m-%d")
        d_tm = (now_cet.date() + dt.timedelta(days=1)).strftime("%Y-%m-%d")

        # Fetch as needed
        try:
            async with aiohttp.ClientSession() as session:
                if need_y_t:
                    data_y = await _fetch_date(session, d_y,  area, currency, resolution)
                    data_t = await _fetch_date(session, d_t,  area, currency, resolution)
                if need_tm:
                    data_tm = await _fetch_date(session, d_tm, area, currency, resolution)
        except Exception as e:
            log.error(f"❌ Session error: {e} — keeping last values")
            return

        # Combine fetched entries
        for origin, data in (("y", data_y), ("t", data_t), ("tm", data_tm)):
            if not data:
                continue
            for e in data.get("multiIndexEntries", []):
                try:
                    su = _parse_utc(e["deliveryStart"])
                    eu = _parse_utc(e["deliveryEnd"])
                    p  = float(e["entryPerArea"][area]) / 1000.0  # EUR/MWh → EUR/kWh
                    sl = su.astimezone(EE_TZ)
                    el = eu.astimezone(EE_TZ)
                    combined.append({"su": su, "eu": eu, "sl": sl, "el": el, "p": p, "src": origin})
                except Exception as ex:
                    log.warning(f"⚠️ Skipping bad entry {e}: {ex}")

        # Merge logic
        merged_raw_all = cached_raw_all[:]

        if need_y_t and combined:
            rebuilt_today = _combine_to_raw_all(combined, today0, tomorrow0)
            # Keep any cached tomorrow+spill; we’ll replace tomorrow if need_tm is true
            tomorrow_cached_slice = _slice_slots(cached_raw_all, tomorrow0, day_after0)
            spill_tail            = _slice_slots(cached_raw_all, day_after0, raw_all_end)
            merged_raw_all = rebuilt_today + tomorrow_cached_slice + spill_tail

        if need_tm and combined:
            rebuilt_tm = _combine_to_raw_all(combined, tomorrow0, raw_all_end)
            kept_today = _slice_slots(merged_raw_all, today0, tomorrow0)
            merged_raw_all = kept_today + rebuilt_tm

        if not merged_raw_all:
            merged_raw_all = cached_raw_all[:]

        try:
            merged_raw_all.sort(key=lambda r: r["start"])
        except Exception:
            pass

        # Recompute counts/validations
        slots_today    = _count_slots_in_range(merged_raw_all, today0,   tomorrow0)
        slots_tomorrow = _count_slots_in_range(merged_raw_all, tomorrow0, day_after0)
        today_first, today_last = _first_last(merged_raw_all, today0, tomorrow0)
        tm_first, tm_last       = _first_last(merged_raw_all, tomorrow0, raw_all_end)

        today_contig_ok    = _is_contiguous_15m(merged_raw_all, today0,   tomorrow0) if slots_today == expected_today else False
        tomorrow_contig_ok = _is_contiguous_15m(merged_raw_all, tomorrow0, raw_all_end) if slots_tomorrow >= expected_tomorrow else False

        # Statuses & area states
        status_y, areaStates_y   = _status_for_area(data_y,  area) if need_y_t else (prev_attrs.get("status_y") or "Unknown", prev_attrs.get("areaStates_y") or [])
        status_t, areaStates_t   = _status_for_area(data_t,  area) if need_y_t else (prev_attrs.get("status_t") or ("Final" if today_contig_ok and slots_today==expected_today else "Unknown"), prev_attrs.get("areaStates_t") or [])
        status_tm, areaStates_tm = _status_for_area(data_tm, area) if need_tm  else (prev_attrs.get("status_tm") or ("Final" if tomorrow_contig_ok and slots_tomorrow>=expected_tomorrow else "Missing"), prev_attrs.get("areaStates_tm") or [])

        # updatedAt for tm
        upd_tm_utc_prev   = prev_attrs.get("updatedAt_tm_utc")
        upd_tm_local_prev = prev_attrs.get("updatedAt_tm_local")
        upd_tm_utc, upd_tm_local = (upd_tm_utc_prev, upd_tm_local_prev)
        if data_tm and data_tm.get("updatedAt"):
            upd_tm_utc, upd_tm_local = _parse_updated_pair(data_tm["updatedAt"])

        # Current price
        market_now = _price_now_from_raw_all(merged_raw_all, now_local)
        if market_now is None and combined:
            for e in combined:
                if e["su"] <= now_utc < e["eu"]:
                    market_now = e["p"]
                    break

        # Final attrs
        base_attrs = {
            "raw_all": merged_raw_all,
            "updatedAt_tm_utc": upd_tm_utc,
            "updatedAt_tm_local": upd_tm_local,
            "status_y": status_y,
            "status_t": status_t,
            "status_tm": status_tm,
            "areaStates_y": areaStates_y,
            "areaStates_t": areaStates_t,
            "areaStates_tm": areaStates_tm,
            "slots_today": slots_today,
            "slots_tomorrow": slots_tomorrow,
            "slots_all": len(merged_raw_all),
            "expected_slots_today": expected_today,
            "expected_slots_tomorrow": expected_tomorrow,
            "today_first_slot": today_first,
            "today_last_slot":  today_last,
            "today_complete":   today_contig_ok and (slots_today == expected_today),
            "tm_first_slot": tm_first,
            "tm_last_slot":  tm_last,
            "tomorrow_complete": slots_tomorrow >= expected_tomorrow and tomorrow_contig_ok,
            "tm_stale": not tomorrow_contig_ok,
            "today_date_local": today0.strftime("%Y-%m-%d"),
            "tomorrow_date_local_expected": tomorrow0.strftime("%Y-%m-%d"),
            "last_fetch_at_local": _fmt_local(now_local),
            "unit_of_measurement": "EUR/kWh",
            "state_class": "measurement",
        }

        state.set(SENSOR_RAW, market_now, new_attributes=base_attrs)

        log.info(
            "✅ Fetched/merged as needed: today %d/%d (contig=%s), tomorrow %d/%d (contig=%s); status t=%s, tm=%s",
            slots_today, expected_today, today_contig_ok,
            slots_tomorrow, expected_tomorrow, tomorrow_contig_ok,
            status_t, status_tm
        )

    finally:
        nordpool_update._running = False
