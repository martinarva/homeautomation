"""
Nord Pool 15-minute price fetcher for Home Assistant (Pyscript)

⚡ What it does
- Queries Nord Pool’s Day-Ahead API every 15 minutes (all day),
  and every 1 minute between 13:00–15:00 local time,
  to ensure the script catches the moment tomorrow’s prices
  are first published by the exchange.
- Runs once at Home Assistant startup.
- Fetches yesterday + today + tomorrow CET data and converts to local time (Europe/Tallinn).
- Builds:
    • raw_today    → today’s 15-min slots, with the first hour filled from yesterday CET data
    • raw_tomorrow → tomorrow’s 15-min slots, once published
    • raw_all      → today + tomorrow combined, including the *extra spill-over hour*
                     caused by CET vs local timezone shift (not available in HA Nord Pool integration).

🛠 Manual run
- Home Assistant → Developer Tools → Services → run `pyscript.nordpool_update`

📂 Installation
1. Save this file as `config/pyscript/nordpool_update.py`
2. Restart Home Assistant or reload Pyscript

📊 Helper entity setup
- Create a *helper sensor* in HA UI with:
    Name: nordpool_15_min_raw_pyscript
    Unit: EUR/kWh
    State class: measurement
- Entity ID must be: `sensor.nordpool_15_min_raw_pyscript`

✅ Notes
- Script preserves last known values if the API is down (no `unknown` / `unavailable`).
- `updatedAt` is shown in Europe/Tallinn local time and reflects when tomorrow’s prices were published.
"""

import json
import datetime as dt
import aiohttp
import asyncio
import random

# Timezones (DST-aware when zoneinfo is available)
try:
    from zoneinfo import ZoneInfo  # Python 3.9+
    EE_TZ  = ZoneInfo("Europe/Tallinn")
    CET_TZ = ZoneInfo("Europe/Paris")   # CET/CEST
except Exception:
    EE_TZ  = dt.timezone(dt.timedelta(hours=3))
    CET_TZ = dt.timezone(dt.timedelta(hours=1))

API_BASE = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPriceIndices"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "HomeAssistant-Pyscript-Nordpool/1.0 (+nordpool_15_min_raw)"
}

async def _fetch_date(session, date, area, currency, resolution) -> dict | None:
    """Fetch a single CET delivery date."""
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

def _parse_updated_at(val: str | None) -> str | None:
    if not val:
        return None
    try:
        ts = dt.datetime.fromisoformat(val.replace("Z", "+00:00"))
        return ts.astimezone(EE_TZ).strftime("%Y-%m-%dT%H:%M:%S%z")
    except Exception as ex:
        log.warning(f"⚠️ Failed to parse updatedAt '{val}': {ex}")
        return val

def _parse_utc(ts: str) -> dt.datetime:
    # e.g. "2025-09-23T00:00:00Z"
    return dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)

