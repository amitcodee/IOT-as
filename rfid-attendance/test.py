"""
RFID Attendance System - Hardware + Terminal
ESP32 scans card -> Python reads serial -> Shows JSON in terminal

pip install pyserial
python test.py
"""

import json
import os
from datetime import datetime

# ---- EMPLOYEE DATABASE ----

employees = {
    "A1B2C3D4": {"id": "EMP001", "name": "John Smith", "department": "Engineering"},
    "E5F6G7H8": {"id": "EMP002", "name": "Sarah Johnson", "department": "Marketing"},
    "I9J0K1L2": {"id": "EMP003", "name": "Mike Wilson", "department": "HR"},
}

attendance = []


def import_pyserial():
    try:
        import serial
        import serial.tools.list_ports
    except ImportError:
        return None
    return serial

# ---- SCAN LOGIC ----

def process_scan(uid):
    uid = uid.strip().upper()
    now = datetime.now()
    date = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")

    if uid not in employees:
        return {
            "status": "error",
            "message": "UNKNOWN CARD",
            "uid": uid,
            "time": time_str
        }

    emp = employees[uid]

    # Find today's record
    today_rec = None
    for rec in attendance:
        if rec["uid"] == uid and rec["date"] == date:
            today_rec = rec
            break

    # 1st scan = CHECK IN
    if today_rec is None:
        status = "Late" if is_late(time_str) else "Present"
        attendance.append({
            "uid": uid,
            "employee_id": emp["id"],
            "employee_name": emp["name"],
            "department": emp["department"],
            "date": date,
            "check_in": time_str,
            "check_out": None,
            "working_hours": None,
            "status": status
        })
        return {
            "status": "success",
            "type": "CHECK_IN",
            "employee": emp["name"],
            "employee_id": emp["id"],
            "department": emp["department"],
            "check_in": time_str,
            "attendance_status": status
        }

    # 2nd scan = CHECK OUT
    if today_rec["check_out"] is None:
        today_rec["check_out"] = time_str
        today_rec["working_hours"] = calc_hours(today_rec["check_in"], time_str)
        return {
            "status": "success",
            "type": "CHECK_OUT",
            "employee": emp["name"],
            "employee_id": emp["id"],
            "check_in": today_rec["check_in"],
            "check_out": time_str,
            "working_hours": today_rec["working_hours"]
        }

    # 3rd+ scan = IGNORE
    return {
        "status": "info",
        "type": "ALREADY_DONE",
        "employee": emp["name"],
        "message": "Already checked in and out today"
    }


def is_late(t):
    p = t.split(":")
    return int(p[0]) * 60 + int(p[1]) > 555


def calc_hours(ci, co):
    a = ci.split(":")
    b = co.split(":")
    d = (int(b[0]) * 60 + int(b[1])) - (int(a[0]) * 60 + int(a[1]))
    if d < 0: d += 1440
    return f"{d // 60}h {d % 60}m"


def print_json(data):
    print("\n" + "=" * 50)
    print(json.dumps(data, indent=4))
    print("=" * 50 + "\n")


# ---- FIND ESP32 PORT ----

def find_port():
    serial = import_pyserial()
    if serial is None:
        print("  Hardware mode requires pyserial. Install it with: pip install pyserial")
        return None

    ports = serial.tools.list_ports.comports()
    if not ports:
        return None
    print("\n  Available COM ports:")
    for i, p in enumerate(ports):
        print(f"    [{i}] {p.device} - {p.description}")
    print()
    choice = input("  Select port number: ").strip()
    try:
        return ports[int(choice)].device
    except (ValueError, IndexError):
        return None


# ---- MAIN ----

def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    print()
    print("=" * 50)
    print("  RFID Attendance System")
    print("  Hardware: ESP32 + RC522")
    print("=" * 50)
    print()
    print("  [1] Connect to ESP32 (scan real cards)")
    print("  [2] Manual mode (type UIDs to test)")
    print()
    mode = input("  Choose (1 or 2): ").strip()

    if mode == "1":
        hardware_mode()
    else:
        manual_mode()


def hardware_mode():
    serial = import_pyserial()
    if serial is None:
        print("  Hardware mode requires pyserial. Install it with: pip install pyserial")
        return

    port = find_port()
    if not port:
        print("  No port selected. Exiting.")
        return

    print(f"\n  Connecting to {port}...")

    try:
        ser = serial.Serial(port, 115200, timeout=1)
    except serial.SerialException as e:
        print(f"  ERROR: {e}")
        return

    print("  Connected! Waiting for ESP32...")

    # Wait for RFID_READY
    while True:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if line == "RFID_READY":
            print("  ESP32 is ready!")
            break
        if line:
            print(f"  ESP32: {line}")

    print()
    print("  *** SCAN A CARD ON THE READER ***")
    print("  (Press Ctrl+C to stop)\n")

    try:
        while True:
            line = ser.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if line.startswith("UID:"):
                uid = line[4:]
                print(f"  Card scanned: {uid}")
                result = process_scan(uid)
                print_json(result)
                print("  *** SCAN NEXT CARD ***\n")
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        ser.close()


def manual_mode():
    print()
    print("  Manual mode - type UID and press Enter")
    print("  Sample UIDs: A1B2C3D4 | E5F6G7H8 | I9J0K1L2")
    print("  Type 'employees' or 'attendance' to view data")
    print("  Type 'add' to register new card")
    print("  Type 'quit' to exit")
    print()

    while True:
        try:
            cmd = input("  SCAN > ").strip()
        except (KeyboardInterrupt, EOFError):
            break

        if not cmd:
            continue
        if cmd.lower() in ("quit", "exit", "q"):
            break
        elif cmd.lower() == "employees":
            print_json({"employees": [{"uid": k, **v} for k, v in employees.items()]})
        elif cmd.lower() == "attendance":
            print_json({"records": attendance})
        elif cmd.lower() == "add":
            uid = input("  UID       : ").strip().upper()
            emp_id = input("  Emp ID    : ").strip()
            name = input("  Name      : ").strip()
            dept = input("  Department: ").strip()
            if uid and emp_id and name and dept:
                employees[uid] = {"id": emp_id, "name": name, "department": dept}
                print_json({"status": "success", "message": f"{name} registered with {uid}"})
            else:
                print_json({"status": "error", "message": "All fields required"})
        else:
            result = process_scan(cmd.upper().replace(" ", ""))
            print_json(result)

    print("  Bye!")


if __name__ == "__main__":
    main()
