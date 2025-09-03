from datetime import datetime, timedelta

# Global variables
previous_time = None
previous_power = None
total_energy_Wh = 0.0
mffr_command_active = False

# --- Track power readings and integrate energy ---
@state_trigger("sensor.ss_battery_power")
def integrate_battery_power(value=None):
    global previous_time, previous_power, total_energy_Wh

    try:
        current_power = float(value)
    except (ValueError, TypeError):
        log.warning(f"Ignoring invalid sensor value: {value}")
        return

    now = datetime.now().astimezone()

    if previous_time is not None and previous_power is not None:
        delta_seconds = (now - previous_time).total_seconds()
        if delta_seconds > 0:
            energy_wh = (previous_power * delta_seconds) / 3600.0
            total_energy_Wh += energy_wh
            log.debug(f"Δt = {delta_seconds}s, P = {previous_power}W, E = {energy_wh:.5f} Wh, Total = {total_energy_Wh:.3f} Wh")

    previous_time = now
    previous_power = current_power

# --- Track MFFR activity during the slot ---
@state_trigger("input_select.battery_mode_selector")
def track_mffr_state(value=None):
    global mffr_command_active
    if value in ["Fusebox Buy", "Fusebox Sell"]:
        mffr_command_active = True
        log.debug(f"MFFR command detected: {value} — flag set for this slot.")

# --- Check at the start of each slot if MFFR mode is already active ---
@time_trigger("cron(0 * * * *)")
@time_trigger("cron(15 * * * *)")
@time_trigger("cron(30 * * * *)")
@time_trigger("cron(45 * * * *)")
def check_initial_mffr_state():
    global mffr_command_active
    mode = input_select.battery_mode_selector
    if mode in ["Fusebox Buy", "Fusebox Sell"]:
        mffr_command_active = True
        log.debug(f"MFFR mode carried over into slot start: {mode}")
    else:
        mffr_command_active = False  # reset to clean slate if mode is inactive

# --- Finalize and optionally update baseline ---
@time_trigger("cron(0 * * * *)")
@time_trigger("cron(15 * * * *)")
@time_trigger("cron(30 * * * *)")
@time_trigger("cron(45 * * * *)")
def finalize_battery_avg_power():
    global total_energy_Wh, previous_time, previous_power, mffr_command_active

    if total_energy_Wh == 0.0:
        log.warning("No energy accumulated during this slot — skipping sensor update.")
        previous_time = None
        previous_power = None
        mffr_command_active = False
        return

    try:
        avg_power = (total_energy_Wh * 3600) / 900
        avg_power_rounded = round(avg_power, 2)

        if mffr_command_active:
            log.info(f"[MFFR Active] Skipping baseline update — preserving previous value.")
        else:
            log.info(f"[No MFFR] Updating Battery Power Baseline to {avg_power_rounded} W, Total energy: {total_energy_Wh:.3f} Wh")
            state.set("sensor.battery_power_baseline", avg_power_rounded,
                    attributes={
                        "friendly_name": "Battery Power Baseline",
                        "energy_Wh": round(total_energy_Wh, 3),
                        "timestamp": datetime.now().astimezone().isoformat()
                    })

    except Exception as e:
        log.error(f"Failed to compute or set sensor state: {e}")

    # Reset for next slot
    total_energy_Wh = 0.0
    previous_time = None
    previous_power = None
    mffr_command_active = False