@time_trigger("startup")
@time_trigger("cron(0 0-13,15-23 * * *)")   # top of the hour, excluding 14:00
@time_trigger("cron(0,15,30,45 14 * * *)")  # every 15 min during 14:00–14:59
@service
async def nordpool_update(area="EE", currency="EUR", resolution=15):
    """
    Fetch Nord Pool (CET-based) for yesterday+today+tomorrow and expose 15-min local (Europe/Tallinn) slots.
    Runs at startup and every minute. Keeps last values if anything fails.
    """
    # ---- overlap guard ----
    if getattr(nordpool_update, "_running", False):
        log.info("⏳ Previous nordpool_update still running; skipping this tick")
        return
    nordpool_update._running = True

    try:
        # ---- small jitter to avoid thundering herd ----
        await asyncio.sleep(random.uniform(0.0, 5.0))

        # Figure CET calendar dates
        now_cet = dt.datetime.now(dt.timezone.utc).astimezone(CET_TZ)
        cet_today     = now_cet.date()
        cet_yesterday = cet_today - dt.timedelta(days=1)
        cet_tomorrow  = cet_today + dt.timedelta(days=1)

        d_y  = cet_yesterday.strftime("%Y-%m-%d")
        d_t  = cet_today.strftime("%Y-%m-%d")
        d_tm = cet_tomorrow.strftime("%Y-%m-%d")

        # Fetch 3 days
        try:
            async with aiohttp.ClientSession() as session:
                data_y  = await _fetch_date(session, d_y,  area, currency, resolution)
                data_t  = await _fetch_date(session, d_t,  area, currency, resolution)
                data_tm = await _fetch_date(session, d_tm, area, currency, resolution)
        except Exception as e:
            log.error(f"❌ Session error: {e} — keeping last values")
            return

        # Collect & tag entries (origin: y / t / tm)
        combined = []
        for origin, data in (("y", data_y), ("t", data_t), ("tm", data_tm)):
            if not data:
                continue
            for e in data.get("multiIndexEntries", []):
                try:
                    su = _parse_utc(e["deliveryStart"])
                    eu = _parse_utc(e["deliveryEnd"])
                    p  = float(e["entryPerArea"][area]) / 1000.0  # EUR/MWh -> EUR/kWh
                    sl = su.astimezone(EE_TZ)
                    el = eu.astimezone(EE_TZ)
                    combined.append({"su": su, "eu": eu, "sl": sl, "el": el, "p": p, "src": origin})
                except Exception as ex:
                    log.warning(f"⚠️ Skipping bad entry {e}: {ex}")

        if not combined:
            log.warning("⚠️ No entries from any day — keeping last values")
            return

        # Current state (match by UTC delivery window)
        now_utc = dt.datetime.now(dt.timezone.utc)
        state_val = None
        for e in combined:
            if e["su"] <= now_utc < e["eu"]:
                state_val = e["p"]
                break

        # Build local-day arrays
        now_local   = now_utc.astimezone(EE_TZ)
        today0      = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow0   = today0 + dt.timedelta(days=1)
        day_after0  = today0 + dt.timedelta(days=2)

        def fmt(ts: dt.datetime) -> str:
            return ts.strftime("%Y-%m-%dT%H:%M:%S%z")

        # raw_today: local date == today, from origins yesterday or today
        raw_today = [
            {"start": fmt(e["sl"]), "end": fmt(e["el"]), "value": e["p"]}
            for e in combined
            if (today0 <= e["sl"] < tomorrow0) and (e["src"] in ("y", "t"))
        ]

        # raw_tomorrow: local date == tomorrow, but only from 'tm' dataset
        raw_tomorrow = [
            {"start": fmt(e["sl"]), "end": fmt(e["el"]), "value": e["p"]}
            for e in combined
            if (tomorrow0 <= e["sl"] < day_after0) and (e["src"] == "tm")
        ]

        # raw_all: full local today + local tomorrow (from any origin, includes spill hour)
        raw_all = [
            {"start": fmt(e["sl"]), "end": fmt(e["el"]), "value": e["p"]}
            for e in combined
            if (today0 <= e["sl"] < day_after0)
        ]
        prev_attrs = state.getattr("sensor.nordpool_15_min_raw_pyscript") or {}
        prev_updated_local = prev_attrs.get("updatedAt")

        tm_updated_local = _parse_updated_at((data_tm or {}).get("updatedAt"))


        attrs = {
            "raw_today": raw_today,
            "raw_tomorrow": raw_tomorrow,     # [] until tomorrow is published
            "raw_all": raw_all,
            # ⏱ updatedAt = ONLY when 'tomorrow' payload appears (publish moment).
            # If not available, keep previous updatedAt (don’t regress to today/yesterday).
            "updatedAt": tm_updated_local if tm_updated_local else prev_updated_local,
            "unit_of_measurement": "EUR/kWh",
            "state_class": "measurement",
        }

        state.set("sensor.nordpool_15_min_raw_pyscript", state_val, new_attributes=attrs)
        log.info(
            f"✅ Updated sensor.nordpool_15_min_raw_pyscript: "
            f"state={state_val}, today={len(raw_today)}, tomorrow={len(raw_tomorrow)}, all={len(raw_all)}"
        )

    finally:
        nordpool_update._running = False
