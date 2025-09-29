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
           expected_slots_tomorrow_spill, slots_tomorrow_spill, tomorrow_spill_complete
           last_fetch_at_local
           unit_of_measurement="EUR/kWh", state_class="measurement"

Scheduling:
- Runs on startup
- Every 15 minutes (script decides whether API calls are needed)
- We chase “tomorrow” only from 13:00 local until midnight, or when status_tm != Final

Install:
- Save as apps/pyscript/nordpool_15min_raw_only.py (or any .py under pyscript/)
- Create helper sensor: sensor.nordpool_15_min_raw_pyscript

Notes:
- Handles CET↔EE spill hour.
- Validates “today/tomorrow” by exact windows (bounds/contiguity/count), not only counts.
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
    "User-Agent": "HomeAssistant-Pyscript-Nordpool/1.6 (+raw_only)"
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
    # 15-min buckets; handles DST (92/96/100) by computing exact 900s steps
    seconds = int((end_local - start_local).total_seconds())
    return max(0, seconds // (15 * 60))

def _slice_slots(raw_all, start_local: dt.datetime, end_local: dt.datetime):
    out = []
    for row in raw_all or []:
        try:
            sl = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            el = dt.datetime.strptime(row["end"],   "%Y-%m-%dT%H:%M:%S%z")
            if start_local <= sl < end_local:
                out.append(row)
        except Exception:
            continue
    return out

def _validate_slice(raw_slice, start_local: dt.datetime, end_local: dt.datetime):
    """
    Validates that:
      - first slot starts at start_local
      - last slot ends at end_local
      - slots are 15-min contiguous (no gaps/overlaps)
      - count equals expected (by exact seconds / 900)
    Returns dict with booleans and diagnostics.
    """
    info = {
        "coverage_ok": False,
        "bounds_ok": False,
        "contiguous_ok": False,
        "count_ok": False,
        "first": None,
        "last": None,
        "count": 0,
        "expected": _expected_slots(start_local, end_local),
    }
    if not raw_slice:
        return info

    parsed = []
    for row in raw_slice:
        try:
            sl = dt.datetime.strptime(row["start"], "%Y-%m-%dT%H:%M:%S%z")
            el = dt.datetime.strptime(row["end"],   "%Y-%m-%dT%H:%M:%S%z")
            parsed.append((sl, el))
        except Exception:
            pass
    if not parsed:
        return info

    parsed.sort(key=lambda x: x[0])
    info["first"] = _fmt_local(parsed[0][0])
    info["last"]  = _fmt_local(parsed[-1][1])
    info["count"] = len(parsed)

    # bounds
    bounds_ok = (parsed[0][0] == start_local and parsed[-1][1] == end_local)
    info["bounds_ok"] = bounds_ok

    # contiguity
    contiguous_ok = True
    step = dt.timedelta(minutes=15)
    for i in range(1, len(parsed)):
        if parsed[i-1][1] != parsed[i][0]:
            contiguous_ok = False
            break
        if (parsed[i][0] - parsed[i-1][0]) != step:
            contiguous_ok = False
            break
    info["contiguous_ok"] = contiguous_ok

    # count & coverage
    info["count_ok"] = (len(parsed) == info["expected"])
    info["coverage_ok"] = (bounds_ok and contiguous_ok and info["count_ok"])
    return info

# ---------- builders ----------
def _combine_to_raw_all(combined, start_local, end_local):
    def fmt(ts): return ts.strftime("%Y-%m-%dT%H:%M:%S%z")
    out = [
        {"start": fmt(e["sl"]), "end": fmt(e["el"]), "value": e["p"]}
        for e in combined
        if (start_local <= e["sl"] < end_local)
    ]
    out.sort(key=lambda r: r["start"])
    return out

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
@time_trigger("cron(0,15,30,45 * * * *)")    # every 15 minutes; internal logic decides whether to fetch
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

        # Spill hour computation (difference EE vs CET at tomorrow boundary)
        spill_hours = int((EE_TZ.utcoffset(tomorrow0) - CET_TZ.utcoffset(tomorrow0)).total_seconds() // 3600)
        spill_hours = max(0, spill_hours)
        raw_all_end = day_after0 + dt.timedelta(hours=spill_hours)

        # NEW: explicit “tomorrow spill” window (00:00–01:00 if spill_hours==1)
        tm_spill_start = tomorrow0
        tm_spill_end   = tomorrow0 + dt.timedelta(hours=spill_hours)

        # Purge cache to [today0, raw_all_end)
        if cached_raw_all:
            cached_raw_all = _slice_slots(cached_raw_all, today0, raw_all_end)

        # Cached slices & validation
        today_slice_cached  = _slice_slots(cached_raw_all, today0,   tomorrow0)
        tm_slice_cached     = _slice_slots(cached_raw_all, tomorrow0, day_after0)

        expected_today      = _expected_slots(today0,   tomorrow0)
        expected_tomorrow   = _expected_slots(tomorrow0, day_after0)

        v_today    = _validate_slice(today_slice_cached, today0,   tomorrow0)
        v_tm_full  = _validate_slice(tm_slice_cached,    tomorrow0, day_after0)
        v_tm_spill = _validate_slice(
            _slice_slots(cached_raw_all, tm_spill_start, tm_spill_end),
            tm_spill_start, tm_spill_end
        ) if spill_hours > 0 else {
            "coverage_ok": True, "count": 0, "expected": 0, "first": None, "last": None,
            "bounds_ok": True, "contiguous_ok": True, "count_ok": True
        }

        # Only chase tm after 13:00 local (pre-13:00: require spill only)
        tomorrow_window = (now_local.hour >= 13)

        need_y_t = False
        need_tm  = False

        # Need today?
        if not v_today["coverage_ok"]:
            need_y_t = True
        elif (prev_status_t and prev_status_t != "Final"):
            need_y_t = True
        else:
            prev_status_t = prev_status_t or "Final"

        # Need tomorrow?
        tm_stale = (not v_tm_spill["coverage_ok"]) if (now_local.hour < 13) else (not v_tm_full["coverage_ok"])
        if tomorrow_window:
            if tm_stale:
                need_tm = True
            elif (prev_status_tm and prev_status_tm != "Final"):
                need_tm = True

        combined = []
        data_y = data_t = data_tm = None

        # Early exit if nothing needed and we have cache
        if not need_y_t and not need_tm and cached_raw_all:
            market_now = _price_now_from_raw_all(cached_raw_all, now_local)

            # spill diagnostics from cache
            tm_slice_spill_cached = _slice_slots(cached_raw_all, tm_spill_start, tm_spill_end) if spill_hours > 0 else []
            v_tm_spill_cached = _validate_slice(tm_slice_spill_cached, tm_spill_start, tm_spill_end) if spill_hours > 0 else {
                "coverage_ok": True, "count": 0, "expected": 0, "first": None, "last": None,
                "bounds_ok": True, "contiguous_ok": True, "count_ok": True
            }

            base_attrs = {
                **prev_attrs,
                "raw_all": cached_raw_all,
                "status_t": prev_status_t or "Final",
                "status_tm": prev_status_tm or ("Final" if v_tm_full["coverage_ok"] else "Missing"),

                "slots_today": v_today["count"],
                "slots_tomorrow": v_tm_full["count"],
                "slots_all": len(cached_raw_all),
                "expected_slots_today": expected_today,
                "expected_slots_tomorrow": expected_tomorrow,

                "expected_slots_tomorrow_spill": v_tm_spill_cached["expected"],
                "slots_tomorrow_spill": v_tm_spill_cached["count"],
                "tomorrow_spill_complete": v_tm_spill_cached["coverage_ok"],

                "today_first_slot": v_today["first"],
                "today_last_slot":  v_today["last"],
                "today_complete":   v_today["coverage_ok"],

                "tm_first_slot":    v_tm_full["first"],
                "tm_last_slot":     v_tm_full["last"],
                "tomorrow_complete": v_tm_full["coverage_ok"],

                "tm_stale": tm_stale,
                "today_date_local": str(today0.date()),
                "tomorrow_date_local_expected": str(tomorrow0.date()),
                "last_fetch_at_local": prev_attrs.get("last_fetch_at_local"),

                # HA graphing
                "unit_of_measurement": "EUR/kWh",
                "state_class": "measurement",
            }

            state.set(SENSOR_RAW, market_now, new_attributes=base_attrs)
            log.info(
                "✅ No fetch; cache OK. Today=%d/%d ok=%s | Tomorrow=%d/%d ok=%s (spill %d/%d ok=%s)",
                v_today["count"], expected_today, v_today["coverage_ok"],
                v_tm_full["count"], expected_tomorrow, v_tm_full["coverage_ok"],
                v_tm_spill_cached["count"], v_tm_spill_cached["expected"], v_tm_spill_cached["coverage_ok"]
            )
            return

        # Build CET dates for fetch
        now_cet = now_utc.astimezone(CET_TZ)
        d_y  = (now_cet.date() - dt.timedelta(days=1)).strftime("%Y-%m-%d")
        d_t  = (now_cet.date()).strftime("%Y-%m-%d")
        d_tm = (now_cet.date() + dt.timedelta(days=1)).strftime("%Y-%m-%d")

        # Fetch as needed (include d_t when fetching tm if there is a local spill hour)
        try:
            async with aiohttp.ClientSession() as session:
                if need_y_t:
                    data_y = await _fetch_date(session, d_y,  area, currency, resolution)
                    data_t = await _fetch_date(session, d_t,  area, currency, resolution)
                if need_tm:
                    if spill_hours > 0 and data_t is None:
                        # Needed to capture local 00:00–01:00 spill into "tomorrow"
                        data_t = await _fetch_date(session, d_t, area, currency, resolution)
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

            spill_from_t = []
            if spill_hours > 0:
                spill_from_t = _combine_to_raw_all(combined, tomorrow0, tomorrow0 + dt.timedelta(hours=spill_hours))

            # Keep cached tomorrow only if it was already valid (rare at midnight)
            tomorrow_cached_slice = tm_slice_cached if v_tm_full["coverage_ok"] else []

            merged_raw_all = rebuilt_today + spill_from_t + tomorrow_cached_slice

        if need_tm and combined:
            # Rebuild tomorrow slice (tomorrow+spill) from t+tm datasets
            rebuilt_tm  = _combine_to_raw_all(combined, tomorrow0, raw_all_end)
            kept_today  = _slice_slots(merged_raw_all, today0, tomorrow0)
            merged_raw_all = kept_today + rebuilt_tm

        if not merged_raw_all:
            merged_raw_all = cached_raw_all[:]

        try:
            merged_raw_all.sort(key=lambda r: r["start"])
        except Exception:
            pass

        # Recompute validations
        today_slice    = _slice_slots(merged_raw_all, today0,   tomorrow0)
        tm_slice_full  = _slice_slots(merged_raw_all, tomorrow0, day_after0)
        tm_slice_spill = _slice_slots(merged_raw_all, tm_spill_start, tm_spill_end) if spill_hours > 0 else []

        v_today2       = _validate_slice(today_slice,    today0,       tomorrow0)
        v_tm2_full     = _validate_slice(tm_slice_full,  tomorrow0,    day_after0)
        v_tm2_spill    = _validate_slice(tm_slice_spill, tm_spill_start, tm_spill_end) if spill_hours > 0 else {
            "coverage_ok": True, "count": 0, "expected": 0, "first": None, "last": None,
            "bounds_ok": True, "contiguous_ok": True, "count_ok": True
        }

        slots_today          = v_today2["count"]
        slots_tomorrow       = v_tm2_full["count"]
        slots_tomorrow_spill = v_tm2_spill["count"]

        # Time-aware staleness
        tm_stale2 = (not v_tm2_spill["coverage_ok"]) if (now_local.hour < 13) else (not v_tm2_full["coverage_ok"])

        # Statuses & area states
        status_y, areaStates_y   = _status_for_area(data_y,  area) if need_y_t else (prev_attrs.get("status_y") or "Unknown", prev_attrs.get("areaStates_y") or [])
        status_t, areaStates_t   = _status_for_area(data_t,  area) if need_y_t else (prev_attrs.get("status_t") or ("Final" if v_today2["coverage_ok"] else "Unknown"), prev_attrs.get("areaStates_t") or [])
        status_tm, areaStates_tm = _status_for_area(data_tm, area) if need_tm  else (
            prev_attrs.get("status_tm") or ("Final" if v_tm2_full["coverage_ok"] else "Missing"),
            prev_attrs.get("areaStates_tm") or []
        )

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

            # Spill diagnostics
            "expected_slots_tomorrow_spill": v_tm2_spill["expected"],
            "slots_tomorrow_spill": slots_tomorrow_spill,
            "tomorrow_spill_complete": v_tm2_spill["coverage_ok"],

            "today_first_slot": v_today2["first"],
            "today_last_slot":  v_today2["last"],
            "today_complete":   v_today2["coverage_ok"],

            "tm_first_slot":    v_tm2_full["first"],
            "tm_last_slot":     v_tm2_full["last"],
            "tomorrow_complete": v_tm2_full["coverage_ok"],

            "tm_stale": tm_stale2,
            "today_date_local": str(today0.date()),
            "tomorrow_date_local_expected": str(tomorrow0.date()),
            "last_fetch_at_local": _fmt_local(now_local),

            # HA graphing
            "unit_of_measurement": "EUR/kWh",
            "state_class": "measurement",
        }

        state.set(SENSOR_RAW, market_now, new_attributes=base_attrs)

        log.info(
            "✅ Fetched/merged: today %d/%d ok=%s | tomorrow %d/%d ok=%s (spill %d/%d ok=%s); status t=%s, tm=%s",
            slots_today, expected_today, v_today2["coverage_ok"],
            slots_tomorrow, expected_tomorrow, v_tm2_full["coverage_ok"],
            slots_tomorrow_spill, v_tm2_spill["expected"], v_tm2_spill["coverage_ok"],
            status_t, status_tm
        )

    finally:
        nordpool_update._running = False
